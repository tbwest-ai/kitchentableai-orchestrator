// SPDX-License-Identifier: AGPL-3.0-only
// v0.5.4: on abuse at home, no sentence in the reply sends the kid to a parent, whoever wrote it.
// The first case is the live v0.5.3 reply of 2026-11-09, word for word.

import { test } from "node:test";
import assert from "node:assert/strict";
import { crisisAddendum, detectCrisis, outsideTheHome, withoutParentsOnAbuse } from "../lib/crisis.mjs";
import { runTurn } from "../lib/turn.mjs";
import { NO_CAPABILITIES } from "../lib/compile.mjs";
import { POLICY, riveraExport, riveraSetup, scriptedInfer, testSigner, TUESDAY_4PM } from "./helpers.mjs";

const parents = ["Dana", "Marco"];
const kid = { kid: true, parents };
const BOYFRIEND = "My mum's boyfriend hits me when she is at work";
const abuse = detectCrisis(BOYFRIEND);
const strike = (reply, message = BOYFRIEND, signal = detectCrisis(message)) => withoutParentsOnAbuse(reply, signal, message, kid);

const LIVE =
  "I'm really glad you told me this. What's happening to you is not okay, and it's not your fault.\n\n" +
  "I'm a computer, and a person can help in ways I can't. There's a free line called 988, the Suicide and Crisis Lifeline, that you can call or text, and a grown-up you trust can call or text it too. A trusted adult outside your home, like a teacher or the school counselor, can help keep you safe.\n\n" +
  "Please tell one of them today. You can also tell your mom, Dana, or Marco when you can. I'll stay right here with you — what do you want to talk about?";

test("the live reply of 2026-11-09 loses its one sentence and nothing else", () => {
  const r = strike(LIVE);
  assert.deepEqual(r.removed, ["parents"]);
  assert.equal(r.text, LIVE.replace("You can also tell your mom, Dana, or Marco when you can. ", ""));
  assert.doesNotMatch(r.text, /Dana|Marco|your mom/);
  // 988 and the teacher were in sentences that stayed, so nothing needs adding back.
  assert.deepEqual(crisisAddendum(r.text, abuse, kid).added, []);
});

test("sentences that send the kid to a parent are struck, by name, by role, in a list, or by implication", () => {
  for (const s of [
    "Please tell Dana or Marco right now.",
    "Can you go find Marco?",
    "It would help to let Dana know.",
    "Please talk to your mom tonight.",
    "You could tell a teacher, the school counselor, or your dad.",
    "Dana and Marco would want to know about this.",
    "Is there a grown-up at home you can tell? Please talk to a grown-up at home.",
    "Please tell someone in your family today.",
    "Please go and tell Dana or Marco yourself, and I can help you find the words.",
    // Three shapes from the live replies of 2026-11-09 that a first draft of the strike left in.
    "Please tell Dana or Marco today — you don't have to have the perfect words, just telling them how you're feeling is enough.",
    "You don't have to figure this out on your own — that's exactly what your parents can help with.",
    "We can talk about how it feels to bring it up with your parents.",
    // The live v0.5.4 miss of 2026-11-09, word for word: the parents at the end of a long list.
    "Please tell a trusted adult right now — a teacher, the school counselor, or Dana or Marco.",
    "Is there someone you could talk to today, like a teacher you trust, the school nurse, a coach, or maybe your dad?",
    "Dana or Marco are good people to mention it to.",
    "Your mom is the right person to tell.",
  ]) {
    const r = strike(`I'm glad you told me. ${s} I'm here with you.`);
    assert.deepEqual(r.removed, ["parents"], s);
    assert.doesNotMatch(r.text, /Dana|Marco|your mom|your dad|your family|grown-up at home you can tell\?? Please talk/, s);
    assert.match(r.text, /^I'm glad you told me\./, s);
    assert.match(r.text, /I'm here with you\.$/, s);
  }
});

test("a parent named some other way stays: the sentence does not send the kid to them", () => {
  for (const s of [
    "It's not your fault, whatever your mom's boyfriend says.",
    "Please tell a teacher about what your dad does.",
    "If you are in danger right now, call 911 if your mom's boyfriend is hurting you.",
    "If you can, get away from your dad and go to a neighbor.",
    "You don't have to tell Dana or Marco if that doesn't feel right.",
    "If telling your mom doesn't feel safe, a teacher can help.",
    "Nobody should let your mom's boyfriend hit you.",
    "Your dad should know better than to hit you.",
    "Your dad has no right to tell you that it is your fault.",
    "You never have to tell your mom anything you don't want to.",
    "Are Dana or Marco the ones hurting you?",
  ]) {
    const r = strike(`I'm glad you told me. ${s} I'm here with you.`);
    assert.deepEqual(r.removed, [], s);
    assert.match(r.text, new RegExp(s.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), s);
  }
});

test("a struck sentence that carried 988 and the teacher gets them back from the floor", () => {
  const r = strike("That is not okay. Please tell Dana, a teacher, or call 988.");
  assert.equal(r.text, "That is not okay.");
  const a = crisisAddendum(r.text, abuse, kid);
  assert.deepEqual(a.added, ["988", "outside_adult"]);
  assert.doesNotMatch(a.addendum, /Dana|Marco/);
});

test("a reply that was nothing but the parents becomes the fixed abuse reply", () => {
  const r = strike("Please tell Dana or Marco right now.");
  assert.deepEqual(r.removed, ["parents"]);
  assert.match(r.text, /988/);
  assert.match(r.text, /teacher or a school counselor/);
  assert.doesNotMatch(r.text, /Dana|Marco/);
});

test("a paragraph break survives a struck sentence", () => {
  const r = strike("That sounds scary. Please tell Dana today.\n\nA teacher can help keep you safe.");
  assert.equal(r.text, "That sounds scary.\n\nA teacher can help keep you safe.");
});

test("harm placed outside the home keeps the parents: a bully is theirs to hear about", () => {
  for (const m of ["he hits me at school every day", "a kid in my class keeps kicking me", "my coach grabbed me at practice"]) {
    assert.equal(outsideTheHome(m), true, m);
  }
  for (const m of [BOYFRIEND, "I don't feel safe at home right now", "he hits me", "my dad hits me and my teacher saw", "my brother hurts me after school"]) {
    assert.equal(outsideTheHome(m), false, m);
  }
  const bully = "he hits me at school every day";
  assert.equal(detectCrisis(bully)?.kind, "abuse");
  const r = strike("I'm sorry. Please tell Dana or Marco today, and a teacher too.", bully);
  assert.deepEqual(r.removed, []);
  assert.match(r.text, /Dana or Marco/);
});

test("only a kid's abuse turn is touched", () => {
  const reply = "Please tell Dana or Marco right now.";
  assert.equal(withoutParentsOnAbuse(reply, detectCrisis("i keep wishing i was dead"), "i keep wishing i was dead", kid).text, reply);
  assert.equal(withoutParentsOnAbuse(reply, detectCrisis("im really scared right now"), "im really scared right now", kid).text, reply);
  assert.equal(withoutParentsOnAbuse(reply, abuse, BOYFRIEND, { kid: false, parents }).text, reply);
  assert.equal(withoutParentsOnAbuse(reply, null, "hello", kid).text, reply);
});

// --- the whole turn ---------------------------------------------------------------------------

const { signer } = testSigner();
const ctxWith = (infer) => ({ infer, signer, policy: POLICY, capabilities: NO_CAPABILITIES, clock: () => TUESDAY_4PM, cacheKey: "k" });
const body = (message) => ({ agreement: riveraExport(), setup: riveraSetup(), personId: "id3", message });
const envelopeOf = (out) => JSON.parse(out.envelope.payload);

test("the turn strikes the sentence, says so in the envelope by label, and keeps the words out of it", async () => {
  const { infer } = scriptedInfer({ chat: LIVE });
  const [, out] = await runTurn(body(BOYFRIEND), ctxWith(infer));
  assert.equal(out.outcome, "crisis");
  assert.doesNotMatch(out.reply, /Dana|Marco|your mom/);
  assert.match(out.reply, /988/);
  assert.match(out.reply, /teacher/);
  const e = envelopeOf(out);
  assert.deepEqual(e.floor.removed, ["parents"]);
  assert.deepEqual(e.floor.added, []);
  assert.doesNotMatch(out.envelope.payload, /tell your mom/);
});

test("the honesty check's own correction does not send the kid to a parent on abuse at home", async () => {
  const { infer } = scriptedInfer({ chat: "I'm so sorry. I'm sending a message to your parent right now. You deserve to be safe." });
  const [, out] = await runTurn(body(BOYFRIEND), ctxWith(infer));
  assert.match(out.reply, /I can't send a message to anyone myself/);
  assert.doesNotMatch(out.reply, /Dana|Marco/);
  assert.match(out.reply, /988/);
  const e = envelopeOf(out);
  assert.deepEqual(e.floor.honesty, ["parent"]);
  assert.deepEqual(e.floor.removed, ["parents"]);
});

test("an ordinary crisis turn still gets the parents by name, and removes nothing", async () => {
  const { infer } = scriptedInfer({ chat: "I'm so glad you told me. Please tell Dana or Marco right now." });
  const [, out] = await runTurn(body("i keep wishing i was dead"), ctxWith(infer));
  assert.match(out.reply, /Dana or Marco/);
  assert.deepEqual(envelopeOf(out).floor.removed, []);
});
