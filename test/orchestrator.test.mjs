// SPDX-License-Identifier: AGPL-3.0-only
// Runs the orchestrator as a child process against the mock inference API and checks the
// contract the browser page relies on: /health, /pubkey, /turn, and that a reply's signature
// verifies with the published key over the exact payload bytes. Also checks the three key
// sources. No network beyond 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function startNode(file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, output: () => out };
}

const kp = generateKeyPairSync("ed25519");
const signingPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
const expectedPubHex = kp.publicKey.export({ type: "spki", format: "der" }).toString("hex");

let mockPort, port, mock, orch;

before(async () => {
  mockPort = await freePort();
  port = await freePort();
  mock = startNode(join(root, "test", "mock-inference.mjs"), { PORT: String(mockPort) });
  orch = startNode(join(root, "server.mjs"), {
    PORT: String(port),
    INFERENCE_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
    TINFOIL_API_KEY: "test-key-not-real",
    SIGNING_KEY_PEM: signingPem,
    CONNECTIVITY_TURN: "on",
  });
  await waitFor(`http://127.0.0.1:${port}/health`);
});

after(() => {
  mock?.child.kill();
  orch?.child.kill();
});

test("/health reports the key source and never a secret", async () => {
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.key_source, "managed-secret");
  assert.equal(body.api_key_present, true);
  assert.equal(body.models["8–11"], "glm-5-3");
  assert.equal(body.judge, "gpt-oss-safeguard-120b");
  assert.equal(body.connectivity_turn, true);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("test-key-not-real"));
  assert.ok(!text.includes("PRIVATE KEY"));
});

test("/pubkey publishes the Ed25519 key that SIGNING_KEY_PEM holds", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/pubkey`, { method: "POST", body: "{}" });
  const body = await r.json();
  assert.equal(body.alg, "Ed25519");
  assert.equal(body.public_key_spki_hex, expectedPubHex);
  assert.match(body.public_key_pem, /BEGIN PUBLIC KEY/);
});

test("/turn calls inference with the bearer token and low reasoning, and signs the reply", async () => {
  const prompt = "Say hello to a family.";
  const r = await fetch(`http://127.0.0.1:${port}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.match(body.reply, /^Mock reply/);
  assert.equal(body.signed.alg, "Ed25519");
  assert.equal(body.signed.key_source, "managed-secret");
  assert.equal(body.signed.public_key_spki_hex, expectedPubHex);

  // Verify over the exact payload bytes, then parse.
  const ok = verify(
    null,
    Buffer.from(body.signed.payload, "utf8"),
    kp.publicKey,
    Buffer.from(body.signed.signature_b64, "base64"),
  );
  assert.equal(ok, true, "signature must verify with the published public key");
  const payload = JSON.parse(body.signed.payload);
  assert.equal(payload.reply, body.reply);
  assert.equal(payload.prompt_sha256, createHash("sha256").update(prompt).digest("hex"));
  assert.equal(payload.key_source, "managed-secret");

  // A tampered payload must not verify.
  const tampered = Buffer.from(body.signed.payload.replace("Mock reply", "Fake reply"), "utf8");
  assert.equal(verify(null, tampered, kp.publicKey, Buffer.from(body.signed.signature_b64, "base64")), false);

  // What the mock received.
  const last = await (await fetch(`http://127.0.0.1:${mockPort}/last`)).json();
  assert.equal(last.authorization_present, true);
  assert.equal(last.body.model, "glm-5-3");
  assert.equal(last.body.reasoning_effort, "low");
  assert.equal(last.body.stream, false);
  assert.equal(last.body.messages.at(-1).content, prompt);
});

test("/turn fails closed with no Agreement, and rejects an empty or over-long check prompt", async () => {
  const empty = await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: "{}" });
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).failed_closed, true);
  const blank = await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "  " }) });
  assert.equal(blank.status, 400);
  const long = await fetch(`http://127.0.0.1:${port}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x".repeat(2001) }),
  });
  assert.equal(long.status, 413);
});

test("/turn with an Agreement: compiled, judged, held, signed with the published key", async () => {
  const agreement = JSON.parse(readFileSync(join(root, "agreement", "sample-export.json"), "utf8"));
  const setup = { format: "kitchentableai-setup", version: 1, timeZone: "America/New_York", people: { id3: { pronouns: "she", age: 9 } } };
  const message = "Can you help me plan my book report about the moon?";
  const r = await fetch(`http://127.0.0.1:${port}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agreement, setup, personId: "id3", message }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.held, true);
  assert.equal(body.outcome, "cleared");
  assert.match(body.reply, /^Mock reply/);
  for (const s of [body.envelope, body.receipt]) {
    assert.equal(s.public_key_spki_hex, expectedPubHex);
    assert.equal(verify(null, Buffer.from(s.payload, "utf8"), kp.publicKey, Buffer.from(s.signature_b64, "base64")), true);
  }
  assert.ok(!body.envelope.payload.includes("book report"));
  const chat = await (await fetch(`http://127.0.0.1:${mockPort}/last`)).json();
  assert.equal(chat.body.model, "glm-5-3");
  assert.match(chat.body.messages[0].content, /^You are the Rivera family's own AI\./);
  const judge = await (await fetch(`http://127.0.0.1:${mockPort}/last-judge`)).json();
  assert.equal(judge.body.model, "gpt-oss-safeguard-120b");
  assert.match(judge.body.messages[1].content, /book report/);

  // "See what the AI is told": the same page, by the same hash, with no model call.
  const p = await fetch(`http://127.0.0.1:${port}/page`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agreement, setup, personId: "id3" }),
  });
  assert.equal(p.status, 200);
  const page = await p.json();
  assert.equal(page.text, chat.body.messages[0].content);
  assert.equal(page.sha256, JSON.parse(body.envelope.payload).page.sha256);
  const bad = await fetch(`http://127.0.0.1:${port}/page`, { method: "POST", body: JSON.stringify({ agreement, personId: "id3" }) });
  assert.equal(bad.status, 422);
});

test("logs carry no prompt, message or Agreement text", () => {
  const out = orch.output();
  for (const words of ["Say hello to a family", "book report", "Rivera", "Grandma"]) assert.ok(!out.includes(words), words);
});

test("an unreachable inference host comes back as 502 with the failure code", async () => {
  const p = await freePort();
  const dead = await freePort();
  const o = startNode(join(root, "server.mjs"), {
    PORT: String(p),
    INFERENCE_URL: `http://127.0.0.1:${dead}/v1/chat/completions`,
    TINFOIL_API_KEY: "test-key-not-real",
    ALLOW_EPHEMERAL_KEY: "1",
    CONNECTIVITY_TURN: "on",
  });
  try {
    await waitFor(`http://127.0.0.1:${p}/health`);
    const r = await fetch(`http://127.0.0.1:${p}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error, "inference unreachable");
    assert.equal(body.detail, "ECONNREFUSED");
  } finally {
    o.child.kill();
  }
});

test("without an API key /turn says so with 503", async () => {
  const p = await freePort();
  const o = startNode(join(root, "server.mjs"), { PORT: String(p), ALLOW_EPHEMERAL_KEY: "1", CONNECTIVITY_TURN: "on" });
  try {
    const h = await (await waitFor(`http://127.0.0.1:${p}/health`)).json();
    assert.equal(h.api_key_present, false);
    assert.equal(h.key_source, "ephemeral-dev");
    const r = await fetch(`http://127.0.0.1:${p}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(r.status, 503);
  } finally {
    o.child.kill();
  }
});

test("an attested-key mount wins over the secret and is reported as such", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-signing-"));
  const other = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, "private_key.pem"), other.privateKey.export({ type: "pkcs8", format: "pem" }));
  const p = await freePort();
  const o = startNode(join(root, "server.mjs"), {
    PORT: String(p),
    ATTESTED_KEY_DIR: dir,
    SIGNING_KEY_PEM: signingPem,
  });
  try {
    const h = await (await waitFor(`http://127.0.0.1:${p}/health`)).json();
    assert.equal(h.key_source, "attested-key");
    const k = await (await fetch(`http://127.0.0.1:${p}/pubkey`, { method: "POST", body: "{}" })).json();
    assert.equal(k.public_key_spki_hex, other.publicKey.export({ type: "spki", format: "der" }).toString("hex"));
  } finally {
    o.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no key source at all the service refuses to start", async () => {
  const p = await freePort();
  const o = startNode(join(root, "server.mjs"), { PORT: String(p), ATTESTED_KEY_DIR: join(tmpdir(), "does-not-exist") });
  const code = await new Promise((resolve) => o.child.on("exit", resolve));
  assert.equal(code, 2);
  assert.match(o.output(), /no signing key/);
});
