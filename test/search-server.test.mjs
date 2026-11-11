// SPDX-License-Identifier: AGPL-3.0-only
// The orchestrator as a child process with a search host named in its environment, against the
// mock inference API and the mock search service: /health reports the host, a sample-family turn
// searches and comes back with sources, and the search service is sent no name. Once over plain
// JSON and once over an event stream. No network beyond 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";
import { ROOT, riveraExport, riveraSetup, samplePhoto } from "./helpers.mjs";

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
const signingPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
const children = [];
let inferencePort, searchPort, ssePort, port, portSse;

before(async () => {
  [inferencePort, searchPort, ssePort, port, portSse] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  children.push(startNode(join(ROOT, "test", "mock-inference.mjs"), { PORT: String(inferencePort) }));
  children.push(startNode(join(ROOT, "test", "mock-search.mjs"), { PORT: String(searchPort) }));
  children.push(startNode(join(ROOT, "test", "mock-search.mjs"), { PORT: String(ssePort), MOCK_SEARCH_SSE: "1" }));
  const common = {
    INFERENCE_URL: `http://127.0.0.1:${inferencePort}/v1/chat/completions`,
    TINFOIL_API_KEY: "test-key-not-real",
    SIGNING_KEY_PEM: signingPem,
    // 4:00pm on a Tuesday in New York, inside everyone's hours.
    TEST_CLOCK: "2026-11-03T21:00:00Z",
  };
  children.push(startNode(join(ROOT, "server.mjs"), { ...common, PORT: String(port), SEARCH_URL: `http://127.0.0.1:${searchPort}/mcp` }));
  children.push(startNode(join(ROOT, "server.mjs"), { ...common, PORT: String(portSse), SEARCH_URL: `http://127.0.0.1:${ssePort}/mcp` }));
  await Promise.all([waitFor(`http://127.0.0.1:${port}/health`), waitFor(`http://127.0.0.1:${portSse}/health`), waitFor(`http://127.0.0.1:${searchPort}/health`), waitFor(`http://127.0.0.1:${ssePort}/health`)]);
});

after(() => {
  for (const c of children) c.kill();
});

const post = async (p, path, body) => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return [r.status, await r.json()];
};
const turn = (personId, message) => ({ agreement: riveraExport(), setup: riveraSetup(), personId, message });

test("/health names the search host and the family's daily limit", async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.version, "0.7.0");
  // What this version can take with a turn (since v0.7.0); the family app shows a feature only when this says so.
  assert.deepEqual(h.can, { photos: true, documents: true });
  assert.equal(h.vision_model, "gemma4-31b");
  assert.equal(h.photos_per_family_per_day, 60);
  assert.equal(h.search_host, `127.0.0.1:${searchPort}`);
  assert.equal(h.searches_per_family_per_day, 30);
  assert.ok(!JSON.stringify(h).includes("test-key-not-real"));
});

test("a turn with a photo goes through whole: a body past 256 KB is taken, the photo is described, and one past 3 MB is refused", async () => {
  const photo = samplePhoto(600_000);
  const [status, out] = await post(port, "/turn", { ...turn("id4", "what is this"), photo });
  assert.equal(status, 200);
  assert.deepEqual(out.photo, { described: true });
  assert.ok(out.user_content.startsWith("what is this\n\n[Photo: Mock reply: "), out.user_content);
  assert.ok(!JSON.stringify(out).includes(photo.data_b64.slice(0, 60)));
  const r = await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...turn("id4", "x"), photo: { type: "image/jpeg", data_b64: "A".repeat(4_300_000) } }) }).catch((err) => ({ status: err?.cause?.code ?? "closed" }));
  assert.ok(r.status === 413 || r.status === "ECONNRESET" || r.status === "EPIPE" || r.status === "closed", String(r.status));
});

for (const [label, serverPort, mockPort] of [
  ["plain JSON", () => port, () => searchPort],
  ["an event stream", () => portSse, () => ssePort],
]) {
  test(`a sample-family turn searches and comes back with sources, and no name reaches the search service (${label})`, async () => {
    const [status, out] = await post(serverPort(), "/turn", turn("id4", "look up the latest Otters score for Theo Rivera"));
    assert.equal(status, 200);
    assert.equal(out.outcome, "cleared");
    assert.equal(out.reply, "Mock answer from the search results [1].\n\nSources:\n1. Mock result one (mock-one.example) https://www.mock-one.example/story");
    assert.deepEqual(out.sources, [{ n: 1, title: "Mock result one", site: "mock-one.example", url: "https://www.mock-one.example/story" }]);

    const sent = await (await fetch(`http://127.0.0.1:${mockPort()}/last`)).json();
    assert.equal(sent.authorization_present, true);
    assert.equal(sent.method, "tools/call");
    assert.equal(sent.tool, "search");
    assert.equal(sent.pii_check, "true");
    assert.equal(sent.injection_check, "true");
    assert.equal(sent.arguments.query, "look up the latest Otters score");
    assert.deepEqual([sent.arguments.max_results, sent.arguments.content_mode, sent.arguments.max_content_chars], [5, "highlights", 700]);

    assert.equal(verify(null, Buffer.from(out.envelope.payload, "utf8"), kp.publicKey, Buffer.from(out.envelope.signature_b64, "base64")), true);
    const e = JSON.parse(out.envelope.payload);
    assert.deepEqual([e.search.offered, e.search.asked, e.search.ran, e.search.results, e.search.cited, e.search.removed, e.search.outcome], [true, 1, 1, 2, 1, ["name"], "ok"]);
    assert.deepEqual(e.search.filter, { checked: true, masked: false });
    assert.deepEqual(e.access, { sample: true });
    for (const words of ["Otters", "score", "Mock", "mock-one", "Theo", "Rivera"]) assert.ok(!out.envelope.payload.includes(words), `envelope leaked "${words}"`);
  });
}

test("the 9-year-old's turn offers no tool and her page says search is off", async () => {
  const [status, out] = await post(port, "/turn", turn("id3", "look up the latest Otters score"));
  assert.equal(status, 200);
  assert.match(out.reply, /^Mock reply/);
  assert.deepEqual(out.sources, []);
  assert.equal(JSON.parse(out.envelope.payload).search, null);
  const model = await (await fetch(`http://127.0.0.1:${inferencePort}/last`)).json();
  assert.equal(model.body.tools, undefined);
  const [, page] = await post(port, "/page", { agreement: riveraExport(), setup: riveraSetup(), personId: "id3" });
  assert.match(page.text, /Web search is off for Maya/);
  const [, theo] = await post(port, "/page", { agreement: riveraExport(), setup: riveraSetup(), personId: "id4" });
  assert.match(theo.text, /Web search is on for Theo\./);
});
