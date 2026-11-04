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

test("the AI says when a rule or limit is its own suggestion, not the family's", () => {
  for (const id of ["id1", "id4"]) assert.match(always(page(id)), /Never present a rule or limit as the family's unless it is on this page: when a suggestion is yours, say it is yours\./);
});
