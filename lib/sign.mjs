// SPDX-License-Identifier: AGPL-3.0-only
// The signing key, and signatures over exact payload bytes.
//
// Three sources, tried in order, and every signature says which one was used:
//   1. an attested key Tinfoil generates inside the enclave and mounts at ATTESTED_KEY_DIR
//      (beta; on since v0.1.2, 2026-11-02), whose public half the attestation endorses;
//   2. SIGNING_KEY_PEM, a Tinfoil-managed secret (PKCS#8 PEM or base64 DER, Ed25519);
//   3. a key generated at start, for local runs only (ALLOW_EPHEMERAL_KEY=1).
//
// What gets signed is the exact UTF-8 bytes of the payload string as returned. A verifier checks
// the signature over those bytes first and parses them second, so no canonicalisation is needed.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function describeKey(privateKey, source, id) {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`signing key must be Ed25519, got ${privateKey.asymmetricKeyType}`);
  }
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    source,
    id,
    // Lowercase hex of the SPKI DER, the shape Tinfoil's attestation document uses for endorsed keys.
    publicKeySpkiHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export function loadSigningKey(env = process.env) {
  const dir = env.ATTESTED_KEY_DIR ?? "/run/tinfoil/keys/turn-signing";
  const attestedPem = join(dir, "private_key.pem");
  if (existsSync(attestedPem)) {
    try {
      const privateKey = createPrivateKey(readFileSync(attestedPem, "utf8"));
      return describeKey(privateKey, "attested-key", `tinfoil:${basename(dir)}`);
    } catch (err) {
      // A key that is mounted but unreadable must not take the service down before its health
      // check: say why, then fall back. The signature's key_source tells the operator which path is live.
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

/** Signs an object: returns { alg, payload, signature_b64, key_source, key_id, public_key_spki_hex }. */
export function signed(signer, obj) {
  const payload = JSON.stringify(obj);
  const signature = sign(null, Buffer.from(payload, "utf8"), signer.privateKey);
  return {
    alg: "Ed25519",
    payload,
    signature_b64: signature.toString("base64"),
    key_source: signer.source,
    key_id: signer.id,
    public_key_spki_hex: signer.publicKeySpkiHex,
  };
}
