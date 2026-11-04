// SPDX-License-Identifier: AGPL-3.0-only
// One turn, end to end: a person's message in, the reply they may see out, with a signed
// envelope of labels (never words) for the control plane and a receipt over the reply for the
// person's own device. The order is the plan's (2026-10-23 §3.8) and the founder's decisions:
//
//   1. The policy fails closed: no valid Agreement and setup, no model (floor item 1).
//   2. The crisis regex reads the message first, before every gate, hours included (item 7).
//   3. Hours, held here in the family's time zone on this container's clock (item 2). Out of hours
//      the person gets the parents by first name and 988, and a crisis gets the crisis reply.
//   4. The page is compiled from the Agreement with today's date (items 13, 15), the homework
//      reminder goes next to the message, and the band's model answers (item 3).
//   5. For a kid, the reply is held until the independent judge has read the message and the
//      reply, and it is replaced only on a safety label (decision 18). A crisis never waits for
//      the judge. Adults are not judged (their client streams; this build answers whole).
//   6. After the model: the honesty check on promises and storage (item 9), then the crisis or
//      distress sentences the reply is missing (item 7).
//   7. The envelope (labels, counts, which page and model) is signed; the topic is sealed to the
//      family's public key when the setup carries one (item 14).
//
// Not in this build, and so never claimed by the page: tools (tell my parent, my hours, my
// Agreement, search), attachments, parent alerts (the envelope says an alert is wanted; nothing
// delivers it yet), breaks, allowances, and a control plane to fetch the Agreement from (the
// client sends it, which a Phase 2 token replaces).

import { createHash, createHmac, randomUUID } from "node:crypto";
import { PolicyError, resolve } from "./agreement.mjs";
import { compilePage } from "./compile.mjs";
import { crisisAddendum, crisisReply, detectCrisis } from "./crisis.mjs";
import { homeworkReminder } from "./homework.mjs";
import { checkHonesty } from "./honesty.mjs";
import { inHours, localNow, todayWindow } from "./hours.mjs";
import { REPLACE_ON, giveUpReplyFor, replacementFor, runJudge } from "./judge.mjs";
import { seal } from "./seal.mjs";
import { signed } from "./sign.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const or = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
const JUDGE_CRISIS = new Set(["self_harm", "abuse", "danger"]);

/** The out-of-hours reply: the parents by first name and 988 (decision 8). Draft copy for the founder's review. */
export function outOfHoursReply(view, local) {
  const window = todayWindow(view.person.hours, local);
  const today = window ? `Your AI hours today are ${window}.` : "There are no AI hours today.";
  return `It's outside your AI hours right now. ${today} If something is wrong, please tell ${or(view.family.parents)}, and you can call or text 988 any time.`;
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
    floor: { crisis: null, crisis_source: null, added: [], homework_reminder: false, honesty: [], out_of_hours: false },
    judge: null,
    alert: { wanted: false, delivered: false },
    usage: { chat: null, judge: [] },
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
    const topic = extra.topic ?? null;
    const sealed = topic && family.familyPublicKey ? seal(family.familyPublicKey, JSON.stringify({ v: 1, id: turnId, at: envelope.at, person_id: person.id, topic })) : null;
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
  let judgeSignal = null;
  if (person.kid && band.judge && !crisis) {
    const j = await runJudge(ctx.infer, ctx.policy.judge, view, message, raw);
    envelope.judge = { model: ctx.policy.judge.model, message: j.verdict?.message ?? null, reply: j.verdict?.reply ?? null, attempts: j.attempts, ms: j.ms, result: null, failures: j.failures };
    envelope.usage.judge = j.usage;
    if (j.outcome === "gave_up") {
      envelope.judge.result = "gave_up";
      return finish(giveUpReplyFor(message, signal, view), "gave_up", { modelMs });
    }
    topic = j.verdict.topic;
    if (REPLACE_ON.has(j.verdict.reply)) {
      reply = replacementFor(j.verdict.reply, view);
      outcome = "replaced";
      envelope.judge.result = "replaced";
    } else {
      envelope.judge.result = "cleared";
    }
    if (!signal && JUDGE_CRISIS.has(j.verdict.message)) {
      // The regex missed what the judge saw: the floor's sentences still go in.
      judgeSignal = { kind: j.verdict.message === "danger" ? "danger" : j.verdict.message, label: "judge" };
      envelope.floor.crisis = { kind: judgeSignal.kind, label: "judge" };
      envelope.floor.crisis_source = "judge";
    }
  } else if (person.kid && crisis) {
    envelope.judge = { model: ctx.policy.judge.model, result: "skipped_crisis" };
    outcome = "crisis";
  }

  // 6. The honesty check, then the help the reply is missing.
  const honest = checkHonesty(reply, view, { parentTold });
  reply = honest.text;
  envelope.floor.honesty = honest.corrections;
  const help = signal ?? judgeSignal;
  if (help) {
    const { addendum, added } = crisisAddendum(reply, help, { kid: person.kid, parents });
    reply += addendum;
    envelope.floor.added = added;
  }
  return finish(reply, outcome, { modelMs, topic });
}
