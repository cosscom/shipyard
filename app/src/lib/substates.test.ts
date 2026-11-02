import assert from "node:assert/strict";
import { test } from "node:test";

import { boxesBehind, editKey, isNewer, newestSet, placeSession, readDue, type SubStateSet } from "./substates.ts";

const states = [
  { id: "decision", name: "Needs a decision", description: "d" },
  { id: "act", name: "Needs you to act", description: "a" },
];

test("a known sub-state is placed there, untagged", () => {
  assert.deepEqual(placeSession({ agent_sub_state: "act" }, states), { column: "act", unsorted: false });
});

test("a missing sub-state goes to the default, tagged", () => {
  assert.deepEqual(placeSession({}, states), { column: "decision", unsorted: true });
});

test("an unknown sub-state goes to the default, tagged", () => {
  assert.deepEqual(placeSession({ agent_sub_state: "just-removed" }, states), { column: "decision", unsorted: true });
});

const set = (revision: number, stamp: string, id = "x"): SubStateSet => ({ states: [{ id, name: id, description: "d" }], revision, stamp });

test("the newest revision wins, whichever box holds it", () => {
  const old = set(100, "z");
  const fresh = set(200, "a");
  assert.equal(newestSet([old, fresh, undefined]), fresh);
  assert.equal(newestSet([fresh, old]), fresh);
});

test("a box that never had a set counts for nothing", () => {
  assert.equal(newestSet([{ states: [] }, undefined]), undefined);
});

test("removing every sub-state is an edit like any other, and spreads", () => {
  const removed: SubStateSet = { states: [], revision: 300, stamp: "a" };
  assert.equal(newestSet([set(200, "a"), removed]), removed);
  assert.deepEqual(boxesBehind({ one: set(200, "a"), two: removed }, removed), ["one"]);
});

test("two edits in the same millisecond settle the same way on every laptop", () => {
  const a = set(100, "a");
  const b = set(100, "b");
  assert.equal(isNewer(b, a), true);
  assert.equal(isNewer(a, b), false);
  assert.equal(newestSet([a, b]), newestSet([b, a]));
});

// Two laptops, each with the boxes as it last saw them. A box takes only what
// is newer than it holds, as a box does (putSubStates), whatever order they
// come in: every box ends on one set and stays there.
test("two laptops spreading at once don't flip a box", () => {
  const a = set(100, "a", "a");
  const b = set(200, "b", "b");
  const boxes: Record<string, SubStateSet> = { one: a, two: b };
  const take = (box: string, s: SubStateSet) => {
    if (isNewer(s, boxes[box])) boxes[box] = s;
  };
  const seen: string[] = [];
  for (let round = 0; round < 4; round++) {
    // Laptop 1 still believes the older set is the newest; laptop 2 knows better.
    take("two", a);
    take("one", b);
    take("two", newestSet(Object.values(boxes)) as SubStateSet);
    seen.push(`${boxes.one.stamp}${boxes.two.stamp}`);
  }
  assert.deepEqual(seen, ["bb", "bb", "bb", "bb"]);
  assert.deepEqual(boxesBehind(boxes, newestSet(Object.values(boxes)) as SubStateSet), []);
});

test("a box that never had a set is behind; one on the newest isn't", () => {
  const n = set(100, "a");
  assert.deepEqual(boxesBehind({ fresh: { states: [] }, same: n }, n), ["fresh"]);
});

test("a failed read tries again with the same info, and not before its time", () => {
  const e = editKey(5, "a");
  assert.equal(readDue(undefined, e, 0), true);
  assert.equal(readDue({ reading: true }, e, 0), false);
  // The GET failed: same edit, nothing kept.
  assert.equal(readDue({ retryAt: 1000 }, e, 999), false);
  assert.equal(readDue({ retryAt: 1000 }, e, 1000), true);
  assert.equal(readDue({ edit: e }, e, 0), false);
  assert.equal(readDue({ edit: e }, editKey(6, "a"), 0), true);
});

test("two edits in one millisecond are told apart when reading, too", () => {
  assert.equal(readDue({ edit: editKey(5, "a") }, editKey(5, "b"), 0), true);
});

// The newest may be on a box that has gone: the set is still known, and goes
// on to the boxes that are here.
test("a box offline with the newest edit still spreads it", () => {
  const n = set(200, "a");
  const held = { gone: n, here: set(100, "a") };
  const newest = newestSet(Object.values(held)) as SubStateSet;
  assert.equal(newest, n);
  assert.deepEqual(boxesBehind({ here: held.here }, newest), ["here"]);
});
