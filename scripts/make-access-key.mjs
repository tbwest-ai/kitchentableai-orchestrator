// SPDX-License-Identifier: AGPL-3.0-only
// Makes the family app's access key pair (lib/access.mjs).
//
//   node scripts/make-access-key.mjs C:\path\outside\every\repo\access-private.jwk.json
//
// Writes the private half, a JWK, to the file you name: a secret for the family app's server only
// (its KTA_ACCESS_PRIVATE_JWK), never committed anywhere. Prints the public half, which goes in
// tinfoil-config.yml as ACCESS_PUBLIC_KEYS by pull request, where anyone can read it.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/make-access-key.mjs <file for the private key, outside every repository>");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite a key`);
  process.exit(2);
}
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
writeFileSync(out, `${JSON.stringify(jwk)}\n`, { mode: 0o600 });
console.log(`Private key written to ${out}. Keep it secret: it goes only in the family app's server settings.`);
console.log(`Public key, for ACCESS_PUBLIC_KEYS in tinfoil-config.yml:\n${jwk.x}`);
