// SPDX-License-Identifier: AGPL-3.0-only
// The honesty check (floor item 9): what the reply says about who can see this, whether it is
// stored, whether anything was deleted, and whether a parent was told, measured against what is
// true and what this system actually did this turn. A false claim is replaced, sentence by
// sentence, with the true one; the rest of the reply is untouched.
//
// Ported from the local prototype. Measured on GLM 5.3 (2026-10-23): told nothing about storage,
// the model denied it on 33 of 36 direct probes; the compiled page now says the storage truth, and
// this stays as the second line (the honesty set went from 104 to 137 of 144 with it). The same
// runs found the model saying "I'm sending a message to your parent right now" and "I already sent
// word" when nothing could send anything, so the promise patterns read those forms too.
//
// The false-positive property: a correction replaces the matched sentence with a statement that
// is true. If the matcher fires on a sentence that was already true, the cost is a blunter
// sentence, never a wrong one.

const normaliseQuotes = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

/** Split into sentences, keeping the delimiter and trailing space. Over-splitting is harmless here. */
export function sentences(text) {
  return text.match(/[^.!?]*[.!?]+[\s]*|[^.!?]+$/g) ?? (text ? [text] : []);
}

const VISIBILITY_DENIALS = [
  /\b(no ?one|nobody|no-one)\b[^.!?]{0,40}\b(see|sees|read|reads|look at|access)\b/i,
  /\bonly (you and (me|i)|the two of us|us|me and you)\b/i,
  /\b(just|only) between (you and (me|i)|us)\b/i,
  /\b(mum|mom|mother|dad|father|parent|parents)\b[^.!?]{0,30}\b(can'?t|cannot|won'?t|do(es)? ?n'?t|will not)\b[^.!?]{0,25}\b(see|read|know|find out)\b/i,
  /\b(can'?t|cannot|won'?t|do(es)? ?n'?t)\b[^.!?]{0,20}\b(be seen|be read)\b/i,
  /\bstays? between us\b/i,
  /\b(this is|it'?s|its) (completely |totally |entirely |)private\b/i,
];

// "Remember" is not a storage verb here. The AI keeps no memory between chats, and the compiled
// page asks it to say so ("you yourself will not remember it next time"); the 2026-11-04 deployed
// run found this check replacing that true sentence, most of its 21 storage corrections. "I don't
// store or remember it" still counts, through the first verb.
const STORAGE_DENIALS = [
  /\b(not|isn'?t|aren'?t|never|nothing|no)\b[^.!?]{0,25}\b(saved|stored|recorded|kept|written down)\b/i,
  /\bi (don'?t|do not|won'?t|will not|can'?t|cannot)\s+(save|store|keep|record)(\s+(or|and|nor)\s+(save|store|keep|record|remember))?\s+(any of |all of |)(this|that|it|these|them|anything|your messages?|what (you|we)('?ve| have|'?d| did|)\s*(say|said|type|typed|write|wrote|talked about)|our (chat|conversation|conversations))\b/i,
  /\bno record\b/i,
  // A claim that the chat goes at once. Not when the word before says it doesn't: "it isn't gone
  // straight away" is true, and the 2026-11-04 run saw this pattern replace it.
  /(?<!\b(?:isn'?t|is not|aren'?t|are not|wasn'?t|was not|not|never|nothing|won'?t be|will not be|doesn'?t get|don'?t get|does not get|do not get)\s+(?:\w+\s+)?)\b(deleted|erased|gone)\b[^.!?]{0,20}\b(right away|immediately|straight away|as soon as)\b/i,
  /\b(disappears?|vanishes?)\b[^.!?]{0,25}\b(when|after|once)\b/i,
];

/**
 * A sentence about the AI's own memory ("nothing is kept from one chat to the next in my memory")
 * is true here and is left alone, unless it also denies that the chat is saved or claims it is gone.
 */
const MEMORY_TALK = /\b(?:remember|remembers|memory|memories|from one chat|next chat|next time|start(?:s)? (?:every chat |each chat )?fresh)\b/i;
const STORED_WORDS = /\b(?:save|saves|saved|store|stores|stored|record|records|recorded|written down|deleted|erased|gone)\b/i;
const aboutMemoryOnly = (s) => MEMORY_TALK.test(s) && !STORED_WORDS.test(s);

const DELETION_CLAIMS = [
  /\bi('| wi)?ll\s+(now\s+|just\s+|right now\s+)?(delete|erase|remove|wipe|forget)\b/i,
  /\bi(?:'ve)?(?:\s+(?:have|just))*\s*(?:deleted|erased|removed|wiped)\b/i,
  /\bi\s+can\s+(delete|erase|remove|wipe)\b/i,
  /\b(it'?s|that'?s|this is)\s+(now\s+)?(deleted|erased|removed|gone)\b/i,
  /\bconsider it (deleted|erased|gone|forgotten)\b/i,
];

/** Who a promise to tell names: a parent by role, or by first name. */
function parentWords(parents) {
  const names = parents.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?:(?:your|a|the|both your|one of your)\\s+(?:parents?|mom|mum|dad|father|mother|grown-?ups?|family)|${names.join("|") || "\\u0000"})`;
}

/** A promise to tell a parent, or a claim to have told one, in the forms GLM 5.3 was seen to use. */
function tellParentClaims(parents) {
  const who = parentWords(parents);
  return [
    new RegExp(
      `\\bi(?:'ll| will| am going to|'m going to| can| could| have| 've|'ve| just| already)\\s+(?:now\\s+|also\\s+|already\\s+|just\\s+|go ahead and\\s+)?(?:tell|told|let|inform|informed|notify|notified|alert|alerted|message|messaged|contact|contacted|text|texted|talk to|speak to|pass (?:this|it|that) (?:on|along) to|send (?:this|it|that|a message|a note|word) to|sent (?:this|it|that|a message|a note|word) to|share (?:this|it|that) with)\\s+${who}`,
      "i",
    ),
    new RegExp(`\\b(?:your|a|the) (?:parents?|mom|mum|dad|father|mother) (?:has|have|will|'ll|are going to|is going to) (?:now )?(?:be )?(?:been )?(?:told|notified|alerted|informed|contacted|messaged|hear about this)\\b`, "i"),
    new RegExp(`\\b(?:i'm|i am|i've|i have) (?:telling|told|letting|notifying|alerting|informing|messaging|texting|contacting) ${who}`, "i"),
    new RegExp(`\\b(?:i'm|i am|i've|i have|i)\\s+(?:now\\s+|just\\s+|already\\s+)?(?:sending|sent)\\s+(?:a message|a note|word|this|it|that|an alert)\\s+(?:to|on to|along to)\\s+${who}`, "i"),
    new RegExp(`\\b(?:a message|word|an alert|a note) (?:is|has been|was) (?:on its way|being sent|sent) to ${who}`, "i"),
  ];
}

/**
 * The true sentences for this person, compiled from the Agreement and the setup. What is saved
 * follows the founder's history model (2026-11-09): no device keeps chat history; an adult's words
 * are never saved and the family app keeps only how much they used it each day; a kid's words are
 * saved only where the family turned on "Parents can read", locked to the parent phones, for
 * retentionDays; every kid exchange leaves a locked summary, kept summaryDays.
 */
export function truthsFor(view) {
  const { person, family } = view;
  const or = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
  const and = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const days = family.retentionDays;
  if (!person.kid) {
    return {
      parentsCanRead: false,
      saved: false,
      visibility: "Nobody in the family can read this conversation.",
      storage: "Your chats with me aren't saved anywhere, and nobody in the family can read them. The family app keeps only how much you used it each day, never your words.",
      deletion: "I can't delete anything myself, and there's nothing to delete. Your chats with me aren't saved anywhere.",
      parentToldTrue: null,
      parentToldFalse: "I can't send a message to anyone myself.",
    };
  }
  return {
    parentsCanRead: person.transcripts,
    saved: person.transcripts,
    visibility: person.transcripts
      ? `${and(family.parents)} can read this conversation.`
      : `${and(family.parents)} cannot read your words. They see a short summary of each session, any safety alert, your hours and how much you use this.`,
    storage: person.transcripts
      ? `This chat is saved for ${days} days so ${and(family.parents)} can read it. It's locked, so only a parent's phone can open it.`
      : `Your words in this chat aren't saved anywhere. ${and(family.parents)} get a short summary of what each chat was about, and only a parent's phone can open it.`,
    deletion: person.transcripts
      ? `I can't delete this chat, and you can't either. It's deleted after ${days} days, or sooner if ${or(family.parents)} turns off reading your chats.`
      : `I can't delete anything myself. Your words in this chat aren't saved anywhere, and the short summary of what it was about is deleted after ${family.summaryDays} days.`,
    parentToldTrue: `A parent is being told that you may need them.`,
    parentToldFalse: `I can't send a message to anyone myself. Please go and tell ${or(family.parents)} yourself, and I can help you find the words.`,
  };
}

/**
 * Replace every false claim with the true statement. `turn.parentTold` is what this system did
 * this turn: true only when an alert was actually raised. Returns { text, corrections } where each
 * correction carries its kind, never the words.
 */
export function checkHonesty(text, view, turn = { parentTold: false }) {
  const t = truthsFor(view);
  const tell = tellParentClaims(view.family.parents);
  const corrections = [];
  const rebuilt = sentences(text ?? "")
    .map((raw) => {
      const s = normaliseQuotes(raw);
      let kind = null;
      let replacement = null;
      if (tell.some((r) => r.test(s))) {
        kind = "parent";
        replacement = turn.parentTold && t.parentToldTrue ? t.parentToldTrue : t.parentToldFalse;
      } else if (t.parentsCanRead && VISIBILITY_DENIALS.some((r) => r.test(s))) {
        // Only checked where parents can read the words: without transcripts, "your parents can't
        // read this" is true of the words, and the page says what they do see.
        kind = "visibility";
        replacement = t.visibility;
      } else if (t.saved && STORAGE_DENIALS.some((r) => r.test(s)) && !aboutMemoryOnly(s)) {
        // Only checked where the words are saved: a kid whose family turned on "Parents can read".
        // For an adult, or a kid without it, "this isn't saved" is true of the words, and the page
        // says what is (2026-11-09).
        kind = "storage";
        replacement = t.storage;
      } else if (DELETION_CLAIMS.some((r) => r.test(s))) {
        kind = "deletion";
        replacement = t.deletion;
      }
      if (!kind) return raw;
      corrections.push(kind);
      const trail = raw.match(/\s*$/)?.[0] ?? "";
      return replacement + trail;
    })
    .join("");
  return { text: rebuilt, corrections };
}
