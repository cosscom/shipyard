// node --experimental-strip-types --test src/lib/nav-core.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { arrange, DEFAULT, migrate, move, type NavLayout, type NavState, navSync, place } from "./nav-core.ts";

const layout = (pinned: string[], more: string[] = [], hidden: string[] = []): NavLayout => ({ version: 2, pinned, more, hidden });

test("migrate: nothing stored is the default", () => {
  assert.deepEqual(migrate(null), DEFAULT);
  assert.deepEqual(migrate(undefined), DEFAULT);
  assert.deepEqual(migrate(""), DEFAULT);
});

test("migrate: version 1's dashboard becomes home, and the rest stays", () => {
  const m = migrate({ pinned: ["dashboard", "review"], more: ["kits"], hidden: ["dashboard"], moreOpen: true });
  assert.deepEqual(m, { version: 2, pinned: ["home", "review"], more: ["kits"], hidden: ["home"], moreOpen: true });
});

test("migrate: version 2 is kept as stored, and lists that aren't lists of names are read safely", () => {
  assert.deepEqual(migrate(layout(["dashboard"], ["home"])), layout(["dashboard"], ["home"]));
  assert.deepEqual(migrate({ version: 2, pinned: ["home", 3], more: "kits" }), layout(["home"]));
});

test("arrange: available ids in their stored lists and order, unknown ones in More, unavailable ones left out", () => {
  const l = layout(["review", "plugin:x:a", "home"], ["kits"], ["worktrees"]);
  assert.deepEqual(arrange(l, ["home", "review", "worktrees", "kits", "automations"]), { pinned: ["review", "home"], more: ["kits", "automations"], hidden: ["worktrees"] });
});

test("arrange: a place listed twice takes its first list (pinned, then hidden, then more)", () => {
  assert.deepEqual(arrange(layout(["home"], ["home", "kits"], ["kits"]), ["home", "kits"]), { pinned: ["home"], more: [], hidden: ["kits"] });
});

test("place: pins an item at the end, or at an index", () => {
  const ids = ["home", "review", "kits"];
  assert.deepEqual(place(layout(["home", "review"]), "kits", "pinned", undefined, ids).pinned, ["home", "review", "kits"]);
  assert.deepEqual(place(layout(["home", "review"]), "kits", "pinned", 0, ids).pinned, ["kits", "home", "review"]);
});

test("place: a pinned plugin that isn't available keeps its place", () => {
  // The plugin is off (or still loading) while the person pins Kits.
  const l = layout(["home", "plugin:usage:main", "review"], ["plugin:intake:main"], ["plugin:old:x"]);
  const next = place(l, "kits", "pinned", undefined, ["home", "review", "kits"]);
  assert.deepEqual(next.pinned, ["home", "plugin:usage:main", "review", "kits"]);
  assert.deepEqual(next.more, ["plugin:intake:main"]);
  assert.deepEqual(next.hidden, ["plugin:old:x"]);
  // Back on, it shows where it was pinned.
  assert.deepEqual(arrange(next, ["home", "review", "kits", "plugin:usage:main", "plugin:intake:main"]).pinned, ["home", "plugin:usage:main", "review", "kits"]);
});

test("move: swaps with the neighbour and keeps unavailable ids in place", () => {
  const l = layout(["home", "plugin:usage:main", "review", "worktrees"]);
  const ids = ["home", "review", "worktrees"];
  assert.deepEqual(move(l, "worktrees", -1, ids).pinned, ["home", "plugin:usage:main", "worktrees", "review"]);
  assert.deepEqual(move(l, "home", -1, ids).pinned, ["home", "plugin:usage:main", "review", "worktrees"]);
  assert.equal(move(l, "nowhere", 1, ids), l);
});

// A store and an agent to sync with: get answers from gets in turn (an
// Error is thrown), put records what was written.
function harness(gets: unknown[]) {
  let state: NavState = { layout: DEFAULT, loaded: false };
  const puts: NavLayout[] = [];
  let reads = 0;
  const sync = navSync(
    {
      get: async () => {
        const g = gets[Math.min(reads++, gets.length - 1)];
        if (g instanceof Error) throw g;
        return g;
      },
      put: async (l) => void puts.push(l),
      describe: (err) => String((err as Error).message),
    },
    { get: () => state, set: (p) => (state = { ...state, ...p }) },
  );
  return { sync, puts, state: () => state, reads: () => reads };
}

const saved = layout(["home", "kits"], ["review"]);
const down = new Error("connection refused");

test("a missing file is a successful load: the default, and saves are allowed", async () => {
  const h = harness([null]);
  assert.equal(await h.sync.load(), true);
  assert.deepEqual(h.state(), { layout: DEFAULT, loaded: true, error: undefined });
  assert.equal(await h.sync.save((l) => place(l, "kits", "pinned", undefined, ["home", "kits"])), true);
  assert.equal(h.puts.length, 1);
});

test("a save before a successful load is refused, and writes nothing", async () => {
  const h = harness([down]);
  assert.equal(await h.sync.load(), false);
  assert.equal(h.state().loaded, false);
  assert.equal(h.state().error, "connection refused");
  assert.deepEqual(h.state().layout, DEFAULT);
  assert.equal(await h.sync.save((l) => place(l, "kits", "pinned", undefined, ["home", "kits"])), false);
  assert.equal(await h.sync.save(() => DEFAULT), false);
  assert.equal(h.puts.length, 0);
  assert.deepEqual(h.state().layout, DEFAULT);
});

test("a load that failed, tried again, swaps the default for the stored layout", async () => {
  const h = harness([down, down, saved]);
  assert.equal(await h.sync.load(), false);
  assert.equal(await h.sync.load(), false);
  assert.deepEqual(h.state().layout, DEFAULT);
  assert.equal(await h.sync.load(), true);
  assert.deepEqual(h.state().layout, saved);
  assert.equal(h.state().error, undefined);
});

test("once loaded, a further load doesn't read again", async () => {
  const h = harness([saved]);
  await h.sync.load();
  assert.equal(await h.sync.load(), true);
  assert.equal(h.reads(), 1);
});

test("a failed write puts the old layout back", async () => {
  let state: NavState = { layout: saved, loaded: true };
  const failing = navSync(
    { get: async () => saved, put: async () => Promise.reject(down), describe: (e) => (e as Error).message },
    { get: () => state, set: (p) => (state = { ...state, ...p }) },
  );
  assert.equal(await failing.save(() => DEFAULT), false);
  assert.deepEqual(state.layout, saved);
  assert.equal(state.error, "connection refused");
});

test("saves run in turn: an earlier write that fails can't undo a later one", async () => {
  // A's write hangs, then fails (the agent restarting); B is made meanwhile.
  let state: NavState = { layout: saved, loaded: true };
  const writes: { layout: NavLayout; settle(ok: boolean): void }[] = [];
  const sync = navSync(
    {
      get: async () => saved,
      put: (layout) => new Promise((resolve, reject) => writes.push({ layout, settle: (ok) => (ok ? resolve(layout) : reject(down)) })),
      describe: (e) => (e as Error).message,
    },
    { get: () => state, set: (p) => (state = { ...state, ...p }) },
  );
  const ids = ["home", "kits", "review", "worktrees"];
  const a = sync.save((l) => place(l, "worktrees", "pinned", undefined, ids));
  const b = sync.save((l) => place(l, "review", "hidden", undefined, ids));
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1, "B waits for A's write");
  writes[0].settle(false);
  assert.equal(await a, false);
  assert.deepEqual(state.layout, saved);
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 2);
  // B is made on the layout A's failure left, so it carries nothing of A's.
  assert.deepEqual(writes[1].layout.pinned, ["home", "kits"]);
  assert.deepEqual(writes[1].layout.hidden, ["review"]);
  writes[1].settle(true);
  assert.equal(await b, true);
  assert.deepEqual(state.layout, writes[1].layout);
});

test("reset to default saves the default once loaded", async () => {
  const h = harness([saved]);
  await h.sync.load();
  assert.equal(await h.sync.save(() => DEFAULT), true);
  assert.deepEqual(h.puts, [DEFAULT]);
  assert.deepEqual(h.state().layout, DEFAULT);
});
