// SPDX-License-Identifier: AGPL-3.0-only
// KitchenTableAI orchestrator, spike build.
//
// One small HTTP service meant to run inside an attested Tinfoil container. It exists to
// answer three questions (see README.md): can a browser verify this container and call it,
// can the container reach Tinfoil's inference API through an egress allowlist with the API
// key supplied as a managed secret, and can it sign a reply with a key a client can verify.
//
//   GET  /health   liveness: version, key source, model, inference host. No secrets.
//   POST /turn     { "prompt": "..." } in; the model's reply plus an Ed25519 signature out.
//   POST /pubkey   the signing public key. POST, not GET, so EHBP seals the answer and the
//                  key arrives over the verified channel.
//
// Rules this file keeps:
//   - No dependency outside Node's standard library, so the image has nothing to install
//     and the build stays reproducible.
//   - The API key and the signing key come from the environment or from the attested-key
//     mount. Neither is ever written to a log or returned by any endpoint.
//   - The prompt and the reply are never logged. Request logs carry method, path, status
//     and milliseconds only.
//   - Nothing here is a family's data. The system prompt is a fixed connectivity line; the
//     Agreement compiler is the next step, not this one.

import { createServer } from "node:http";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const VERSION = "0.1.0";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const INFERENCE_URL =
  process.env.INFERENCE_URL ?? "https://inference.tinfoil.sh/v1/chat/completions";
const MODEL = process.env.MODEL ?? "glm-5-3";
// GLM 5.3 cannot turn reasoning off (Tinfoil docs, read 2026-10-23); "low" is the floor.
// gemma4-31b accepts "none". The value is configuration, never code.
const REASONING_EFFORT = process.env.REASONING_EFFORT ?? "low";
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 400);
const MAX_PROMPT_CHARS = 2000;
const MAX_BODY_BYTES = 64 * 1024;
const INFERENCE_TIMEOUT_MS = Number(process.env.INFERENCE_TIMEOUT_MS ?? 60_000);
// Where Tinfoil mounts an attested key declared as `id: turn-signing` (beta).
const ATTESTED_KEY_DIR = process.env.ATTESTED_KEY_DIR ?? "/run/tinfoil/keys/turn-signing";
const SYSTEM_PROMPT =
  "You are a connectivity check for a family AI service. Reply in one short, friendly sentence.";

const startedAt = Date.now();

// ---------------------------------------------------------------------------------------
// Signing key. Three sources, tried in order, and the response says which one was used.
// ---------------------------------------------------------------------------------------

function describeKey(privateKey, source, id) {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`signing key must be Ed25519, got ${privateKey.asymmetricKeyType}`);
  }
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    source,
    id,
    // Lowercase hex of the SPKI DER, the same shape Tinfoil's attestation document uses for
    // endorsed keys (format https://tinfoil.sh/key/spki/v1).
    publicKeySpkiHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export function loadSigningKey(env = process.env) {
  const attestedPem = join(ATTESTED_KEY_DIR, "private_key.pem");
  if (existsSync(attestedPem)) {
    try {
      const privateKey = createPrivateKey(readFileSync(attestedPem, "utf8"));
      return describeKey(privateKey, "attested-key", `tinfoil:${basename(ATTESTED_KEY_DIR)}`);
    } catch (err) {
      // An attested key that is mounted but unreadable (wrong uid/gid on the mount, or a
      // format this build does not parse) must not take the service down before its health
      // check: say why, then fall back to the managed secret. The reply's key_source tells
      // the operator which path is live.
      console.error(`attested key at ${attestedPem} is present but unusable (${err.code ?? err.message}); falling back`);
    }
  }
  const secret = env.SIGNING_KEY_PEM;
  if (secret && secret.trim()) {
    const privateKey = secret.includes("-----BEGIN")
      ? createPrivateKey(secret)
      : createPrivateKey({ key: Buffer.from(secret.trim(), "base64"), format: "der", type: "pkcs8" });
    return describeKey(privateKey, "managed-secret", "SIGNING_KEY_PEM");
  }
  if (env.ALLOW_EPHEMERAL_KEY === "1") {
    const { privateKey } = generateKeyPairSync("ed25519");
    return describeKey(privateKey, "ephemeral-dev", "generated at start, local runs only");
  }
  return null;
}

const signer = loadSigningKey();
if (!signer) {
  console.error(
    `no signing key: mount an attested key at ${ATTESTED_KEY_DIR}, set SIGNING_KEY_PEM ` +
      "(PKCS#8 PEM or base64 DER, Ed25519), or set ALLOW_EPHEMERAL_KEY=1 for a local run",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

// The browser test page is served from another origin (localhost). Tinfoil's shim may apply
// its own CORS policy (`shim.origins`); these headers cover the case where it passes ours on.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, ehbp-encapsulated-key, x-tinfoil-enclave-url",
  "access-control-expose-headers": "ehbp-response-nonce",
  "access-control-max-age": "600",
};

// ---------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------

function health() {
  return [
    200,
    {
      ok: true,
      service: "kitchentableai-orchestrator",
      version: VERSION,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      inference_host: new URL(INFERENCE_URL).host,
      api_key_present: Boolean(process.env.TINFOIL_API_KEY),
      key_source: signer.source,
      key_id: signer.id,
    },
  ];
}

function pubkey() {
  return [
    200,
    {
      ok: true,
      alg: "Ed25519",
      key_source: signer.source,
      key_id: signer.id,
      public_key_spki_hex: signer.publicKeySpkiHex,
      public_key_pem: signer.publicKeyPem,
    },
  ];
}

export async function turn(body, env = process.env) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return [400, { ok: false, error: "prompt (string) is required" }];
  if (prompt.length > MAX_PROMPT_CHARS) {
    return [413, { ok: false, error: `prompt longer than ${MAX_PROMPT_CHARS} characters` }];
  }
  const apiKey = env.TINFOIL_API_KEY;
  if (!apiKey) return [503, { ok: false, error: "TINFOIL_API_KEY is not set in this container" }];

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(INFERENCE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_TOKENS,
        reasoning_effort: REASONING_EFFORT,
        stream: false,
      }),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
  } catch (err) {
    // With a wrong allowlist this is where the enclave fails: ENOTFOUND, ECONNREFUSED or a
    // timeout. The code is the evidence, so it is returned.
    const detail = err?.cause?.code ?? err?.cause?.message ?? err?.name ?? String(err);
    return [502, { ok: false, error: "inference unreachable", detail, latency_ms: Date.now() - t0 }];
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return [
      502,
      { ok: false, error: `inference returned HTTP ${upstream.status}`, detail: text.slice(0, 300) },
    ];
  }
  let completion;
  try {
    completion = JSON.parse(text);
  } catch {
    return [502, { ok: false, error: "inference returned a body that is not JSON" }];
  }
  const reply = completion?.choices?.[0]?.message?.content ?? "";

  // What gets signed is the exact UTF-8 bytes of `payload` as returned. A verifier checks the
  // signature over those bytes first and parses them second, so no canonicalisation is needed.
  const payload = {
    v: 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    model: completion.model ?? MODEL,
    prompt_sha256: sha256Hex(prompt),
    reply,
    usage: completion.usage ?? null,
    latency_ms: Date.now() - t0,
    key_source: signer.source,
    key_id: signer.id,
  };
  const payloadJson = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadJson, "utf8"), signer.privateKey);

  return [
    200,
    {
      ok: true,
      reply,
      model: payload.model,
      usage: payload.usage,
      latency_ms: payload.latency_ms,
      signed: {
        alg: "Ed25519",
        payload: payloadJson,
        signature_b64: signature.toString("base64"),
        key_source: signer.source,
        key_id: signer.id,
        public_key_spki_hex: signer.publicKeySpkiHex,
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const path = new URL(req.url, "http://localhost").pathname;
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  let status = 500;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      status = 204;
    } else if (req.method === "GET" && path === "/health") {
      const [s, body] = health();
      sendJson(res, (status = s), body);
    } else if ((req.method === "POST" || req.method === "GET") && path === "/pubkey") {
      if (req.method === "POST") await readJsonBody(req); // drain the (empty) body
      const [s, body] = pubkey();
      sendJson(res, (status = s), body);
    } else if (req.method === "POST" && path === "/turn") {
      const body = await readJsonBody(req);
      const [s, out] = await turn(body);
      sendJson(res, (status = s), out);
    } else {
      sendJson(res, (status = 404), { ok: false, error: "not found" });
    }
  } catch (err) {
    status = err?.status ?? 500;
    sendJson(res, status, { ok: false, error: err?.message ?? "error" });
  }
  console.log(`${req.method} ${path} ${status} ${Date.now() - t0}ms`);
});

server.listen(PORT, HOST, () => {
  console.log(
    `kitchentableai-orchestrator ${VERSION} listening on ${HOST}:${PORT} ` +
      `model=${MODEL} reasoning_effort=${REASONING_EFFORT} inference=${new URL(INFERENCE_URL).host} ` +
      `key_source=${signer.source} api_key=${process.env.TINFOIL_API_KEY ? "present" : "absent"}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
