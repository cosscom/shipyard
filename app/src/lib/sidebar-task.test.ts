// node --experimental-strip-types --test src/lib/sidebar-task.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { boxesLine, shortAgo } from "./sidebar-task.ts";

const now = Date.parse("2026-03-01T12:00:00Z");
const ago = (s: number) => new Date(now - s * 1000).toISOString();

test("the time lane says now, then minutes, hours and days", () => {
  assert.equal(shortAgo(ago(5), now), "now");
  assert.equal(shortAgo(ago(59), now), "now");
  assert.equal(shortAgo(ago(60), now), "1m");
  assert.equal(shortAgo(ago(22 * 60 + 30), now), "22m");
  assert.equal(shortAgo(ago(3600), now), "1h");
  assert.equal(shortAgo(ago(26 * 3600), now), "1d");
});

test("an unknown, unreadable or future time", () => {
  assert.equal(shortAgo(undefined, now), "");
  assert.equal(shortAgo("not a time", now), "");
  assert.equal(shortAgo(ago(-300), now), "now");
});

test("the foot names the boxes that are online", () => {
  assert.equal(
    boxesLine([
      { name: "devl", online: true },
      { name: "gpu", online: true },
      { name: "old-vps", online: false },
    ]),
    "devl, gpu online",
  );
  assert.equal(boxesLine([{ name: "devl", online: false }]), "devl is offline");
  assert.equal(
    boxesLine([
      { name: "a", online: false },
      { name: "b", online: false },
    ]),
    "No boxes online",
  );
  assert.equal(boxesLine([]), "No boxes yet");
  assert.equal(boxesLine(["cal", "devl", "omarchy", "mac-test"].map((name) => ({ name, online: name !== "mac-test" }))), "3 of 4 boxes online");
  assert.equal(boxesLine(["a", "b", "c", "d", "e"].map((name) => ({ name, online: name !== "e" }))), "4 of 5 boxes online");
});
