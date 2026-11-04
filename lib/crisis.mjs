// SPDX-License-Identifier: AGPL-3.0-only
// The crisis floor (floor item 7): when a message suggests self-harm, abuse or danger, the help
// the family's Agreement promises reaches the person, whatever the model wrote.
//
// Ported from the local prototype's crisis check, where it was measured: on the shipping 4B model
// the prompt alone got both the crisis line and a person to tell into 3 of 12 crisis replies. On
// GLM 5.3 under the compiled page (2026-10-23, two-arm runs) the page alone does far better, and
// this floor still caught the online-stranger message three times where the model named neither
// 988 nor a parent. So it stays, with the changes those runs asked for:
//
//   - "Already said" means the parents' first names and 988 appear in the reply, not the words
//     "trusted adult" (which it added to replies that already named Dana and Marco).
//   - Abuse leads with 988 and a trusted adult outside the home, such as a teacher, and never
//     names the parents (the founder, 2026-11-02: "988 and an adult outside").
//   - Distress (scared, hurting, "i need help", "don't leave me") gets the parents by name and no
//     helpline: "call 988" under "I'm scared you're not giving me clear answers" is the wrong size,
//     and a message that warrants the line matches a crisis pattern. On the red-team turns the
//     distress phrases caught 12 of 12, against 8 of 12 for the page alone.
//
// It only ever adds sentences after the model's reply. It never removes or rewrites what the
// model said: a warm reply stays warm. Where there is no model reply (out of hours, the model
// down), the person gets the fixed crisis reply instead.
//
// Detection is term matching, with the limits that implies: euphemism, other languages,
// misspelling and a conversation that builds over several turns all pass. It requires the first
// person on purpose, so an essay on Romeo and Juliet or "this homework is killing me" gets no
// helpline. A false positive costs two unneeded sentences; a false negative leaves the reply as the
// model wrote it. The judge reads every kid turn as well.

/** Typographic quotes to ASCII, lower case, collapsed spacing. Models and phones both curl. */
export function normalise(s) {
  return s
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Idioms that borrow crisis words and mean nothing of the kind. Removed before matching. */
const IDIOMS = [
  /\b(?:die|dying|died) (?:of|from) (?:embarrassment|boredom|shame|cringe|laughter|laughing|hunger|thirst)\b/g,
  /\bdying to (?:know|see|go|try|tell|meet|get|have|find out|hear|play)\b/g,
];

const FAMILY_WORDS =
  "(?:dad|mum|mom|father|mother|stepdad|stepmum|stepmom|step-dad|step-mum|step-mom|parents?|uncle|aunt|brother|sister|grandad|grandpa|grandma|nan|family)";

const PATTERNS = [
  // --- self-harm ------------------------------------------------------------
  { kind: "self_harm", label: "kill myself", re: /\bkill(?:ing)? myself\b/ },
  { kind: "self_harm", label: "method, first person", re: /\b(?:poison|drown|hang|stab|shoot|strangle|suffocate|overdose)(?:ing)?\s+myself\b/ },
  {
    kind: "self_harm",
    label: "intends to hurt self",
    re: /\b(?:want(?:ing)?|wanna|plan(?:ning)?|try(?:ing)?|thinking about|think about|thought about|feel like|urge to)\s+(?:to\s+)?(?:hurt|harm|cut|burn|starv|punish|hit)\w*\s+myself\b/,
  },
  { kind: "self_harm", label: "hurting self", re: /\b(?:i|i've|ive|i have|i keep|i started|i still)\s+(?:been\s+)?(?:cutting|hurting|harming|burning|starving)\s+myself\b/ },
  { kind: "self_harm", label: "self-harm, first person", re: /\b(?:i|i've|ive|i have|i'm|im|i am)\s+(?:been\s+)?(?:started\s+|keep\s+)?self[- ]?harm(?:ing)?\b/ },
  { kind: "self_harm", label: "wants to die", re: /\b(?:want(?:ing)?|wanna|planning|ready)\s+to\s+die\b/ },
  {
    kind: "self_harm",
    label: "does not want to be alive",
    re: /\b(?:don't|dont|do not|no longer|never)\s+want\s+to\s+(?:be alive|exist|wake up|be here anymore|keep living|go on living|live anymore|live(?!\s+(?:in|with|at|near|there|here|on|by)\b))\b/,
  },
  { kind: "self_harm", label: "wishes to be dead", re: /\bwish(?:ing|ed|es)?\s+(?:i|i'd|id)\s+(?:was|were|had)\s+(?:dead|never born|never been born|not been born|not born)\b/ },
  { kind: "self_harm", label: "wishes not to exist", re: /\bwish(?:ing|ed|es)?\s+i\s+(?:didn't|did not|could stop|could just stop)\s+exist(?:ing)?\b/ },
  { kind: "self_harm", label: "end my life", re: /\bend\s+(?:my life|it all)\b/ },
  { kind: "self_harm", label: "suicidal", re: /\b(?:i'm|im|i am|i feel|feeling|i've been|ive been|i have been|i get)\s+(?:so\s+|really\s+|very\s+|kind of\s+|kinda\s+)?suicidal\b/ },
  { kind: "self_harm", label: "thinks about suicide", re: /\b(?:thinking|thoughts|thought|think)\s+(?:about|of)\s+(?:suicide|killing myself|ending it|ending my life|dying)\b/ },
  { kind: "self_harm", label: "better off without me", re: /\bbetter off (?:without me|if i (?:was|were) (?:dead|gone)|dead)\b/ },
  { kind: "self_harm", label: "no reason to live", re: /\bno (?:reason|point) (?:to|in) (?:live|living|being alive|going on)\b/ },
  {
    kind: "self_harm",
    label: "overdose intent",
    re: /\b(?:take|took|swallow|swallowed|taking)\s+(?:all|a lot|loads|a bunch|a whole bottle|the whole bottle)\s+of\s+(?:the\s+|my\s+|[a-z]+'s\s+)?(?:pills|tablets|medicine|meds)\b/,
  },

  // --- abuse ----------------------------------------------------------------
  {
    kind: "abuse",
    label: "someone hurts me",
    re: new RegExp(
      String.raw`\b(?:someone|somebody|he|she|they|a grown-?up|an adult|a man|a woman|a teacher|a coach|my\s+(?:${FAMILY_WORDS.slice(3, -1)}|teacher|coach|tutor|babysitter|boyfriend|girlfriend|cousin|neighbou?r|mum's boyfriend|mom's boyfriend|dad's girlfriend))(?:\s+(?:at|in|from|who lives in|who lives at)\s+(?:home|school|my house|my home|my family|my class|the house|our house))?\s+(?:always\s+|keeps\s+|keeps on\s+|sometimes\s+|still\s+|often\s+)?(?:hits|hurts|kicks|slaps|punches|chokes|burns|touches|grabs|whips|hit|hurt|kicked|slapped|punched|choked|burned|touched|grabbed|hitting|hurting|kicking|slapping|punching|choking|burning|touching|grabbing)\s+me\b`,
    ),
  },
  { kind: "abuse", label: "beats me up", re: /\bbeat(?:s|ing)? me up\b/ },
  {
    kind: "abuse",
    label: "scared at home",
    re: new RegExp(
      String.raw`\b(?:i'm|im|i am|i feel|i get)\s+(?:so\s+|really\s+|very\s+)?(?:scared|afraid|frightened|terrified)\s+(?:of|to go|to be|when i'm|when i am)\s+(?:home|at home|going home|my\s+${FAMILY_WORDS})(?!')\b`,
    ),
  },
  { kind: "abuse", label: "not safe at home", re: new RegExp(String.raw`\b(?:not|don't feel|do not feel|never feel)\s+safe\s+(?:at home|in my house|in my home|with my\s+${FAMILY_WORDS})\b`) },
  { kind: "abuse", label: "does not feel safe", re: /\bi\s+(?:don't|do not|never)\s+feel\s+safe\b/ },
  { kind: "abuse", label: "unwanted touching", re: /\btouch(?:es|ed|ing)?\s+me\s+(?:where|in places|down there|in a (?:bad|weird|wrong) way)\b/ },

  // --- danger ---------------------------------------------------------------
  { kind: "danger", label: "running away", re: /\b(?:going to|gonna|want to|wanna|planning to|about to)\s+run away\b|\bran away from home\b/ },
  { kind: "danger", label: "being followed", re: /\b(?:someone|somebody|a man|a woman|a stranger)\s+(?:is|keeps|has been|was)\s+(?:following|stalking)\s+me\b/ },
  {
    kind: "danger",
    label: "online stranger wants to meet",
    re: /\b(?:someone|somebody|a person|a man|a woman|a guy|a stranger)\s+(?:i|i've|ive)\s+(?:met|been talking to|talk to|chat with|chatted with)\s+online\s+(?:wants|asked|asks|told)\s+me\s+to\s+(?:meet|send)\b/,
  },
];

/** Distress in plain words: first person, the feeling as the person's own state, or the whole message. */
const DISTRESS = [
  { label: "scared", re: /\b(?:i'm|im|i am|i feel)\s+(?:so\s+|really\s+|very\s+)?(?:scared|frightened|terrified|afraid)\b(?!\s+(?:of|for|to|that|about|the|you'll|you will|it'll|it will)\b)/ },
  { label: "hurting", re: /\b(?:i'm|im|i am)\s+(?:really\s+|so\s+)?(?:hurting|in pain|in so much pain)\b/ },
  { label: "wants pain", re: /\bi\s+(?:need|want)\s+(?:pain|to hurt|to be hurt)\b(?!\s+(?:him|her|them|you|someone|somebody)\b)/ },
  { label: "asks for help", re: /\b(?:i need help|please help me|help me please|somebody help me|someone help me|can you help me please)\s*(?:now|right now|please)?\s*[.!?]*\s*$/ },
  { label: "abandoned", re: /\b(?:abandoning me|abandon me|don't leave me|do not leave me|nobody (?:cares|loves) (?:about )?me|no one (?:cares|loves) (?:about )?me|i hate myself|everyone hates me)\b/ },
];

/** The first crisis pattern the message matches: { kind, label }, or null. The label is never the person's words. */
export function detectCrisis(message) {
  let text = normalise(message ?? "");
  for (const idiom of IDIOMS) text = text.replace(idiom, " ");
  for (const p of PATTERNS) if (p.re.test(text)) return { kind: p.kind, label: p.label };
  for (const p of DISTRESS) if (p.re.test(text)) return { kind: "distress", label: p.label };
  return null;
}

// --- the help, in words --------------------------------------------------------------------------
// Draft copy for the founder's review (2026-11-04). The opening two sentences are the prototype's.

export const OPENING = "I'm really glad you told me.";
export const NOT_ALONE = "You don't have to deal with this on your own.";
const or = (names) => (names.length <= 1 ? names[0] ?? "" : names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);

export const sentences = {
  tellParents: (parents) => `Please tell ${or(parents)} right now.`,
  line: () => "You can also call or text 988, the Suicide and Crisis Lifeline, any time.",
  abuseLine: () => "Please call or text 988, the Suicide and Crisis Lifeline. They can help you stay safe.",
  outsideAdult: () => "You can also tell a trusted adult outside your home, like a teacher or a school counselor.",
  distressParents: (parents) => `Please tell ${or(parents)} how you're feeling. A person can help in ways I can't.`,
  adultLine: () => "You can call or text 988, the Suicide and Crisis Lifeline, any time, and it can help to reach out to someone you trust.",
};

/**
 * The reply sends the person to a parent by first name: a verb of telling or going within one
 * sentence before the name ("please tell Dana", "go find Marco", "let Dana or Marco know"). A
 * mention is not enough: on the 2026-11-04 red-team run a distressed kid was asked "Are Dana or
 * Marco somewhere in the house right now?", a yes-or-no question that tells them nothing to do,
 * and a mention-only check added nothing. The verbs are the measurement harness's own.
 */
const DIRECTIVE = "(?:tell|telling|talk to|talk with|speak to|speak with|reach out to|let|go to|go find|go get|find|get|ask|check with|wake|wake up|call|show|turn to)";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sendsToParents = (text, names) =>
  names.length > 0 && new RegExp(`\\b${DIRECTIVE}\\b[^.!?]{0,40}(?:^|[^\\p{L}])(?:${names.map(escapeRe).join("|")})(?:$|[^\\p{L}])`, "iu").test(text);
const has988 = (text) => /(?:^|[^0-9])988(?:$|[^0-9])/.test(text);
const OUTSIDE_ADULT = /\b(?:teacher|school counsel(?:l)?or|counsel(?:l)?or|school nurse|coach|trusted adult outside|adult outside|grown-?up outside)\b/i;

/**
 * What the reply is missing from the help the floor guarantees, as text to append.
 * `person` is { kid }, `parents` the parents' first names. Returns { addendum, added }.
 */
export function crisisAddendum(reply, signal, { kid, parents }) {
  if (!signal) return { addendum: "", added: [] };
  const text = normalise(reply ?? "");
  const out = [];
  const added = [];
  if (!kid) {
    if (signal.kind !== "distress" && !has988(text)) {
      out.push(sentences.adultLine());
      added.push("988");
    }
  } else if (signal.kind === "abuse") {
    if (!has988(text)) {
      out.push(sentences.abuseLine());
      added.push("988");
    }
    if (!OUTSIDE_ADULT.test(text)) {
      out.push(sentences.outsideAdult());
      added.push("outside_adult");
    }
  } else if (signal.kind === "distress") {
    if (!sendsToParents(text, parents)) {
      out.push(sentences.distressParents(parents));
      added.push("parents");
    }
  } else {
    if (!sendsToParents(text, parents)) {
      out.push(sentences.tellParents(parents));
      added.push("parents");
    }
    if (!has988(text)) {
      out.push(sentences.line());
      added.push("988");
    }
  }
  if (!out.length) return { addendum: "", added };
  const joined = out.join(" ");
  return { addendum: (reply ?? "").trim() ? `\n\n${joined}` : joined, added };
}

/** The whole reply where there is no model reply to add to: out of hours, or the model unreachable. */
export function crisisReply(signal, { kid, parents }) {
  if (!kid) return `${OPENING} ${NOT_ALONE} ${sentences.adultLine()}`;
  if (signal?.kind === "abuse") return `${OPENING} ${NOT_ALONE} ${sentences.abuseLine()} ${sentences.outsideAdult()}`;
  if (signal?.kind === "distress") return `${OPENING} ${sentences.distressParents(parents)}`;
  return `${OPENING} ${NOT_ALONE} ${sentences.tellParents(parents)} ${sentences.line()}`;
}
