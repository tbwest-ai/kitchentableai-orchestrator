// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixtures for the tests: the builder's own Rivera export (its golden file, copied
// verbatim from the builder's test fixtures), a setup for it, the model policy with short timeouts,
// and a scripted stand-in for the inference API. Everyone here is synthetic.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { loadSigningKey } from "../lib/sign.mjs";
import { cleanResults } from "../lib/search.mjs";

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

/** The same setup with "Parents can read Maya's chats" turned on. Theo's stays off. */
export const riveraReading = (over = {}) => riveraSetup({ people: { ...riveraSetup().people, id3: { pronouns: "she", age: 9, transcripts: true } }, ...over });

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
    if (s.throws) throw Object.assign(new Error(s.throws), { kind: s.throws, status: s.status ?? null });
    return { content: s.content ?? "", toolCalls: s.toolCalls ?? [], usage: { prompt_tokens: 100, completion_tokens: 20 }, model: body.model, finish: s.finish ?? "stop", ms: s.delayMs ?? 5 };
  };
  return { infer, calls };
}

// --- web search ---------------------------------------------------------------------------------

export const SEARCH_POLICY = JSON.parse(readFileSync(join(ROOT, "policy", "search-policy.json"), "utf8"));

/** A model's request for one search, as the inference API returns it. */
export const searchCall = (query, id = "call_1") => ({ id, type: "function", function: { name: "search", arguments: JSON.stringify({ query }) } });

/** Three results as Tinfoil's search server returns them. Every site here is made up. */
export const SAMPLE_RESULTS = [
  { title: "Harbor City Otters win 4 to 2", url: "https://www.otters-hockey.example/recap/1107", content: "The Otters beat the Lakeside Herons 4 to 2 on Saturday night.", published_date: "2026-11-08T03:10:00Z" },
  { title: "Otters schedule and results", url: "https://sports.example.org/otters/schedule", content: "Next game: Thursday at home against the Pinecrest Owls.", published_date: "2026-11-07" },
  { title: "League standings", url: "https://league.example.net/standings", content: "The Otters are second in the division with 19 points." },
];

/**
 * A scripted stand-in for the search service. `results` is a list or a function (query, n) -> list;
 * `fails` makes it throw that kind. Records every query it was sent and with which limits.
 */
export function scriptedSearch(results = SAMPLE_RESULTS, { filter = { checked: true, masked: false }, fails = null } = {}) {
  const queries = [];
  const search = async (query, opts = {}) => {
    queries.push({ query, opts });
    if (fails) throw Object.assign(new Error(fails), { kind: fails });
    const list = typeof results === "function" ? results(query, queries.length) : results;
    return { results: cleanResults(list, opts), filter, ms: 7 };
  };
  return { search, queries };
}

/** 4:00pm on Tuesday 2026-11-03 in New York (21:00 UTC). */
export const TUESDAY_4PM = new Date("2026-11-03T21:00:00Z");
/** 11:00pm on Tuesday 2026-11-03 in New York. */
export const TUESDAY_11PM = new Date("2026-11-04T04:00:00Z");
