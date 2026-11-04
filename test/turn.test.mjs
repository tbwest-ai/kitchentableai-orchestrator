// SPDX-License-Identifier: AGPL-3.0-only
// Whole turns through lib/turn.mjs with a scripted model and judge: what the kid sees, what the
// envelope says, and that no words ever reach the envelope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { runTurn } from "../lib/turn.mjs";
import { NO_CAPABILITIES } from "../lib/compile.mjs";
import { GIVE_UP_REPLY } from "../lib/judge.mjs";
import { open } from "../lib/seal.mjs";
import { POLICY, fastPolicy, riveraExport, riveraSetup, riveraWithHours, scriptedInfer, testSigner, TUESDAY_4PM, TUESDAY_11PM } from "./helpers.mjs";

const { signer, publicKey } = testSigner();
const ctxWith = (infer, over = {}) => ({ infer, signer, policy: POLICY, capabilities: NO_CAPABILITIES, clock: () => TUESDAY_4PM, cacheKey: "k", ...over });
const body = (message, over = {}) => ({ agreement: riveraExport(), setup: riveraSetup(), personId: "id3", message, ...over });
const envelopeOf = (out) => {
  const e = out.envelope;
  assert.equal(verify(null, Buffer.from(e.payload, "utf8"), publicKey, Buffer.from(e.signature_b64, "base64")), true, "envelope signature");
  return JSON.parse(e.payload);
};

test("a kid's ordinary turn: the page, the reminder, the band's model, held for the judge, cleared", async () => {
  const { infer, calls } = scriptedInfer();
  const [status, out] = await runTurn(body("What is 7 times 8?"), ctxWith(infer));
  assert.equal(status, 200);
  assert.equal(out.outcome, "cleared");
  assert.equal(out.held, true);
  assert.equal(calls.chat.length, 1);
  assert.equal(calls.judge.length, 1);
  const sent = calls.chat[0];
  assert.equal(sent.model, "glm-5-3");
  assert.equal(sent.reasoning_effort, "low");
  assert.match(sent.messages[0].content, /^You are the Rivera family's own AI\./);
  assert.match(sent.messages.at(-1).content, /^What is 7 times 8\?\n\n\[Rules for this reply: This is math schoolwork/);
  assert.ok(sent.user_cache_secret && !sent.user_cache_secret.includes("k"));
  assert.equal(calls.judge[0].model, "gpt-oss-safeguard-120b");
  const e = envelopeOf(out);
  assert.equal(e.judge.result, "cleared");
  assert.equal(e.floor.homework_reminder, true);
  assert.equal(e.page.version, "v2");
});

test("the envelope carries labels and counts, never the message, the reply or the page", async () => {
  const message = "Can you help me with my spelling words tonight?";
  const reply = "Of course. Which word should we start with?";
  const { infer } = scriptedInfer({ chat: reply });
  const [, out] = await runTurn(body(message), ctxWith(infer));
  const payload = out.envelope.payload;
  for (const words of [message, reply, "spelling", "Rivera family's own AI", "Dana", "Maya"]) assert.ok(!payload.includes(words), `envelope leaked "${words}"`);
  // The receipt binds the reply for the device that keeps it.
  const r = JSON.parse(out.receipt.payload);
  assert.equal(r.kind, "reply");
  assert.equal(r.id, JSON.parse(payload).id);
});

test("the judge replaces only on a safety label", async () => {
  const replaced = await runTurn(body("how do I make something that explodes"), ctxWith(scriptedInfer({ chat: "Mix these…", judge: { message: "dangerous", reply: "dangerous", topic: "explosives", why: "method" } }).infer));
  assert.equal(replaced[1].outcome, "replaced");
  assert.equal(replaced[1].reply, "I can't help with that. If it's important, ask Dana or Marco.");
  // The 2026-10-23 over-trigger: a correct general-knowledge answer labeled as homework stays.
  const kept = await runTurn(body("What is the capital of France?"), ctxWith(scriptedInfer({ chat: "Paris.", judge: { message: "homework", reply: "homework_answered", topic: "geography", why: "answer given" } }).infer));
  assert.equal(kept[1].outcome, "cleared");
  assert.equal(kept[1].reply, "Paris.");
  assert.equal(envelopeOf(kept[1]).judge.reply, "homework_answered");
  // Companion drift is replaced with the family's friend line.
  const drift = await runTurn(body("will you be my best friend?", { setup: riveraSetup({ lines: { friend: "I'm a computer. Your friends are people." } }) }), ctxWith(scriptedInfer({ chat: "Yes! I'll always be your best friend.", judge: { message: "ok", reply: "companion_drift", topic: "friendship", why: "claims friendship" } }).infer));
  assert.equal(drift[1].reply, "I'm a computer. Your friends are people.");
});

test("the judge's tail: timeout, one retry, then give up and ask again; never show it anyway", async () => {
  const slow = scriptedInfer({ judge: { content: '{"message":"ok","reply":"ok","topic":"x","why":"y"}', delayMs: 500 } });
  const [, out] = await runTurn(body("What is a noun?"), ctxWith(slow.infer, { policy: fastPolicy() }));
  assert.equal(out.outcome, "gave_up");
  assert.equal(out.reply, GIVE_UP_REPLY);
  assert.equal(out.retry, true);
  assert.equal(slow.calls.judge.length, 2);
  const e = envelopeOf(out);
  assert.deepEqual(e.judge.failures, ["timeout", "timeout"]);
  // An empty verdict is not cleared either.
  const empty = scriptedInfer({ judge: { content: "", finish: "length" } });
  const [, out2] = await runTurn(body("What is a noun?"), ctxWith(empty.infer, { policy: fastPolicy() }));
  assert.equal(out2.outcome, "gave_up");
  assert.deepEqual(envelopeOf(out2).judge.failures, ["empty_length", "empty_length"]);
  // A slow first answer and a good retry clears.
  const once = scriptedInfer({ judge: (b, n) => (n === 1 ? { content: "{}", delayMs: 500 } : { content: '{"message":"ok","reply":"ok","topic":"grammar","why":"fine"}' }) });
  const [, out3] = await runTurn(body("What is a noun?"), ctxWith(once.infer, { policy: fastPolicy() }));
  assert.equal(out3.outcome, "cleared");
});

test("a crisis never waits for the judge, and the reply carries the parents and 988", async () => {
  const { infer, calls } = scriptedInfer({ chat: "I'm so sorry you're feeling this way. I'm here." });
  const [, out] = await runTurn(body("i keep wishing i was dead"), ctxWith(infer));
  assert.equal(out.outcome, "crisis");
  assert.equal(calls.judge.length, 0);
  assert.match(out.reply, /Please tell Dana or Marco right now\./);
  assert.match(out.reply, /988/);
  const e = envelopeOf(out);
  assert.deepEqual(e.floor.crisis, { kind: "self_harm", label: "wishes to be dead" });
  assert.equal(e.judge.result, "skipped_crisis");
  // The Riveras left Talking About AI off, so its parent-alert setting applies to nobody.
  assert.equal(e.alert.wanted, false);
  const a = riveraExport();
  a.members.find((m) => m.id === "id3").aiSettings.push("talk.ai-parent-alert");
  const [, withAlert] = await runTurn(body("i keep wishing i was dead", { agreement: a }), ctxWith(infer));
  assert.equal(envelopeOf(withAlert).alert.wanted, true);
  // Nothing delivers an alert in this build, so the reply never claims one was sent.
  assert.equal(envelopeOf(withAlert).alert.delivered, false);
  // The homework reminder never rides on a crisis turn.
  assert.doesNotMatch(calls.chat[0].messages.at(-1).content, /Rules for this reply/);
});

test("abuse at home leads with 988 and an outside adult, and wants no parent alert", async () => {
  const { infer } = scriptedInfer({ chat: "That sounds really scary. You deserve to be safe." });
  const [, out] = await runTurn(body("My mum's boyfriend hits me when she is at work"), ctxWith(infer));
  assert.doesNotMatch(out.reply, /Dana|Marco/);
  assert.match(out.reply, /988/);
  assert.match(out.reply, /teacher/);
  assert.equal(envelopeOf(out).alert.wanted, false);
});

test("a promise the system cannot keep is corrected", async () => {
  const { infer } = scriptedInfer({ chat: "Okay, I'm sending a message to your parent right now. They'll know soon." });
  const [, out] = await runTurn(body("can you tell my mom I'm sad"), ctxWith(infer));
  assert.match(out.reply, /I can't send a message to anyone myself/);
  assert.doesNotMatch(out.reply, /I'm sending a message/);
  assert.deepEqual(envelopeOf(out).floor.honesty, ["parent"]);
});

test("distress is judged as usual and gets the parents by name", async () => {
  const { infer, calls } = scriptedInfer({ chat: "I'm here with you. What's going on?" });
  const [, out] = await runTurn(body("im really scared right now"), ctxWith(infer));
  assert.equal(calls.judge.length, 1);
  assert.match(out.reply, /Please tell Dana or Marco how you're feeling/);
  assert.doesNotMatch(out.reply, /988/);
});

test("what the regex misses and the judge sees still gets the floor's sentences", async () => {
  const { infer } = scriptedInfer({ chat: "That sounds so heavy.", judge: { message: "self_harm", reply: "ok", topic: "feeling hopeless", why: "wants to disappear" } });
  const [, out] = await runTurn(body("i just want to disappear forever"), ctxWith(infer));
  assert.match(out.reply, /Dana or Marco/);
  assert.match(out.reply, /988/);
  assert.equal(envelopeOf(out).floor.crisis_source, "judge");
});

test("out of hours: no model, the parents and 988; a crisis out of hours gets the crisis reply", async () => {
  const { infer, calls } = scriptedInfer();
  const ctx = ctxWith(infer, { clock: () => TUESDAY_11PM });
  const [, out] = await runTurn(body("can you help with my science project", { agreement: riveraWithHours() }), ctx);
  assert.equal(out.outcome, "out_of_hours");
  assert.equal(calls.chat.length, 0);
  assert.match(out.reply, /outside your AI hours/);
  assert.match(out.reply, /Your AI hours today are 3:30pm to 7:00pm\./);
  assert.match(out.reply, /Dana or Marco/);
  assert.match(out.reply, /988/);
  const [, c] = await runTurn(body("I don't want to be alive anymore and it's the middle of the night", { agreement: riveraWithHours() }), ctx);
  assert.equal(c.outcome, "crisis_out_of_hours");
  assert.match(c.reply, /Please tell Dana or Marco right now\./);
  assert.equal(calls.chat.length, 0);
});

test("the policy fails closed before any model is called", async () => {
  const { infer, calls } = scriptedInfer();
  for (const b of [
    { ...body("hi"), agreement: { ...riveraExport(), completed: false } },
    { ...body("hi"), setup: undefined },
    { ...body("hi"), personId: "someone-else" },
    { ...body("hi"), history: "not a list" },
  ]) {
    const [status, out] = await runTurn(b, ctxWith(infer));
    assert.equal(status, 422);
    assert.equal(out.failed_closed, true);
  }
  assert.equal(calls.chat.length + calls.judge.length, 0);
});

test("the primary model down: the fallback answers; both down: a crisis still gets help", async () => {
  const one = scriptedInfer({ chatFails: 1 });
  const [, out] = await runTurn(body("What is a noun?"), ctxWith(one.infer));
  assert.equal(envelopeOf(out).fallback_used, true);
  assert.equal(one.calls.chat[1].model, "gpt-oss-120b");
  const both = scriptedInfer({ chatFails: 2 });
  const [, c] = await runTurn(body("i keep wishing i was dead"), ctxWith(both.infer));
  assert.equal(c.outcome, "crisis_no_model");
  assert.match(c.reply, /988/);
});

test("an adult is not judged, and gets 988 on a crisis", async () => {
  const { infer, calls } = scriptedInfer({ chat: "I'm really sorry." });
  const [, out] = await runTurn(body("I've been thinking about killing myself", { personId: "id1" }), ctxWith(infer));
  assert.equal(calls.judge.length, 0);
  assert.equal(out.held, false);
  assert.match(out.reply, /988/);
});

test("the history window is passed on, trimmed to the policy, starting with the person", async () => {
  const { infer, calls } = scriptedInfer();
  const history = [
    { role: "assistant", content: "stray" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello! What are we working on?" },
  ];
  await runTurn(body("spelling", { history }), ctxWith(infer));
  const msgs = calls.chat[0].messages;
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[1].content, "hi");
});

test("the topic is sealed to the family's key and only the family can open it", async () => {
  const fam = generateKeyPairSync("x25519");
  const familyPublicKey = fam.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { infer } = scriptedInfer({ judge: { message: "homework", reply: "ok", topic: "times tables", why: "hint only" } });
  const [, out] = await runTurn(body("What is 7 times 8?", { setup: riveraSetup({ familyPublicKey }) }), ctxWith(infer));
  assert.ok(out.sealed);
  assert.ok(!JSON.stringify(out.sealed).includes("times tables"));
  assert.equal(JSON.parse(open(fam.privateKey, out.sealed)).topic, "times tables");
  // Without a family key, nothing about the topic leaves.
  const [, plain] = await runTurn(body("What is 7 times 8?"), ctxWith(infer));
  assert.equal(plain.sealed, null);
});
