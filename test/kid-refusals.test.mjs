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
      /name the family's line when one applies\. When a person could help, point to one: Dana or Marco by name, or a teacher for school work\. Do not offer another way you could help instead\./,
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
  assert.doesNotMatch(t, /Do not offer another way you could help instead/);
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
