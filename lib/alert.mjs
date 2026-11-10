// SPDX-License-Identifier: AGPL-3.0-only
// The parent alert (since v0.6.0): when a kid may be in real trouble, the parents are told, and
// the kid is told that they were. The founder's decisions of 2026-11-09:
//
//   - Every kid, whatever the Agreement says. It is part of the product, not a setting. The alert
//     goes to parents only.
//   - What sets it off: the crisis patterns saying self-harm or danger, or the judge labeling the
//     kid's message as self-harm or as the kid being in danger. The patterns missed three indirect
//     self-harm messages on 2026-11-09 that the judge labeled, which is why the judge counts.
//     A kid asking for something dangerous (a weapon, a poison) is refused and counted as before,
//     and sends no alert.
//   - Never on abuse, by pattern or by judge, and never for the rest of a sitting in which the kid
//     said someone at home hurts them (lib/turn.mjs): a parent can be the one doing it. That alert
//     waits on counsel (decision 25).
//   - This service tells the family's account directly, before it answers the kid, and waits about
//     two seconds. Only when the account answered `ok` does the kid's reply say a parent is being
//     told. The same event goes back to the kid's device as a backup, and the account takes each
//     alert once.
//
// What leaves this container for the family's account (ALERT_URL, the third and last host in the
// egress allowlist) is `{ event, sealed }`, and nothing else ever goes there:
//   - `event`: signed like a turn's envelope with the turn-signing key. Its payload is
//     { v: 1, kind: "alert", id, at, family, device, person_id, sealed_sha256 }: who and when, the
//     family and device ids from the pass. No reason, and no word of the chat.
//   - `sealed`: the reason ({ v: 1, kind: "alert", id, at, person_id, reason }, reason `self_harm`
//     or `danger`) sealed to the family's public key, so only a parent's phone can open it. Null
//     when the family has no parent phone set up yet; the alert still goes.
// This service keeps no record of an alert and no memory of earlier ones: the account applies the
// one-an-hour limit. Nothing here is logged.
//
// Before any alert leaves: is the trouble at home? (`troubleAtHome`.) The patterns and the judge's
// one label per message are not enough to keep "never on abuse". On the real model on 2026-11-09
// a kid wrote "someone at home scares me and i dont want to go back there" (the judge said
// abuse, the patterns said nothing, and this service remembers no label from one turn to the
// next), then "sometimes i wish i could just disappear", and the parents were alerted. So the
// safeguard model is asked one question over everything the kid wrote in the sitting, this
// message included. "Yes" means no alert. No answer means no alert either: it fails closed,
// because the kid still gets the crisis reply and 988, and an alert to the wrong parent cannot
// be taken back.

import { createHash } from "node:crypto";
import { seal } from "./seal.mjs";
import { signed } from "./sign.mjs";

/** Why an alert goes. Abuse is not here on purpose. */
export const ALERT_REASONS = ["self_harm", "danger"];

/** The reason the crisis patterns give, or null. `signal` is lib/crisis.mjs detectCrisis(). */
export const reasonFromPattern = (signal) => (ALERT_REASONS.includes(signal?.kind) ? signal.kind : null);

/**
 * The reason the judge's label on the kid's message gives, or null. `danger` is the kid being in
 * danger (running away, being followed, someone met online); `dangerous`, a request for a weapon
 * or a poison, is not an alert.
 */
export const reasonFromJudge = (verdict) => (ALERT_REASONS.includes(verdict?.message) ? verdict.message : null);

const and = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What the kid is told, only when the account took the alert. The founder's pick of the draft (2026-11-09). */
export const alertLine = (parents) => `I'm letting ${and(parents)} know you may need them.`;

/**
 * The alert for one turn: { event, sealed }. `to` is { family, device }, the account's own ids
 * from the family's pass. The event's signature covers the sealed note by its SHA-256, as a turn's
 * envelope covers its notes.
 */
export function makeAlert({ signer, id, at, to, personId, reason, familyPublicKey }) {
  const sealed = familyPublicKey ? seal(familyPublicKey, JSON.stringify({ v: 1, kind: "alert", id, at, person_id: personId, reason })) : null;
  const payload = { v: 1, kind: "alert", id, at, family: to.family, device: to.device, person_id: personId };
  if (sealed) payload.sealed_sha256 = createHash("sha256").update(JSON.stringify(sealed), "utf8").digest("hex");
  return { event: signed(signer, payload), sealed };
}

/**
 * Returns send(alert, { timeoutMs }) -> { ok, result, ms }. `ok` is true only when the account
 * answered 200 with { ok: true }; `result` is a label for the envelope ("ok", "timeout",
 * "network", "http_404", "refused"). It never throws and never follows a redirect: the allowlist
 * names one host. `fetchImpl` is injectable for tests.
 */
export function makeAlertSender({ url, fetchImpl = fetch }) {
  return async function send(alert, { timeoutMs = 2000 } = {}) {
    const t0 = Date.now();
    const done = (ok, result) => ({ ok, result, ms: Date.now() - t0 });
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) return done(false, `http_${res.status}`);
      const body = JSON.parse(await res.text());
      return body?.ok === true ? done(true, "ok") : done(false, "refused");
    } catch (err) {
      return done(false, err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err instanceof SyntaxError ? "refused" : "network");
    }
  };
}

// --- before any alert leaves: is the trouble at home? ---------------------------------------------

/** The one question, for the safeguard model. It returns a label and never writes to the kid. */
export const HOME_CHECK_PROMPT = [
  "You check one thing for a family's AI before it alerts a child's parents that the child may need them.",
  "You read what the child wrote in one sitting, oldest first. You never write a reply.",
  "",
  "QUESTION",
  "Does anything the child wrote say or suggest that someone the child lives with, or someone in the child's family, hurts them, hits them, touches them in a way they do not want, threatens them or frightens them, or that the child is afraid to be at home or to go home?",
  "",
  "Answer yes for any of that, however briefly or indirectly it is said, and whoever the person at home is.",
  "Answer yes too when the child does not say who a person is (\"he\", \"she\", \"someone\") and that person does something to the child that the child hates, fears or does not want, in a place that sounds like home: their room, their bed, the house, at night.",
  "Answer no when the trouble is somewhere else or is the child's own: a bully or a fight at school, a stranger, someone met online, sadness, loneliness, wanting to die, a bad grade.",
  "Ordinary family friction is no: being grounded, a phone taken away, an argument, a strict or angry parent, a parent who will be mad about something.",
  "A figure of speech is no: \"my dad is going to kill me when he sees my grades\" means he will be angry, and nothing more.",
  "",
  "OUTPUT",
  "Return exactly one line of JSON and nothing else:",
  '{"home":"yes"} or {"home":"no"}',
].join("\n");

/** The kid's own messages in the sitting as the check reads them: the newest kept when there are too many. */
export function homeCheckInput(messages, { maxMessages = 40, maxChars = 8000 } = {}) {
  const kept = messages.filter((m) => typeof m === "string" && m.trim()).slice(-maxMessages);
  let total = kept.reduce((n, m) => n + m.length, 0);
  while (kept.length > 1 && total > maxChars) total -= kept.shift().length;
  return `THE CHILD WROTE:\n${kept.map((m, i) => `${i + 1}. ${m.trim().slice(0, 2000)}`).join("\n")}`;
}

/**
 * Asks the question. Returns "yes", "no" or "unknown" (no answer in time, or one that cannot be
 * read). `infer` is the inference client; `cfg` is the policy's check: { model, reasoningEffort,
 * maxTokens, timeoutMs, maxMessages, maxChars }. It never throws.
 */
export async function troubleAtHome(infer, cfg, messages) {
  try {
    const r = await infer(
      {
        model: cfg.model,
        messages: [
          { role: "system", content: HOME_CHECK_PROMPT },
          { role: "user", content: homeCheckInput(messages, cfg) },
        ],
        temperature: 0,
        max_tokens: cfg.maxTokens,
        ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      },
      { timeoutMs: cfg.timeoutMs },
    );
    const found = String(r?.content ?? "").match(/\{[^{}]*\}/);
    const answer = found ? JSON.parse(found[0])?.home : null;
    return answer === "yes" || answer === "no" ? answer : "unknown";
  } catch {
    return "unknown";
  }
}
