// node --experimental-strip-types --test packages/core/src/screen.test.ts (pnpm test in app/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { askIn, choicesIn, meaningfulTail, questionFormIn, screenAt } from "./screen.ts";

test("meaningfulTail keeps one empty line between paragraphs when asked", () => {
  const screen = "  one\n  wrapped\n\n\n  two\n────\n❯ \n";
  assert.deepEqual(meaningfulTail(screen, 10), ["one", "wrapped", "two"]);
  assert.deepEqual(meaningfulTail(screen, 10, { blanks: true }), ["one", "wrapped", "", "two"]);
});

// The box's own screens (internal/box/testdata/screens), which its tests
// read too.
const boxScreen = (name: string) => readFileSync(join(import.meta.dirname, "../../../internal/box/testdata/screens", name), "utf8");

const RULE = "─".repeat(80);

// Claude Code 2.1's question form, as its screen shows it.
const threeQuestions = [
  "❯ Use the AskUserQuestion tool to ask me three questions at once",
  RULE,
  "←  ☐ Colour  ☐ Toppings  ☐ Pet name  ✔ Submit  →",
  "",
  "Pick a colour:",
  "",
  "❯ 1. Red",
  "     The colour red",
  "  2. Green",
  "     The colour green",
  "  3. Blue",
  "     The colour blue",
  "  4. Type something.",
  RULE,
  "  5. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  "",
].join("\n");

const oneQuestion = [
  "❯ Ask me tea or coffee",
  RULE,
  " ☐ Drink            ",
  "",
  "Tea or coffee?",
  "",
  "❯ 1. Tea",
  "     A cup of tea",
  "  2. Coffee",
  "     A cup of coffee",
  "  3. Type something.",
  RULE,
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

const severalPicks = [
  RULE,
  "←  ☐ Fruits  ✔ Submit  →",
  "",
  "Which fruits?",
  "",
  "❯ 1. [ ] Apple",
  "  2. [ ] Pear",
  "  3. [ ] Type something",
  "     Submit",
  RULE,
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

test("a form of several questions isn't one number's to answer", () => {
  assert.equal(questionFormIn(threeQuestions), true);
  assert.deepEqual(choicesIn(threeQuestions), []);
  assert.equal(questionFormIn(severalPicks), true);
  assert.deepEqual(choicesIn(severalPicks), []);
  // Still the agent's own screen: the live terminal can open on it.
  assert.equal(screenAt("claude", threeQuestions), "interactive");
});

test("one question with one pick still answers by number", () => {
  assert.equal(questionFormIn(oneQuestion), false);
  assert.deepEqual(
    choicesIn(oneQuestion)
      .slice(0, 3)
      .map((c) => `${c.key}. ${c.label}`),
    ["1. Tea", "2. Coffee", "3. Type something."],
  );
});

test("a permission prompt is a menu, not a form", () => {
  const perm = ["Bash command", "  rm -rf build", "Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)", "", "Esc to cancel"].join("\n");
  assert.equal(questionFormIn(perm), false);
  assert.equal(choicesIn(perm).length, 2);
});

test("answers in the conversation above the prompt aren't a form", () => {
  const done = ["⏺ User answered Claude's questions:", "  ⎿  · Pick a colour: → Green", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"].join("\n");
  assert.equal(questionFormIn(done), false);
});

test("a trust question is answered with keys, never a word", () => {
  const trust = ["", " Accessing workspace:", "", " /w/shop-fix", "", " Quick safety check: Is this a project you created or one you trust?", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel", ""].join("\n");
  assert.equal(screenAt(undefined, trust), "interactive");
  assert.deepEqual(askIn(trust), { detail: "", choices: [], form: false });
  // Numbered, as older Claude Code asks it: its options answer it.
  const numbered = [" Do you trust the files in this folder?", "", " ❯ 1. Yes, proceed", "   2. No, exit", "", " Enter to confirm · Esc to exit"].join("\n");
  assert.equal(askIn(numbered).detail, "Do you trust the files in this folder?");
  assert.equal(askIn(numbered).choices.length, 2);
});

test("a question is the line above its options", () => {
  const perm = [RULE, " Bash command", "", "   rm -rf build", "   Remove the old build", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");
  assert.deepEqual(askIn(perm), { detail: "Do you want to proceed?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }], form: false });
});

test("a screen at the agent's prompt asks nothing, whatever its last message lists", () => {
  // Turn check's wait: the agent asks in words, under a numbered list, and
  // its footer ends in "/rc". No options, no question to draw.
  for (const f of ["asked-in-reply.ansi", "bypass-switched.ansi"]) {
    const screen = boxScreen(f);
    assert.equal(screenAt("claude", screen), "prompt", f);
    assert.deepEqual(askIn(screen), { detail: "", choices: [], form: false }, f);
  }
  // A short list right above the prompt is still the agent's words.
  const listed = ["● Which should move to nightly?", "", "  1. checkout retries", "  2. cart badge", "", "  Which ones?", "", RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)", "                                                                           /rc"].join("\n");
  assert.equal(choicesIn(listed).length, 2);
  assert.deepEqual(askIn(listed), { detail: "", choices: [], form: false });
  // Remote Control's menu after /rc: keys answer it, in its own screen.
  const rc = boxScreen("remote-control.ansi");
  assert.equal(screenAt("claude", rc), "interactive");
  assert.deepEqual(askIn(rc), { detail: "", choices: [], form: false });
});

test("the question is never the prompt the person typed", () => {
  const typed = ["❯ /model", RULE, " 1. Default (recommended)", " 2. Opus", " 3. Haiku", "", " Enter to confirm · Esc to exit"].join("\n");
  assert.equal(askIn(typed).choices.length, 3);
  assert.equal(askIn(typed).detail, "");
  assert.equal(askIn(["❯ /rc", "", " 1. Disconnect", " 2. Continue"].join("\n")).detail, "");
});

test("a plan in the agent's last message is no menu to pick from", () => {
  // Steps it lists and a question about them, in words: the reply box
  // answers it ("yes, 1-3"), not one number.
  const plan = [
    "● What I'd build:",
    "",
    "  1. The statusline writes its limits to a file per account.",
    "  2. A pacing picker for new sessions.",
    "  3. The connector check between accounts.",
    "  4. Later: another agent, once you want it.",
    "",
    "  Should I start on 1-3?",
    "",
    "✻ Worked for 2m 10s",
    "",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "                                                                           /rc",
  ].join("\n");
  assert.equal(choicesIn(plan).length, 4);
  assert.deepEqual(askIn(plan), { detail: "", choices: [], form: false });
});
