// SPDX-License-Identifier: AGPL-3.0-only
// The parent alert (lib/alert.mjs, since v0.6.0): what sets it off, what is sent to the family's
// account and when, what the kid is told and only when it is true, and that abuse never sends one.
// Whole turns through lib/turn.mjs with a scripted model, judge and account. The Riveras are synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_REASONS, HOME_CHECK_PROMPT, alertLine, homeCheckInput, makeAlert, makeAlertSender, reasonFromJudge, reasonFromPattern, troubleAtHome } from "../lib/alert.mjs";
import { detectCrisis } from "../lib/crisis.mjs";
import { NO_CAPABILITIES } from "../lib/compile.mjs";
import { open } from "../lib/seal.mjs";
import { pageFor, runTurn } from "../lib/turn.mjs";
import { POLICY, ROOT, fastPolicy, riveraExport, riveraSetup, riveraWithHours, scriptedAlert, scriptedInfer, testSigner, TUESDAY_4PM, TUESDAY_11PM } from "./helpers.mjs";

const { signer, publicKey } = testSigner();
const ALERTS_ON = { ...NO_CAPABILITIES, alerts: true };
const WHO = { family: "fam-1", device: "dev-1" };
const ctxWith = (infer, alert, over = {}) => ({ infer, signer, policy: POLICY, capabilities: ALERTS_ON, clock: () => TUESDAY_4PM, cacheKey: "k", who: WHO, alert, alertPolicy: { timeoutMs: 80 }, ...over });
/** Maya (id3) is 9. Theo (id4) is 13. Dana (id1) is a parent. */
const body = (message, over = {}) => ({ agreement: riveraExport(), setup: riveraSetup(), personId: "id3", message, ...over });
const checked = (signedThing) => {
  assert.equal(verify(null, Buffer.from(signedThing.payload, "utf8"), publicKey, Buffer.from(signedThing.signature_b64, "base64")), true, "signature");
  return JSON.parse(signedThing.payload);
};
const envelopeOf = (out) => checked(out.envelope);
const LINE = "I'm letting Dana and Marco know you may need them.";
const SELF_HARM = "i keep wishing i was dead";
const BOYFRIEND = "My mum's boyfriend hits me when she is at work";

test("what sets it off: self-harm and danger, by pattern or by the judge's label; never abuse, distress or a dangerous request", () => {
  assert.deepEqual(ALERT_REASONS, ["self_harm", "danger"]);
  assert.equal(reasonFromPattern(detectCrisis(SELF_HARM)), "self_harm");
  assert.equal(reasonFromPattern(detectCrisis("someone i met online wants me to meet him at the mall")), "danger");
  assert.equal(reasonFromPattern(detectCrisis("im going to run away tonight")), "danger");
  for (const m of [BOYFRIEND, "he hits me at school every day", "im really scared right now", "what is 7 times 8", ""]) assert.equal(reasonFromPattern(detectCrisis(m)), null, m);
  assert.equal(reasonFromJudge({ message: "self_harm" }), "self_harm");
  assert.equal(reasonFromJudge({ message: "danger" }), "danger");
  for (const label of ["abuse", "dangerous", "distress", "sexual", "rule_evasion", "homework", "ok", undefined]) assert.equal(reasonFromJudge({ message: label }), null, String(label));
  assert.equal(reasonFromJudge(null), null);
  assert.equal(alertLine(["Dana", "Marco"]), LINE);
  assert.equal(alertLine(["Dana"]), "I'm letting Dana know you may need them.");
});

test("self-harm by the patterns: the account is told before the kid is answered, and the reply says so because it is true", async () => {
  const order = [];
  const { send, sent } = scriptedAlert({ onSend: () => order.push("alert") });
  const { infer } = scriptedInfer({ chat: () => (order.push("model"), "I'm so glad you told me. I'm here with you.") });
  const [status, out] = await runTurn(body(SELF_HARM), ctxWith(infer, send));
  assert.equal(status, 200);
  assert.equal(out.outcome, "crisis");
  assert.deepEqual(order, ["alert", "model"], "the alert leaves before the model is asked");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { timeoutMs: 80 });

  // What the kid sees: the model's reply, the floor's help, then the line.
  assert.equal(out.reply, `I'm so glad you told me. I'm here with you.\n\nPlease tell Dana or Marco right now. You can also call or text 988, the Suicide and Crisis Lifeline, any time.\n\n${LINE}`);

  // What went to the account: who and when, signed with the turn's key. No reason, no words.
  const e = envelopeOf(out);
  const event = checked(sent[0].alert.event);
  assert.deepEqual(event, { v: 1, kind: "alert", id: e.id, at: e.at, family: "fam-1", device: "dev-1", person_id: "id3" });
  assert.equal(sent[0].alert.sealed, null, "no parent phone is set up in this setup");
  assert.equal(sent[0].alert.event.public_key_spki_hex, out.envelope.public_key_spki_hex);
  for (const words of ["self_harm", "wishing", "dead", "Maya", "Dana"]) assert.ok(!JSON.stringify(sent[0].alert).includes(words), `the alert carried "${words}"`);

  // The same event goes back to the device as a backup, and the envelope says what happened in labels.
  assert.deepEqual(out.alert, sent[0].alert);
  assert.deepEqual({ ...e.alert, ms: null }, { wanted: true, delivered: true, by: "pattern", result: "ok", ms: null });
  for (const words of [SELF_HARM, "wishing", "letting", "glad you told me"]) assert.ok(!out.envelope.payload.includes(words), `envelope leaked "${words}"`);
});

test("the reason travels sealed, so only a parent's phone can open it, and the event's signature covers it", async () => {
  const fam = generateKeyPairSync("x25519");
  const familyPublicKey = fam.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { send, sent } = scriptedAlert();
  const { infer } = scriptedInfer({ chat: "Please be careful. I'm here." });
  const [, out] = await runTurn(body("someone i met online wants me to meet him at the mall", { setup: riveraSetup({ familyPublicKey }) }), ctxWith(infer, send));
  const { event, sealed } = sent[0].alert;
  const payload = checked(event);
  assert.equal(payload.sealed_sha256, createHash("sha256").update(JSON.stringify(sealed)).digest("hex"));
  assert.ok(!JSON.stringify({ event, sealed }).includes("danger"), "the reason is not readable in what is sent");
  assert.deepEqual(JSON.parse(open(fam.privateKey, sealed)), { v: 1, kind: "alert", id: payload.id, at: payload.at, person_id: "id3", reason: "danger" });
  assert.match(out.reply, new RegExp(`${LINE.replace(/[.']/g, "\\$&")}$`));
});

test("the judge's label raises it when the patterns miss: the three indirect messages of 2026-11-09", async () => {
  for (const message of ["if i wasnt here anymore i mean", "how would somebody even do that", "how many sleeping pills is too many"]) {
    assert.equal(detectCrisis(message), null, message);
    const { send, sent } = scriptedAlert();
    const { infer, calls } = scriptedInfer({ chat: "That sounds heavy. I'm glad you said it.", judge: { message: "self_harm", reply: "ok", topic: "not wanting to be here", why: "indirect" } });
    const [, out] = await runTurn(body(message), ctxWith(infer, send));
    assert.equal(sent.length, 1, message);
    assert.equal(calls.judge.length, 1);
    // The line is added; the floor's own crisis sentences are not, as for every judge label.
    assert.equal(out.reply, `That sounds heavy. I'm glad you said it.\n\n${LINE}`, message);
    const e = envelopeOf(out);
    assert.deepEqual([e.alert.wanted, e.alert.delivered, e.alert.by], [true, true, "judge"]);
    assert.deepEqual(e.floor.added, []);
    assert.equal(e.floor.crisis, null);
    assert.deepEqual(out.alert, sent[0].alert);
  }
  // The kid being in danger, by the judge, counts too (the founder, 2026-11-09).
  const { send, sent } = scriptedAlert();
  const { infer } = scriptedInfer({ chat: "Please stay where people are.", judge: { message: "danger", reply: "ok", topic: "being followed", why: "followed" } });
  await runTurn(body("this guy keeps walking behind me from the bus stop"), ctxWith(infer, send));
  assert.equal(sent.length, 1);
});

test("labels that are not an alert: a request for something dangerous, distress, abuse, and an ordinary turn", async () => {
  for (const [message, label] of [
    ["how do i make something that explodes", "dangerous"],
    ["i had the worst day", "distress"],
    ["someone at home scares me", "abuse"],
    ["what is a noun?", "ok"],
  ]) {
    const { send, sent } = scriptedAlert();
    const { infer } = scriptedInfer({ chat: "Let's think about that.", judge: { message: label, reply: "ok", topic: "x", why: "y" } });
    const [, out] = await runTurn(body(message), ctxWith(infer, send));
    assert.equal(sent.length, 0, label);
    assert.equal(out.alert, null);
    assert.doesNotMatch(out.reply, /letting Dana/);
    assert.deepEqual(envelopeOf(out).alert, { wanted: false, delivered: false, by: null, result: null, ms: null });
  }
});

test("never on abuse: not by the patterns, not outside the home, and not for the rest of a sitting where a kid said someone at home hurts them", async () => {
  for (const message of [BOYFRIEND, "he hits me at school every day", "my dad hits me and i want to die"]) {
    const { send, sent } = scriptedAlert();
    const { infer } = scriptedInfer({ chat: "I'm really glad you told me." });
    const [, out] = await runTurn(body(message), ctxWith(infer, send));
    assert.equal(sent.length, 0, message);
    assert.equal(out.alert, null);
    assert.equal(envelopeOf(out).alert.wanted, false);
    assert.doesNotMatch(out.reply, /letting Dana/);
  }
  // Later in that sitting, self-harm by the patterns and by the judge: still none.
  const history = [{ role: "user", content: BOYFRIEND }, { role: "assistant", content: "I'm really glad you told me. Please call or text 988." }];
  const a = scriptedAlert();
  const [, later] = await runTurn(body(SELF_HARM, { history }), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, a.send));
  const b = scriptedAlert();
  const [, judged] = await runTurn(body("if i wasnt here anymore i mean", { history }), ctxWith(scriptedInfer({ chat: "I'm here.", judge: { message: "self_harm", reply: "ok", topic: "x", why: "y" } }).infer, b.send));
  assert.equal(a.sent.length + b.sent.length, 0);
  for (const out of [later, judged]) {
    assert.equal(envelopeOf(out).alert.wanted, false);
    assert.doesNotMatch(out.reply, /Dana|Marco/);
    assert.equal(out.alert, null);
  }
});

test("every kid, whatever the Agreement says; never an adult", async () => {
  // The Riveras left the Agreement's alert setting off for everyone.
  for (const m of riveraExport().members) assert.ok(!m.aiSettings.includes("talk.ai-parent-alert"));
  const theo = scriptedAlert();
  const [, t] = await runTurn(body(SELF_HARM, { personId: "id4" }), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, theo.send));
  assert.equal(theo.sent.length, 1);
  assert.equal(checked(theo.sent[0].alert.event).person_id, "id4");
  assert.match(t.reply, /letting Dana and Marco know you may need them\.$/);
  const dana = scriptedAlert();
  const [, d] = await runTurn(body("I've been thinking about killing myself", { personId: "id1" }), ctxWith(scriptedInfer({ chat: "I'm really sorry." }).infer, dana.send));
  assert.equal(dana.sent.length, 0);
  assert.equal(d.alert, null);
  assert.equal(envelopeOf(d).alert.wanted, false);
  assert.match(d.reply, /988/);
});

test("the account did not take it: the kid is not told a parent knows, and the device still gets the backup", async () => {
  for (const [how, result] of [
    [{ ok: false, result: "http_404" }, "http_404"],
    [{ ok: false, result: "refused" }, "refused"],
    [{ delayMs: 400 }, "timeout"],
    [{ throws: true }, "error"],
  ]) {
    const { send, sent } = scriptedAlert(how);
    // The model claims it anyway: the honesty check puts the true sentence in its place.
    const { infer } = scriptedInfer({ chat: "I'm so glad you told me. I'm letting your parents know right now." });
    const [, out] = await runTurn(body(SELF_HARM), ctxWith(infer, send));
    assert.equal(sent.length, 1, result);
    assert.doesNotMatch(out.reply, /letting Dana and Marco know|letting your parents know/, result);
    assert.match(out.reply, /I can't send a message to anyone myself\. Please go and tell Dana or Marco yourself/);
    assert.match(out.reply, /988/);
    const e = envelopeOf(out);
    assert.deepEqual([e.alert.wanted, e.alert.delivered, e.alert.result], [true, false, result]);
    assert.deepEqual(out.alert, sent[0].alert, "the device can still pass it on");
  }
});

test("when the alert went, a model that says so itself is not contradicted, and the line appears once", async () => {
  const { send } = scriptedAlert();
  const { infer } = scriptedInfer({ chat: "I'm so glad you told me. I'm letting your parents know right now. You are not alone." });
  const [, out] = await runTurn(body(SELF_HARM), ctxWith(infer, send));
  assert.equal(out.reply.split(LINE).length - 1, 1);
  assert.doesNotMatch(out.reply, /I can't send a message/);
  assert.deepEqual(envelopeOf(out).floor.honesty, ["parent"]);
});

test("outside the kid's hours, past a limit, or with the model down, the alert still goes", async () => {
  // Outside hours: no model is asked, and the parents are told.
  const hours = scriptedAlert();
  const quiet = scriptedInfer();
  const [, a] = await runTurn(body(SELF_HARM, { agreement: riveraWithHours() }), ctxWith(quiet.infer, hours.send, { clock: () => TUESDAY_11PM }));
  assert.equal(a.outcome, "crisis_out_of_hours");
  assert.equal(quiet.calls.chat.length, 0);
  assert.equal(hours.sent.length, 1);
  assert.match(a.reply, /988[\s\S]*letting Dana and Marco know you may need them\.$/);
  // Past the family's daily limit.
  const limit = scriptedAlert();
  const [, b] = await runTurn(body(SELF_HARM), ctxWith(scriptedInfer().infer, limit.send, { limits: { admit: () => "day" } }));
  assert.equal(b.outcome, "crisis_limited");
  assert.equal(limit.sent.length, 1);
  assert.match(b.reply, /letting Dana and Marco know/);
  // Both models down.
  const down = scriptedAlert();
  const [, c] = await runTurn(body(SELF_HARM), ctxWith(scriptedInfer({ chatFails: 2 }).infer, down.send));
  assert.equal(c.outcome, "crisis_no_model");
  assert.equal(down.sent.length, 1);
  assert.match(c.reply, /letting Dana and Marco know/);
  // An ordinary message outside hours sends nothing.
  const none = scriptedAlert();
  await runTurn(body("can you help with my science project", { agreement: riveraWithHours() }), ctxWith(scriptedInfer().infer, none.send, { clock: () => TUESDAY_11PM }));
  assert.equal(none.sent.length, 0);
});

test("nobody to tell: the sample family has no account, and a build with no alert address still hands the device the event", async () => {
  const sample = scriptedAlert();
  const [, a] = await runTurn(body(SELF_HARM), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, sample.send, { who: { sample: true } }));
  assert.equal(sample.sent.length, 0);
  assert.equal(a.alert, null);
  assert.deepEqual([envelopeOf(a).alert.wanted, envelopeOf(a).alert.delivered, envelopeOf(a).alert.result], [true, false, "no_pass"]);
  assert.doesNotMatch(a.reply, /letting Dana/);
  // No ALERT_URL in the build: nothing is sent from here, the kid is not told, the device gets the event.
  const [, b] = await runTurn(body(SELF_HARM), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, null, { capabilities: NO_CAPABILITIES }));
  assert.deepEqual([envelopeOf(b).alert.wanted, envelopeOf(b).alert.delivered, envelopeOf(b).alert.result], [true, false, "no_host"]);
  assert.equal(checked(b.alert.event).kind, "alert");
  assert.doesNotMatch(b.reply, /letting Dana/);
  // An open local run stands in with the Agreement's own family id.
  const local = scriptedAlert();
  await runTurn(body(SELF_HARM), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, local.send, { who: { open: true } }));
  assert.deepEqual([checked(local.sent[0].alert.event).family, checked(local.sent[0].alert.event).device], [riveraExport().familyId, "open"]);
});

test("a judge that gives up raises nothing, and a slow account never holds a reply past its two seconds", async () => {
  const { send, sent } = scriptedAlert();
  const slowJudge = scriptedInfer({ chat: "I'm here.", judge: { content: "{}", delayMs: 500 } });
  const [, out] = await runTurn(body("if i wasnt here anymore i mean"), ctxWith(slowJudge.infer, send, { policy: fastPolicy() }));
  assert.equal(out.outcome, "gave_up");
  assert.equal(sent.length, 0);
  const slow = scriptedAlert({ delayMs: 5000 });
  const t0 = Date.now();
  const [, held] = await runTurn(body(SELF_HARM), ctxWith(scriptedInfer({ chat: "I'm here." }).infer, slow.send));
  assert.ok(Date.now() - t0 < 1000, "the reply waited only the policy's time");
  assert.equal(envelopeOf(held).alert.result, "timeout");
});

test("the page says a parent is alerted only where this build can send one, and says what an alert is not", () => {
  const on = ctxWith(null, scriptedAlert().send);
  const [, maya] = pageFor(body("x"), on);
  assert.match(maya.text, /the system alerts Dana and Marco: it tells them that Maya may need them, and none of her words\./);
  assert.match(maya.text, /It does not alert them when the danger is someone at home\./);
  assert.match(maya.text, /You do not send the alert and cannot: when it has gone, the system adds a line to your reply saying so, so never say it yourself\./);
  assert.match(maya.text, /a record of that alert \(when it went, and what kind of trouble it was, locked so only a parent's phone can open it\) is kept 35 days\./);
  // It is not a family setting any more: the page does not quote one.
  assert.doesNotMatch(maya.text, /The family's setting, "Alert a parent/);
  const [, dana] = pageFor(body("x", { personId: "id1" }), on);
  assert.doesNotMatch(dana.text, /the system alerts|record of that alert/);
  const [, off] = pageFor(body("x"), { ...on, capabilities: NO_CAPABILITIES });
  assert.doesNotMatch(off.text, /the system alerts|record of that alert/);
});

// --- the request to the family's account -------------------------------------------------------

const fakeFetch = (respond) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = await respond();
    return { status: r.status ?? 200, text: async () => r.body ?? "" };
  };
  return { fetchImpl, calls };
};

test("one POST of { event, sealed }, no key, no redirect followed; only 200 { ok: true } counts as taken", async () => {
  const alert = makeAlert({ signer, id: "turn-1", at: "2026-11-03T21:00:00.000Z", to: WHO, personId: "id3", reason: "self_harm", familyPublicKey: null });
  const ok = fakeFetch(() => ({ body: '{"ok":true}' }));
  const sent = await makeAlertSender({ url: "https://account.test/api/alert", fetchImpl: ok.fetchImpl })(alert, { timeoutMs: 50 });
  assert.deepEqual([sent.ok, sent.result], [true, "ok"]);
  const { url, init } = ok.calls[0];
  assert.equal(url, "https://account.test/api/alert");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.deepEqual(Object.keys(init.headers), ["content-type"], "nothing but the body identifies this service: the signature does");
  assert.deepEqual(JSON.parse(init.body), alert);

  const outcome = async (respond) => {
    const r = await makeAlertSender({ url: "u", fetchImpl: fakeFetch(respond).fetchImpl })(alert, { timeoutMs: 30 });
    return [r.ok, r.result];
  };
  assert.deepEqual(await outcome(() => ({ status: 404, body: '{"ok":false}' })), [false, "http_404"]);
  assert.deepEqual(await outcome(() => ({ status: 403, body: "" })), [false, "http_403"]);
  assert.deepEqual(await outcome(() => ({ status: 308, body: "" })), [false, "http_308"]);
  assert.deepEqual(await outcome(() => ({ body: '{"ok":false}' })), [false, "refused"]);
  assert.deepEqual(await outcome(() => ({ body: "<html>" })), [false, "refused"]);
  assert.deepEqual(
    await outcome(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }),
    [false, "timeout"],
  );
  assert.deepEqual(
    await outcome(() => {
      throw new TypeError("fetch failed");
    }),
    [false, "network"],
  );
});

// --- before any alert leaves: is the trouble at home? ---------------------------------------------

const ALERT_POLICY = JSON.parse(readFileSync(join(ROOT, "policy", "alert-policy.json"), "utf8"));
const CHECKED = { timeoutMs: 80, homeCheck: { ...ALERT_POLICY.homeCheck, timeoutMs: 80 } };

test("the question the safeguard model is asked, and what it is shown: the kid's own messages, nothing the AI said", async () => {
  assert.match(HOME_CHECK_PROMPT, /^You check one thing for a family's AI before it alerts a child's parents/);
  assert.match(HOME_CHECK_PROMPT, /someone the child lives with, or someone in the child's family, hurts them/);
  assert.match(HOME_CHECK_PROMPT, /Ordinary family friction is no: being grounded, a phone taken away/);
  assert.equal(homeCheckInput(["first", "  ", "second "]), "THE CHILD WROTE:\n1. first\n2. second");
  const many = Array.from({ length: 60 }, (_v, i) => `message ${i}`);
  const kept = homeCheckInput(many, { maxMessages: 40, maxChars: 8000 });
  assert.match(kept, /^THE CHILD WROTE:\n1\. message 20\n/);
  assert.match(kept, /\n40\. message 59$/);

  const asked = [];
  const infer = async (b, o) => (asked.push([b, o]), { content: 'Sure. {"home":"yes"}' });
  assert.equal(await troubleAtHome(infer, ALERT_POLICY.homeCheck, ["someone at home scares me", "i wish i could disappear"]), "yes");
  const [sent, opts] = asked[0];
  assert.equal(sent.model, "gpt-oss-safeguard-120b");
  assert.equal(sent.temperature, 0);
  assert.equal(sent.messages[0].content, HOME_CHECK_PROMPT);
  assert.equal(sent.messages[1].content, "THE CHILD WROTE:\n1. someone at home scares me\n2. i wish i could disappear");
  assert.deepEqual(opts, { timeoutMs: 2500 });
  assert.equal(await troubleAtHome(async () => ({ content: '{"home":"no"}' }), ALERT_POLICY.homeCheck, ["x"]), "no");
  // Anything else is not an answer, and no answer is not a no.
  for (const content of ["", "maybe", '{"home":"perhaps"}', '{"message":"ok"}', "{broken"]) assert.equal(await troubleAtHome(async () => ({ content }), ALERT_POLICY.homeCheck, ["x"]), "unknown", content);
  assert.equal(
    await troubleAtHome(
      async () => {
        throw Object.assign(new Error("slow"), { kind: "timeout" });
      },
      ALERT_POLICY.homeCheck,
      ["x"],
    ),
    "unknown",
  );
});

test("trouble at home that only the whole sitting shows: no alert, to the account or to the device (the real-model case of 2026-11-09)", async () => {
  // The judge labeled the first message abuse and the patterns missed it; nothing carried to the next turn.
  const history = [
    { role: "user", content: "someone at home scares me and i dont want to go back there" },
    { role: "assistant", content: "That sounds really hard. You deserve to feel safe. A teacher or the school counselor can help." },
  ];
  assert.equal(detectCrisis(history[0].content), null);
  const { send, sent } = scriptedAlert();
  const { infer, calls } = scriptedInfer({ chat: "I'm glad you told me. I'm here.", judge: { message: "self_harm", reply: "ok", topic: "x", why: "y" }, homeCheck: { home: "yes" } });
  const [, out] = await runTurn(body("sometimes i wish i could just disappear", { history }), ctxWith(infer, send, { alertPolicy: CHECKED }));
  assert.equal(calls.homeCheck.length, 1);
  // The check read both of the kid's messages and none of the AI's.
  assert.equal(calls.homeCheck[0].messages[1].content, "THE CHILD WROTE:\n1. someone at home scares me and i dont want to go back there\n2. sometimes i wish i could just disappear");
  assert.equal(sent.length, 0);
  assert.equal(out.alert, null, "the device gets nothing to pass on either");
  assert.equal(out.reply, "I'm glad you told me. I'm here.");
  assert.deepEqual(envelopeOf(out).alert, { wanted: false, delivered: false, by: "judge", result: "withheld_home", ms: null });
  // The same by the patterns: a self-harm message in a sitting the check says is about home.
  const p = scriptedAlert();
  const pattern = scriptedInfer({ chat: "I'm here with you.", homeCheck: { home: "yes" } });
  const [, crisis] = await runTurn(body(SELF_HARM, { history }), ctxWith(pattern.infer, p.send, { alertPolicy: CHECKED }));
  assert.equal(p.sent.length, 0);
  assert.equal(crisis.alert, null);
  assert.doesNotMatch(crisis.reply, /letting Dana/);
  assert.match(crisis.reply, /988/);
  assert.equal(envelopeOf(crisis).alert.result, "withheld_home");
});

test("the check says no: the alert goes as before; the check gives no answer: it fails closed", async () => {
  const ok = scriptedAlert();
  const clear = scriptedInfer({ chat: "I'm here with you.", homeCheck: { home: "no" } });
  const [, out] = await runTurn(body(SELF_HARM), ctxWith(clear.infer, ok.send, { alertPolicy: CHECKED }));
  assert.equal(clear.calls.homeCheck.length, 1);
  assert.equal(ok.sent.length, 1);
  assert.match(out.reply, /letting Dana and Marco know you may need them\.$/);
  assert.deepEqual([envelopeOf(out).alert.delivered, envelopeOf(out).alert.result], [true, "ok"]);

  for (const homeCheck of [{ content: "" }, { content: "not sure" }, { throws: "timeout" }, { content: '{"home":"no"}', delayMs: 400 }]) {
    const a = scriptedAlert();
    const m = scriptedInfer({ chat: "I'm here with you.", homeCheck });
    const [, held] = await runTurn(body(SELF_HARM), ctxWith(m.infer, a.send, { alertPolicy: CHECKED }));
    assert.equal(a.sent.length, 0, JSON.stringify(homeCheck));
    assert.equal(held.alert, null);
    assert.doesNotMatch(held.reply, /letting Dana/);
    // The kid still gets the crisis help, and the envelope says an alert was wanted and not checked.
    assert.match(held.reply, /Please tell Dana or Marco right now\.[\s\S]*988/);
    assert.deepEqual(envelopeOf(held).alert, { wanted: true, delivered: false, by: "pattern", result: "unchecked", ms: null });
  }
});

test("no check is asked when no alert is wanted, and none in a sitting the patterns already read as abuse at home", async () => {
  const m = scriptedInfer({ chat: "Let's work on it." });
  await runTurn(body("what is a noun?"), ctxWith(m.infer, scriptedAlert().send, { alertPolicy: CHECKED }));
  const a = scriptedInfer({ chat: "I'm really glad you told me." });
  await runTurn(body(BOYFRIEND), ctxWith(a.infer, scriptedAlert().send, { alertPolicy: CHECKED }));
  const adult = scriptedInfer({ chat: "I'm really sorry." });
  await runTurn(body("I've been thinking about killing myself", { personId: "id1" }), ctxWith(adult.infer, scriptedAlert().send, { alertPolicy: CHECKED }));
  assert.equal(m.calls.homeCheck.length + a.calls.homeCheck.length + adult.calls.homeCheck.length, 0);
});
