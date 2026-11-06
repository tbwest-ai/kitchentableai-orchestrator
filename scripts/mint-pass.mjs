// SPDX-License-Identifier: AGPL-3.0-only
// Mints a family pass (lib/access.mjs), the way the family app's server does. For tests and for a
// hand-made pass while the app is being built:
//
//   node scripts/mint-pass.mjs --key access-private.jwk.json --agreement my-export.json \
//        --setup my-setup.json --person id3 [--family my-family] [--device laptop] [--hours 12]
//
// Prints the pass. --key is the private JWK from scripts/make-access-key.mjs: a secret, kept
// outside every repository. The pass is good only for that person and that exact Agreement and setup.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUDIENCE, agreementHash } from "../lib/access.mjs";

export function mintPass({ privateJwk, family, device, personId, agreement, setup, lifetimeSeconds = 3600, now = new Date() }) {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const iat = Math.floor(now.getTime() / 1000);
  const payload = { v: 1, aud: AUDIENCE, fam: family, dev: device, pid: personId, ah: agreementHash(agreement, setup), iat, exp: iat + lifetimeSeconds };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(null, Buffer.from(body, "ascii"), key).toString("base64url")}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []),
  );
  for (const need of ["key", "agreement", "setup", "person"]) {
    if (!args[need]) {
      console.error(`missing --${need}. Usage: node scripts/mint-pass.mjs --key K --agreement A --setup S --person ID [--family F] [--device D] [--hours H]`);
      process.exit(2);
    }
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const hours = Number(args.hours ?? 12);
  console.log(
    mintPass({
      privateJwk: read(args.key),
      family: args.family ?? "hand-made",
      device: args.device ?? "hand-made",
      personId: args.person,
      agreement: read(args.agreement),
      setup: read(args.setup),
      lifetimeSeconds: Math.round(hours * 3600),
    }),
  );
}
