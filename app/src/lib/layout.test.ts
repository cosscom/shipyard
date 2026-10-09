// node --experimental-strip-types --test src/lib/layout.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { adopt, bounds, leaf, leaves, mixed, moveBetween, movePane, type PaneNode, paneWorktree, place, remove, sessionsShown, sideAt, split, swap, tile, worktreesOf, layout } from "./layout.ts";

const term = (s: string) => leaf({ kind: "terminal", box: "b", session: s });
const names = (n: PaneNode) => leaves(n).map((l) => (l.content.kind === "terminal" ? l.content.session : "?"));
const shape = (n: PaneNode): string => (n.kind === "leaf" ? names(n)[0] : `${n.dir}(${shape(n.a)},${shape(n.b)})`);

test("place puts a pane on each side of another", () => {
  const a = term("a");
  assert.equal(shape(place(a, a.id, "right", term("x"))), "row(a,x)");
  assert.equal(shape(place(a, a.id, "left", term("x"))), "row(x,a)");
  assert.equal(shape(place(a, a.id, "top", term("x"))), "col(x,a)");
  assert.equal(shape(place(a, a.id, "bottom", term("x"))), "col(a,x)");
});

test("place takes a whole tab's tree and keeps its leaves' ids", () => {
  const a = term("a");
  const x = term("x");
  const y = term("y");
  const other = split(x, x.id, "col", y);
  const got = place(a, a.id, "right", other);
  assert.equal(shape(got), "row(a,col(x,y))");
  assert.deepEqual(leaves(got).map((l) => l.id), [a.id, x.id, y.id]);
});

test("movePane closes the gap it leaves and keeps the pane's id", () => {
  const a = term("a");
  const b = term("b");
  const c = term("c");
  let t = split(a, a.id, "row", b); // a | b
  t = split(t, b.id, "col", c); // a | (b / c)
  const got = movePane(t, c.id, a.id, "left");
  assert.equal(shape(got), "row(row(c,a),b)");
  assert.ok(leaves(got).some((l) => l.id === c.id));
  // Out of a two-pane split and back in the other way.
  assert.equal(shape(movePane(split(a, a.id, "row", b), a.id, b.id, "bottom")), "col(b,a)");
});

test("movePane leaves the tree alone for itself or an unknown pane", () => {
  const a = term("a");
  const b = term("b");
  const t = split(a, a.id, "row", b);
  assert.equal(movePane(t, a.id, a.id, "left"), t);
  assert.equal(movePane(t, a.id, "nope", "left"), t);
  assert.equal(movePane(a, a.id, a.id, "left"), a);
});

test("swap trades two panes", () => {
  const a = term("a");
  const b = term("b");
  const c = term("c");
  const t = split(split(a, a.id, "row", b), b.id, "col", c);
  assert.equal(shape(swap(t, a.id, c.id)), "row(c,col(b,a))");
  assert.equal(swap(t, a.id, "nope"), t);
});

test("removing the last pane of a side collapses the split", () => {
  const a = term("a");
  const b = term("b");
  const t = split(a, a.id, "row", b);
  assert.equal(remove(t, b.id), a);
});

test("bounds is where moved leaves land", () => {
  const a = term("a");
  const x = term("x");
  const y = term("y");
  const got = place(a, a.id, "right", split(x, x.id, "col", y));
  assert.deepEqual(bounds(got, [x.id, y.id]), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(bounds(got, [a.id]), { x: 0, y: 0, w: 0.5, h: 1 });
  assert.equal(bounds(got, ["nope"]), undefined);
});

test("sideAt picks the nearest edge, or the middle when asked", () => {
  assert.equal(sideAt(0.1, 0.5), "left");
  assert.equal(sideAt(0.9, 0.5), "right");
  assert.equal(sideAt(0.5, 0.05), "top");
  assert.equal(sideAt(0.6, 0.95), "bottom");
  assert.equal(sideAt(0.5, 0.5, true), "center");
  assert.notEqual(sideAt(0.5, 0.5), "center");
});

// A pane may belong to a worktree other than its tab's.

const A = "devl:/w/a";
const B = "devl:/w/b";
const C = "gpu:/w/b";

test("paneWorktree is the pane's own worktree, else its tab's", () => {
  assert.equal(paneWorktree(A, term("a")), A);
  assert.equal(paneWorktree(A, leaf({ kind: "browser", url: "" }, B)), B);
  // A leaf made without one carries no wt at all, so saved state stays as it was.
  assert.equal("wt" in term("a"), false);
});

test("a tab is mixed when a pane belongs to another worktree", () => {
  const a = term("a");
  const b = leaf({ kind: "panel", plugin: "diff", panel: "diff", title: "Diff" }, B);
  const t = split(a, a.id, "row", b);
  assert.equal(mixed(a, A), false);
  assert.equal(mixed(t, A), true);
  assert.deepEqual(worktreesOf(t, A), [A, B]);
  // A tab left with only another worktree's pane lists just that one.
  assert.deepEqual(worktreesOf(b, A), [B]);
});

test("adopt keeps each pane's worktree when a tree moves to another workspace", () => {
  const own = term("a"); // A's
  const guest = leaf({ kind: "browser", url: "" }, C); // C's, in A's tab
  const back = leaf({ kind: "browser", url: "" }, B); // B's, in A's tab
  const t = split(split(own, own.id, "row", guest), guest.id, "col", back);
  const moved = adopt(t, A, B);
  const by = Object.fromEntries(leaves(moved).map((l) => [l.id, l.wt]));
  assert.equal(by[own.id], A, "A's own pane names A once it is in B's tab");
  assert.equal(by[guest.id], C, "a guest stays its worktree's");
  assert.equal(by[back.id], undefined, "B's pane, home in B's tab, needs no wt");
  assert.equal("wt" in leaves(moved).find((l) => l.id === back.id)!, false);
  assert.deepEqual(leaves(moved).map((l) => l.id), leaves(t).map((l) => l.id));
  assert.equal(adopt(t, A, A), t);
});

test("sessionsShown counts panes of every tree, on that box only", () => {
  const roots = [term("one"), leaf({ kind: "terminal", box: "b", session: "two" }, B), leaf({ kind: "terminal", box: "other", session: "three" })];
  assert.deepEqual([...sessionsShown(roots, "b")].sort(), ["one", "two"]);
});

test("moveBetween takes a tab into another workspace's pane, as guests", () => {
  const own = term("a");
  const tb = term("b1");
  const tb2 = term("b2");
  const spaces = {
    [A]: { tabs: [{ id: "ta", root: own as PaneNode, focus: own.id }], active: "ta" },
    [B]: { tabs: [{ id: "tb", root: split(tb, tb.id, "col", tb2), focus: tb2.id }, { id: "tb3", root: term("x") as PaneNode, focus: "?" }], active: "tb" },
  };
  const got = moveBetween(spaces, { key: B, tab: "tb" }, { key: A, tab: "ta", pane: own.id, side: "right" })!;
  // B lost the tab and shows its next one; A's tab has both of B's panes, marked B's.
  assert.deepEqual(got[B].tabs.map((t) => t.id), ["tb3"]);
  assert.equal(got[B].active, "tb3");
  const t = got[A].tabs[0];
  assert.equal(shape(t.root), "row(a,col(b1,b2))");
  assert.deepEqual(leaves(t.root).map((l) => paneWorktree(A, l)), [A, B, B]);
  assert.equal(t.focus, tb2.id, "the moved tab's focus comes with it");
});

test("moveBetween takes one pane out and leaves the rest of its tab", () => {
  const a = term("a");
  const b = leaf({ kind: "browser", url: "" }, B);
  const c = term("c");
  const spaces = {
    [A]: { tabs: [{ id: "t1", root: split(a, a.id, "row", b), focus: b.id }, { id: "t2", root: c as PaneNode, focus: c.id }], active: "t1" },
  };
  // b (B's page, a guest in t1) moves into t2 of the same workspace.
  const got = moveBetween(spaces, { key: A, tab: "t1", pane: b.id }, { key: A, tab: "t2", pane: c.id, side: "left" })!;
  assert.equal(shape(got[A].tabs[0].root), "a");
  assert.equal(got[A].tabs[0].focus, a.id);
  assert.equal(got[A].tabs[1].root.kind, "split");
  assert.equal(leaves(got[A].tabs[1].root)[0].wt, B, "still B's");
  assert.equal(got[A].active, "t2");
  // Into its own tab, or onto itself, makes no sense.
  assert.equal(moveBetween(spaces, { key: A, tab: "t1", pane: b.id }, { key: A, tab: "t1", pane: a.id, side: "left" }), undefined);
});

test("tile lays panes out in even columns, keeping their ids", () => {
  const ls = [1, 2, 3, 4].map(() => leaf({ kind: "browser", url: "" }));
  const t = tile(ls, "columns")!;
  const rects = layout(t).leaves;
  assert.deepEqual(rects.map((r) => r.leaf.id), ls.map((l) => l.id));
  for (const r of rects) {
    assert.ok(Math.abs(r.rect.w - 0.25) < 1e-9);
    assert.equal(r.rect.h, 1);
  }
});

test("tile's grid puts three as one beside two, four as two over two", () => {
  const ls = [1, 2, 3, 4].map(() => leaf({ kind: "browser", url: "" }));
  const three = layout(tile(ls.slice(0, 3), "grid")!).leaves.map((l) => l.rect);
  assert.deepEqual(three[0], { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(three[2], { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  const four = layout(tile(ls, "grid")!).leaves.map((l) => l.rect);
  assert.deepEqual(four.map((r) => [r.x, r.y]), [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]);
  assert.equal(tile([], "grid"), undefined);
  // auto: columns up to three, a grid at four.
  for (const l of layout(tile(ls.slice(0, 3), "auto")!).leaves) assert.ok(Math.abs(l.rect.w - 1 / 3) < 1e-9 && l.rect.h === 1);
  assert.deepEqual(layout(tile(ls, "auto")!).leaves.map((l) => [l.rect.x, l.rect.y]), [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]);
  assert.equal(tile(ls.slice(0, 1), "grid"), ls[0]);
});
