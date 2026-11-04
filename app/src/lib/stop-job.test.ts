// node --experimental-strip-types --test src/lib/stop-job.test.ts (pnpm test)
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { KEPT_OTHER_AGENT } from "./archive-after-stop.ts";
import { cancelJob, dismissJob, jobOf, useJobs } from "./jobs.ts";
import { inTurn, markRemoving, removalOf, useRemovals } from "./removing.ts";
import { reattachStopJobs, readStopRun, runStopJob, type StopDeps, type StopItem, type StopRuns, type StopRunParams, type StopRunStep, stopSummary } from "./stop-job.ts";

const row = (session: string, wt?: string, box = "devl"): StopItem => ({
  key: `${box}/${session}`,
  box,
  session,
  label: wt ?? "shop",
  where: { location: "shop", worktree: wt ? { name: wt, path: `/w/${wt}` } : { name: "shop", path: "/w/shop", main: true } },
});

function fakeBoxes(over: Partial<StopDeps> = {}) {
  const calls: string[] = [];
  const deps: StopDeps = {
    stop: async (box, s) => void calls.push(`stop ${box}/${s}`),
    liveAgents: async () => [],
    archive: async (box, _loc, wt) => {
      calls.push(`archive ${box}:${wt.name}`);
      return {};
    },
    errorText: (err) => (err instanceof Error ? err.message : String(err)),
    ...over,
  };
  return { deps, calls };
}

// The real archive clears its mark when the box answers; the fakes don't.
beforeEach(() => useRemovals.setState({ byKey: {} }));

const itemsOf = (id: number) => Object.fromEntries(jobOf(id)!.items.map((i) => [i.key, `${i.state}: ${i.message}`]));

test("a clean run stops them all, archives their worktrees, and sums it up", async () => {
  useJobs.setState({ jobs: [] });
  const { deps, calls } = fakeBoxes();
  const res = await runStopJob([row("a", "fix"), row("b", "perf"), row("c")], true, deps);
  assert.equal(res.clean, true);
  assert.equal(jobOf(res.job)!.title, "Stopping 3 agents");
  assert.equal(jobOf(res.job)!.summary, "3 stopped, 2 archived");
  assert.deepEqual(itemsOf(res.job), {
    "devl/a": "done: Stopped · Archived; its branch is kept",
    "devl/b": "done: Stopped · Archived; its branch is kept",
    "devl/c": "done: Stopped",
  });
  assert.deepEqual(calls.filter((c) => c.startsWith("archive")), ["archive devl:fix", "archive devl:perf"]);
});

test("without archiving, only the agents stop", async () => {
  const { deps, calls } = fakeBoxes();
  const res = await runStopJob([row("a", "fix")], false, deps);
  assert.equal(res.clean, true);
  assert.equal(jobOf(res.job)!.summary, "1 stopped");
  assert.deepEqual(calls, ["stop devl/a"]);
});

test("kept and failed rows make a report, each saying why", async () => {
  const { deps } = fakeBoxes({
    stop: async (_box, s) => {
      if (s === "d") throw new Error("box went away");
    },
    liveAgents: async () => [{ dir: "/w/busy", name: "someone-else" }],
    archive: async (_box, _loc, wt) => {
      if (wt.name === "dirty") throw new Error("contains uncommitted changes");
      if (wt.name === "broken") throw new Error("permission denied");
      return wt.name === "scripted" ? { archive: "pnpm archive" } : {};
    },
  });
  const res = await runStopJob([row("a", "dirty"), row("b", "busy"), row("c", "broken"), row("d", "gone"), row("e", "scripted")], true, deps);
  assert.equal(res.clean, false);
  assert.deepEqual(itemsOf(res.job), {
    "devl/a": "kept: Stopped · Kept: uncommitted changes",
    "devl/b": `kept: Stopped · Kept: ${KEPT_OTHER_AGENT}`,
    "devl/c": "failed: Stopped · Couldn't archive: permission denied",
    "devl/d": "failed: Failed: box went away",
    "devl/e": "done: Stopped · Archiving: its archive script runs, then it goes",
  });
  assert.equal(jobOf(res.job)!.summary, "4 stopped, 1 archiving, 2 kept, 2 failed");
});

test("Stop the rest sends nothing more; what was sent finishes", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  const { deps } = fakeBoxes({
    stop: async (_box, s) => {
      sent.push(s);
      await hold;
    },
  });
  const rows = ["a", "b", "c", "d", "e", "f"].map((s) => row(s, `wt-${s}`));
  const running = runStopJob(rows, true, deps);
  await new Promise((r) => setTimeout(r, 0));
  const id = useJobs.getState().jobs[0].id;
  assert.deepEqual(sent, ["a", "b", "c"], "three at a time");
  cancelJob(id);
  release();
  const res = await running;
  assert.deepEqual(sent, ["a", "b", "c"]);
  const items = itemsOf(res.job);
  for (const s of ["a", "b", "c"]) assert.equal(items[`devl/${s}`], "cancelled: Stopped · Not archived");
  for (const s of ["d", "e", "f"]) assert.equal(items[`devl/${s}`], "cancelled: Not stopped");
  assert.equal(jobOf(res.job)!.summary, "3 stopped, 3 not stopped, 3 not archived");
  assert.equal(res.clean, false);
});

test("the job carries on in the store with nothing holding it", async () => {
  useJobs.setState({ jobs: [] });
  const { deps } = fakeBoxes();
  // As the dialog does: start it and let go, with no view to keep it alive.
  void runStopJob([row("a", "fix")], true, deps);
  const id = useJobs.getState().jobs[0].id;
  for (let i = 0; i < 20 && !jobOf(id)!.finished; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(jobOf(id)!.summary, "1 stopped, 1 archived");
});

test("the summary names what was kept, failed and never sent", () => {
  assert.equal(stopSummary(17, 17, 0, Array(15).fill("archived")), "17 stopped, 15 archived");
  assert.equal(stopSummary(5, 3, 1, ["archived", "kept", "failed"]), "3 stopped, 1 archived, 1 kept, 2 failed, 1 not stopped");
});

test("an agent started in a worktree while its archive waited its turn keeps it", async () => {
  let listings = 0;
  const { deps, calls } = fakeBoxes({
    // The first look finds nobody; by its turn someone has started there.
    liveAgents: async () => (++listings === 1 ? [] : [{ dir: "/w/fix/app", name: "newcomer" }]),
  });
  const res = await runStopJob([row("a", "fix")], true, deps);
  assert.equal(itemsOf(res.job)["devl/a"], `kept: Stopped · Kept: ${KEPT_OTHER_AGENT}`);
  assert.deepEqual(calls.filter((c) => c.startsWith("archive")), []);
  assert.equal(removalOf(useRemovals.getState().byKey, "devl", "/w/fix"), undefined, "its mark goes with it");
});

test("a worktree already on its way out isn't asked for twice", async () => {
  markRemoving("devl", "/w/fix", "archive", "fix");
  const { deps, calls } = fakeBoxes();
  const res = await runStopJob([row("a", "fix"), row("b", "perf")], true, deps);
  assert.deepEqual(calls.filter((c) => c.startsWith("archive")), ["archive devl:perf"]);
  assert.equal(itemsOf(res.job)["devl/a"], "done: Stopped · Already being archived");
  assert.equal(res.clean, true);
});

test("while archives wait their turn they can still be held back", async () => {
  // Another removal on devl holds the line.
  let release!: () => void;
  const busy = inTurn("devl", () => new Promise<void>((r) => (release = r)));
  const { deps, calls } = fakeBoxes();
  const running = runStopJob([row("a", "fix"), row("b", "perf")], true, deps);
  for (let i = 0; i < 20 && jobOf(useJobs.getState().jobs[0].id)!.items.some((x) => x.state !== "queued"); i++) await new Promise((r) => setTimeout(r, 0));
  const id = useJobs.getState().jobs[0].id;
  assert.deepEqual(itemsOf(id), { "devl/a": "queued: Stopped · waiting to archive", "devl/b": "queued: Stopped · waiting to archive" });
  // Marked, so Archive… from the sidebar leaves them be meanwhile.
  assert.ok(removalOf(useRemovals.getState().byKey, "devl", "/w/fix"));
  cancelJob(id);
  release();
  await busy;
  const res = await running;
  assert.deepEqual(calls.filter((c) => c.startsWith("archive")), []);
  assert.equal(itemsOf(res.job)["devl/a"], "cancelled: Stopped · Not archived");
  assert.equal(removalOf(useRemovals.getState().byKey, "devl", "/w/fix"), undefined);
});

test("Stop the rest pressed while an archive looks for agents still holds it back", async () => {
  let listings = 0;
  const { deps, calls } = fakeBoxes({
    // The second look, in its turn, is when Stop the rest is pressed.
    liveAgents: async () => {
      if (++listings === 2) cancelJob(useJobs.getState().jobs[0].id);
      return [];
    },
  });
  const res = await runStopJob([row("a", "fix")], true, deps);
  assert.deepEqual(calls.filter((c) => c.startsWith("archive")), []);
  assert.equal(itemsOf(res.job)["devl/a"], "cancelled: Stopped · Not archived");
  assert.equal(removalOf(useRemovals.getState().byKey, "devl", "/w/fix"), undefined);
});

// A box that runs the stop itself (internal/box/runs/templates/stop.json),
// faked: each run is read back as the box would build its steps. held keeps
// it on its first three stops until it's cancelled or let go.
// startsLost: answers lost after the box took the run; startsDropped:
// asks that never reached it. forgets: the box no longer has the run.
// findFails: asking for a run by its group goes unanswered too.
function runsBox(o: { onBox?: (box: string) => boolean; refuses?: string[]; startsLost?: number; startsDropped?: number; stopFails?: Record<string, string>; archive?: Record<string, Pick<StopRunStep, "status" | "output" | "error">>; held?: boolean; awayFor?: number; forgets?: boolean; findFails?: boolean } = {}) {
  const started: { box: string; title: string; group: string; params: StopRunParams; idemKey: string }[] = [];
  const asked: string[] = [];
  let lost = 0;
  let dropped = 0;
  const cancelled = new Set<string>();
  let reads = 0;
  const step = (path: string, kind: string, s: Partial<StopRunStep>): StopRunStep => ({ path, kind, status: "succeeded", ...s });
  const runs: StopRuns = {
    onBox: (box) => o.onBox?.(box) ?? true,
    start: async (box, req) => {
      asked.push(req.idemKey);
      if (o.refuses?.includes(box)) throw Object.assign(new Error('template stop: no template "stop"'), { status: 400 });
      if (dropped++ < (o.startsDropped ?? 0)) throw Object.assign(new Error(`${box} is offline`), { status: 503 });
      // The run is taken (once per key), but the answer never comes back.
      if (!started.some((s) => s.idemKey === req.idemKey)) started.push({ box, ...req });
      if (lost++ < (o.startsLost ?? 0)) throw Object.assign(new Error(`${box} is offline`), { status: 503 });
      return { id: `r${started.findIndex((s) => s.idemKey === req.idemKey) + 1}` };
    },
    find: async (box, group) => {
      if (o.findFails) throw Object.assign(new Error(`${box} is offline`), { status: 503 });
      const k = started.findIndex((s) => s.box === box && s.group === group);
      return k < 0 ? undefined : { id: `r${k + 1}` };
    },
    get: async (_box, id) => {
      // The laptop asleep, or the box out of reach: no answer.
      if (++reads <= (o.awayFor ?? 0)) throw Object.assign(new Error("devl is offline"), { status: 503 });
      if (o.forgets) throw Object.assign(new Error("no run with that id"), { status: 404 });
      const { params } = started[Number(id.slice(1)) - 1];
      const held = o.held && !cancelled.has(id);
      const sent = held || cancelled.has(id) ? params.sessions.slice(0, 3) : params.sessions;
      const stops = sent.map((s, k) => step(`0.i${k}`, "item", { children: [step(`0.i${k}.0`, "stop_session", o.stopFails?.[s] ? { status: "failed", error: o.stopFails[s] } : held ? { status: "running" } : { output: "stopped" })] }));
      const archives = held || cancelled.has(id) ? [] : params.worktrees.map((w, j) => step(`1.i${j}`, "item", { children: [step(`1.i${j}.0`, "archive_worktree", o.archive?.[w.name] ?? { output: "Archived; its branch is kept" })] }));
      const status = held ? "running" : cancelled.has(id) ? "cancelled" : "succeeded";
      return { status, params: { ...params }, steps: [step("0", "map", { status, children: stops }), ...(archives.length ? [step("1", "map", { children: archives })] : [])] };
    },
    // The box takes a moment to cancel: reads meanwhile still say running.
    cancel: async (_box, id) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      cancelled.add(id);
    },
  };
  return { runs, started, asked, cancelled, release: () => (o.held = false), reachable: () => Object.assign(o, { startsLost: 0, startsDropped: 0, findFails: false }) };
}

test("a box with runs does its share as one run; a box without gets the app's loop", async () => {
  const { runs, started } = runsBox({ onBox: (box) => box === "devl" });
  const { deps, calls } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "fix"), row("b", "fix"), row("c"), row("d", "ci", "gpu")], true, deps);
  assert.deepEqual(
    started.map((s) => [s.box, s.params]),
    [["devl", { sessions: ["a", "b", "c"], worktrees: [{ location: "shop", name: "fix", path: "/w/fix", sessions: ["a", "b"] }] }]],
  );
  assert.equal(started[0].group, jobOf(res.job)!.ref);
  assert.deepEqual(calls, ["stop gpu/d", "archive gpu:ci"]);
  assert.deepEqual(itemsOf(res.job), {
    "devl/a": "done: Stopped · Archived; its branch is kept",
    "devl/b": "done: Stopped · Archived; its branch is kept",
    "devl/c": "done: Stopped",
    "gpu/d": "done: Stopped · Archived; its branch is kept",
  });
  assert.equal(jobOf(res.job)!.summary, "4 stopped, 2 archived");
  assert.equal(res.clean, true);
});

test("an archive the box failed shows the box's own words: a timeout is a failure, not kept", async () => {
  const timedOut = "git worktree remove timed out after 10 min and was stopped; the folder may be partly removed, and archiving it again finishes it";
  const silent = "git worktree remove failed with no output (exit status 1)";
  const { runs } = runsBox({ archive: { slow: { status: "failed", error: timedOut }, mute: { status: "failed", error: silent } } });
  const { deps } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "slow"), row("b", "mute")], true, deps);
  assert.deepEqual(itemsOf(res.job), {
    "devl/a": `failed: Stopped · Couldn't archive: ${timedOut}`,
    "devl/b": `failed: Stopped · Couldn't archive: ${silent}`,
  });
  assert.equal(jobOf(res.job)!.summary, "2 stopped, 2 failed");
});

test("a box offline at the start, or from before stop runs, gets the app's loop for its rows", async () => {
  const { runs, started } = runsBox({ onBox: (box) => box !== "gpu", refuses: ["devl"] });
  const { deps, calls } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "fix"), row("b", "ci", "gpu"), row("c", "eval", "mini")], true, deps);
  assert.deepEqual(
    started.map((s) => s.box),
    ["mini"],
  );
  assert.deepEqual(calls.sort(), ["archive devl:fix", "archive gpu:ci", "stop devl/a", "stop gpu/b"]);
  assert.equal(jobOf(res.job)!.summary, "3 stopped, 3 archived");
});

test("a start whose answer was lost is asked again under the same key: one run, followed, nothing done twice", async () => {
  const { runs, started, asked } = runsBox({ startsLost: 2 });
  const { deps, calls } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "fix")], true, deps);
  assert.equal(asked.length, 3);
  assert.equal(new Set(asked).size, 1, "one idempotency key");
  assert.equal(started.length, 1);
  assert.deepEqual(calls, [], "the app didn't do it as well");
  assert.equal(jobOf(res.job)!.summary, "1 stopped, 1 archived");
});

test("a box that doesn't answer the start is asked until it does: its rows wait for it, and nothing fails", async () => {
  const { runs, started, asked } = runsBox({ startsDropped: 6 });
  const { deps, calls } = fakeBoxes({ runs, every: 1 });
  const running = runStopJob([row("a", "fix")], true, deps);
  for (let i = 0; i < 100 && asked.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(itemsOf(useJobs.getState().jobs[0].id)["devl/a"], "queued: Waiting for devl");
  const res = await running;
  assert.equal(asked.length, 7);
  assert.equal(started.length, 1);
  assert.deepEqual(calls, [], "the app didn't do it as well");
  assert.equal(jobOf(res.job)!.summary, "1 stopped, 1 archived");
});

test("Stop the rest while a start goes unanswered: a run the box took is cancelled there, and with none nothing is done", async () => {
  // The box took it, but every answer was lost.
  const took = runsBox({ startsLost: 1000, held: true });
  const a = fakeBoxes({ runs: took.runs, every: 1 });
  const first = runStopJob([row("a", "fix")], true, a.deps);
  for (let i = 0; i < 100 && took.asked.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
  cancelJob(useJobs.getState().jobs[0].id);
  const r1 = await first;
  assert.deepEqual([...took.cancelled], ["r1"], "its run is found by its group, and cancelled");
  assert.deepEqual(a.calls, []);
  assert.equal(itemsOf(r1.job)["devl/a"], "cancelled: Stopped · Not archived");

  // No ask ever reached the box.
  const never = runsBox({ startsDropped: 1000 });
  const b = fakeBoxes({ runs: never.runs, every: 1 });
  const second = runStopJob([row("b", "perf")], true, b.deps);
  for (let i = 0; i < 100 && never.asked.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
  cancelJob(useJobs.getState().jobs[0].id);
  const r2 = await second;
  assert.equal(never.started.length, 0);
  assert.deepEqual(b.calls, []);
  assert.equal(itemsOf(r2.job)["devl/b"], "cancelled: Not stopped");
  assert.equal(jobOf(r2.job)!.summary, "0 stopped, 1 not stopped");
});

test("a run its box no longer has fails its rows and lets go of their Archiving… marks", async () => {
  const { runs } = runsBox({ forgets: true });
  const { deps } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "fix")], true, deps);
  assert.equal(itemsOf(res.job)["devl/a"], "failed: Failed: devl no longer has this run");
  assert.equal(removalOf(useRemovals.getState().byKey, "devl", "/w/fix"), undefined);
});

test("an archive whose script runs holds its box's line until the box says the worktree went", async () => {
  const order: string[] = [];
  let gone: (how: "gone") => void = () => {};
  const { deps } = fakeBoxes({
    archive: async (_box, _loc, wt) => {
      order.push(`archive ${wt.name}`);
      return { archive: "pnpm archive" };
    },
    settled: (_box, path) =>
      new Promise((resolve) => {
        order.push(`script ${path}`);
        gone = resolve;
      }),
  });
  const running = runStopJob([row("a", "fix"), row("b", "perf")], true, deps);
  for (let i = 0; i < 100 && order.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["archive fix", "script /w/fix"], "perf waits for fix's script");
  gone("gone");
  for (let i = 0; i < 100 && order.length < 4; i++) await new Promise((r) => setTimeout(r, 1));
  gone("gone");
  const res = await running;
  assert.deepEqual(order, ["archive fix", "script /w/fix", "archive perf", "script /w/perf"]);
  assert.equal(jobOf(res.job)!.summary, "2 stopped, 2 archived");
});

test("the run's steps become the rows, in the app's words, and a step not reached yet waits", () => {
  const params: StopRunParams = {
    sessions: ["a", "b", "c", "d", "e", "f"],
    worktrees: [
      { location: "shop", name: "dirty", path: "/w/dirty", sessions: ["a"] },
      { location: "shop", name: "busy", path: "/w/busy", sessions: ["b"] },
      { location: "shop", name: "held", path: "/w/held", sessions: ["c", "d"] },
      { location: "shop", name: "scripted", path: "/w/scripted", sessions: ["e"] },
      { location: "shop", name: "next", path: "/w/next", sessions: ["f"] },
    ],
  };
  const leaf = (path: string, status: string, more: Partial<StopRunStep> = {}): StopRunStep => ({ path: path.split(".").slice(0, 2).join("."), kind: "item", status, children: [{ path, kind: "leaf", status, ...more }] });
  const read = readStopRun({
    status: "running",
    params: { ...params },
    steps: [
      { path: "0", kind: "map", status: "failed", children: ["a", "b", "c", "e", "f"].map((s) => leaf(`0.i${params.sessions.indexOf(s)}.0`, "succeeded")).concat(leaf("0.i3.0", "failed", { error: "a before:session.stop hook stopped it" })) },
      {
        path: "1",
        kind: "map",
        status: "running",
        children: [
          leaf("1.i0.0", "skipped", { output: "Kept: uncommitted changes" }),
          leaf("1.i1.0", "skipped", { output: `Kept: ${KEPT_OTHER_AGENT}` }),
          leaf("1.i2.0", "skipped", { output: "Kept: an agent there didn't stop" }),
          leaf("1.i3.0", "running"),
        ],
      },
    ],
  });
  assert.deepEqual(read.rows, {
    a: { state: "kept", message: "Stopped · Kept: uncommitted changes" },
    b: { state: "kept", message: `Stopped · Kept: ${KEPT_OTHER_AGENT}` },
    c: { state: "kept", message: "Stopped · Kept: an agent there didn't stop" },
    d: { state: "failed", message: "Failed: a before:session.stop hook stopped it" },
    e: { state: "running", message: "Archiving…" },
    f: { state: "queued", message: "Stopped · waiting to archive" },
  });
  assert.deepEqual(read.worktrees, { "/w/dirty": "kept", "/w/busy": "kept", "/w/held": "kept" });
  assert.equal(read.over, false);
});

test("the laptop losing touch with the box fails nothing: the job waits for the box to say", async () => {
  const { runs } = runsBox({ awayFor: 3, archive: { fix: { status: "succeeded", output: "Archiving: its archive script runs, then it goes" } } });
  const { deps } = fakeBoxes({ runs, every: 1 });
  const res = await runStopJob([row("a", "fix"), row("b")], true, deps);
  assert.deepEqual(itemsOf(res.job), { "devl/a": "done: Stopped · Archiving: its archive script runs, then it goes", "devl/b": "done: Stopped" });
  assert.equal(jobOf(res.job)!.summary, "2 stopped, 1 archiving");
});

test("Stop the rest cancels the box's run: what it began finishes there, the rest isn't done", async () => {
  const { runs, cancelled } = runsBox({ held: true });
  const { deps, calls } = fakeBoxes({ runs, every: 1 });
  const rows = ["a", "b", "c", "d", "e", "f"].map((s) => row(s, `wt-${s}`));
  const running = runStopJob(rows, true, deps);
  for (let i = 0; i < 50 && jobOf(useJobs.getState().jobs[0].id)!.items[0].state !== "running"; i++) await new Promise((r) => setTimeout(r, 1));
  cancelJob(useJobs.getState().jobs[0].id);
  const res = await running;
  assert.deepEqual([...cancelled], ["r1"]);
  assert.deepEqual(calls, [], "the app sent nothing itself");
  const items = itemsOf(res.job);
  for (const s of ["a", "b", "c"]) assert.equal(items[`devl/${s}`], "cancelled: Stopped · Not archived");
  for (const s of ["d", "e", "f"]) assert.equal(items[`devl/${s}`], "cancelled: Not stopped");
  assert.equal(jobOf(res.job)!.summary, "3 stopped, 3 not stopped, 3 not archived");
  for (const s of ["a", "d"]) assert.equal(removalOf(useRemovals.getState().byKey, "devl", `/w/wt-${s}`), undefined, "the marks go with them");
});

test("after a relaunch the job comes back from the box's runs, with how they ended, until it's dismissed", async () => {
  const kept = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } });
  try {
    useJobs.setState({ jobs: [] });
    const box = runsBox({ held: true });
    const { deps } = fakeBoxes({ runs: box.runs, every: 1 });
    const first = runStopJob([row("a", "fix"), row("b", "perf")], true, deps);
    for (let i = 0; i < 50 && !kept.get("berth.jobs.stopRuns"); i++) await new Promise((r) => setTimeout(r, 1));
    // The app quits mid-run; the box carries on and finishes.
    useJobs.setState({ jobs: [] });
    await first;
    box.release();

    await reattachStopJobs({ runs: box.runs, every: 1 });
    const [job] = useJobs.getState().jobs;
    assert.equal(job.title, "Stopping 2 agents");
    assert.equal(job.summary, "2 stopped, 2 archived");
    assert.deepEqual(itemsOf(job.id), { "devl/a": "done: Stopped · Archived; its branch is kept", "devl/b": "done: Stopped · Archived; its branch is kept" });
    // Brought back once, however often the app reconnects.
    await reattachStopJobs({ runs: box.runs, every: 1 });
    assert.equal(useJobs.getState().jobs.length, 1);
    dismissJob(job.id);
    assert.deepEqual(JSON.parse(kept.get("berth.jobs.stopRuns")!), []);
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a job is kept before its start is sent, so one the app quit on before the box answered is asked for again after a relaunch", async () => {
  const kept = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } });
  try {
    useJobs.setState({ jobs: [] });
    const box = runsBox({ startsDropped: 1000 });
    const { deps } = fakeBoxes({ runs: box.runs, every: 1 });
    const first = runStopJob([row("a", "fix")], true, deps);
    for (let i = 0; i < 100 && box.asked.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    const [saved] = JSON.parse(kept.get("berth.jobs.stopRuns")!);
    assert.equal(saved.runs[0].id, undefined, "kept with no run yet");
    assert.deepEqual(saved.runs[0].params.sessions, ["a"]);
    // The app quits while the box is out of reach.
    useJobs.setState({ jobs: [] });
    await first;

    // Back, the box answers: asked again under the same key, it takes it.
    const back = runsBox();
    await reattachStopJobs({ runs: back.runs, every: 1 });
    assert.equal(back.started.length, 1);
    assert.equal(back.started[0].idemKey, box.asked[0], "the same key");
    const [job] = useJobs.getState().jobs;
    assert.equal(job.summary, "1 stopped, 1 archived");
    assert.equal(JSON.parse(kept.get("berth.jobs.stopRuns")!)[0].runs[0].id, "r1");
    dismissJob(job.id);
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("Stop the rest while the box is out of reach is kept: after a relaunch its run is only looked up and cancelled, never started", async () => {
  const kept = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } });
  try {
    for (const tookIt of [true, false]) {
      kept.clear();
      useJobs.setState({ jobs: [] });
      // The box took the first ask (its answer lost), or never got one; and
      // it answers nothing, a lookup included, until the relaunch.
      const box = runsBox(tookIt ? { startsLost: 1000, findFails: true, held: true } : { startsDropped: 1000, findFails: true });
      const { deps, calls } = fakeBoxes({ runs: box.runs, every: 1 });
      const first = runStopJob([row("a", "fix")], true, deps);
      for (let i = 0; i < 100 && box.asked.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
      cancelJob(useJobs.getState().jobs[0].id);
      const r1 = await first;
      assert.equal(itemsOf(r1.job)["devl/a"], "failed: Failed: devl didn't answer, so it may still stop it");
      assert.equal(JSON.parse(kept.get("berth.jobs.stopRuns")!)[0].cancelled, true, "the cancel is kept");
      const sent = box.asked.length;

      // Relaunched, the box back.
      useJobs.setState({ jobs: [] });
      box.reachable();
      await reattachStopJobs({ runs: box.runs, every: 1 });
      assert.equal(box.asked.length, sent, "no start is sent again");
      assert.deepEqual(calls, []);
      const [job] = useJobs.getState().jobs;
      if (tookIt) {
        assert.deepEqual([...box.cancelled], ["r1"], "the run it took is cancelled");
        assert.equal(itemsOf(job.id)["devl/a"], "cancelled: Stopped · Not archived");
      } else {
        assert.equal(box.started.length, 0);
        assert.equal(itemsOf(job.id)["devl/a"], "cancelled: Not stopped");
      }
      dismissJob(job.id);
    }
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
