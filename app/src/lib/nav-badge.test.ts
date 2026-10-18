// node --experimental-strip-types --test src/lib/nav-badge.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { readNavBadge } from "./nav-badge.ts";

const quiet = () => {};

test("a count of 3 is a loud badge of 3", () => {
  assert.deepEqual(readNavBadge("Intake", () => 3, quiet), { count: 3, loud: true, title: "Intake: 3" });
  assert.deepEqual(readNavBadge("Intake", () => ({ n: 3 }), quiet), { count: 3, loud: true, title: "Intake: 3" });
  assert.deepEqual(readNavBadge("Intake", () => ({ n: 3, urgent: true }), quiet), { count: 3, loud: true, title: "Intake: 3" });
});

test("urgent: false shows the count quiet, like Review's", () => {
  assert.deepEqual(readNavBadge("Intake", () => ({ n: 2, urgent: false }), quiet), { count: 2, loud: false, title: "Intake: 2" });
});

test("0, undefined or nothing usable is no badge", () => {
  assert.equal(readNavBadge("Intake", () => 0, quiet), undefined);
  assert.equal(readNavBadge("Intake", () => ({ n: 0, urgent: true }), quiet), undefined);
  assert.equal(readNavBadge("Intake", () => undefined, quiet), undefined);
  assert.equal(readNavBadge("Intake", () => -1, quiet), undefined);
  assert.equal(readNavBadge("Intake", () => Number.NaN, quiet), undefined);
  assert.equal(readNavBadge("Intake", () => ({}) as { n: number }, quiet), undefined);
});

test("a hook that throws is no badge, and its error is reported", () => {
  const seen: unknown[] = [];
  const boom = new Error("boom");
  const badge = readNavBadge(
    "Intake",
    () => {
      throw boom;
    },
    (err) => seen.push(err),
  );
  assert.equal(badge, undefined);
  assert.deepEqual(seen, [boom]);
});
