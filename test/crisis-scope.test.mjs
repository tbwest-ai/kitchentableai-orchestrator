// SPDX-License-Identifier: AGPL-3.0-only
// The page asks for 988 only in a real crisis (the founder, 2026-11-04, after his family's test chat
// offered it for a fire and a bully), and says when a suggestion is the AI's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../lib/agreement.mjs";
import { compilePage } from "../lib/compile.mjs";
import { riveraExport, riveraSetup } from "./helpers.mjs";

const page = (id) => compilePage(resolve(riveraExport(), riveraSetup(), id), { facts: { dateLabel: "x" } }).text;
const always = (text) => text.slice(text.indexOf("ALWAYS: THE LAST WORD"));

test("a kid's always-trues keep 988 for self-harm, abuse at home and danger, and leave it out of ordinary trouble", () => {
  const a = always(page("id4"));
  assert.match(a, /self-harm or not wanting to be alive, someone hurting him at home, or someone he met online/);
  assert.match(a, /Name both every time one of these comes up/);
  assert.doesNotMatch(a, /Name both, every time it comes up/);
  assert.match(a, /a bully at school, a scary moment\. For those, name Dana or Marco, and a teacher or the school counselor when it is about school, and leave 988 out\./);
  assert.match(a, /such as a fire or someone badly hurt, say to get to safety and call 911/);
});

test("a kid's upset line keeps 988 for danger it can help with, and never as a matter of course (worksheet 2026-11-05)", () => {
  const maya = page("id3");
  const theo = page("id4");
  assert.match(maya, /When Maya is upset\..*Mention 988 only if Maya talks about hurting herself, not wanting to be alive, someone at home hurting her, or being in the type of danger where 988 could actually help\./);
  assert.match(theo, /When Theo is upset\..*Mention 988 only if Theo talks about hurting himself, not wanting to be alive, being hurt at home, or being in the type of danger where 988 could actually help\./);
  for (const t of [maya, theo]) assert.doesNotMatch(t, /988 is there by call or text if it ever feels serious|any time it feels serious/);
});

test("a family's own line closes its refusal shape with one period, inside the quotes", () => {
  const t = page("id3");
  assert.match(t, /the shape is: "I can't help with that one\. Your family's own line in the Agreement is 'No AI at Grandma's house on Sundays\.'"/);
  assert.doesNotMatch(t, /\.'\./);
  // A line typed without an end mark takes the template's period after the closing quote.
  const a = riveraExport();
  const sundays = a.customRules.find((r) => r.text.startsWith("No AI at Grandma's"));
  sundays.text = "No AI at Grandma's house on Sundays";
  const bare = compilePage(resolve(a, riveraSetup(), "id3"), { facts: { dateLabel: "x" } }).text;
  assert.match(bare, /Your family's own line in the Agreement is 'No AI at Grandma's house on Sundays'\."/);
});

test("the AI says when a rule or limit is its own suggestion, not the family's", () => {
  for (const id of ["id1", "id4"]) assert.match(always(page(id)), /Never present a rule or limit as the family's unless it is on this page: when a suggestion is yours, say it is yours\./);
});
