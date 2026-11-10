// SPDX-License-Identifier: AGPL-3.0-only
// The orchestrator as a child process with an alert address in its environment, against the mock
// inference API and a mock family account: /health names the host, a kid's crisis turn posts one
// signed, word-free event the account can check against /pubkey, and the reply says a parent is
// being told only when the account took it. No network beyond 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";
import { ROOT, riveraExport, riveraSetup } from "./helpers.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitFor(url, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const startNode = (file, env) => spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: "ignore" });
const kp = generateKeyPairSync("ed25519");
const children = [];
let inferencePort, accountPort, missingPort, port, portMissing;

before(async () => {
  [inferencePort, accountPort, missingPort, port, portMissing] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  children.push(startNode(join(ROOT, "test", "mock-inference.mjs"), { PORT: String(inferencePort) }));
  children.push(startNode(join(ROOT, "test", "mock-alert.mjs"), { PORT: String(accountPort) }));
  children.push(startNode(join(ROOT, "test", "mock-alert.mjs"), { PORT: String(missingPort), MOCK_ALERT_MODE: "missing" }));
  const common = {
    INFERENCE_URL: `http://127.0.0.1:${inferencePort}/v1/chat/completions`,
    TINFOIL_API_KEY: "test-key-not-real",
    SIGNING_KEY_PEM: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
    TEST_CLOCK: "2026-11-03T21:00:00Z",
    // An open local run: the sample family has no account to tell, so the lock is left open here.
    ACCESS: "open",
  };
  children.push(startNode(join(ROOT, "server.mjs"), { ...common, PORT: String(port), ALERT_URL: `http://127.0.0.1:${accountPort}/api/alert` }));
  children.push(startNode(join(ROOT, "server.mjs"), { ...common, PORT: String(portMissing), ALERT_URL: `http://127.0.0.1:${missingPort}/api/alert` }));
  await Promise.all([port, portMissing, accountPort, missingPort].map((p) => waitFor(`http://127.0.0.1:${p}/health`)));
});

after(() => {
  for (const c of children) c.kill();
});

const post = async (p, path, body) => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return [r.status, await r.json()];
};
const turn = (personId, message) => ({ agreement: riveraExport(), setup: riveraSetup(), personId, message });
const LINE = "I'm letting Dana and Marco know you may need them.";

test("/health names the alert host, and the kid's page says a parent is alerted", async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.alert_host, `127.0.0.1:${accountPort}`);
  const [, page] = await post(port, "/page", { agreement: riveraExport(), setup: riveraSetup(), personId: "id3" });
  assert.match(page.text, /the system alerts Dana and Marco/);
});

test("a kid's crisis turn posts one signed event with no words, and the reply says so", async () => {
  const [status, out] = await post(port, "/turn", turn("id3", "i keep wishing i was dead"));
  assert.equal(status, 200);
  assert.equal(out.outcome, "crisis");
  assert.ok(out.reply.endsWith(LINE));
  assert.match(out.reply, /988/);

  const all = await (await fetch(`http://127.0.0.1:${accountPort}/all`)).json();
  assert.equal(all.length, 1);
  assert.equal(all[0].authorization_present, false, "the inference key never goes to the account");
  const { event, sealed } = all[0].body;
  assert.equal(sealed, null);
  // The account checks the event as it checks a turn's envelope: against the key /pubkey publishes.
  const [, pub] = await post(port, "/pubkey", {});
  assert.equal(event.public_key_spki_hex, pub.public_key_spki_hex);
  const key = createPublicKey({ key: Buffer.from(pub.public_key_spki_hex, "hex"), format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(event.payload, "utf8"), key, Buffer.from(event.signature_b64, "base64")), true);
  const payload = JSON.parse(event.payload);
  const envelope = JSON.parse(out.envelope.payload);
  assert.deepEqual(payload, { v: 1, kind: "alert", id: envelope.id, at: envelope.at, family: riveraExport().familyId, device: "open", person_id: "id3" });
  for (const words of ["wishing", "dead", "self_harm", "Maya"]) assert.ok(!JSON.stringify(all[0].body).includes(words), `the alert carried "${words}"`);
  // The backup for the device is the same event, and the envelope says it was taken.
  assert.deepEqual(out.alert, { event, sealed });
  assert.deepEqual([envelope.alert.wanted, envelope.alert.delivered, envelope.alert.by, envelope.alert.result], [true, true, "pattern", "ok"]);
});

test("abuse at home, an ordinary message and an adult's crisis post nothing", async () => {
  await post(port, "/turn", turn("id3", "My mum's boyfriend hits me when she is at work"));
  await post(port, "/turn", turn("id3", "what is a noun?"));
  const [, adult] = await post(port, "/turn", turn("id1", "I've been thinking about killing myself"));
  assert.match(adult.reply, /988/);
  assert.equal(adult.alert, null);
  const all = await (await fetch(`http://127.0.0.1:${accountPort}/all`)).json();
  assert.equal(all.length, 1, "still only the one from the test before");
});

test("an account that does not know the family: the kid is not told a parent knows, and the device gets the backup", async () => {
  const [, out] = await post(portMissing, "/turn", turn("id4", "i keep wishing i was dead"));
  assert.doesNotMatch(out.reply, /letting Dana/);
  assert.match(out.reply, /Please tell Dana or Marco right now\./);
  const envelope = JSON.parse(out.envelope.payload);
  assert.deepEqual([envelope.alert.wanted, envelope.alert.delivered, envelope.alert.result], [true, false, "http_404"]);
  assert.equal(JSON.parse(out.alert.event.payload).person_id, "id4");
});
