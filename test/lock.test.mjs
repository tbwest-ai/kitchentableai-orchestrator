// SPDX-License-Identifier: AGPL-3.0-only
// The lock end to end: the server started with an access key admits a family's device by its pass
// and nobody else, keeps the sample family open, and says which mode it runs in.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { mintPass } from "../scripts/mint-pass.mjs";
import { ROOT, riveraExport, riveraSetup } from "./helpers.mjs";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

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

const start = (file, env) => spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: "ignore" });

const appKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
// A real family's Agreement: anything but the exact sample.
const family = () => ({ ...riveraExport(), familyId: "11111111-2222-4333-8444-555555555555", familyName: "The Okafor Family" });
const setup = riveraSetup();
const pass = (personId, over = {}) => mintPass({ privateJwk: appKey, family: "fam-okafor", device: "kitchen-tablet", personId, agreement: family(), setup, ...over });

let mock, locked, closed, lockedPort, closedPort;

before(async () => {
  const mockPort = await freePort();
  lockedPort = await freePort();
  closedPort = await freePort();
  mock = start(join(ROOT, "test", "mock-inference.mjs"), { PORT: String(mockPort) });
  const common = { INFERENCE_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`, TINFOIL_API_KEY: "test-key-not-real", ALLOW_EPHEMERAL_KEY: "1" };
  locked = start(join(ROOT, "server.mjs"), { ...common, PORT: String(lockedPort), ACCESS_PUBLIC_KEYS: appKey.x });
  closed = start(join(ROOT, "server.mjs"), { ...common, PORT: String(closedPort) });
  await Promise.all([waitFor(`http://127.0.0.1:${mockPort}/last`).catch(() => {}), waitFor(`http://127.0.0.1:${lockedPort}/health`), waitFor(`http://127.0.0.1:${closedPort}/health`)]);
});

after(() => {
  for (const c of [mock, locked, closed]) c?.kill();
});

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);

test("/health says the lock runs on passes, with one key", async () => {
  const h = await (await fetch(`http://127.0.0.1:${lockedPort}/health`)).json();
  assert.equal(h.access, "passes");
  assert.equal(h.access_keys, 1);
  const c = await (await fetch(`http://127.0.0.1:${closedPort}/health`)).json();
  assert.equal(c.access, "sample-only");
});

test("a family's device with its pass gets a turn and its page; without one, nothing", async () => {
  const turn = { agreement: family(), setup, personId: "id3", message: "What is 7 times 8?" };
  const [noPass, refused] = await post(lockedPort, "/turn", turn);
  assert.equal(noPass, 401);
  assert.equal(refused.code, "no_pass");
  assert.equal(refused.failed_closed, true);
  assert.match(refused.error, /not linked to a family/);

  const [ok, out] = await post(lockedPort, "/turn", { ...turn, pass: pass("id3") });
  assert.equal(ok, 200);
  assert.equal(out.outcome, "cleared");
  assert.deepEqual(JSON.parse(out.envelope.payload).access, { family: "fam-okafor", device: "kitchen-tablet" });

  const [pageOk, page] = await post(lockedPort, "/page", { agreement: family(), setup, personId: "id3", pass: pass("id3") });
  assert.equal(pageOk, 200);
  assert.match(page.text, /Okafor/);
  const [pageNo] = await post(lockedPort, "/page", { agreement: family(), setup, personId: "id3" });
  assert.equal(pageNo, 401);
});

test("a kid's pass cannot open a parent's page, and an edited Agreement is refused", async () => {
  const [s1, b1] = await post(lockedPort, "/turn", { agreement: family(), setup, personId: "id1", message: "hi", pass: pass("id3") });
  assert.equal(s1, 401);
  assert.equal(b1.code, "wrong_person");
  const loosened = family();
  loosened.customRules = [];
  const [s2, b2] = await post(lockedPort, "/turn", { agreement: loosened, setup, personId: "id3", message: "hi", pass: pass("id3") });
  assert.equal(s2, 401);
  assert.equal(b2.code, "agreement_changed");
});

test("the sample family needs no pass, on either server", async () => {
  for (const port of [lockedPort, closedPort]) {
    const [status, out] = await post(port, "/turn", { agreement: riveraExport(), setup, personId: "id3", message: "What is 7 times 8?" });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(out.envelope.payload).access, { sample: true });
  }
});

test("with no access key configured, a real family is refused as locked", async () => {
  const [status, out] = await post(closedPort, "/turn", { agreement: family(), setup, personId: "id3", message: "hi", pass: pass("id3") });
  assert.equal(status, 401);
  assert.equal(out.code, "locked");
});
