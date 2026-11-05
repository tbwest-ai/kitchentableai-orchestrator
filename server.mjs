// SPDX-License-Identifier: AGPL-3.0-only
// KitchenTableAI orchestrator.
//
// A small HTTP service that runs inside an attested Tinfoil container. A family's device sends a
// person's message with the family's Agreement; this service compiles that person's page, keeps
// the deterministic floor, asks the band's model, holds a kid's reply until an independent judge
// has read it, and returns the reply with a signed envelope of labels (never words).
//
//   GET  /health   liveness: version, key source, models, inference host. No secrets.
//   POST /turn     one turn (lib/turn.mjs): { agreement, setup, personId, history?, message }.
//                  The spike's connectivity check ({ "prompt": "..." }) still answers when the
//                  measured config sets CONNECTIVITY_TURN=on, and is refused otherwise.
//   POST /page     the compiled page a turn would run under, { agreement, setup, personId } in,
//                  { text, sha256, version } out. No model call. Nothing on it is secret from the
//                  family; this is "See what the AI is told".
//   POST /pubkey   the signing public key. POST, not GET, so EHBP seals the answer and the key
//                  arrives over the verified channel.
//
// Rules this file keeps:
//   - No dependency outside Node's standard library: nothing to install, a reproducible build.
//   - The API key and the signing key come from the environment or the attested-key mount, and
//     are never written to a log or returned by any endpoint.
//   - No message, reply or Agreement is ever logged. Request logs carry method, path, status and
//     milliseconds only.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeInference } from "./lib/inference.mjs";
import { loadSigningKey, signed } from "./lib/sign.mjs";
import { pageFor, runTurn } from "./lib/turn.mjs";
import { NO_CAPABILITIES, PAGE_VERSION } from "./lib/compile.mjs";
import { CONTENT_MODEL } from "./lib/agreement.mjs";

export const VERSION = "0.3.3";
const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const INFERENCE_URL = process.env.INFERENCE_URL ?? "https://inference.tinfoil.sh/v1/chat/completions";
const POLICY = JSON.parse(readFileSync(process.env.MODEL_POLICY_PATH ?? join(HERE, "policy", "model-policy.json"), "utf8"));
const CONNECTIVITY_TURN = process.env.CONNECTIVITY_TURN === "on";
const MAX_BODY_BYTES = 256 * 1024;
const startedAt = Date.now();

const signer = loadSigningKey();
if (!signer) {
  console.error(
    "no signing key: mount an attested key, set SIGNING_KEY_PEM (PKCS#8 PEM or base64 DER, Ed25519), " +
      "or set ALLOW_EPHEMERAL_KEY=1 for a local run",
  );
  process.exit(2);
}
const infer = makeInference({ url: INFERENCE_URL, apiKey: process.env.TINFOIL_API_KEY });
// The clock is this container's. A test run may pin it (never set in the measured config).
const clock = process.env.TEST_CLOCK ? () => new Date(process.env.TEST_CLOCK) : () => new Date();
const ctx = { infer, signer, policy: POLICY, capabilities: NO_CAPABILITIES, clock, cacheKey: process.env.TINFOIL_API_KEY ?? null };

// ---------------------------------------------------------------------------------------

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

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, ehbp-encapsulated-key, x-tinfoil-enclave-url",
  "access-control-expose-headers": "ehbp-response-nonce",
  "access-control-max-age": "600",
};

function health() {
  return [
    200,
    {
      ok: true,
      service: "kitchentableai-orchestrator",
      version: VERSION,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      page_version: PAGE_VERSION,
      content_model_commit: CONTENT_MODEL.source?.commit ?? null,
      models: Object.fromEntries(Object.entries(POLICY.bands).map(([band, b]) => [band, b.model])),
      judge: POLICY.judge.model,
      reasoning_effort: POLICY.bands["8–11"].reasoningEffort,
      inference_host: new URL(INFERENCE_URL).host,
      api_key_present: Boolean(process.env.TINFOIL_API_KEY),
      connectivity_turn: CONNECTIVITY_TURN,
      key_source: signer.source,
      key_id: signer.id,
    },
  ];
}

function pubkey() {
  return [200, { ok: true, alg: "Ed25519", key_source: signer.source, key_id: signer.id, public_key_spki_hex: signer.publicKeySpkiHex, public_key_pem: signer.publicKeyPem }];
}

/** The spike's connectivity check: a fixed system line, no family data. Only when the config allows it. */
async function connectivity(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return [400, { ok: false, error: "prompt (string) is required" }];
  if (prompt.length > 2000) return [413, { ok: false, error: "prompt longer than 2000 characters" }];
  const t0 = Date.now();
  let r;
  try {
    r = await infer(
      {
        model: POLICY.bands.Adult.model,
        messages: [
          { role: "system", content: "You are a connectivity check for a family AI service. Reply in one short, friendly sentence." },
          { role: "user", content: prompt },
        ],
        max_tokens: 400,
        reasoning_effort: POLICY.bands.Adult.reasoningEffort,
      },
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    if (err.kind === "no_key") return [503, { ok: false, error: err.message }];
    return [502, { ok: false, error: "inference unreachable", detail: err.kind === "network" ? err.message : err.kind ?? err.message, latency_ms: Date.now() - t0 }];
  }
  const payload = { v: 1, id: randomUUID(), at: new Date().toISOString(), model: r.model, prompt_sha256: createHash("sha256").update(prompt, "utf8").digest("hex"), reply: r.content, usage: r.usage, latency_ms: Date.now() - t0, key_source: signer.source, key_id: signer.id };
  return [200, { ok: true, reply: r.content, model: r.model, usage: r.usage, latency_ms: payload.latency_ms, signed: signed(signer, payload) }];
}

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
      if (req.method === "POST") await readJsonBody(req);
      const [s, body] = pubkey();
      sendJson(res, (status = s), body);
    } else if (req.method === "POST" && path === "/page") {
      const body = await readJsonBody(req);
      const [s, out] = pageFor(body, ctx);
      sendJson(res, (status = s), out);
    } else if (req.method === "POST" && path === "/turn") {
      const body = await readJsonBody(req);
      let out;
      if (body && typeof body === "object" && "agreement" in body) out = await runTurn(body, ctx);
      else if (CONNECTIVITY_TURN && typeof body?.prompt === "string") out = await connectivity(body);
      else out = [422, { ok: false, error: "an Agreement is required: { agreement, setup, personId, message }", failed_closed: true }];
      sendJson(res, (status = out[0]), out[1]);
    } else {
      sendJson(res, (status = 404), { ok: false, error: "not found" });
    }
  } catch (err) {
    status = err?.status ?? 500;
    // The error's message only: never the request body.
    sendJson(res, status, { ok: false, error: status === 500 ? "internal error" : err?.message ?? "error" });
    if (status === 500) console.error(`500 on ${path}: ${err?.name ?? "Error"} ${String(err?.message ?? "").slice(0, 200)}`);
  }
  console.log(`${req.method} ${path} ${status} ${Date.now() - t0}ms`);
});

server.listen(PORT, HOST, () => {
  console.log(
    `kitchentableai-orchestrator ${VERSION} listening on ${HOST}:${PORT} page=${PAGE_VERSION} ` +
      `judge=${POLICY.judge.model} inference=${new URL(INFERENCE_URL).host} key_source=${signer.source} ` +
      `api_key=${process.env.TINFOIL_API_KEY ? "present" : "absent"} connectivity_turn=${CONNECTIVITY_TURN ? "on" : "off"}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
