// SPDX-License-Identifier: AGPL-3.0-only
// The lock: only an invited family's device can run a turn or read a page.
//
// The family's account (the control plane) signs a short-lived pass for one device, one person and
// one exact Agreement and setup; the device sends it in the request body, inside the encrypted
// channel. This service checks it against the public keys in its measured config, so anyone can
// read which control plane may admit a family, and nothing here holds a secret.
//
//   pass    = base64url(payload JSON) + "." + base64url(Ed25519 signature over the first part's ASCII)
//   payload = { v: 1, aud: "kitchentableai-orchestrator", fam, dev, pid, ah, iat, exp }
//     fam   the control plane's opaque family id (the daily limit counts by it)
//     dev   an opaque device id (the burst limit counts by it)
//     pid   the person the pass is for: a kid cannot borrow a parent's page
//     ah    agreementHash(agreement, setup): a device cannot edit its own rules
//     iat, exp  seconds since the epoch; exp - iat no longer than the policy allows
//
// The control plane computes `ah` with the same canonicalJson below. Keys are Ed25519 public keys
// given as the 32-byte "x" of a JWK, base64url, comma-separated (two at once while rotating).
//
// The synthetic sample family (agreement/sample-export.json, the builder's own Rivera fixture)
// needs no pass, so the public check page and a verifier can still try a turn. It runs under a
// small daily limit of its own.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIENCE = "kitchentableai-orchestrator";
const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_PASS_CHARS = 4096;
const B64U = /^[A-Za-z0-9_-]+$/;

/** JSON with every object's keys sorted and undefined members left out: the same bytes on both sides. */
export function canonicalJson(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** The hex SHA-256 of the canonical { agreement, setup }: what a pass's `ah` must equal. */
export function agreementHash(agreement, setup) {
  return createHash("sha256").update(canonicalJson({ agreement: agreement ?? null, setup: setup ?? null }), "utf8").digest("hex");
}

/** Public keys from "x1,x2": each the base64url "x" of an Ed25519 JWK. Throws on a malformed key. */
export function parseAccessKeys(list) {
  return String(list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((x) => {
      if (!B64U.test(x) || Buffer.from(x, "base64url").length !== 32) throw new Error(`access key is not a 32-byte base64url Ed25519 key: ${x.slice(0, 8)}…`);
      return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    });
}

const SAMPLE_HASH = (() => {
  try {
    return createHash("sha256").update(canonicalJson(JSON.parse(readFileSync(join(HERE, "..", "agreement", "sample-export.json"), "utf8"))), "utf8").digest("hex");
  } catch {
    return null;
  }
})();

/** True when the Agreement is exactly the synthetic sample family's (the setup may vary). */
export function isSampleAgreement(agreement) {
  return Boolean(SAMPLE_HASH && agreement && typeof agreement === "object" && createHash("sha256").update(canonicalJson(agreement), "utf8").digest("hex") === SAMPLE_HASH);
}

/**
 * Checks a pass. Returns { ok: true, family, device, person, exp } or { ok: false, code } where code
 * is one of no_pass, bad_pass, bad_signature, not_yet, expired, too_long, wrong_person,
 * agreement_changed. Never throws on input.
 */
export function checkPass(pass, { keys, now, personId, agreement, setup, maxLifetimeSeconds }) {
  if (typeof pass !== "string" || !pass) return { ok: false, code: "no_pass" };
  if (pass.length > MAX_PASS_CHARS) return { ok: false, code: "bad_pass" };
  const parts = pass.split(".");
  if (parts.length !== 2 || !B64U.test(parts[0]) || !B64U.test(parts[1])) return { ok: false, code: "bad_pass" };
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== 64) return { ok: false, code: "bad_pass" };
  const signedBytes = Buffer.from(parts[0], "ascii");
  if (!keys.some((k) => verify(null, signedBytes, k, signature))) return { ok: false, code: "bad_signature" };
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "bad_pass" };
  }
  const str = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;
  if (!p || p.v !== 1 || p.aud !== AUDIENCE || !str(p.fam) || !str(p.dev) || !str(p.pid) || !/^[0-9a-f]{64}$/.test(p.ah ?? "") || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)) {
    return { ok: false, code: "bad_pass" };
  }
  const t = Math.floor(now.getTime() / 1000);
  if (p.iat > t + 60) return { ok: false, code: "not_yet" };
  if (p.exp <= t) return { ok: false, code: "expired" };
  if (p.exp - p.iat > maxLifetimeSeconds) return { ok: false, code: "too_long" };
  if (p.pid !== personId) return { ok: false, code: "wrong_person" };
  if (p.ah !== agreementHash(agreement, setup)) return { ok: false, code: "agreement_changed" };
  return { ok: true, family: p.fam, device: p.dev, person: p.pid, exp: p.exp };
}

/** Plain words for a refused pass, for the device to show. */
export const PASS_ERRORS = {
  no_pass: "This device is not linked to a family. Ask a parent to link it.",
  bad_pass: "This device's pass could not be read. Ask a parent to link it again.",
  bad_signature: "This device's pass was not signed by KitchenTableAI. Ask a parent to link it again.",
  not_yet: "This device's clock is ahead. Check the date and time, then try again.",
  expired: "This device's pass ran out. Reload to get a new one.",
  too_long: "This device's pass is not valid. Reload to get a new one.",
  wrong_person: "This pass is for someone else in the family. Pick your own name and try again.",
  agreement_changed: "Your family's Agreement changed. Reload to get the new one.",
  locked: "This service is open to invited families only.",
};

/**
 * The daily limit per family and the burst limit per device, in memory. A restart forgets them,
 * which is fine for a cost guard. `admit(who, dayKey)` returns null (go ahead), "day" or "burst",
 * and counts the turn only when it goes ahead.
 */
export function makeLimits({ familyTurnsPerDay, deviceTurnsPerMinute, sampleTurnsPerDay }, nowMs = () => Date.now()) {
  // Each family keeps its own date (its own time zone), so one family's midnight resets nobody else.
  const perDay = new Map();
  const recent = new Map();
  return {
    admit(who, dayKey) {
      if (who.open) return null;
      const dayCap = who.sample ? sampleTurnsPerDay : familyTurnsPerDay;
      const famKey = who.sample ? "sample" : `fam:${who.family}`;
      const day = perDay.get(famKey);
      const used = day && day.date === dayKey ? day.n : 0;
      if (used >= dayCap) return "day";
      const devKey = who.sample ? "sample" : `dev:${who.device}`;
      const t = nowMs();
      const times = (recent.get(devKey) ?? []).filter((x) => t - x < 60_000);
      if (times.length >= deviceTurnsPerMinute) {
        recent.set(devKey, times);
        return "burst";
      }
      times.push(t);
      recent.set(devKey, times);
      perDay.set(famKey, { date: dayKey, n: used + 1 });
      return null;
    },
  };
}
