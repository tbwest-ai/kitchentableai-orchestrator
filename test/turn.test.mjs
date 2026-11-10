// SPDX-License-Identifier: AGPL-3.0-only
// Whole turns through lib/turn.mjs with a scripted model and judge: what the kid sees, what the
// envelope says, and that no words ever reach the envelope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
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
  // Every kid's crisis wants a parent alert, whatever the Agreement says (the founder, 2026-11-09;
  // the Riveras left the setting off). This context has no account to tell, so none is
  // delivered and the reply never claims one was sent. test/alert.test.mjs has the rest.
  assert.equal(e.alert.wanted, true);
  assert.equal(e.alert.delivered, false);
  assert.doesNotMatch(out.reply, /letting Dana/);
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

test("the judge's crisis labels stay labels: they add no words to the reply (2026-11-04 test chat)", async () => {
  // The messages that drew five appended 988 lines in the founder's own test, each labeled by the judge.
  for (const [message, label] of [
    ["Ah! there is a fire in my room!! What should I do?", "danger"],
    ["She keeps tripping me and will like push me in the bathroom and all her friends laugh and think it's hilarious. it sucks", "abuse"],
    ["how do i tell the school without looking like a snitch?", "abuse"],
  ]) {
    const reply = "That sounds hard. Getting out safe, or telling a teacher and your parents, comes first.";
    const { infer } = scriptedInfer({ chat: reply, judge: { message: label, reply: "ok", topic: "x", why: "y" } });
    const [, out] = await runTurn(body(message), ctxWith(infer));
    assert.equal(out.reply, reply, message);
    const e = envelopeOf(out);
    assert.equal(e.judge.message, label, "the label still reaches the envelope");
    assert.equal(e.floor.crisis, null);
    assert.deepEqual(e.floor.added, []);
  }
});

test("out of hours: no model, when the hours start and who to ask, no 988; a crisis out of hours gets the crisis reply", async () => {
  const { infer, calls } = scriptedInfer();
  // After Tuesday's hours (3:30pm to 7:00pm in New York).
  const late = ctxWith(infer, { clock: () => TUESDAY_11PM });
  const [, out] = await runTurn(body("can you help with my science project", { agreement: riveraWithHours() }), late);
  assert.equal(out.outcome, "out_of_hours");
  assert.equal(calls.chat.length, 0);
  assert.equal(out.reply, "It's outside your AI hours right now. They ended at 7:00pm and start again tomorrow at 3:30pm. If you need help before then, ask Dana or Marco.");
  // Before them: version A, the founder's words of 2026-11-04.
  const early = ctxWith(infer, { clock: () => new Date("2026-11-03T19:00:00Z") });
  const [, before] = await runTurn(body("can you help with my science project", { agreement: riveraWithHours() }), early);
  assert.equal(before.reply, "It's outside your AI hours right now. Your hours today start at 3:30pm. If you need help before then, ask Dana or Marco.");
  for (const r of [out.reply, before.reply]) assert.doesNotMatch(r, /988/);
  // A day with no hours names the next day that has some.
  const offToday = riveraWithHours();
  offToday.members.find((m) => m.id === "id3").hours.find((h) => h.day === "Tue").on = false;
  offToday.members.find((m) => m.id === "id3").hours.find((h) => h.day === "Wed").on = false;
  const [, none] = await runTurn(body("hi", { agreement: offToday }), early);
  assert.equal(none.reply, "It's outside your AI hours right now. They start again on Thursday at 3:30pm. If you need help before then, ask Dana or Marco.");
  // A crisis is caught before the hours, and gets 988.
  const [, c] = await runTurn(body("I don't want to be alive anymore and it's the middle of the night", { agreement: riveraWithHours() }), late);
  assert.equal(c.outcome, "crisis_out_of_hours");
  assert.match(c.reply, /Please tell Dana or Marco right now\./);
  assert.match(c.reply, /988/);
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

test("a whole sitting reaches the model: 60 messages pass, and past 100 the oldest go first", async () => {
  const sitting = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  let { infer, calls } = scriptedInfer();
  await runTurn(body("and the next one?", { history: sitting(60) }), ctxWith(infer));
  assert.equal(calls.chat[0].messages.length, 1 + 60 + 1, "the page, all 60, the new message");
  ({ infer, calls } = scriptedInfer());
  await runTurn(body("and the next one?", { history: sitting(130) }), ctxWith(infer));
  const kept = calls.chat[0].messages.slice(1, -1);
  assert.equal(kept.length, 100);
  assert.equal(kept[0].content, "m30", "the oldest 30 dropped, still starting with the person");
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

test("the sealed note carries the judge's area, and the envelope's signature covers each note by its hash", async () => {
  const fam = generateKeyPairSync("x25519");
  const familyPublicKey = fam.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { infer } = scriptedInfer({ judge: { message: "homework", reply: "ok", topic: "times tables", area: "math", why: "hint only" } });
  const [, out] = await runTurn(body("What is 7 times 8?", { setup: riveraSetup({ familyPublicKey }) }), ctxWith(infer));
  const note = JSON.parse(open(fam.privateKey, out.sealed));
  assert.equal(note.area, "math");
  const env = envelopeOf(out);
  assert.equal(env.sealed_sha256, createHash("sha256").update(JSON.stringify(out.sealed)).digest("hex"));
  // Maya's transcripts are off in this setup: no readable chat leaves.
  assert.equal(out.transcript, null);
  assert.equal(env.transcript_sha256, null);
  // An area outside the list is dropped; the verdict still stands.
  const odd = scriptedInfer({ judge: { message: "ok", reply: "ok", topic: "dinosaurs", area: "dinosaurs", why: "fine" } });
  const [, out2] = await runTurn(body("What did T. rex eat?", { setup: riveraSetup({ familyPublicKey }) }), ctxWith(odd.infer));
  assert.equal(out2.outcome, "cleared");
  assert.equal(JSON.parse(open(fam.privateKey, out2.sealed)).area, null);
});

test("with transcripts on, the kid's message and reply are sealed for the parent phones, and never in the envelope", async () => {
  const fam = generateKeyPairSync("x25519");
  const familyPublicKey = fam.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const setup = riveraSetup({ familyPublicKey, people: { ...riveraSetup().people, id3: { pronouns: "she", age: 9, transcripts: true } } });
  const { infer } = scriptedInfer({ chat: "Try counting by sevens: 7, 14, 21. Where do you land after eight of them?", judge: { message: "homework", reply: "ok", topic: "times tables", area: "math", why: "hint" } });
  const [, out] = await runTurn(body("What is 7 times 8?", { setup }), ctxWith(infer));
  assert.ok(out.transcript);
  const chat = JSON.parse(open(fam.privateKey, out.transcript));
  assert.equal(chat.kind, "chat");
  assert.equal(chat.message, "What is 7 times 8?");
  assert.equal(chat.reply, out.reply);
  const env = envelopeOf(out);
  assert.equal(env.transcript_sha256, createHash("sha256").update(JSON.stringify(out.transcript)).digest("hex"));
  assert.ok(!out.envelope.payload.includes("7 times 8"));
  assert.ok(!JSON.stringify(out.transcript).includes("7 times 8"));

  // Abuse at home is never in the readable chat, whether the patterns or the judge saw it.
  const [, abuse] = await runTurn(body("my dad hits me when he gets mad", { setup }), ctxWith(infer));
  assert.equal(abuse.transcript, null);
  assert.equal(envelopeOf(abuse).transcript_sha256, null);
  const judged = scriptedInfer({ chat: "I'm sorry that happened.", judge: { message: "abuse", reply: "ok", topic: "trouble at home", area: "feelings_friends", why: "abuse" } });
  const [, j2] = await runTurn(body("someone at home scares me", { setup }), ctxWith(judged.infer));
  assert.equal(j2.transcript, null);

  // A turn the kid must send again is not part of the chat.
  const slow = scriptedInfer({ judge: { content: "{}", delayMs: 500 } });
  const [, gave] = await runTurn(body("spelling help", { setup }), ctxWith(slow.infer, { policy: fastPolicy() }));
  assert.equal(gave.outcome, "gave_up");
  assert.equal(gave.transcript, null);

  // A parent's own chat is never readable by the family, transcripts or not.
  const [, adult] = await runTurn(body("Plan a weeknight dinner", { setup, personId: "id1" }), ctxWith(infer));
  assert.equal(adult.transcript, null);
  assert.equal(adult.sealed, null);
});
