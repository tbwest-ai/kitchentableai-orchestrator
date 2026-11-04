// SPDX-License-Identifier: AGPL-3.0-only
// Sealing a short note (a turn's topic) to the family's public key, so only the family's devices
// can read it. The control plane stores the sealed bytes and cannot open them.
//
// X25519 with an ephemeral key per note, HKDF-SHA256 to a 256-bit key, AES-256-GCM. Node's
// standard library only. The family key pair itself is Phase 2 (passkeys and the recovery code);
// until a setup carries `familyPublicKey`, nothing is sealed and nothing about the topic leaves.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

export const SEAL_ALG = "X25519-HKDF-SHA256-AES-256-GCM/v1";
const INFO = Buffer.from("kitchentableai seal v1", "utf8");

/** Seals UTF-8 text to an X25519 public key given as base64 SPKI DER. */
export function seal(publicKeySpkiB64, text) {
  const recipient = createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" });
  if (recipient.asymmetricKeyType !== "x25519") throw new Error("familyPublicKey must be an X25519 key");
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const epk = eph.publicKey.export({ type: "spki", format: "der" });
  const key = Buffer.from(hkdfSync("sha256", shared, epk, INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { alg: SEAL_ALG, epk_b64: epk.toString("base64"), nonce_b64: nonce.toString("base64"), ct_b64: ct.toString("base64") };
}

/** The family's side, for tests and for the client: opens a sealed note with the X25519 private key (PKCS#8 DER base64 or a KeyObject). */
export function open(privateKey, box) {
  const priv = typeof privateKey === "string" ? createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }) : privateKey;
  const epk = Buffer.from(box.epk_b64, "base64");
  const shared = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: epk, format: "der", type: "spki" }) });
  const key = Buffer.from(hkdfSync("sha256", shared, epk, INFO, 32));
  const ct = Buffer.from(box.ct_b64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce_b64, "base64"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8");
}
