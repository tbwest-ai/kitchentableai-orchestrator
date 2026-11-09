// SPDX-License-Identifier: AGPL-3.0-only
// v0.3.0: the compiled page on request ("See what the AI is told"), the negated deletion the
// honesty check used to replace, and the gentler give-up on secrets and distress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFor, runTurn } from "../lib/turn.mjs";
import { NO_CAPABILITIES } from "../lib/compile.mjs";
import { GIVE_UP_REPLY } from "../lib/judge.mjs";
import { checkHonesty } from "../lib/honesty.mjs";
import { resolve } from "../lib/agreement.mjs";
import { POLICY, fastPolicy, riveraExport, riveraReading, riveraSetup, scriptedInfer, testSigner, TUESDAY_4PM } from "./helpers.mjs";

const { signer } = testSigner();
const ctxWith = (infer, over = {}) => ({ infer, signer, policy: POLICY, capabilities: NO_CAPABILITIES, clock: () => TUESDAY_4PM, cacheKey: "k", ...over });
const body = (message, over = {}) => ({ agreement: riveraExport(), setup: riveraSetup(), personId: "id3", message, ...over });

test("/page returns the page a turn runs under, with the hash the envelope reports", async () => {
  const { infer, calls } = scriptedInfer();
  const [status, page] = pageFor(body(undefined), ctxWith(infer));
  assert.equal(status, 200);
  assert.equal(page.version, "v2");
  assert.match(page.text, /^You are the Rivera family's own AI\./);
  assert.match(page.text, /Today is Tuesday, November 3, 2026\./);
  assert.equal(calls.chat.length + calls.judge.length, 0, "no model call");
  const [, turn] = await runTurn(body("What is a noun?"), ctxWith(infer));
  assert.equal(JSON.parse(turn.envelope.payload).page.sha256, page.sha256);
  assert.equal(calls.chat[0].messages[0].content, page.text);
});

test("/page fails closed like a turn", () => {
  const { infer } = scriptedInfer();
  const [status, out] = pageFor({ agreement: riveraExport(), setup: undefined, personId: "id3" }, ctxWith(infer));
  assert.equal(status, 422);
  assert.equal(out.failed_closed, true);
});

test("honesty: a chat that is not gone at once is left alone; one claimed gone at once is not", () => {
  // Maya with "Parents can read" on: the one case where "it's gone right away" is false.
  const v = resolve(riveraExport(), riveraReading(), "id3");
  for (const ok of ["It isn't gone straight away.", "Nothing is deleted right away.", "It won't be deleted immediately."]) {
    assert.deepEqual(checkHonesty(ok, v).corrections, [], ok);
  }
  for (const bad of ["It's deleted right away.", "Everything is gone as soon as you close the app."]) {
    assert.deepEqual(checkHonesty(bad, v).corrections, ["storage"], bad);
  }
});

test("a give-up on a secret is gentler, and on distress still names the parents", async () => {
  const slow = () => scriptedInfer({ judge: { content: "{}", delayMs: 500 } });
  const run = async (message) => (await runTurn(body(message), ctxWith(slow().infer, { policy: fastPolicy() })))[1];
  const secret = await run("I don't want anyone to know about this. Is that okay?");
  assert.equal(secret.outcome, "gave_up");
  assert.equal(secret.reply, "I'm still here, and I want to answer this carefully. Please send it again in a moment.");
  const scared = await run("im really scared right now");
  assert.equal(scared.outcome, "gave_up");
  assert.match(scared.reply, /^I'm still here\. Please tell Dana or Marco how you're feeling/);
  const plain = await run("What is a noun?");
  assert.equal(plain.reply, GIVE_UP_REPLY);
});
