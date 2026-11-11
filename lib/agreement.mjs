// SPDX-License-Identifier: AGPL-3.0-only
// Reads a Family AI Agreement export and the KitchenTableAI setup next to it, and resolves one
// person's view of both. This is floor item 1: the policy fails closed. A missing, malformed or
// incomplete Agreement throws a PolicyError and the turn never reaches a model.
//
// The export is the builder's declared format (`family-ai-agreement`, version 1), produced by
// `exportAgreement(draft)` in the builder. Its rules, in words, are the builder's own: a person
// holds a family rule, a custom rule applies to some people, an AI setting applies to a person
// when its family-wide switch is on and the person holds the family rule it sits under (`pair`).
// The export already resolved all of that per person, so this file only reads it.
//
// The setup (`kitchentableai-setup`, version 1) is what the builder does not capture and the
// product's "Finish setting up the AI" step will: the time zone, an optional name for the AI,
// how long chats are kept, and per person their pronouns, age, homework style and switches.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const CONTENT_MODEL = JSON.parse(readFileSync(join(HERE, "..", "agreement", "content-model.json"), "utf8"));
export const ROWS = new Map(
  CONTENT_MODEL.priorities.flatMap((p) => p.rows.map((r) => [r.id, { ...r, priority: p }])),
);
export const BANDS = ["Under 8", "8–11", "12–14", "15–18", "Adult"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
    this.status = 422;
  }
}

const fail = (msg) => {
  throw new PolicyError(msg);
};
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x, max = 200) => typeof x === "string" && x.length <= max;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How long the family app keeps a day's activity rows, and with them each kid exchange's sealed
 * summary (topic and area): KEEP_ROW_DAYS in the builder's lib/family-activity.ts. The setup's
 * retentionDays is the other number there, how long a chat parents can read is kept (30).
 */
export const SUMMARY_DAYS = 35;

/** Pronoun sets. "they" is the default when the setup gives none. */
export const PRONOUNS = {
  she: { subj: "she", obj: "her", poss: "her", plural: false },
  he: { subj: "he", obj: "him", poss: "his", plural: false },
  they: { subj: "they", obj: "them", poss: "their", plural: true },
};

/** Checks the export's shape. Returns it unchanged; throws PolicyError on anything off. */
export function validateExport(a) {
  if (!isObj(a)) fail("agreement: an Agreement export object is required");
  if (a.format !== "family-ai-agreement") fail('agreement: format must be "family-ai-agreement"');
  if (a.version !== 1) fail("agreement: only version 1 of the export is understood");
  if (!str(a.familyName, 120)) fail("agreement: familyName must be a string");
  if (a.completed !== true) fail("agreement: the family has not completed this Agreement yet");
  if (!Array.isArray(a.members) || a.members.length === 0 || a.members.length > 16) fail("agreement: members must be a list of 1 to 16 people");
  const ids = new Set();
  for (const m of a.members) {
    if (!isObj(m) || !str(m.id, 64) || !m.id) fail("agreement: every member needs an id");
    if (ids.has(m.id)) fail(`agreement: member id ${m.id} appears twice`);
    ids.add(m.id);
    if (!str(m.name, 60) || !m.name.trim()) fail(`agreement: member ${m.id} needs a name`);
    if (!BANDS.includes(m.band)) fail(`agreement: member ${m.id} has an unknown age band`);
    for (const key of ["rules", "customRules", "aiSettings"]) {
      if (!Array.isArray(m[key]) || !m[key].every((x) => str(x, 80))) fail(`agreement: member ${m.id} ${key} must be a list of ids`);
    }
    for (const r of [...m.rules, ...m.aiSettings]) if (!ROWS.has(r)) fail(`agreement: member ${m.id} names ${r}, which is not in the content model`);
    for (const r of m.rules) if (ROWS.get(r).ai) fail(`agreement: ${r} is an AI setting, listed as a family rule`);
    for (const r of m.aiSettings) if (!ROWS.get(r).ai) fail(`agreement: ${r} is a family rule, listed as an AI setting`);
    if (!Array.isArray(m.hours) || m.hours.length !== 7) fail(`agreement: member ${m.id} needs seven days of hours`);
    m.hours.forEach((h, i) => {
      if (!isObj(h) || h.day !== DAYS[i] || typeof h.on !== "boolean" || !HHMM.test(h.start) || !HHMM.test(h.end)) {
        fail(`agreement: member ${m.id} hours for ${DAYS[i]} are malformed`);
      }
      if (h.on && h.end <= h.start) fail(`agreement: member ${m.id} hours for ${DAYS[i]} end before they start`);
    });
  }
  if (!Array.isArray(a.customRules)) fail("agreement: customRules must be a list");
  const custom = new Set();
  for (const c of a.customRules) {
    if (!isObj(c) || !str(c.id, 64) || !str(c.text, 400) || !c.text.trim()) fail("agreement: a custom rule needs an id and text");
    if (!Array.isArray(c.for) || !c.for.every((id) => ids.has(id))) fail(`agreement: custom rule ${c.id} is for someone not in the family`);
    custom.add(c.id);
  }
  for (const m of a.members) for (const c of m.customRules) if (!custom.has(c)) fail(`agreement: member ${m.id} holds custom rule ${c}, which is not in the Agreement`);
  if (!Array.isArray(a.aiSettings)) fail("agreement: aiSettings must be a list");
  return a;
}

/** Checks the setup's shape and fills its defaults. Throws PolicyError on anything off. */
export function validateSetup(s, agreement) {
  if (!isObj(s)) fail("setup: the KitchenTableAI setup object is required");
  if (s.format !== "kitchentableai-setup") fail('setup: format must be "kitchentableai-setup"');
  if (s.version !== 1) fail("setup: only version 1 of the setup is understood");
  if (!str(s.timeZone, 64) || !s.timeZone) fail("setup: timeZone is required (an IANA name such as America/New_York)");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone });
  } catch {
    fail(`setup: ${s.timeZone} is not a time zone this system knows`);
  }
  if (s.aiName !== undefined && s.aiName !== null && (!str(s.aiName, 40) || !s.aiName.trim())) fail("setup: aiName must be a short name or null");
  if (s.aiNamedBy !== undefined && s.aiNamedBy !== null && !str(s.aiNamedBy, 60)) fail("setup: aiNamedBy must be a short phrase or null");
  const retentionDays = s.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) fail("setup: retentionDays must be a whole number of days");
  const lines = isObj(s.lines) ? s.lines : {};
  for (const k of ["notSure", "friend", "parentsPromise"]) if (lines[k] !== undefined && !str(lines[k], 300)) fail(`setup: lines.${k} must be a sentence`);
  const ids = new Set(agreement.members.map((m) => m.id));
  const people = isObj(s.people) ? s.people : {};
  for (const [id, p] of Object.entries(people)) {
    if (!ids.has(id)) fail(`setup: people.${id} is not a member of the Agreement`);
    if (!isObj(p)) fail(`setup: people.${id} must be an object`);
    if (p.pronouns !== undefined && !PRONOUNS[p.pronouns]) fail(`setup: people.${id}.pronouns must be she, he or they`);
    if (p.age !== undefined && !(Number.isInteger(p.age) && p.age >= 2 && p.age <= 120)) fail(`setup: people.${id}.age must be a whole number`);
    if (p.homework !== undefined && !["think-first", "explain-and-check"].includes(p.homework)) fail(`setup: people.${id}.homework must be think-first or explain-and-check`);
    if (p.homeworkClause !== undefined && p.homeworkClause !== null && !str(p.homeworkClause, 200)) fail(`setup: people.${id}.homeworkClause must be a sentence`);
    for (const k of ["webSearch", "uploads", "transcripts"]) if (p[k] !== undefined && typeof p[k] !== "boolean") fail(`setup: people.${id}.${k} must be true or false`);
    // The family's documents about this person (since v0.7.0, lib/attachments.mjs): the id of each
    // and the SHA-256 a sent document must match. The text is never in the setup.
    if (p.documents !== undefined) {
      if (!Array.isArray(p.documents) || p.documents.length > 8) fail(`setup: people.${id}.documents must be a short list`);
      const seen = new Set();
      for (const d of p.documents) {
        if (!isObj(d) || typeof d.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(d.id) || typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256)) fail(`setup: people.${id}.documents entries need an id and a sha256`);
        if (seen.has(d.id)) fail(`setup: people.${id}.documents lists ${d.id} twice`);
        seen.add(d.id);
      }
    }
  }
  if (s.parents !== undefined && (!Array.isArray(s.parents) || !s.parents.every((id) => ids.has(id)))) fail("setup: parents must list member ids");
  if (s.familyPublicKey !== undefined && s.familyPublicKey !== null && !str(s.familyPublicKey, 200)) fail("setup: familyPublicKey must be base64 SPKI");
  return { ...s, retentionDays, lines, people };
}

/** "The Rivera Family" -> "the Rivera family"; "" -> "the family". */
function familyPhrase(name) {
  const t = (name ?? "").trim();
  if (!t) return { phrase: "the family", upper: "THE FAMILY" };
  const m = t.match(/^(?:the\s+)?(.+?)\s+family$/i);
  const core = m ? `the ${m[1]} family` : /^the\s/i.test(t) ? `the ${t.slice(4)}` : t;
  return { phrase: core, upper: core.toUpperCase() };
}

/** Default band behaviour where the setup is silent (plan 2026-10-23 §3.6; decision 10). */
const BAND_DEFAULTS = {
  "Under 8": { homework: "think-first", webSearch: false },
  "8–11": { homework: "think-first", webSearch: false },
  "12–14": { homework: "explain-and-check", webSearch: true },
  "15–18": { homework: "explain-and-check", webSearch: true },
  Adult: { homework: null, webSearch: true },
};

/**
 * One person's view of the Agreement, everything the compiler and the floor need, resolved.
 * Throws PolicyError when the person is not in the Agreement.
 */
export function resolve(agreementIn, setupIn, personId) {
  const agreement = validateExport(agreementIn);
  const setup = validateSetup(setupIn, agreement);
  const m = agreement.members.find((x) => x.id === personId);
  if (!m) fail("personId: not a member of this Agreement");

  const adults = agreement.members.filter((x) => x.band === "Adult");
  const parentIds = setup.parents ?? adults.map((x) => x.id);
  const parents = parentIds.map((id) => agreement.members.find((x) => x.id === id).name.trim());
  const kid = m.band !== "Adult";
  if (kid && parents.length === 0) fail("agreement: a kid's page needs at least one parent in the family");

  const own = setup.people[m.id] ?? {};
  const band = BAND_DEFAULTS[m.band];
  const customById = new Map(agreement.customRules.map((c) => [c.id, c]));
  const custom = m.customRules.map((id) => customById.get(id));

  const settings = new Set(m.aiSettings);
  const fam = familyPhrase(agreement.familyName);
  const changed = agreement.timestamps?.changedAt ?? agreement.timestamps?.completedAt ?? null;

  return {
    family: {
      id: agreement.familyId ?? null,
      name: agreement.familyName.trim(),
      phrase: fam.phrase,
      upper: fam.upper,
      parents,
      // Everyone's first name, for the one place that must know them all: keeping names out of a web search (lib/search.mjs).
      members: agreement.members.map((x) => x.name.trim()),
      aiName: setup.aiName ? setup.aiName.trim() : null,
      aiNamedBy: setup.aiNamedBy ?? null,
      retentionDays: setup.retentionDays,
      summaryDays: SUMMARY_DAYS,
      timeZone: setup.timeZone,
      changedOn: typeof changed === "string" ? changed.slice(0, 10) : null,
      priorityCount: Array.isArray(agreement.priorities) ? agreement.priorities.filter((p) => p?.on === true).length : 0,
      lines: setup.lines,
      familyPublicKey: setup.familyPublicKey ?? null,
      kids: agreement.members
        .filter((x) => x.band !== "Adult")
        .map((x) => ({ name: x.name.trim(), age: setup.people[x.id]?.age ?? null, pronouns: setup.people[x.id]?.pronouns ?? null })),
    },
    person: {
      id: m.id,
      name: m.name.trim(),
      band: m.band,
      kid,
      age: own.age ?? null,
      pronoun: PRONOUNS[own.pronouns ?? "they"],
      homework: kid ? own.homework ?? band.homework : null,
      homeworkClause: own.homeworkClause ?? null,
      rules: m.rules.filter((r) => ROWS.has(r)),
      // A custom rule written for this one person is their own line; any other is the family's.
      familyLines: custom.filter((c) => !(c.for.length === 1 && c.for[0] === m.id)).map((c) => c.text.trim()),
      ownLines: custom.filter((c) => c.for.length === 1 && c.for[0] === m.id).map((c) => ({ text: c.text.trim(), by: c.by })),
      settings,
      hours: m.hours,
      hoursApply: settings.has("balance.ai-hours"),
      webSearch: own.webSearch ?? band.webSearch,
      uploads: own.uploads ?? true,
      documents: (own.documents ?? []).map((d) => ({ id: d.id, sha256: d.sha256 })),
      transcripts: kid ? own.transcripts ?? false : false,
    },
  };
}
