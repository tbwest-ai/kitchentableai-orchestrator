// SPDX-License-Identifier: AGPL-3.0-only
// Makes the Ed25519 signing key for exit test 3's fallback path (a Tinfoil-managed secret).
//
//   node scripts/make-signing-key.mjs signing-key.pem
//
// Writes the private key (PKCS#8 PEM) to the file named, mode 0600, and prints the public
// key's SPKI hex so it can be recorded before the instance starts. The private key is never
// printed. *.pem is ignored by git at the repository root; keep it that way and delete the
// file once `tinfoil secret create SIGNING_KEY_PEM --value-file signing-key.pem` has run.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/make-signing-key.mjs <file.pem>");
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} exists; refusing to overwrite a key`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
console.log(`private key written to ${out} (not printed, do not commit)`);
console.log(`public key, SPKI hex: ${publicKey.export({ type: "spki", format: "der" }).toString("hex")}`);
