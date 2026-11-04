// SPDX-License-Identifier: AGPL-3.0-only
// What the check page (index.html) and the test chat (chat.html) share: the synthetic sample
// family, Ed25519 verification with WebCrypto, SHA-256, and reading a signed envelope.

/** The builder's own synthetic Rivera export, served from test/fixtures by serve.mjs. */
export async function loadSampleAgreement() {
  const r = await fetch("./sample/rivera-export.json", { cache: "no-store" });
  if (!r.ok) throw new Error(`sample not found (HTTP ${r.status})`);
  return r.json();
}

/** A setup for the sample: Maya (id3) is 9 and Theo (id4) is 13. */
export function sampleSetup(timeZone = "America/New_York") {
  return {
    format: "kitchentableai-setup",
    version: 1,
    timeZone,
    retentionDays: 30,
    people: { id1: { pronouns: "she", age: 41 }, id2: { pronouns: "he" }, id3: { pronouns: "she", age: 9 }, id4: { pronouns: "he", age: 13 } },
  };
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** True when the signature over the exact payload bytes verifies with the SPKI key. Throws if this browser lacks Ed25519. */
export async function verifyEd25519(spkiHex, payload, signatureB64) {
  const key = await crypto.subtle.importKey("spki", hexToBytes(spkiHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(signatureB64), new TextEncoder().encode(payload));
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks a turn's envelope and receipt against the key /pubkey published over the same channel,
 * and that the receipt binds this reply. Returns { ok, envelope, notes }.
 */
export async function checkTurn(body, pubkey) {
  const notes = [];
  let ok = true;
  for (const [name, s] of [["envelope", body.envelope], ["receipt", body.receipt]]) {
    if (s.public_key_spki_hex !== pubkey.public_key_spki_hex) {
      ok = false;
      notes.push(`${name} key does not match /pubkey`);
    }
    if (!(await verifyEd25519(pubkey.public_key_spki_hex, s.payload, s.signature_b64))) {
      ok = false;
      notes.push(`${name} signature does not verify`);
    }
  }
  const receipt = JSON.parse(body.receipt.payload);
  if (receipt.reply_sha256 !== (await sha256Hex(body.reply))) {
    ok = false;
    notes.push("the receipt is for a different reply");
  }
  const envelope = JSON.parse(body.envelope.payload);
  if (receipt.id !== envelope.id) {
    ok = false;
    notes.push("the receipt and the envelope are for different turns");
  }
  return { ok, envelope, keySource: body.envelope.key_source, notes };
}
