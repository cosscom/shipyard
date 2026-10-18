import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRow, pickedColumn } from "./sidebar-columns.ts";

const order = ["evals", "notes", "shop"];

test("the project picked last is the one shown", () => {
  assert.equal(pickedColumn(order, "notes", "shop"), "notes");
});

test("with no pick, the worktree in front's project, then the first", () => {
  assert.equal(pickedColumn(order, null, "shop"), "shop");
  assert.equal(pickedColumn(order, undefined, undefined), "evals");
});

test("a pick that is gone gives way", () => {
  assert.equal(pickedColumn(order, "gone", "shop"), "shop");
  assert.equal(pickedColumn(order, "gone", "also-gone"), "evals");
  assert.equal(pickedColumn([], "gone", undefined), undefined);
});

test("arrow keys move between rows and stop at the ends", () => {
  assert.equal(nextRow(3, 0, "ArrowDown"), 1);
  assert.equal(nextRow(3, 2, "ArrowDown"), undefined);
  assert.equal(nextRow(3, 0, "ArrowUp"), undefined);
  assert.equal(nextRow(3, 2, "ArrowUp"), 1);
  assert.equal(nextRow(3, -1, "ArrowDown"), 0);
  assert.equal(nextRow(3, 1, "Home"), 0);
  assert.equal(nextRow(3, 1, "End"), 2);
  assert.equal(nextRow(3, 1, "x"), undefined);
  assert.equal(nextRow(0, 0, "ArrowDown"), undefined);
});
