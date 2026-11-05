// SPDX-License-Identifier: AGPL-3.0-only
// A kid's refusal names the family's line and points to a person, with no offer of more help (the
// founder, 2026-11-05: "a person only"); a parent's page keeps its offer of something nearby.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../lib/agreement.mjs";
import { BAND_GUIDE, compilePage } from "../lib/compile.mjs";
import { riveraExport, riveraSetup } from "./helpers.mjs";

const page = (id) => compilePage(resolve(riveraExport(), riveraSetup(), id), { facts: { dateLabel: "x" } }).text;
const paragraph = (text, head) => text.split("\n\n").find((p) => p.startsWith(head)) ?? "";

test("a kid's refusal names the family's line, points to a person, and offers no other help", () => {
  for (const id of ["id3", "id4"]) {
    const t = page(id);
    const refusing = paragraph(t, "Refusing.");
    assert.match(
      refusing,
      /name the family's line when one applies\. When a person could help, point to one: Dana or Marco by name, or a teacher for school work\. Then stop: do not offer another way you could help, and do not end with a question\./,
    );
    assert.doesNotMatch(refusing, /nearby/);
    assert.match(t, /Keep to (it|them): decline in a sentence and name the line\./);
    assert.doesNotMatch(t, /offer something nearby|a nearby thing you can help with/);
  }
});

test("a parent's refusal keeps its offer of a person or something nearby", () => {
  const t = page("id1");
  assert.match(paragraph(t, "Refusing."), /name the family's line when one applies, and offer a person or a nearby thing you can help with\./);
  assert.match(t, /Keep to (it|them): decline in a sentence and offer something nearby\./);
  assert.doesNotMatch(t, /do not offer another way you could help/i);
});

test("a kid's writing help waits for the kid's own first try, in both homework styles (2026-11-05)", () => {
  const maya = paragraph(page("id3"), "Homework:");
  const theo = paragraph(page("id4"), "Homework:");
  assert.match(maya, /For writing, wait for her own first try: a sentence, a list of ideas or a rough draft\. Until she brings one, say that the first try has to be her own, and stop: no plan, outline or first line from you\. Once she has, help her plan, pick words and fix her own sentences/);
  assert.match(theo, /For writing, wait for his own first try: a sentence, a list of ideas or a rough draft\. Until he brings one, say that the first try has to be his own, and stop: no plan, outline or first line from you\. Once he has, help him outline, draft and improve his own text\./);
  for (const t of [maya, theo]) assert.doesNotMatch(t, /For writing, help|Help (her|him) outline, draft and improve (her|his) own text instead/);
});

test("the eight examples the founder cut end on the rule or a person, with no offer of more help (2026-11-05)", () => {
  const cut = [
    "age.no-companion-chatbots", "age.toys", "real.no-tricks", "real.no-media-without-permission",
    "real.tell-if-faked", "talk.tell-if-secret-or-wrong", "talk.why-a-rule-exists", "talk.loosen",
  ];
  for (const id of cut) assert.doesNotMatch(BAND_GUIDE.refusals[id].reply, /I can help|I can write|I can tell you|If you want/, id);
  for (const id of ["id3", "id4"]) {
    assert.match(page(id), /"I can't play that part\. Your family's rule is 'No character or companion chatbots in our house,' and I'm a computer, not a friend\."/);
  }
});
