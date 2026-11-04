// node --experimental-strip-types --test src/lib/jobs.test.ts (pnpm test)
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const stored = new Map<string, string>();
globalThis.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) } as Storage;
// Folded when the app last quit.
stored.set("berth.jobs.folded", "true");

const { cancelJob, dismissJob, FADE_MS, finishJob, isCancelling, jobOf, leftOver, outcomeOf, progressOf, runPool, setFolded, setItem, startJob, useJobs } = await import("./jobs.ts");

const reset = () => useJobs.setState({ jobs: [] });
const items = (...keys: string[]) => keys.map((key) => ({ key, group: "devl", label: key }));

test("progress counts the rows that have settled, whichever way", () => {
  reset();
  const id = startJob({ title: "Stopping 4 agents", items: items("a", "b", "c", "d") });
  assert.deepEqual(progressOf(jobOf(id)!), { settled: 0, total: 4 });
  setItem(id, "a", { state: "running" });
  setItem(id, "b", { state: "done" });
  setItem(id, "c", { state: "failed", message: "Failed: gone" });
  setItem(id, "d", { state: "cancelled" });
  assert.deepEqual(progressOf(jobOf(id)!), { settled: 3, total: 4 });
  assert.equal(outcomeOf(jobOf(id)!), "running");
});

test("several jobs stack, newest on top", () => {
  reset();
  const a = startJob({ title: "first", items: items("a") });
  const b = startJob({ title: "second", items: items("b") });
  assert.deepEqual(
    useJobs.getState().jobs.map((j) => j.id),
    [b, a],
  );
});

test("a clean job sums itself up and goes after a while; one with something kept stays as a report", () => {
  reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const clean = startJob({ title: "clean", items: items("a", "b") });
    setItem(clean, "a", { state: "done" });
    setItem(clean, "b", { state: "done" });
    finishJob(clean, "2 stopped");
    assert.equal(outcomeOf(jobOf(clean)!), "clean");

    const kept = startJob({ title: "kept", items: items("c", "d") });
    setItem(kept, "c", { state: "done" });
    setItem(kept, "d", { state: "kept", message: "Stopped · Kept: uncommitted changes" });
    finishJob(kept, "2 stopped, 1 kept");
    assert.equal(outcomeOf(jobOf(kept)!), "report");
    assert.deepEqual(
      leftOver(jobOf(kept)!).map((i) => i.key),
      ["d"],
    );

    mock.timers.tick(FADE_MS - 1);
    assert.ok(jobOf(clean));
    mock.timers.tick(1);
    assert.equal(jobOf(clean), undefined);
    assert.ok(jobOf(kept), "a report waits to be dismissed");
    dismissJob(kept);
    assert.equal(jobOf(kept), undefined);
  } finally {
    mock.timers.reset();
  }
});

test("a cancelled job takes no more: only the items not yet sent are left out", async () => {
  reset();
  const id = startJob({ title: "x", items: items("a", "b", "c", "d", "e"), cancellable: true });
  const sent: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const run = runPool(
    ["a", "b", "c", "d", "e"],
    2,
    async (k) => {
      sent.push(k);
      if (k === "b") {
        cancelJob(id);
        await hold;
      }
    },
    () => isCancelling(id),
  );
  // a went and finished; b is in flight when the job is cancelled.
  await new Promise((r) => setTimeout(r, 0));
  release();
  const unsent = await run;
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(unsent.sort(), ["c", "d", "e"]);
});

test("the pool runs a few at a time", async () => {
  let inFlight = 0;
  let most = 0;
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
  });
  assert.equal(most, 3);
});

test("the pool runs every item it's given, undefined too", async () => {
  const seen: (string | undefined)[] = [];
  const unsent = await runPool(["a", undefined, "b"], 2, async (item) => void seen.push(item));
  assert.deepEqual(seen, ["a", undefined, "b"]);
  assert.deepEqual(unsent, []);
});

test("folding the tray is remembered", () => {
  assert.equal(useJobs.getState().folded, true, "as it was left");
  setFolded(false);
  setFolded(true);
  assert.equal(useJobs.getState().folded, true);
  assert.equal(stored.get("berth.jobs.folded"), "true");
  setFolded(false);
  assert.equal(stored.get("berth.jobs.folded"), "false");
});
