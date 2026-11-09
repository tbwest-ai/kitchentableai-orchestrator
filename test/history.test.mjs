// SPDX-License-Identifier: AGPL-3.0-only
// v0.5.3: what is saved, as the founder set it on 2026-11-09, for each of the three cases. No
// device keeps chat history. An adult's words are never saved, and the family app keeps only how
// much they used it each day. A kid's words are saved only where the family turned on "Parents can
// read", locked to the parent phones, for 30 days. Every kid exchange leaves a locked summary,
// kept 35 days. The page says it, and the honesty check corrects only what is false.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../lib/agreement.mjs";
import { BAND_GUIDE, compilePage } from "../lib/compile.mjs";
import { checkHonesty, truthsFor } from "../lib/honesty.mjs";
import { riveraExport, riveraReading, riveraSetup } from "./helpers.mjs";

const dana = () => resolve(riveraExport(), riveraSetup(), "id1");
const mayaRead = () => resolve(riveraExport(), riveraReading(), "id3");
const theo = () => resolve(riveraExport(), riveraSetup(), "id4");
const itemOne = (view) =>
  compilePage(view, { facts: { dateLabel: "x" } })
    .text.split("\n")
    .find((l) => l.startsWith("1. What is saved.")) ?? "";

// Denials of saving, and claims that the chat goes at once, as the model was seen to make them.
const DENIALS = [
  "Nothing here is saved.",
  "Don't worry, this isn't saved anywhere.",
  "I don't store what we've said.",
  "There's no record of this chat.",
  "It's deleted right away.",
  "Everything is gone as soon as you close the app.",
];

test("the page: an adult's chats are never saved, and the family app keeps only daily use", () => {
  const t = itemOne(dana());
  assert.match(t, /Dana's chats are never saved anywhere, and nobody in the family can read them\./);
  assert.match(t, /No device keeps chat history: each time Dana opens her profile, the chat starts fresh\./);
  assert.match(t, /The family app keeps only how much she used you each day, never her words\./);
  assert.match(t, /say plainly that it is not/);
  assert.doesNotMatch(t, /\bwords (?:in each chat )?are saved\b|30 days|35 days|summary|parent dashboard/);
  assert.doesNotMatch(t, /a kid's account/);
});

test("the page: a kid with Parents can read on, words saved 30 days, a summary 35", () => {
  const t = itemOne(mayaRead());
  assert.match(t, /The family turned on "Parents can read Maya's chats", so Maya's words in each chat are saved, locked so only a parent's phone can open them\./);
  assert.match(t, /Dana and Marco can read them in the parent dashboard, and they are deleted after 30 days\./);
  assert.match(t, /a short summary \(what it was about, and an area such as math or feelings\) is saved, locked so only a parent's phone can open it, and kept 35 days\./);
  assert.match(t, /No device keeps chat history: each time Maya opens her profile, the chat starts fresh\./);
  assert.match(t, /Maya cannot delete any of it, and neither can you\. A parent can turn "Parents can read Maya's chats" off, which deletes the saved chats\./);
  assert.match(t, /Never say this chat is not saved/);
  assert.match(t, /Dana and Marco can read it for 30 days, and you yourself will not remember it next time\./);
});

test("the page: a kid with Parents can read off, words never saved, a summary 35 days", () => {
  const t = itemOne(theo());
  assert.match(t, /Theo's words are not saved anywhere: the family has not turned on "Parents can read Theo's chats"\./);
  assert.match(t, /a short summary .* is saved, locked so only a parent's phone can open it, and kept 35 days\./);
  assert.match(t, /each time Theo opens his profile, the chat starts fresh\./);
  assert.match(t, /his words are not saved, and Dana and Marco get a short summary of what each chat was about\./);
  assert.doesNotMatch(t, /Never say this chat is not saved|30 days/);
  // The same for Maya when her switch is off.
  assert.match(itemOne(resolve(riveraExport(), riveraSetup(), "id3")), /Maya's words are not saved anywhere/);
});

test("no band-guide line says chats are saved in the family's history (the founder, 2026-11-09)", () => {
  const text = JSON.stringify({ bands: BAND_GUIDE.bands, refusals: BAND_GUIDE.refusals, customRefusal: BAND_GUIDE.customRefusal });
  assert.doesNotMatch(text, /saved in (?:your|the) family's history|family's history/i);
  assert.equal(
    BAND_GUIDE.refusals["privacy.assume-stored"].reply,
    "I can't promise that. Your family's rule is 'Assuming anything we type into AI is stored and could be seen by others.' If it's private, tell a person you trust instead.",
  );
});

test("the true sentences, case by case", () => {
  const a = truthsFor(dana());
  assert.equal(a.saved, false);
  assert.equal(a.storage, "Your chats with me aren't saved anywhere, and nobody in the family can read them. The family app keeps only how much you used it each day, never your words.");
  assert.equal(a.deletion, "I can't delete anything myself, and there's nothing to delete. Your chats with me aren't saved anywhere.");

  const on = truthsFor(mayaRead());
  assert.equal(on.saved, true);
  assert.equal(on.storage, "This chat is saved for 30 days so Dana and Marco can read it. It's locked, so only a parent's phone can open it.");
  assert.equal(on.deletion, "I can't delete this chat, and you can't either. It's deleted after 30 days, or sooner if Dana or Marco turns off reading your chats.");

  const off = truthsFor(theo());
  assert.equal(off.saved, false);
  assert.equal(off.storage, "Your words in this chat aren't saved anywhere. Dana and Marco get a short summary of what each chat was about, and only a parent's phone can open it.");
  assert.equal(off.deletion, "I can't delete anything myself. Your words in this chat aren't saved anywhere, and the short summary of what it was about is deleted after 35 days.");

  // Only the kid whose parents can read is ever told something is saved.
  for (const t of [a, off]) assert.doesNotMatch(`${t.storage} ${t.deletion}`, /\b(?:is|are) saved\b/);
});

test("honesty: 'not saved' is corrected only for a kid whose parents can read", () => {
  for (const said of DENIALS) {
    const r = checkHonesty(`Okay. ${said} What else is on your mind?`, mayaRead());
    assert.deepEqual(r.corrections, ["storage"], said);
    assert.match(r.text, /^Okay\. This chat is saved for 30 days so Dana and Marco can read it\. It's locked, so only a parent's phone can open it\. What else is on your mind\?$/);
  }
  for (const [who, view] of [["Dana", dana()], ["Theo", theo()]]) {
    for (const said of DENIALS.slice(0, 4)) {
      const r = checkHonesty(`Okay. ${said}`, view);
      assert.deepEqual(r.corrections, [], `${who}: ${said}`);
      assert.equal(r.text, `Okay. ${said}`);
    }
  }
});

test("honesty: a claim to have deleted something gets each case's true sentence, never 'saved' where it isn't", () => {
  const said = "Sure, I'll delete it now.";
  assert.match(checkHonesty(said, mayaRead()).text, /^I can't delete this chat, and you can't either\./);
  const adult = checkHonesty(said, dana());
  assert.deepEqual(adult.corrections, ["deletion"]);
  assert.equal(adult.text, "I can't delete anything myself, and there's nothing to delete. Your chats with me aren't saved anywhere.");
  const kid = checkHonesty(said, theo());
  assert.deepEqual(kid.corrections, ["deletion"]);
  assert.match(kid.text, /^I can't delete anything myself\. Your words in this chat aren't saved anywhere/);
  // "Gone as soon as you close the app" is true for an adult and for a kid without Parents can read.
  // Where the deletion check reads it as a claim, the replacement is still true and still says no "saved".
  for (const view of [dana(), theo()]) {
    for (const s of DENIALS.slice(4)) assert.doesNotMatch(checkHonesty(s, view).text, /\b(?:is|are) saved\b/, s);
  }
});
