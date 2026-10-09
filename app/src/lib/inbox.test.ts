// node --experimental-strip-types --test src/lib/inbox.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { afterDone, arrange, holdOf, type InboxItem, markDone, NO_FILTER, prune, sectionOf, step, undone } from "./inbox.ts";

const item = (id: string, section: InboxItem["section"], since: string, more: Partial<InboxItem> = {}): InboxItem => ({
  id,
  box: "devl",
  session: { name: id, dir: `/w/${id}`, created: since, attached: 0, exited: false },
  state: section === "needs" ? "waiting" : section === "working" ? "running" : "finished",
  section,
  agent: "claude",
  title: id,
  project: "shop",
  worktree: id,
  location: "shop",
  path: `/w/${id}`,
  main: false,
  since,
  boxMatters: false,
  ...more,
});

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("states go to their sections; shells and ended agents stay out", () => {
  assert.equal(sectionOf("waiting"), "needs");
  assert.equal(sectionOf("running"), "working");
  assert.equal(sectionOf("finished"), "recent");
  assert.equal(sectionOf("ready"), "recent");
  assert.equal(sectionOf("idle"), undefined);
  assert.equal(sectionOf("exited"), undefined);
});

test("needs you comes first, longest waiting on top; the rest newest first", () => {
  const rows = [item("r1", "recent", "2026-01-01T10:00:00Z"), item("w1", "working", "2026-01-01T09:00:00Z"), item("n-new", "needs", "2026-01-01T11:00:00Z"), item("n-old", "needs", "2026-01-01T08:00:00Z"), item("w2", "working", "2026-01-01T12:00:00Z")];
  const { sections, order } = arrange(rows, { done: {}, filter: NO_FILTER });
  assert.deepEqual(
    sections.map((s) => s.section),
    ["needs", "working", "recent"],
  );
  assert.deepEqual(ids(order), ["n-old", "n-new", "w2", "w1", "r1"]);
});

test("a row marked done stays away until its agent's state changes", () => {
  const before = item("a", "needs", "2026-01-01T08:00:00Z");
  let done = markDone({}, before);
  assert.deepEqual(ids(arrange([before], { done, filter: NO_FILTER }).order), []);
  assert.equal(arrange([before], { done, filter: NO_FILTER }).hidden, 1);
  // Shown again when asked for.
  assert.deepEqual(ids(arrange([before], { done, filter: NO_FILTER, showDone: true }).order), ["a"]);
  // It asks again: back in the inbox.
  const again = { ...before, since: "2026-01-01T09:00:00Z" };
  assert.deepEqual(ids(arrange([again], { done, filter: NO_FILTER }).order), ["a"]);
  // Undo, and pruning marks for rows that moved on.
  assert.deepEqual(undone(done, "a"), {});
  done = markDone(done, item("gone", "recent", "x"));
  assert.deepEqual(prune(done, [before]), { a: before.since });
});

test("filters by box and by project", () => {
  const rows = [item("a", "working", "1", { box: "devl" }), item("b", "working", "2", { box: "gpu" }), item("c", "working", "3", { project: "evals" })];
  assert.deepEqual(ids(arrange(rows, { done: {}, filter: { hiddenBoxes: ["gpu"] } }).order), ["c", "a"]);
  assert.deepEqual(ids(arrange(rows, { done: {}, filter: { hiddenBoxes: [], project: "evals" } }).order), ["c"]);
});

test("the cursor moves within the list and lands on the next row after done", () => {
  const order = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(step(order, undefined, 1), "a");
  assert.equal(step(order, "a", 1), "b");
  assert.equal(step(order, "c", 1), "c");
  assert.equal(step(order, "a", -1), "a");
  assert.equal(step(order, "gone", 1), "a");
  assert.equal(step([], "a", 1), undefined);
  assert.equal(afterDone(order, "b"), "c");
  assert.equal(afterDone(order, "c"), "b");
  assert.equal(afterDone([{ id: "a" }], "a"), undefined);
});

test("rows hold their places while the list is held, and new ones still show", () => {
  const a = item("a", "needs", "1");
  const b = item("b", "working", "2");
  const hold = holdOf(arrange([a, b], { done: {}, filter: NO_FILTER }).order);
  // a is answered and works now; c starts.
  const moved = [{ ...a, section: "working" as const, state: "running" as const, since: "3" }, b, item("c", "working", "4")];
  const held = arrange(moved, { done: {}, filter: NO_FILTER, hold });
  assert.deepEqual(held.sections.map((s) => [s.section, ids(s.items)]), [["needs", ["a"]], ["working", ["b", "c"]]]);
  // Let go: where each belongs.
  assert.deepEqual(ids(arrange(moved, { done: {}, filter: NO_FILTER }).order), ["c", "a", "b"]);
});
