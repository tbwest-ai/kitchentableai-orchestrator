// SPDX-License-Identifier: AGPL-3.0-only
// The compiler on the builder's real Rivera export: it fails closed on a bad Agreement, writes
// only rules the person holds, never promises a tool this build lacks, and keeps the five layers
// in order with the always-trues last.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyError, resolve } from "../lib/agreement.mjs";
import { BAND_GUIDE, THEY_WORDS_OK, compilePage, fill } from "../lib/compile.mjs";
import { riveraExport, riveraSetup, riveraWithHours } from "./helpers.mjs";

const page = (personId, opts = {}, setup = riveraSetup(), agreement = riveraExport()) =>
  compilePage(resolve(agreement, setup, personId), { facts: { dateLabel: "Tuesday, November 3, 2026" }, ...opts }).text;

test("fails closed: no export, an unfinished one, an unknown row, a missing time zone, a stranger", () => {
  const bad = [
    () => resolve(null, riveraSetup(), "id3"),
    () => resolve({ ...riveraExport(), completed: false }, riveraSetup(), "id3"),
    () => resolve({ ...riveraExport(), version: 2 }, riveraSetup(), "id3"),
    () => {
      const a = riveraExport();
      a.members[2].rules.push("balance.made-up-row");
      return resolve(a, riveraSetup(), "id3");
    },
    () => resolve(riveraExport(), riveraSetup({ timeZone: undefined }), "id3"),
    () => resolve(riveraExport(), riveraSetup({ timeZone: "Mars/Olympus" }), "id3"),
    () => resolve(riveraExport(), riveraSetup(), "nobody"),
    () => resolve(riveraExport(), { ...riveraSetup(), format: "something-else" }, "id3"),
  ];
  for (const f of bad) assert.throws(f, PolicyError);
});

test("Maya's page quotes the rules she holds and none she does not", () => {
  const t = page("id3");
  assert.match(t, /"Trying it ourselves first: write a first draft/);
  assert.match(t, /"No character or companion chatbots in our house\."/);
  // Theo holds the privacy never-give rule; Maya does not.
  assert.doesNotMatch(t, /Never giving AI our full names/);
  // Nobody tapped the settings-together rule, so the storage setting is not quoted as the family's.
  assert.doesNotMatch(t, /the family's setting is "Not learning from our chats/);
  assert.match(t, /nothing is learned from chats, and there is no memory on a kid's account/);
  // The family turned "say when it isn't sure" off: not quoted as their setting, the truth still told.
  assert.doesNotMatch(t, /"Say when it isn't sure, and who to ask instead\."/);
  assert.match(t, /When you are not sure, or cannot check something, say so plainly/);
});

test("the family's custom rules land as the family's lines, a one-person rule as that person's", () => {
  const t = page("id3");
  assert.match(t, /The family's own lines:\n- "No AI at Grandma's house on Sundays\."\n- "Homework help happens at the kitchen table\."/);
  const a = riveraExport();
  a.customRules.push({ id: "id9", priority: "real", text: "No spoilers for anything I'm reading.", by: "family", for: ["id4"] });
  a.members.find((m) => m.id === "id4").customRules.push("id9");
  const theo = page("id4", {}, riveraSetup(), a);
  assert.match(theo, /Theo's own lines, added at the table:\n- "No spoilers for anything I'm reading\."/);
});

test("the five layers are in order, the always-trues last, with the date and the parents", () => {
  const t = page("id3");
  const at = (s) => t.indexOf(s);
  assert.ok(at("You are the Rivera family's own AI.") === 0);
  assert.ok(at("THE RIVERA FAMILY'S AGREEMENT") < at("THREE THINGS THAT ARE TRUE"));
  assert.ok(at("THREE THINGS THAT ARE TRUE") < at("\nMAYA\n"));
  assert.ok(at("\nMAYA\n") < at("HOW TO TALK TO MAYA"));
  assert.ok(at("HOW TO TALK TO MAYA") < at("ALWAYS: THE LAST WORD"));
  assert.match(t, /Today is Tuesday, November 3, 2026\./);
  assert.match(t, /Her parents are Dana and Marco\./);
});

test("no tool, search, upload or alert is promised that this build cannot deliver", () => {
  const t = page("id3");
  assert.doesNotMatch(t, /tell-my-parent tool/);
  assert.doesNotMatch(t, /"my hours"/);
  assert.doesNotMatch(t, /a parent is alerted/i);
  assert.doesNotMatch(t, /Web search is on/);
  assert.doesNotMatch(t, /Attaching a photo or file is on/);
  assert.match(t, /You cannot send a message to Dana or Marco or to anyone else\./);
  assert.match(t, /You cannot search the web in this version/);
  // With the tools on, the same page says what they do.
  const all = { tellMyParent: true, myHours: true, myAgreement: true, search: true, attachments: true, alerts: true, breaks: true };
  const withTools = page("id4", { capabilities: all });
  assert.match(withTools, /tell-my-parent tool/);
  assert.match(withTools, /Web search is on for Theo/);
});

test("hours are stated only for a person the hours setting applies to", () => {
  assert.match(page("id3"), /Hours\. No hours limit Maya's use of AI\./);
  const t = page("id3", {}, riveraSetup(), riveraWithHours());
  assert.match(t, /Maya's hours are Monday to Thursday 3:30pm to 7:00pm; Friday 3:30pm to 8:00pm; Saturday and Sunday 9:00am to 7:00pm\./);
  assert.match(t, /"Only answer during each person's hours\."/);
});

test("pronouns agree, and they/them is the default", () => {
  const she = page("id3");
  assert.match(she, /show her this page if she asks what you were told/);
  const setup = riveraSetup();
  delete setup.people.id3;
  const they = page("id3", {}, setup);
  assert.match(they, /show them this page if they ask what you were told/);
  assert.match(they, /Their parents are Dana and Marco\./);
  assert.doesNotMatch(they, /\bthey (?:asks|has|wants|brings|was)\b/);
  assert.doesNotMatch(she, /\bshe (?:ask|know|want|have)\b/);
});

test("every {they} in the band guide is followed by a word the agreement table handles", () => {
  const text = JSON.stringify(BAND_GUIDE.bands) + JSON.stringify(BAND_GUIDE.refusals) + JSON.stringify(BAND_GUIDE.customRefusal);
  for (const m of text.matchAll(/\{they\} ([a-z]+)/g)) assert.ok(THEY_WORDS_OK.has(m[1]), `"{they} ${m[1]}" needs an entry in AFTER_THEY or THEY_WORDS_OK`);
  const view = resolve(riveraExport(), riveraSetup(), "id4");
  assert.equal(fill("so {they} know you read it", view), "so he knows you read it");
});

test("an adult's page has no kid rules, no judge talk, and says what the family sees", () => {
  const t = page("id1");
  // The kids' pronouns are on a parent's page, so the AI does not guess them (2026-11-04).
  assert.match(t, /Dana is 41, an adult and a parent of Maya \(9, she\/her\) and Theo \(13, he\/him\)\./);
  assert.match(t, /Nobody in the family sees an adult's conversations\./);
  assert.doesNotMatch(t, /Homework:/);
});

test("the same Agreement always compiles to the same page", () => {
  const a = compilePage(resolve(riveraExport(), riveraSetup(), "id4"), { facts: { dateLabel: "x" } });
  const b = compilePage(resolve(riveraExport(), riveraSetup(), "id4"), { facts: { dateLabel: "x" } });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.version, "v2");
});
