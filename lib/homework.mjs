// SPDX-License-Identifier: AGPL-3.0-only
// The homework reminder, next to the message. Ported from the local prototype's turn reminder.
//
// Measured on GLM 5.3 under the compiled page (2026-10-23, two-arm runs): with the page alone the
// model stated the answer to schoolwork five times in 81 turns (inside hints, inside a "similar"
// problem with the same answer, outright) and withheld without a question twice; with this
// reminder after the message it kept the family's homework rule on 81 of 81 and declined less.
// So it joined the floor. It is term matching on the message: math, science and writing signs.
// Questions outside schoolwork get no reminder and are answered as ordinary questions.

export const SCHOOLWORK = ["math", "science", "writing"];

const MATH_SIGNS = [
  // Two numbers joined by an operation. No bare "/" (9/11 is history), and "-" only with spaces.
  /\d\s*(?:[+*×÷=^]|x(?=\s*\d)|times|plus|minus|divided by|multiplied by)\s*\d|\d\s+-\s+\d/,
  /\b\d+(?:\.\d+)?\s*%|\bpercent(?:age)?\b/,
  /\b\d+\s*\/\s*\d+\s+of\b|\bwhat(?:'s| is)\s+\d+\s*\/\s*\d+/,
  /\b\d*x\s*[-+=]|[-+=]\s*\d*x\b/,
  /\b(?:solve|simplify|equations?|fractions?|decimals?|multiply|multiplication|divide|division|subtract(?:ion)?|(?<!in )addition|square root|times tables?|long division|perimeter|area of|volume of|average of|round(?:ed|ing)? to|sums?(?! up))\b/,
];

// "forces" is left out: "the armed forces" is history.
const SCIENCE_SIGNS =
  /\b(?:chemical|symbol for|periodic table|elements?|atoms?|molecules?|compounds?|formula for|photosynthesis|gravity|energy|planets?|solar system|orbits?|gas(?:es)?|liquids?|solids?|boiling point|freezing point|melting point|evaporat\w*|condens\w*|oxygen|carbon dioxide|hydrogen|nitrogen|breathe\w*|digest\w*|skeleton|muscles?|circuits?|electricity|magnets?|volcano(?:es)?|fossils?|species|habitats?|food chains?|ecosystems?|dna|genes?|bacteria|viruses|cells?|experiments?|hypothesis|science)\b/;

const WRITING_SIGNS = [
  /\b(?:write|draft|compose|finish|do)\b[^.?!]{0,50}\b(?:paragraphs?|essays?|story|stories|poems?|sentences?|report|introduction|intro|conclusion|summary|book review|speech)\b/,
];

/** Which kinds of schoolwork a message looks like. */
export function schoolworkSubjects(message) {
  const t = (message ?? "").replace(/[‘’ʼ]/g, "'").toLowerCase();
  const out = [];
  if (MATH_SIGNS.some((re) => re.test(t))) out.push("math");
  if (SCIENCE_SIGNS.test(t)) out.push("science");
  if (WRITING_SIGNS.some((re) => re.test(t))) out.push("writing");
  return out;
}

const listOf = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The reminder for this message, or "" for none. `homework` is the person's style: "think-first"
 * (never the answer, one guiding question) or "explain-and-check" (the first step only, when
 * they have not tried). Adults get none. Writing is always guided for a kid.
 */
export function homeworkReminder(person, message) {
  if (!person.kid || !person.homework) return "";
  const found = schoolworkSubjects(message);
  const questions = found.filter((s) => s !== "writing");
  const rules = [];
  if (person.homework === "think-first" && questions.length) {
    rules.push(
      `This is ${listOf(questions)} schoolwork. Do not state the answer anywhere in your reply - not first, not at the end, not in brackets, not as a hint. Ask one guiding question, then stop.`,
    );
  } else if (person.homework === "explain-and-check" && questions.length) {
    rules.push(`This is ${listOf(questions)} schoolwork. If they have not tried it yet, give only the first step for them to do, then stop. Do not solve it.`);
  }
  if (found.includes("writing")) {
    rules.push("If they ask you to write something they could hand in, do not write it: outline it and ask for their first sentence.");
  }
  return rules.length ? `[Rules for this reply: ${rules.join(" ")}]` : "";
}
