// node --experimental-strip-types --test src/lib/removing.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { clearRemoving, inTurn, markRemoving, markScript, pruneRemovals, removalLabel, removalOf, removeResult, STALE_MS, useRemovals } from "./removing.ts";

const reset = () => useRemovals.setState({ byKey: {} });
const of = (box: string, path: string, now?: number) => removalOf(useRemovals.getState().byKey, box, path, now);

test("an archive stays marked while its script runs, until the box reports", () => {
  reset();
  markRemoving("devl", "/w/shop-search", "archive", "search", 1000);
  assert.equal(removalLabel(of("devl", "/w/shop-search", 1000)!), "Archiving…");
  markScript("devl", "/w/shop-search");
  assert.equal(of("devl", "/w/shop-search", 2000)?.script, true);
  // Another box's worktree at the same path is a different one.
  assert.equal(of("cal", "/w/shop-search", 2000), undefined);
  const was = clearRemoving("devl", "/w/shop-search");
  assert.equal(was?.name, "search");
  assert.equal(of("devl", "/w/shop-search", 2000), undefined);
  assert.equal(clearRemoving("devl", "/w/shop-search"), undefined);
});

test("markScript does not invent a mark", () => {
  reset();
  markScript("devl", "/w/x");
  assert.deepEqual(useRemovals.getState().byKey, {});
});

test("a mark whose event never came goes stale", () => {
  reset();
  markRemoving("devl", "/w/a", "remove", "a", 0);
  assert.equal(removalLabel(of("devl", "/w/a", 10)!), "Removing…");
  assert.equal(of("devl", "/w/a", STALE_MS + 1), undefined);
});

test("a worktree the box no longer lists loses its mark", () => {
  reset();
  markRemoving("devl", "/w/a", "archive");
  markRemoving("devl", "/w/b", "archive");
  markRemoving("cal", "/w/a", "archive");
  pruneRemovals("devl", new Set(["/w/b"]));
  assert.deepEqual(Object.keys(useRemovals.getState().byKey).sort(), ["cal:/w/a", "devl:/w/b"]);
});

test("a DELETE's answer is read from JSON or, from older boxes, text", () => {
  assert.deepEqual(removeResult({ removing: "a", archive: "./archive.sh" }), { removing: "a", archive: "./archive.sh" });
  assert.equal(removeResult('{"archive":"./archive.sh","removing":"a"}\n').archive, "./archive.sh");
  assert.deepEqual(removeResult({ removed: "a" }), { removed: "a" });
  assert.deepEqual(removeResult("not json"), {});
  assert.deepEqual(removeResult(undefined), {});
});

test("a box takes its removals one at a time; another box's don't wait", async () => {
  const log: string[] = [];
  let answer!: () => void;
  const slow = new Promise<void>((r) => (answer = r));
  void inTurn("devl", async () => {
    log.push("a sent");
    await slow;
    log.push("a done");
  });
  const b = inTurn("devl", async () => {
    log.push("b sent");
  });
  await inTurn("gpu", async () => {
    log.push("c sent");
  });
  assert.deepEqual(log, ["a sent", "c sent"]);
  answer();
  await b;
  assert.deepEqual(log, ["a sent", "c sent", "a done", "b sent"]);
});
