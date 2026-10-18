import assert from "node:assert/strict";
import { test } from "node:test";

import { BIG_STEP, clampTasks, clampWidth, draggedTasks, PROJECTS_COLUMN, steppedTasks, TASKS_DEFAULT, TASKS_FOLD_AT, TASKS_MAX, TASKS_MIN, tasksMax, defaultWidth, dragged, FOLD_AT, SIDEBAR_DEFAULT, SIDEBAR_NARROW_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarMax, STEP, stepped, UNFOLD_AT } from "./sidebar-width.ts";

test("a width is held between the narrowest and the widest", () => {
  assert.equal(clampWidth(300), 300);
  assert.equal(clampWidth(120), SIDEBAR_MIN);
  assert.equal(clampWidth(900), SIDEBAR_MAX);
  assert.equal(clampWidth(255.6), 256);
});

test("anything saved that isn't a width is the default", () => {
  for (const v of [undefined, null, "320", NaN, Infinity, {}]) assert.equal(clampWidth(v), SIDEBAR_DEFAULT);
});

test("the widest is 40% of a small window, never under the default", () => {
  assert.equal(sidebarMax(), SIDEBAR_MAX);
  assert.equal(sidebarMax(1440), SIDEBAR_MAX);
  assert.equal(sidebarMax(900), 360);
  assert.equal(sidebarMax(400), SIDEBAR_DEFAULT);
  assert.equal(clampWidth(400, 900), 360);
});

test("dragging past the narrowest folds to the rail, and out of it opens again", () => {
  assert.deepEqual(dragged(180, false), { folded: false, width: SIDEBAR_MIN });
  assert.deepEqual(dragged(FOLD_AT - 1, false), { folded: true, width: SIDEBAR_MIN });
  // Between the two edges it stays as it was: no flicker.
  assert.equal(dragged(FOLD_AT + 5, true).folded, true);
  assert.equal(dragged(FOLD_AT + 5, false).folded, false);
  assert.deepEqual(dragged(UNFOLD_AT, true), { folded: false, width: SIDEBAR_MIN });
  assert.deepEqual(dragged(330, true), { folded: false, width: 330 });
  assert.deepEqual(dragged(2000, false), { folded: false, width: SIDEBAR_MAX });
});

test("arrow keys step it, Shift further, Home and End go to the ends", () => {
  assert.equal(stepped(240, "ArrowRight", false), 240 + STEP);
  assert.equal(stepped(240, "ArrowLeft", false), 240 - STEP);
  assert.equal(stepped(240, "ArrowRight", true), 240 + BIG_STEP);
  assert.equal(stepped(SIDEBAR_MIN, "ArrowLeft", true), SIDEBAR_MIN);
  assert.equal(stepped(SIDEBAR_MAX, "ArrowRight", false), SIDEBAR_MAX);
  assert.equal(stepped(300, "Home", false), SIDEBAR_MIN);
  assert.equal(stepped(300, "End", false, 900), 360);
  assert.equal(stepped(300, "a", false), undefined);
});

test("a narrow window starts the sidebar at 240px, a roomy one at the default", () => {
  assert.equal(defaultWidth(900), SIDEBAR_NARROW_DEFAULT);
  assert.equal(defaultWidth(1199), SIDEBAR_NARROW_DEFAULT);
  assert.equal(defaultWidth(1200), SIDEBAR_DEFAULT);
  assert.equal(defaultWidth(), SIDEBAR_DEFAULT);
});

test("the tasks column is held between its narrowest and widest, and both columns within 40% of the window", () => {
  assert.equal(clampTasks(300), 300);
  assert.equal(clampTasks(50), TASKS_MIN);
  assert.equal(clampTasks(900), TASKS_MAX);
  for (const v of [undefined, "300", NaN]) assert.equal(clampTasks(v), TASKS_DEFAULT);
  assert.equal(tasksMax(1440), 576 - PROJECTS_COLUMN);
  assert.equal(PROJECTS_COLUMN + tasksMax(1200), 480);
  // A small window still keeps a readable column.
  assert.equal(tasksMax(800), TASKS_MIN);
});

test("dragging the tasks column's edge in far enough folds it", () => {
  assert.deepEqual(draggedTasks(TASKS_FOLD_AT - 1), { folded: true, width: TASKS_MIN });
  assert.deepEqual(draggedTasks(TASKS_FOLD_AT + 10), { folded: false, width: TASKS_MIN });
  assert.deepEqual(draggedTasks(320, 1440), { folded: false, width: 320 });
});

test("keys on the tasks column's edge step it", () => {
  assert.equal(steppedTasks(272, "ArrowRight", false), 272 + STEP);
  assert.equal(steppedTasks(272, "ArrowLeft", true), 272 - BIG_STEP);
  assert.equal(steppedTasks(272, "Home", false), TASKS_MIN);
  assert.equal(steppedTasks(272, "End", false, 1440), tasksMax(1440));
  assert.equal(steppedTasks(272, "a", false), undefined);
});
