// node --experimental-strip-types --test src/lib/last-of.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { lastOf } from "./last-of.ts";

test("the same arguments give the same answer without working it out again", () => {
  let runs = 0;
  const rows = lastOf((all: number[], k: string) => {
    runs++;
    return all.map((n) => `${k}${n}`);
  });
  const all = [1, 2, 3];
  const a = rows(all, "x");
  const b = rows(all, "x");
  assert.equal(a, b);
  assert.equal(runs, 1);
});

test("an argument that is a new object, even an equal one, works it out again", () => {
  let runs = 0;
  const sum = lastOf((xs: number[]) => {
    runs++;
    return xs.reduce((s, x) => s + x, 0);
  });
  assert.equal(sum([1, 2]), 3);
  assert.equal(sum([1, 2]), 3);
  assert.equal(runs, 2);
  const xs = [4];
  sum(xs);
  sum(xs);
  assert.equal(runs, 3);
});

test("only the last answer is kept", () => {
  let runs = 0;
  const twice = lastOf((n: number) => {
    runs++;
    return n * 2;
  });
  twice(1);
  twice(2);
  twice(1);
  assert.equal(runs, 3);
});
