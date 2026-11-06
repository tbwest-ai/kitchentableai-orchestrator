// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixtures for the tests: the builder's own Rivera export (its golden file, copied
// verbatim from the builder's test fixtures), a setup for it, the model policy with short timeouts,
// and a scripted stand-in for the inference API. Everyone here is synthetic.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { loadSigningKey } from "../lib/sign.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

export const riveraExport = () => JSON.parse(readFileSync(join(ROOT, "agreement", "sample-export.json"), "utf8"));
export const POLICY = JSON.parse(readFileSync(join(ROOT, "policy", "model-policy.json"), "utf8"));

/** A setup for the builder's Rivera family. Maya (id3) and Theo (id4) are the kids. */
export const riveraSetup = (over = {}) => ({
  format: "kitchentableai-setup",
  version: 1,
  timeZone: "America/New_York",
  retentionDays: 30,
  people: { id1: { pronouns: "she", age: 41 }, id2: { pronouns: "he" }, id3: { pronouns: "she", age: 9 }, id4: { pronouns: "he", age: 13 } },
  ...over,
});

/** The Rivera export with Maya on the hours setting, after school on weekdays. */
export function riveraWithHours() {
  const a = riveraExport();
  const maya = a.members.find((m) => m.id === "id3");
  maya.rules = ["balance.try-first", "balance.off-times-and-places", ...maya.rules.filter((r) => r !== "balance.try-first")];
  maya.aiSettings = ["balance.ai-hours", ...maya.aiSettings];
  return a;
}

export function testSigner() {
  const kp = generateKeyPairSync("ed25519");
  const signer = loadSigningKey({ SIGNING_KEY_PEM: kp.privateKey.export({ type: "pkcs8", format: "pem" }), ATTESTED_KEY_DIR: join(HERE, "no-such-dir") });
  return { signer, publicKey: kp.publicKey };
}

export const fastPolicy = (judge = {}) => ({ ...POLICY, judge: { ...POLICY.judge, timeoutMs: 60, retries: 1, giveUpMs: 150, ...judge } });

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("timeout"), { kind: "timeout" }));
    });
  });

/**
 * A scripted inference API. `chat` and `judge` are each a function (body, n) -> { content, delayMs? }
 * or a value; `n` counts calls of that kind. Records every body it was sent.
 */
export function scriptedInfer({ chat = "Here is a hint: what do you get if you count by sevens?", judge = { message: "ok", reply: "ok", topic: "a question", why: "fine" }, chatFails = 0 } = {}) {
  const calls = { chat: [], judge: [] };
  const infer = async (body, { timeoutMs }) => {
    const isJudge = /safeguard/.test(body.model);
    const kind = isJudge ? "judge" : "chat";
    calls[kind].push(body);
    const n = calls[kind].length;
    if (!isJudge && n <= chatFails) throw Object.assign(new Error("down"), { kind: "http", status: 503 });
    const spec = typeof (isJudge ? judge : chat) === "function" ? (isJudge ? judge : chat)(body, n) : isJudge ? judge : chat;
    const s = typeof spec === "string" ? { content: spec } : spec && "content" in spec ? spec : { content: JSON.stringify(spec) };
    if (s.delayMs) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        await sleep(s.delayMs, ac.signal);
      } finally {
        clearTimeout(t);
      }
    }
    if (s.throws) throw Object.assign(new Error(s.throws), { kind: s.throws });
    return { content: s.content ?? "", usage: { prompt_tokens: 100, completion_tokens: 20 }, model: body.model, finish: s.finish ?? "stop", ms: s.delayMs ?? 5 };
  };
  return { infer, calls };
}

/** 4:00pm on Tuesday 2026-11-03 in New York (21:00 UTC). */
export const TUESDAY_4PM = new Date("2026-11-03T21:00:00Z");
/** 11:00pm on Tuesday 2026-11-03 in New York. */
export const TUESDAY_11PM = new Date("2026-11-04T04:00:00Z");
