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
 * A scripted inference API. `chat`, `judge` and `homeCheck` are each a function (body, n) ->
 * { content, delayMs? } or a value; `n` counts calls of that kind. Records every body it was sent.
 */
export function scriptedInfer({ chat = "Here is a hint: what do you get if you count by sevens?", judge = { message: "ok", reply: "ok", topic: "a question", why: "fine" }, homeCheck = { home: "no" }, photo = SAMPLE_DESCRIPTION, chatFails = 0 } = {}) {
  const calls = { chat: [], judge: [], homeCheck: [], photo: [] };
  const infer = async (body, { timeoutMs }) => {
    // The safeguard model answers two things: the judge's labels, and, before a parent alert, the
    // one question about trouble at home (lib/alert.mjs). They are scripted apart.
    const isCheck = /safeguard/.test(body.model) && /^You check one thing/.test(body.messages?.[0]?.content ?? "");
    const isJudge = /safeguard/.test(body.model) && !isCheck;
    // The vision model describes a photo (lib/attachments.mjs); it is scripted apart too.
    const isPhoto = body.model === ATTACHMENT_POLICY.photo.model;
    const kind = isPhoto ? "photo" : isCheck ? "homeCheck" : isJudge ? "judge" : "chat";
    calls[kind].push(body);
    const n = calls[kind].length;
    if (kind === "chat" && n <= chatFails) throw Object.assign(new Error("down"), { kind: "http", status: 503 });
    const script = isPhoto ? photo : isCheck ? homeCheck : isJudge ? judge : chat;
    const spec = typeof script === "function" ? script(body, n) : script;
    const s = typeof spec === "string" ? { content: spec } : spec && ("content" in spec || "throws" in spec) ? spec : { content: JSON.stringify(spec) };
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

// --- a photo and the family's documents -----------------------------------------------------------

export const ATTACHMENT_POLICY = JSON.parse(readFileSync(join(ROOT, "policy", "attachment-policy.json"), "utf8"));
export const SAMPLE_DESCRIPTION = "A math worksheet titled Fractions Practice. Question 3 reads: Which is larger, 3/4 or 5/8? Show how you know. Below it is a drawing of two pizzas cut into slices.";

/** A small JPEG's worth of bytes: the three bytes every JPEG starts with, then filler. Nothing opens it in a test. */
export const samplePhoto = (bytes = 3000, type = "image/jpeg") => {
  const head = type === "image/png" ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : type === "image/webp" ? [...Buffer.from("RIFF0000WEBP", "latin1")] : [0xff, 0xd8, 0xff, 0xe0];
  return { type, data_b64: Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, bytes - head.length), 7)]).toString("base64") };
};

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

// --- the parent alert ---------------------------------------------------------------------------

/**
 * A scripted stand-in for the family's account: records every alert it was sent. By default it
 * takes the alert, as the account does. `ok: false` with a `result` refuses it; `delayMs` answers
 * late (and is cut off at the caller's timeout, as the real sender is); `throws` makes it throw.
 */
export function scriptedAlert({ ok = true, result = "ok", delayMs = 0, throws = false, onSend = null } = {}) {
  const sent = [];
  const send = async (alert, opts = {}) => {
    sent.push({ alert, opts });
    onSend?.(alert);
    if (throws) throw new Error("account unreachable");
    if (delayMs) {
      const waited = Math.min(delayMs, opts.timeoutMs ?? delayMs);
      await new Promise((r) => setTimeout(r, waited));
      if (delayMs > (opts.timeoutMs ?? Infinity)) return { ok: false, result: "timeout", ms: waited };
    }
    return { ok, result, ms: delayMs };
  };
  return { send, sent };
}
