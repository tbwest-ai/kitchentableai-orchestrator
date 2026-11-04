// SPDX-License-Identifier: AGPL-3.0-only
// Browser test page for the orchestrator spike. Three jobs:
//   1. Verify a Tinfoil container with the official JavaScript SDK (SecureClient): fetch the
//      attestation bundle, check the Sigstore provenance of the config repo's release, check
//      the hardware attestation, compare measurements, pin the enclave's HPKE key.
//   2. Send one turn to /turn over the SDK's encrypted channel (EHBP), as Maya of the synthetic
//      sample family, and show the reply and its outcome.
//   3. Verify the reply's Ed25519 signature with WebCrypto, using the public key the
//      container published over the same verified channel (/pubkey).
// Every host this page talks to is recorded, so the evidence shows what a browser needs.

import { SecureClient } from "tinfoil";
import { checkTurn, loadSampleAgreement, sampleSetup } from "./common.js";

const $ = (id) => document.getElementById(id);
const evidence = { page: "orchestrator-check", userAgent: navigator.userAgent, startedAt: new Date().toISOString(), hosts: [] };

// Record every host the SDK and this page contact.
const hosts = new Set();
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  try { hosts.add(new URL(typeof input === "string" ? input : input.url ?? String(input), location.href).host); } catch {}
  return realFetch(input, init);
};

let client = null;      // SecureClient after a successful verify
let localBase = null;   // http://localhost:8080 in unverified mode
let lastDoc = null;

function render() {
  evidence.hosts = [...hosts];
  $("hosts").textContent = hosts.size ? `Hosts contacted: ${[...hosts].join(", ")}` : "";
  $("evidence").textContent = JSON.stringify(evidence, null, 2);
}

function rows(table, pairs) {
  table.innerHTML = "";
  for (const [k, v] of pairs) {
    const tr = document.createElement("tr");
    const th = document.createElement("th"); th.textContent = k;
    const td = document.createElement("td");
    if (v instanceof Node) td.appendChild(v); else td.textContent = v ?? "";
    tr.append(th, td); table.appendChild(tr);
  }
}

function code(text) { const c = document.createElement("code"); c.textContent = text; return c; }

function banner(text) {
  const b = $("banner");
  b.style.display = text ? "block" : "none";
  b.textContent = text ?? "";
}

function showDoc(doc) {
  lastDoc = doc;
  const steps = $("vsteps");
  steps.innerHTML = "";
  for (const [name, step] of Object.entries(doc.steps ?? {})) {
    const li = document.createElement("li");
    const cls = step.status === "success" ? "ok" : step.status === "failed" ? "bad" : "muted";
    li.innerHTML = `<span class="${cls}">${step.status}</span> ${name}${step.error ? `: <code>${escapeHtml(step.error)}</code>` : ""}`;
    steps.appendChild(li);
  }
  rows($("vdoc"), [
    ["Verified", doc.securityVerified ? "yes" : "no"],
    ["Enclave host", doc.enclaveHost],
    ["Config repo", doc.configRepo],
    ["Release tag", doc.releaseTag ?? ""],
    ["Release digest", code(doc.releaseDigest)],
    ["Code measurement", code(`${doc.codeMeasurement?.type}\n${(doc.codeMeasurement?.registers ?? []).join("\n")}`)],
    ["Enclave measurement", code(`${doc.enclaveMeasurement?.measurement?.type}\n${(doc.enclaveMeasurement?.measurement?.registers ?? []).join("\n")}`)],
    ["Code fingerprint", code(doc.codeFingerprint)],
    ["Enclave fingerprint", code(doc.enclaveFingerprint)],
    ["HPKE public key", code(doc.hpkePublicKey)],
    ["TLS key fingerprint", code(doc.tlsPublicKey)],
    ["Verifier", `${doc.verifier?.name ?? ""} ${doc.verifier?.version ?? ""}`],
    ["Verified at", doc.verifiedAt ?? ""],
  ]);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function verify(enclaveURL, configRepo) {
  localBase = null;
  client = null;
  banner(null);
  $("turn").disabled = true;
  $("tstatus").className = "status muted"; $("tstatus").textContent = "Not run."; $("tdoc").innerHTML = "";
  delete evidence.turn; delete evidence.local;
  $("vstatus").className = "status muted";
  $("vstatus").textContent = `Verifying ${enclaveURL} against ${configRepo}…`;
  $("vsteps").innerHTML = ""; $("vdoc").innerHTML = "";
  const t0 = performance.now();
  const c = new SecureClient({ enclaveURL, configRepo, transport: "ehbp" });
  try {
    await c.ready();
    const doc = c.getVerificationDocument();
    showDoc(doc);
    client = c;
    $("vstatus").className = "status ok";
    $("vstatus").textContent = `Verified in ${Math.round(performance.now() - t0)} ms. The channel is now pinned to this enclave's HPKE key.`;
    $("turn").disabled = false;
    evidence.verification = { enclaveURL, configRepo, ms: Math.round(performance.now() - t0), document: doc };
  } catch (err) {
    const doc = c.getVerificationDocument();
    showDoc(doc);
    $("vstatus").className = "status bad";
    $("vstatus").textContent = `Verification failed: ${err?.message ?? err}`;
    evidence.verification = { enclaveURL, configRepo, ms: Math.round(performance.now() - t0), error: String(err?.message ?? err), document: doc };
  }
  render();
}

// Since v0.3.0 the turn is a real one, through the Agreement, the floor and the judge: Maya, 9,
// of the synthetic sample family, asks the prompt. The raw connectivity check is off.
async function sendTurn() {
  const prompt = $("prompt").value.trim();
  const t = $("tstatus");
  t.className = "status muted"; t.textContent = "Sending…"; $("tdoc").innerHTML = "";
  const doFetch = client ? client.fetch : realFetch;
  const base = client ? client.getEnclaveURL() : localBase;
  const mode = client ? "verified (EHBP, attested HPKE key)" : "LOCAL, UNVERIFIED (plain fetch)";
  const t0 = performance.now();
  try {
    // The public key, over the same channel as the turn. POST so EHBP seals the reply.
    const pk = await (await doFetch(`${base}/pubkey`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const agreement = await loadSampleAgreement();
    const r = await doFetch(`${base}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agreement, setup: sampleSetup(), personId: "id3", message: prompt }) });
    const body = await r.json();
    const ms = Math.round(performance.now() - t0);
    if (!r.ok || !body.ok) {
      t.className = "status bad";
      t.textContent = `Turn failed: HTTP ${r.status} ${body.error ?? ""} ${body.detail ?? ""}`;
      evidence.turn = { mode, status: r.status, body, ms };
      render();
      return;
    }
    let check = null, sigNote = "";
    try { check = await checkTurn(body, pk); }
    catch (e) { sigNote = `WebCrypto could not verify Ed25519 here: ${e?.message ?? e}`; }
    const env = check?.envelope ?? JSON.parse(body.envelope.payload);
    const good = check?.ok === true;
    t.className = `status ${good ? "ok" : check === null ? "warn" : "bad"}`;
    t.textContent = good
      ? `Reply received, ${body.outcome}, and both signatures verified (${body.envelope.key_source}) in ${ms} ms. Mode: ${mode}.`
      : check === null ? `Reply received in ${ms} ms, signatures not checked. ${sigNote}` : `Reply received but the check FAILED: ${check.notes.join("; ")}. Mode: ${mode}.`;
    rows($("tdoc"), [
      ["Reply (Maya, sample family)", body.reply],
      ["Outcome", `${body.outcome}${body.held ? ", held for the judge" : ""}`],
      ["Model", env.model],
      ["Judge", env.judge ? `${env.judge.result ?? ""} ${env.judge.message ?? ""}/${env.judge.reply ?? ""} ${env.judge.ms != null ? `${env.judge.ms} ms` : ""}` : "none"],
      ["Timing", `${body.timing?.total_ms} ms inside the container (model ${body.timing?.model_ms ?? "–"} ms, judge ${body.timing?.judge_ms ?? "–"} ms)`],
      ["Key source", `${body.envelope.key_source} (${body.envelope.key_id})`],
      ["Envelope and receipt verify", check === null ? "not checked" : good ? "yes, and the receipt binds this reply" : check.notes.join("; ")],
      ["Public key (SPKI hex)", code(pk.public_key_spki_hex)],
      ["Signed envelope (labels, no words)", code(body.envelope.payload)],
    ]);
    evidence.turn = { mode, ms, reply: body.reply, outcome: body.outcome, envelope: env, keySource: body.envelope.key_source, pubkey: pk, verified: check?.ok ?? null, notes: check?.notes, note: sigNote || undefined };
  } catch (err) {
    t.className = "status bad";
    t.textContent = `Turn failed: ${err?.message ?? err}`;
    evidence.turn = { mode, error: String(err?.message ?? err) };
  }
  render();
}

$("verify").onclick = () => verify($("enclave").value.trim().replace(/\/$/, ""), $("repo").value.trim());
$("control").onclick = () => verify("https://websearch.tinfoil.sh", "tinfoilsh/confidential-websearch");
$("turn").onclick = sendTurn;
$("local").onclick = async () => {
  client = null; localBase = "http://localhost:8080";
  banner("Local mode: plain fetch to http://localhost:8080, no attestation, an ephemeral signing key. This exercises the page and the service, not Tinfoil.");
  $("vstatus").className = "status warn"; $("vstatus").textContent = "Skipped (local, unverified)."; $("vsteps").innerHTML = ""; $("vdoc").innerHTML = "";
  try {
    const h = await (await realFetch(`${localBase}/health`)).json();
    rows($("vdoc"), [["Local /health", code(JSON.stringify(h))]]);
    $("turn").disabled = false;
    evidence.local = h;
  } catch (e) {
    $("vstatus").className = "status bad"; $("vstatus").textContent = `No local orchestrator on 8080 (${e?.message ?? e}). Run: npm run dev`;
  }
  render();
};
$("ed").onclick = async () => {
  try {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const data = new TextEncoder().encode("probe");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, data);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, data);
    banner(`WebCrypto Ed25519: ${ok ? "supported" : "sign/verify mismatch"} in this browser.`);
    evidence.webcryptoEd25519 = ok;
  } catch (e) {
    banner(`WebCrypto Ed25519 is NOT available in this browser: ${e?.message ?? e}. The page would need an ECDSA P-256 key or a JS Ed25519 library.`);
    evidence.webcryptoEd25519 = false;
  }
  render();
};
$("copy").onclick = async () => {
  render();
  try { await navigator.clipboard.writeText($("evidence").textContent); $("copy").textContent = "Copied"; setTimeout(() => ($("copy").textContent = "Copy evidence JSON"), 1500); } catch {}
};

render();
