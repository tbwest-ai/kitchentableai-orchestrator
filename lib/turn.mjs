// SPDX-License-Identifier: AGPL-3.0-only
// One turn, end to end: a person's message in, the reply they may see out, with a signed
// envelope of labels (never words) for the control plane and a receipt over the reply for the
// person's own device. The order is the plan's (2026-10-23 §3.8) and the founder's decisions:
//
//   1. The policy fails closed: no valid Agreement and setup, no model (floor item 1).
//   2. The crisis regex reads the message first, before every gate, hours included (item 7).
//   3. Hours, held here in the family's time zone on this container's clock (item 2). Out of hours
//      the person is told when the hours start and to ask a parent by first name; a crisis out of
//      hours gets the crisis reply, 988 included.
//   4. The page is compiled from the Agreement with today's date (items 13, 15), the homework
//      reminder goes next to the message, and the band's model answers (item 3).
//   5. For a kid, the reply is held until the independent judge has read the message and the
//      reply, and it is replaced only on a safety label (decision 18). A crisis never waits for
//      the judge. Adults are not judged (their client streams; this build answers whole).
//   6. After the model: the honesty check on promises and storage (item 9), then the crisis or
//      distress sentences the reply is missing (item 7).
//   7. The envelope (labels, counts, which page and model) is signed; a kid's topic and area, and
//      the chat itself where the family turned transcripts on for that kid, are sealed to the
//      family's public key when the setup carries one (item 14), and the envelope names each
//      sealed note's SHA-256 (since v0.5.0).
//
// Not in this build, and so never claimed by the page: tools (tell my parent, my hours, my
// Agreement, search), attachments, parent alerts (the envelope says an alert is wanted; nothing
// delivers it yet), breaks and allowances. The client still sends the Agreement, but since v0.4.0
// with a pass the family's account signed over it (lib/access.mjs, checked in server.mjs), so a
// device cannot change its own rules; ctx.who and ctx.limits carry what the lock admitted.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { PolicyError, resolve } from "./agreement.mjs";
import { compilePage } from "./compile.mjs";
import { crisisAddendum, crisisReply, detectCrisis } from "./crisis.mjs";
import { homeworkReminder } from "./homework.mjs";
import { checkHonesty } from "./honesty.mjs";
import { hoursPosition, inHours, localNow } from "./hours.mjs";
import { REPLACE_ON, giveUpReplyFor, replacementFor, runJudge } from "./judge.mjs";
import { seal } from "./seal.mjs";
import { signed } from "./sign.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const or = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/**
 * The out-of-hours reply: when the hours start, and the parents by first name. The founder's words
 * (2026-11-04, "Use version A"). No 988: on an ordinary message it is the wrong size, and a crisis
 * out of hours never reaches this reply, because the crisis check runs first and answers with the
 * crisis reply, 988 included.
 */
export function outOfHoursReply(view, local) {
  const pos = hoursPosition(view.person.hours, local);
  const ask = `If you need help before then, ask ${or(view.family.parents)}.`;
  const nextLine = (n) => (n ? `${n.label} at ${n.start}` : null);
  if (pos.when === "later") return `It's outside your AI hours right now. Your hours today start at ${pos.start}. ${ask}`;
  if (pos.when === "ended") {
    const again = nextLine(pos.next);
    return `It's outside your AI hours right now. They ended at ${pos.end}${again ? ` and start again ${again}` : ""}. ${again ? ask : `If you need help, ask ${or(view.family.parents)}.`}`;
  }
  const again = nextLine(pos.next);
  return again
    ? `It's outside your AI hours right now. They start again ${again}. ${ask}`
    : `It's outside your AI hours right now. If you need help, ask ${or(view.family.parents)}.`;
}

/**
 * The reply past one of the lock's limits (lib/access.mjs). The founder's openings (2026-11-05:
 * "You've reached your daily limit...." and "You've exceeded limits. Wait at a minute..."), read as
 * "Wait a minute"; the endings after them are ours. No 988: a crisis past a limit never reaches
 * this reply, because the crisis check runs first and answers with the crisis reply.
 */
export function limitReply(view, kind) {
  if (kind === "burst") return "You've exceeded limits. Wait a minute, then try again.";
  const kid = view.person.kid ? ` If you need help before then, ask ${or(view.family.parents)}.` : "";
  return `You've reached your daily limit. You can use the AI again tomorrow.${kid}`;
}

/** The conversation window the client sends: prior turns, oldest first, trimmed to the policy's limits. */
function windowOf(history, limits) {
  if (history === undefined) return [];
  if (!Array.isArray(history)) throw new PolicyError("history must be a list of { role, content }");
  const turns = history.map((h) => {
    if (!h || (h.role !== "user" && h.role !== "assistant") || typeof h.content !== "string") throw new PolicyError("history entries need a role (user or assistant) and content");
    return { role: h.role, content: h.content.slice(0, limits.maxMessageChars) };
  });
  const kept = turns.slice(-limits.maxMessages);
  let total = kept.reduce((n, t) => n + t.content.length, 0);
  while (kept.length && total > limits.maxChars) total -= kept.shift().content.length;
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
}

/**
 * The compiled page a turn for this person would run under right now, with no model call: the
 * same facts (today's date in the family's zone) and capabilities as runTurn, so its sha256 is
 * the one a turn's envelope reports. Nothing on the page is secret from the family (decision 6);
 * this is what "See what the AI is told" shows. Returns [httpStatus, body].
 */
export function pageFor(body, ctx) {
  let view;
  try {
    view = resolve(body?.agreement, body?.setup, body?.personId);
  } catch (err) {
    if (err instanceof PolicyError) return [422, { ok: false, error: err.message, failed_closed: true }];
    throw err;
  }
  const local = localNow(view.family.timeZone, ctx.clock());
  const page = compilePage(view, { facts: { dateLabel: local.dateLabel }, capabilities: ctx.capabilities });
  return [200, { ok: true, person_id: view.person.id, version: page.version, sha256: page.sha256, text: page.text }];
}

/**
 * Runs one turn. `ctx`: { infer, signer, policy, capabilities, clock: () => Date, cacheKey }.
 * Returns [httpStatus, body]. Never throws for a bad request: a PolicyError becomes a 422.
 */
export async function runTurn(body, ctx) {
  const t0 = Date.now();
  const nowDate = ctx.clock();
  let view;
  let history;
  try {
    view = resolve(body?.agreement, body?.setup, body?.personId);
    history = windowOf(body?.history, ctx.policy.window);
  } catch (err) {
    if (err instanceof PolicyError) return [422, { ok: false, error: err.message, failed_closed: true }];
    throw err;
  }
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return [400, { ok: false, error: "message (string) is required" }];
  if (message.length > ctx.policy.window.maxMessageChars) return [413, { ok: false, error: `message longer than ${ctx.policy.window.maxMessageChars} characters` }];

  const { person, family } = view;
  const band = ctx.policy.bands[person.band];
  const local = localNow(family.timeZone, nowDate);
  const turnId = randomUUID();
  const envelope = {
    v: 1,
    kind: "turn",
    id: turnId,
    at: nowDate.toISOString(),
    family_id: family.id,
    person_id: person.id,
    band: person.band,
    page: null,
    model: null,
    fallback_used: false,
    outcome: null,
    floor: { crisis: null, crisis_source: null, added: [], homework_reminder: false, honesty: [], out_of_hours: false, limited: null },
    // Who the lock admitted: the control plane's opaque family and device ids, or the sample.
    access: ctx.who ? (ctx.who.sample ? { sample: true } : ctx.who.open ? { open: true } : { family: ctx.who.family, device: ctx.who.device }) : null,
    judge: null,
    alert: { wanted: false, delivered: false },
    usage: { chat: null, judge: [] },
    // The SHA-256 of each sealed note returned beside the envelope, or null (since v0.5.0).
    sealed_sha256: null,
    transcript_sha256: null,
  };
  const parents = family.parents;

  // 2. The crisis regex, before every gate.
  const signal = detectCrisis(message);
  if (signal) {
    envelope.floor.crisis = { kind: signal.kind, label: signal.label };
    envelope.floor.crisis_source = "regex";
  }
  const crisis = signal && signal.kind !== "distress" ? signal : null;
  // The family's alert setting asks for one on a crisis; abuse at home waits on counsel (decision 25).
  envelope.alert.wanted = Boolean(person.kid && crisis && crisis.kind !== "abuse" && person.settings.has("talk.ai-parent-alert"));
  const parentTold = Boolean(envelope.alert.wanted && envelope.alert.delivered);

  const finish = (reply, outcome, extra = {}) => {
    envelope.outcome = outcome;
    const receipt = signed(ctx.signer, { v: 1, kind: "reply", id: turnId, at: envelope.at, person_id: person.id, reply_sha256: sha256(reply) });
    // Two notes sealed to the family's public key, so only the family's parent phones can open
    // them: what a kid's exchange was about (the judge's topic and area), and, only for a kid
    // whose family turned transcripts on, the message and the reply as the kid saw it. The
    // envelope carries each note's SHA-256, so its signature covers them and a device cannot swap
    // one for a note of its own making (the public half is public).
    //
    // Abuse at home stays out of the readable chat: a parent can be the one doing it, and the
    // alert for abuse waits on counsel (decision 25). A turn the kid is asked to send again is not
    // part of the chat either.
    const topic = extra.topic ?? null;
    const sealed = topic && family.familyPublicKey ? seal(family.familyPublicKey, JSON.stringify({ v: 1, id: turnId, at: envelope.at, person_id: person.id, topic, area: extra.area ?? null })) : null;
    const abuse = signal?.kind === "abuse" || envelope.judge?.message === "abuse";
    const readable = person.kid && person.transcripts && family.familyPublicKey && outcome !== "gave_up" && !abuse;
    const transcript = readable ? seal(family.familyPublicKey, JSON.stringify({ v: 1, kind: "chat", id: turnId, at: envelope.at, person_id: person.id, message, reply })) : null;
    envelope.sealed_sha256 = sealed ? sha256(JSON.stringify(sealed)) : null;
    envelope.transcript_sha256 = transcript ? sha256(JSON.stringify(transcript)) : null;
    return [
      200,
      {
        ok: true,
        reply,
        held: person.kid,
        outcome,
        retry: outcome === "gave_up",
        envelope: signed(ctx.signer, envelope),
        receipt,
        sealed,
        transcript,
        timing: { total_ms: Date.now() - t0, model_ms: extra.modelMs ?? null, judge_ms: envelope.judge?.ms ?? null },
      },
    ];
  };

  // 3. Hours, on this clock, in the family's zone.
  if (person.hoursApply && !inHours(person.hours, local)) {
    envelope.floor.out_of_hours = true;
    if (signal) return finish(crisisReply(signal, { kid: person.kid, parents }), "crisis_out_of_hours");
    return finish(outOfHoursReply(view, local), "out_of_hours");
  }

  // 3b. The lock's limits, by the family's own date. Only a turn that would reach a model counts.
  // A crisis past a limit still gets the crisis reply, 988 included.
  const limited = ctx.limits && ctx.who ? ctx.limits.admit(ctx.who, local.dateLabel) : null;
  if (limited) {
    envelope.floor.limited = limited;
    if (signal) return finish(crisisReply(signal, { kid: person.kid, parents }), "crisis_limited");
    return finish(limitReply(view, limited), limited === "day" ? "daily_limit" : "slow_down");
  }

  // 4. The page, the reminder, the model.
  const page = compilePage(view, { facts: { dateLabel: local.dateLabel }, capabilities: ctx.capabilities });
  envelope.page = { version: page.version, sha256: page.sha256 };
  const reminder = crisis ? "" : homeworkReminder(person, message);
  envelope.floor.homework_reminder = Boolean(reminder);
  const userContent = reminder ? `${message}\n\n${reminder}` : message;
  const cacheSecret = ctx.cacheKey ? createHmac("sha256", ctx.cacheKey).update(`page:${family.id ?? family.name}:${person.id}`).digest("hex").slice(0, 32) : undefined;
  const chatBody = (model, effort) => ({
    model,
    messages: [{ role: "system", content: page.text }, ...history, { role: "user", content: userContent }],
    max_tokens: band.maxTokens,
    temperature: ctx.policy.temperature,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(cacheSecret ? { user_cache_secret: cacheSecret } : {}),
  });

  let raw = null;
  let modelMs = null;
  try {
    const r = await ctx.infer(chatBody(band.model, band.reasoningEffort), { timeoutMs: ctx.policy.chatTimeoutMs });
    raw = r.content;
    modelMs = r.ms;
    envelope.model = band.model;
    envelope.usage.chat = r.usage;
  } catch (first) {
    try {
      const f = ctx.policy.fallback;
      const r = await ctx.infer(chatBody(f.model, f.reasoningEffort), { timeoutMs: ctx.policy.chatTimeoutMs });
      raw = r.content;
      modelMs = r.ms;
      envelope.model = f.model;
      envelope.fallback_used = true;
      envelope.usage.chat = r.usage;
    } catch {
      // Neither model answered. A crisis still gets its help; anything else is asked to try again.
      if (signal) return finish(crisisReply(signal, { kid: person.kid, parents }), "crisis_no_model");
      return finish(giveUpReplyFor(message, signal, view), "gave_up");
    }
  }
  if (!raw) {
    if (signal) return finish(crisisReply(signal, { kid: person.kid, parents }), "crisis_no_model", { modelMs });
    return finish(giveUpReplyFor(message, signal, view), "gave_up", { modelMs });
  }

  // 5. The judge, for a kid, holding the reply. A crisis does not wait for it.
  let reply = raw;
  let outcome = person.kid ? "cleared" : "adult";
  let topic = null;
  let area = null;
  if (person.kid && band.judge && !crisis) {
    const j = await runJudge(ctx.infer, ctx.policy.judge, view, message, raw);
    envelope.judge = { model: ctx.policy.judge.model, message: j.verdict?.message ?? null, reply: j.verdict?.reply ?? null, attempts: j.attempts, ms: j.ms, result: null, failures: j.failures };
    envelope.usage.judge = j.usage;
    if (j.outcome === "gave_up") {
      envelope.judge.result = "gave_up";
      return finish(giveUpReplyFor(message, signal, view), "gave_up", { modelMs });
    }
    topic = j.verdict.topic;
    area = j.verdict.area;
    if (REPLACE_ON.has(j.verdict.reply)) {
      reply = replacementFor(j.verdict.reply, view);
      outcome = "replaced";
      envelope.judge.result = "replaced";
    } else {
      envelope.judge.result = "cleared";
    }
    // The judge's message label (danger, abuse, self_harm…) stays a label in the envelope, for the
    // parent dashboard. It never adds words to the reply: on 2026-11-04 it read a fire and a bully at
    // school as danger and abuse, and the floor appended 988 to five replies in one kid's chat, after
    // the AI had promised to stop. Only the measured crisis patterns add the floor's sentences.
  } else if (person.kid && crisis) {
    envelope.judge = { model: ctx.policy.judge.model, result: "skipped_crisis" };
    outcome = "crisis";
  }

  // 6. The honesty check, then the help the reply is missing.
  const honest = checkHonesty(reply, view, { parentTold });
  reply = honest.text;
  envelope.floor.honesty = honest.corrections;
  if (signal) {
    const { addendum, added } = crisisAddendum(reply, signal, { kid: person.kid, parents });
    reply += addendum;
    envelope.floor.added = added;
  }
  return finish(reply, outcome, { modelMs, topic, area });
}
