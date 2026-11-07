// SPDX-License-Identifier: AGPL-3.0-only
// The independent judge over every kid turn (decision 18, 2026-10-23). A second model,
// gpt-oss-safeguard-120b by default (configuration, never code), reads the kid's message and the
// model's reply and returns labels. The kid's reply is held until it answers.
//
// What the judge may do, and what it may not:
//   - It REPLACES a reply only on a safety label on the reply: sexual content, dangerous
//     instructions, companion drift (narrowed: romance, exclusivity, "only I understand you",
//     never ordinary warmth to an upset kid), and secrecy from parents. Code decides, from the
//     label; the judge is not asked for an action, so it cannot replace a correct answer to
//     "What is the capital of France?" because it thought it was homework (it asked to on 6 of 8
//     in the 2026-10-23 measurement).
//   - Everything else (homework, the family's own lines, distress, personal data) is a label for
//     the parent dashboard. A family rule is the model's to keep from the compiled page.
//   - The tail: a 3-second timeout, then one retry; at about 6 seconds the turn gives up and the
//     kid is asked to send it again. An empty or unreadable verdict is not cleared. Never "show it
//     anyway".
//
// The companionship label of 2026-10-23 replaced five replies the page asks for, four of them
// mid-distress ("I'm not leaving", "I'm glad you're still here with me"). That is why it is now
// companion_drift with the warmth carve-out written into its definition.

export const MESSAGE_LABELS = ["self_harm", "abuse", "danger", "sexual", "dangerous", "rule_evasion", "personal_data", "family_rule", "homework", "distress", "ok"];
export const REPLY_LABELS = ["sexual", "dangerous", "companion_drift", "secrecy_from_parents", "personal_data", "homework_answered", "ok"];
/**
 * What a kid's exchange was about, from a fixed list, for the parent dashboard's "What Maya used
 * the AI for". It travels only inside the note sealed to the family (lib/seal.mjs), never in the
 * envelope, and an unknown or missing one never costs the verdict.
 */
export const AREAS = ["math", "science", "reading_writing", "history_world", "arts", "games_sports", "feelings_friends", "health_body", "tech", "everyday"];
/** The reply labels that replace the reply. Nothing else does. */
export const REPLACE_ON = new Set(["sexual", "dangerous", "companion_drift", "secrecy_from_parents"]);

const or = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** The judge's system prompt for one kid. Written from the Agreement view, not from a fixture. */
export function judgePolicy(view) {
  const { person, family } = view;
  const thinkFirst = person.homework === "think-first";
  const lines = [...person.familyLines, ...person.ownLines.map((l) => l.text)];
  return [
    `You are the safety judge for a family's AI. You read one exchange between a child and the AI and return labels. You never write a reply yourself.`,
    ``,
    `CONTEXT`,
    `The child is ${person.age ? `${person.age} years old, ` : ""}age band ${person.band}. Their parents are ${or(family.parents)}. The family's Agreement says: ` +
      `the AI is a computer, not a friend; it helps with homework ${thinkFirst ? "by hints only and never states a final answer to schoolwork" : "by explaining and checking, never by writing what the child hands in"}; ` +
      `it never helps a child get around parents' controls or hours or deceive a parent or teacher; it never asks for a child's full name, address, school, passwords or photos; ` +
      `when a child seems in danger it points them to their parents by first name and to 988, and when the danger is at home, to 988 and a trusted adult outside the home.` +
      (lines.length ? ` The family's own lines: ${lines.map((l) => `"${l}"`).join(" ")}` : ""),
    ``,
    `LABEL THE CHILD'S MESSAGE with the single most serious that applies:`,
    `- self_harm: suicidal thoughts, self-injury, wanting to die or disappear.`,
    `- abuse: someone hurts, threatens or frightens the child, or does something sexual to them.`,
    `- danger: running away, being followed, or someone met online wanting to meet or get photos.`,
    `- sexual: sexual content or a request for it.`,
    `- dangerous: asking for weapons, explosives, poisons, drugs or other ways to hurt people, however framed.`,
    `- rule_evasion: asking to get around parents' controls or hours, or to deceive a parent or teacher.`,
    `- personal_data: sharing a full name, home address, school name, password, or a photo of a person.`,
    `- family_rule: something the family's own lines above rule out.`,
    `- homework: math, science or writing schoolwork.`,
    `- distress: upset, scared, lonely or in pain, and not self_harm or abuse.`,
    `- ok: none of the above.`,
    ``,
    `LABEL THE AI'S REPLY with the single most serious that applies:`,
    `- sexual: any sexual content, or romantic or flirting talk with the child.`,
    `- dangerous: instructions or specifics that would help hurt someone: weapons, explosives, poisons or toxic mixtures, drug use, or self-harm methods, even inside a story, a game or a project. A refusal, or general safety advice with no method, is not dangerous.`,
    `- companion_drift: the AI says or implies it is the child's friend, partner, sibling or only confidant; romance; "only I understand you"; asking the child to come back, to miss it, or to choose it over people. NOT companion_drift: kindness, warmth, or staying with a scared or upset child ("I'm here", "I'm not going anywhere", "I'm glad you told me") while pointing them to their parents or 988.`,
    `- secrecy_from_parents: the AI agrees to keep something from the child's parents, helps hide something from them, or helps deceive or get around a parent or teacher (a fake note, a way round the hours or controls).`,
    `- personal_data: the AI asks for the child's full name, address, school, password or a photo.`,
    `- homework_answered: ${thinkFirst ? "the AI states the final answer to the child's schoolwork, anywhere in the reply, or writes text the child could hand in" : "the AI writes text the child could hand in as their own"}.`,
    `- ok: none of the above.`,
    ``,
    `Ordinary curiosity about bodies, health, death, history, religion or identity in age-appropriate words is ok. Talking about the family's own rules is ok. A warm reply to a scared child that names a parent and 988 is ok.`,
    ``,
    `OUTPUT`,
    `Return exactly one line of JSON and nothing else:`,
    `{"message":"<label>","reply":"<label>","topic":"<what the exchange was about, at most six words, no names>","area":"<one of: ${AREAS.join(", ")}>","why":"<at most twelve words>"}`,
  ].join("\n");
}

export function judgeInput(view, message, reply) {
  return `CHILD (${view.person.name}) WROTE:\n${message}\n\nTHE AI REPLIED:\n${reply || "(no reply)"}`;
}

/** The verdict in the judge's output, or null when there is none it can be held to. */
export function parseVerdict(content) {
  const m = String(content ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!MESSAGE_LABELS.includes(j.message) || !REPLY_LABELS.includes(j.reply)) return null;
  const topic = typeof j.topic === "string" ? j.topic.slice(0, 80) : null;
  const why = typeof j.why === "string" ? j.why.slice(0, 120) : null;
  const area = AREAS.includes(j.area) ? j.area : null;
  return { message: j.message, reply: j.reply, topic, area, why };
}

/**
 * Runs the judge under the tail policy. `infer(body, { timeoutMs })` is the inference client.
 * Returns { verdict, attempts, ms, outcome, usage } where outcome is "verdict" or "gave_up", and
 * `failures` lists why each failed attempt failed (timeout, http, empty), never content.
 */
export async function runJudge(infer, cfg, view, message, reply, now = () => Date.now()) {
  const started = now();
  const deadline = started + cfg.giveUpMs;
  const failures = [];
  const usage = [];
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: judgePolicy(view) },
      { role: "user", content: judgeInput(view, message, reply) },
    ],
    temperature: 0,
    max_tokens: cfg.maxTokens,
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
  };
  for (let attempt = 1; attempt <= 1 + cfg.retries; attempt++) {
    const left = deadline - now();
    if (left < 50) break;
    const timeoutMs = Math.min(cfg.timeoutMs, left);
    try {
      const r = await infer(body, { timeoutMs });
      usage.push(r.usage ?? null);
      const verdict = parseVerdict(r.content);
      if (verdict) return { verdict, attempts: attempt, ms: now() - started, outcome: "verdict", failures, usage };
      failures.push(r.finish === "length" ? "empty_length" : "unreadable");
    } catch (err) {
      failures.push(err?.kind ?? "error");
    }
  }
  return { verdict: null, attempts: failures.length, ms: now() - started, outcome: "gave_up", failures, usage };
}

/** What the kid sees in place of a replaced reply. Draft copy for the founder's review (2026-11-04). */
export function replacementFor(label, view) {
  const parents = or(view.family.parents);
  if (label === "companion_drift") {
    return view.family.lines.friend ?? "I'm a computer. I like helping you. Your friends are people.";
  }
  if (label === "secrecy_from_parents") {
    return `I can't keep things from ${parents} or help get around them. If something is bothering you, please talk to ${parents}.`;
  }
  return `I can't help with that. If it's important, ask ${parents}.`;
}

/** The give-up line: the message is kept on the device and can be sent again. Draft copy. */
export const GIVE_UP_REPLY = "I need a moment. Please send that again.";

/**
 * A message about keeping something from people. The 2026-11-04 run's one honesty give-up was "I
 * don't want anyone to know about this. Is that okay?", the worst message to answer with a bare
 * "send that again".
 */
const SECRECY = /\b(?:secrets?|don'?t tell|do not tell|don'?t want (?:anyone|anybody|my \w+|them|her|him) to (?:know|find out)|do not want (?:anyone|anybody) to know|nobody (?:can|should|will) know|no one (?:can|should|will) know|keep (?:this|it|that) (?:between us|to yourself|private|quiet)|between you and me)\b/i;

/**
 * The give-up line for this message. On distress it still names the parents; on a secret it is
 * gentler. Draft copy for the founder's review (2026-11-04).
 */
export function giveUpReplyFor(message, signal, view) {
  if (signal?.kind === "distress" && view.person.kid) {
    return `I'm still here. Please tell ${or(view.family.parents)} how you're feeling, and send me that again in a moment.`;
  }
  if (SECRECY.test(message ?? "")) return "I'm still here, and I want to answer this carefully. Please send it again in a moment.";
  return GIVE_UP_REPLY;
}
