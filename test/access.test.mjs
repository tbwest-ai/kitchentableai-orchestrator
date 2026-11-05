// SPDX-License-Identifier: AGPL-3.0-only
// The lock (lib/access.mjs): a pass admits one person under one exact Agreement and setup, the
// limits hold per family and per device, and a crisis past a limit still gets its help.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { agreementHash, canonicalJson, checkPass, isSampleAgreement, makeLimits, parseAccessKeys } from "../lib/access.mjs";
import { runTurn } from "../lib/turn.mjs";
import { NO_CAPABILITIES } from "../lib/compile.mjs";
import { mintPass } from "../scripts/mint-pass.mjs";
import { POLICY, riveraExport, riveraSetup, scriptedInfer, testSigner, TUESDAY_4PM } from "./helpers.mjs";

const appKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const otherKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const keys = parseAccessKeys(appKey.x);
const NOW = new Date("2026-11-05T20:00:00Z");
const a = () => riveraExport();
const s = () => riveraSetup();
const mint = (over = {}) => mintPass({ privateJwk: appKey, family: "fam-1", device: "dev-1", personId: "id3", agreement: a(), setup: s(), now: NOW, ...over });
const check = (pass, over = {}) => checkPass(pass, { keys, now: NOW, personId: "id3", agreement: a(), setup: s(), maxLifetimeSeconds: 43200, ...over });

test("canonical JSON sorts keys at every depth and drops undefined members", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(agreementHash({ x: 1, y: 2 }, null), agreementHash({ y: 2, x: 1 }, undefined));
});

test("a pass the app signed admits its person under its Agreement", () => {
  const r = check(mint());
  assert.deepEqual(r, { ok: true, family: "fam-1", device: "dev-1", person: "id3", exp: Math.floor(NOW.getTime() / 1000) + 3600 });
});

test("a pass is refused for the wrong key, person, Agreement, setup, time or shape", () => {
  assert.equal(check(undefined).code, "no_pass");
  assert.equal(check("nonsense").code, "bad_pass");
  assert.equal(check(mint({ privateJwk: otherKey })).code, "bad_signature");
  assert.equal(check(mint(), { personId: "id1" }).code, "wrong_person", "a kid's pass cannot run a parent's page");
  const loosened = a();
  loosened.customRules = [];
  assert.equal(check(mint(), { agreement: loosened }).code, "agreement_changed", "a device cannot edit its own rules");
  assert.equal(check(mint(), { setup: riveraSetup({ timeZone: "Pacific/Honolulu" }) }).code, "agreement_changed");
  assert.equal(check(mint({ now: new Date(NOW.getTime() - 2 * 3600_000) })).code, "expired");
  assert.equal(check(mint({ now: new Date(NOW.getTime() + 10 * 60_000) })).code, "not_yet");
  assert.equal(check(mint({ lifetimeSeconds: 48 * 3600 })).code, "too_long");
  // A signature moved onto another payload does not verify.
  const [, sig] = mint().split(".");
  const [body] = mint({ personId: "id1" }).split(".");
  assert.equal(check(`${body}.${sig}`, { personId: "id1" }).code, "bad_signature");
});

test("two keys at once, for a rotation", () => {
  const both = parseAccessKeys(`${appKey.x}, ${otherKey.x}`);
  assert.equal(check(mint({ privateJwk: otherKey }), { keys: both }).ok, true);
  assert.throws(() => parseAccessKeys("not-a-key"), /32-byte base64url/);
});

test("the sample family is recognized by its exact Agreement only", () => {
  assert.equal(isSampleAgreement(a()), true);
  const edited = a();
  edited.familyName = "The Rivera Family, edited";
  assert.equal(isSampleAgreement(edited), false);
  assert.equal(isSampleAgreement(undefined), false);
});

test("limits: per family per day by the family's date, per device per minute, the sample apart", () => {
  let t = 0;
  const limits = makeLimits({ familyTurnsPerDay: 3, deviceTurnsPerMinute: 2, sampleTurnsPerDay: 1 }, () => t);
  const kidTablet = { family: "f", device: "tablet" };
  const kidLaptop = { family: "f", device: "laptop" };
  assert.equal(limits.admit(kidTablet, "Thu"), null);
  assert.equal(limits.admit(kidTablet, "Thu"), null);
  assert.equal(limits.admit(kidTablet, "Thu"), "burst");
  t = 61_000;
  assert.equal(limits.admit(kidLaptop, "Thu"), null);
  assert.equal(limits.admit(kidLaptop, "Thu"), "day", "three turns used across the family's devices");
  assert.equal(limits.admit({ family: "g", device: "x" }, "Fri"), null, "another family's date resets nobody");
  assert.equal(limits.admit(kidLaptop, "Thu"), "day");
  assert.equal(limits.admit(kidLaptop, "Fri"), null, "the family's own next day starts fresh");
  assert.equal(limits.admit({ sample: true }, "Thu"), null);
  assert.equal(limits.admit({ sample: true }, "Thu"), "day");
  assert.equal(limits.admit({ open: true }, "Thu"), null);
});

const { signer, publicKey } = testSigner();
const ctxWith = (infer, over = {}) => ({ infer, signer, policy: POLICY, capabilities: NO_CAPABILITIES, clock: () => TUESDAY_4PM, cacheKey: "k", ...over });
const envelopeOf = (out) => {
  assert.equal(verify(null, Buffer.from(out.envelope.payload, "utf8"), publicKey, Buffer.from(out.envelope.signature_b64, "base64")), true);
  return JSON.parse(out.envelope.payload);
};

test("past the family's daily limit: no model, plain words, and the envelope says which limit", async () => {
  const limits = makeLimits({ familyTurnsPerDay: 0, deviceTurnsPerMinute: 20, sampleTurnsPerDay: 0 });
  const { infer, calls } = scriptedInfer();
  const [status, out] = await runTurn({ agreement: a(), setup: s(), personId: "id3", message: "What is 7 times 8?" }, ctxWith(infer, { limits, who: { family: "f", device: "d" } }));
  assert.equal(status, 200);
  assert.equal(out.outcome, "daily_limit");
  assert.equal(out.reply, "That's all the AI for today. It starts again tomorrow. If you need help before then, ask Dana or Marco.");
  assert.equal(calls.chat.length, 0);
  const e = envelopeOf(out);
  assert.equal(e.floor.limited, "day");
  assert.deepEqual(e.access, { family: "f", device: "d" });
});

test("a crisis past a limit still gets the crisis reply, 988 included", async () => {
  const limits = makeLimits({ familyTurnsPerDay: 0, deviceTurnsPerMinute: 20, sampleTurnsPerDay: 0 });
  const { infer, calls } = scriptedInfer();
  const [, out] = await runTurn({ agreement: a(), setup: s(), personId: "id3", message: "I want to die" }, ctxWith(infer, { limits, who: { family: "f", device: "d" } }));
  assert.equal(out.outcome, "crisis_limited");
  assert.match(out.reply, /988/);
  assert.match(out.reply, /Dana|Marco/);
  assert.equal(calls.chat.length, 0);
});

test("a turn under the limits runs as before and names the sample when the lock admitted it", async () => {
  const limits = makeLimits({ familyTurnsPerDay: 5, deviceTurnsPerMinute: 5, sampleTurnsPerDay: 5 });
  const { infer } = scriptedInfer();
  const [, out] = await runTurn({ agreement: a(), setup: s(), personId: "id3", message: "What is 7 times 8?" }, ctxWith(infer, { limits, who: { sample: true } }));
  assert.equal(out.outcome, "cleared");
  const e = envelopeOf(out);
  assert.equal(e.floor.limited, null);
  assert.deepEqual(e.access, { sample: true });
});
