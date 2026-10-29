// node --experimental-strip-types --test src/lib/answer-attachments.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { attachedTo, shownName, splitAttached } from "./attachments.ts";

const shot =
  "/home/acme/shop/.berth/attachments/20261025-152924-pasted-152924.webp";
const log = "/home/acme/shop/.berth/attachments/20261025-152931-checkout.png";
const spaced =
  "/Users/acme/My Projects/shop/.berth/attachments/20261025-152931-1-flow step.png";

test("files attached to an answer go after its words, on the same line", () => {
  assert.equal(
    attachedTo("this step  was off\n", [shot, log]),
    `this step was off [attached: ${shot}, ${log}]`,
  );
});

test("files alone are an answer, and words alone stay as they are", () => {
  assert.equal(attachedTo("  ", [shot]), `[attached: ${shot}]`);
  assert.equal(attachedTo("just words", []), "just words");
});

test("an answer splits back into its words and the files attached to it", () => {
  assert.deepEqual(
    splitAttached(attachedTo("this step was off", [shot, log])),
    { words: "this step was off", paths: [shot, log] },
  );
  assert.deepEqual(splitAttached(`[attached: ${shot}]`), {
    words: "",
    paths: [shot],
  });
  assert.deepEqual(splitAttached("Unit tests, E2E on staging"), {
    words: "Unit tests, E2E on staging",
    paths: [],
  });
});

test("a path with a space, a comma or a bracket stays one path", () => {
  const odd = "/home/acme/a, b [c]/d.png";
  assert.deepEqual(splitAttached(attachedTo("see these", [spaced, odd, log])), {
    words: "see these",
    paths: [spaced, odd, log],
  });
});

test("an answer without a path in its brackets is all words", () => {
  const answer = "the cart [attached: none]";
  assert.deepEqual(splitAttached(answer), { words: answer, paths: [] });
});

test("an attachment is shown by the name it was given", () => {
  assert.equal(shownName(shot), "pasted-152924.webp");
  assert.equal(shownName(spaced), "flow step.png");
  assert.equal(shownName("/a/20261025-152924-12-shot.png"), "shot.png");
  assert.equal(shownName("notes.md"), "notes.md");
});
