// The board's bulk Stop as a background job (lib/jobs.ts). A box with runs
// does its share itself, as one stop run (internal/box/runs/templates/
// stop.json): it stops the agents a few at a time, then archives their
// worktrees where it's safe, one at a time, and keeps going while the
// laptop sleeps. The job only follows the run: a row fails when the box
// says so, never because the laptop lost touch. It is kept before the
// start is sent, so it comes back after a relaunch (reattachStopJobs), and
// a start whose answer never came is asked again or looked up by its group
// (startStopRun). A box without runs, or offline when
// it starts, gets the app's own loop for its rows: the agents stopped a few
// at a time, then their worktrees archived where it's safe
// (lib/archive-after-stop.ts), one at a time on each box in the same line
// as every other removal there (inTurn). "Stop the rest" sends nothing
// more: rows not yet stopped say "Not stopped", worktrees not yet archived
// are left as they are.
//
// No imports from "@/": pnpm test runs this file in plain node. The calls to
// the boxes come in as deps (lib/stop-on-box.ts, views/dashboard/stop.tsx).

import { planArchive, type StopTarget, type WorktreeTarget } from "./archive-after-stop.ts";
import { plural } from "./format.ts";
import { cancelJob, finishJob, type JobItem, isCancelling, jobOf, onCancel, onDismiss, outcomeOf, runPool, setItem, startJob, useJobs } from "./jobs.ts";
import { archivedMessage, clearRemoving, inTurn, KEPT_DIRTY, keepsWork, markRemoving, markScript, removalKey, removalOf, useRemovals } from "./removing.ts";
import { load, save } from "./storage.ts";

export interface StopItem extends StopTarget {
  session: string;
  // What the tray calls it: its place, and its name when the place is shared.
  label: string;
  aside?: string;
}

// A stop run as GET /v1/runs/{id} has it, as far as the job reads it.
export interface StopRunStep {
  path: string;
  kind: string;
  status: string;
  output?: string;
  error?: string;
  children?: StopRunStep[];
}

export interface StopRun {
  status: string;
  error?: string;
  params?: Record<string, unknown>;
  steps: StopRunStep[];
}

// The stop template's parameters: the sessions, and the worktrees to archive
// once they stopped, each with the batch's sessions that worked there.
export interface StopRunParams {
  sessions: string[];
  worktrees: { location: string; name: string; path: string; sessions: string[] }[];
}

// StopRuns reach the boxes' runs (lib/stop-on-box.ts).
export interface StopRuns {
  // Whether the box does it itself: it has runs and is online.
  onBox(box: string): boolean;
  // idemKey makes asking again after an answer that never came safe.
  start(box: string, req: { title: string; group: string; params: StopRunParams; idemKey: string }): Promise<{ id: string }>;
  // The run started under group, when the box has one.
  find(box: string, group: string): Promise<{ id: string } | undefined>;
  get(box: string, id: string): Promise<StopRun>;
  cancel(box: string, id: string): Promise<void>;
}

export interface StopDeps {
  stop(box: string, session: string): Promise<void>;
  // The agent sessions still live on a box, fresh, or undefined when it
  // doesn't answer.
  liveAgents(box: string): Promise<{ dir: string; name: string }[] | undefined>;
  archive(box: string, location: string, wt: { name: string; path: string }): Promise<{ archive?: string }>;
  // How an archive whose script runs on the box ended, once it says:
  // gone, failed, or undefined when it can't tell. The box's line waits for
  // it, so its archive scripts never run side by side.
  settled?(box: string, path: string): Promise<"gone" | "failed" | undefined>;
  errorText(err: unknown): string;
  // The boxes that do it themselves; without it the app does it all.
  runs?: StopRuns;
  // How often a run is read, in ms.
  every?: number;
}

export type WorktreeOutcome = "archived" | "archiving" | "kept" | "failed" | "cancelled";

export interface StopResult {
  job: number;
  // By worktree (removalKey).
  worktrees: Record<string, WorktreeOutcome>;
  clean: boolean;
}

// What one part of a job did, for its summary.
interface Tally {
  stopped: number;
  unsent: number;
  // By worktree (removalKey).
  worktrees: Record<string, WorktreeOutcome>;
}

// A few at a time, so a long list is quick without every request landing on
// a box at once.
const CONCURRENCY = 3;
// A run's map takes at most 64 items (internal/box/runs/exec.go): a box
// asked for more does it the app's way.
const MAX_ITEMS = 64;
const ARCHIVING = archivedMessage({ archive: "yes" });

const willArchive = (archive: boolean) => (r: StopItem) => archive && !!r.where && !r.where.worktree.main;

export const fitsRun = (p: StopRunParams) => p.sessions.length <= MAX_ITEMS && p.worktrees.length <= MAX_ITEMS;

export async function runStopJob(rows: StopItem[], archive: boolean, deps: StopDeps): Promise<StopResult> {
  const title = `Stopping ${plural(rows.length, "agent")}`;
  const ref = `stop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const items = rows.map((r) => ({ key: r.key, group: r.box, label: r.label, aside: r.aside, message: "Waiting to stop" }));
  const job = startJob({ title, items, cancellable: true, ref });

  const byBox = new Map<string, StopItem[]>();
  for (const r of rows) byBox.set(r.box, [...(byBox.get(r.box) ?? []), r]);
  // Each box with runs takes its share as one run; the rest is the app's.
  const shares = [...byBox].map(([box, mine]) => ({ box, mine, params: stopParams(mine, archive) }));
  const onBox = shares.filter((sh) => deps.runs?.onBox(sh.box) && fitsRun(sh.params));
  // Kept before anything is sent, so a relaunch before a box answers still
  // finds its run, or asks for it again (reattachStopJobs).
  if (onBox.length) {
    const boxes = new Set(onBox.map((sh) => sh.box));
    remember({ ref, title, started: Date.now(), runs: onBox.map(({ box, params }) => ({ box, params })), items: items.filter((i) => boxes.has(i.group)) });
  }
  const local = shares.filter((sh) => !onBox.includes(sh)).flatMap((sh) => sh.mine);
  const tallies = await Promise.all([
    ...onBox.map(async ({ box, mine, params }) => {
      const t = await onTheBox(job, { ref, title, box, params, keys: mine.map((r) => r.key) }, deps.runs!, deps.every);
      // Refused (a box from before stop runs): nothing was sent, so the app
      // does it.
      return t ?? appStop(job, mine, archive, deps);
    }),
    local.length ? appStop(job, local, archive, deps) : undefined,
  ]);
  const worktrees: Record<string, WorktreeOutcome> = Object.assign({}, ...tallies.map((t) => t?.worktrees ?? {}));
  const sum = (k: "stopped" | "unsent") => tallies.reduce((n, t) => n + (t?.[k] ?? 0), 0);
  finishJob(job, stopSummary(rows.length, sum("stopped"), sum("unsent"), Object.values(worktrees)));
  const done = jobOf(job);
  return { job, worktrees, clean: !!done && outcomeOf(done) === "clean" };
}

// onTheBox has box do one share of a job as a stop run and follows it, its
// rows (keys) waiting for the box until it answers. Undefined is the box
// refusing it: nothing was sent.
async function onTheBox(job: number, sh: { ref: string; title: string; box: string; params: StopRunParams; keys: string[]; asked?: boolean }, runs: StopRuns, every?: number): Promise<Tally | undefined> {
  const { ref, box, params, keys } = sh;
  const started = await startStopRun(runs, box, { title: sh.title, group: ref, params }, {
    every,
    asked: sh.asked,
    // A job that left the tray (the app quitting) asks no more; it stays
    // kept for the next start.
    cancelled: () => isCancelling(job) || !jobOf(job),
    waiting: () => {
      for (const k of keys) if (jobOf(job)?.items.find((i) => i.key === k)?.state === "queued") setItem(job, k, { message: `Waiting for ${box}` });
    },
  });
  const none: Tally = { stopped: 0, unsent: 0, worktrees: {} };
  if (!jobOf(job)) return none;
  if (started === "refused") {
    keptRun(ref, box, undefined);
    return undefined;
  }
  if (started === "unsent") {
    keptRun(ref, box, undefined);
    for (const k of keys) setItem(job, k, { state: "cancelled", message: "Not stopped" });
    return { ...none, unsent: keys.length };
  }
  if (started === "unknown") {
    for (const k of keys) setItem(job, k, { state: "failed", message: `Failed: ${box} didn't answer, so it may still stop it` });
    return none;
  }
  keptRun(ref, box, started.id);
  for (const w of params.worktrees) if (!removalOf(useRemovals.getState().byKey, box, w.path)) markRemoving(box, w.path, "archive", w.name);
  return followJobRun(job, box, started.id, runs, every, params);
}

// What became of asking a box to start a stop run: its id; refused (4xx: a
// box from before stop runs), so nothing was sent and the app does it;
// unsent, cancelled before the box had it; or unknown, cancelled while the
// box never answered (the share stays kept, cancelled, for the next start to
// look up again).
export type Started = { id: string } | "refused" | "unsent" | "unknown";

// Asked again no slower than this, while a box doesn't answer.
const MAX_RETRY_MS = 30_000;

// startStopRun asks box to take its share as one stop run. A box that
// doesn't answer is asked again, under the same idempotency key, until it
// does: a run whose answer was lost is neither started twice nor given up
// on, and its rows never fail for the laptop losing touch. waiting hears
// each time it goes unanswered. Once cancelled says so it asks no more; a
// box asked before then is asked whether it has the run (its group), so a
// run it took is followed, and cancelled, rather than lost. asked says it
// may have been asked before (a share brought back after a relaunch), so a
// cancelled one is looked up and never sent.
export async function startStopRun(runs: StopRuns, box: string, req: { title: string; group: string; params: StopRunParams }, o: { every?: number; asked?: boolean; cancelled?(): boolean; waiting?(err: unknown): void } = {}): Promise<Started> {
  const every = o.every ?? 1500;
  for (let tries = 0; ; tries++) {
    if (o.cancelled?.()) return tries || o.asked ? lookUp(runs, box, req.group, every) : "unsent";
    try {
      return { id: (await runs.start(box, { ...req, idemKey: `${req.group}/${box}` })).id };
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500) return "refused";
      o.waiting?.(err);
      await sleep(Math.min(every * 2 * (tries + 1), MAX_RETRY_MS));
    }
  }
}

// lookUp asks box for the run started under group: a few times, as the
// user is waiting on Stop the rest.
async function lookUp(runs: StopRuns, box: string, group: string, every: number): Promise<Started> {
  for (let tries = 1; ; tries++) {
    try {
      const run = await runs.find(box, group);
      return run ? { id: run.id } : "unsent";
    } catch {
      if (tries >= 3) return "unknown";
      await sleep(every * 2);
    }
  }
}

// stopParams is one box's share as the stop template takes it: its
// sessions, and, when archiving, the worktrees they worked in, each once.
export function stopParams(rows: StopItem[], archive: boolean): StopRunParams {
  const byPath = new Map<string, StopRunParams["worktrees"][number]>();
  for (const r of rows.filter(willArchive(archive))) {
    const wt = r.where!.worktree;
    const w = byPath.get(wt.path) ?? { location: r.where!.location, name: wt.name, path: wt.path, sessions: [] };
    w.sessions.push(r.session);
    byPath.set(wt.path, w);
  }
  return { sessions: rows.map((r) => r.session), worktrees: [...byPath.values()] };
}

export interface StopRead {
  // By session: what its row says.
  rows: Record<string, Pick<JobItem, "state" | "message">>;
  // By worktree path, once the box says how its archive went, and in what
  // words: "Kept: uncommitted changes".
  worktrees: Record<string, WorktreeOutcome>;
  said: Record<string, string>;
  stopped: number;
  unsent: number;
  over: boolean;
}

const stepAt = (steps: StopRunStep[] | undefined, path: string): StopRunStep | undefined => {
  for (const s of steps ?? []) {
    if (s.path === path) return s;
    if (path.startsWith(`${s.path}.`)) return stepAt(s.children, path);
  }
  return undefined;
};

const ended = (status: string) => status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";

// readStopRun reads a stop run's steps into its rows, in the words the
// app's own loop uses. Session k's stop is step 0.ik.0, worktree j's
// archive 1.ij.0. A step the run never got to is waiting while it goes,
// and, once it's over, not done (cancelled) or failed with the run.
export function readStopRun(run: StopRun): StopRead {
  const sessions = ((run.params?.sessions ?? []) as (string | { session: string })[]).map((s) => (typeof s === "string" ? s : s.session));
  const worktrees = (run.params?.worktrees ?? []) as StopRunParams["worktrees"];
  const over = ended(run.status);
  const cancelled = run.status === "cancelled";
  const why = (st?: StopRunStep) => st?.error || run.error || "the box didn't say why";
  const read: StopRead = { rows: {}, worktrees: {}, said: {}, stopped: 0, unsent: 0, over };
  const stopped = new Set<string>();
  sessions.forEach((s, k) => {
    const st = stepAt(run.steps, `0.i${k}.0`);
    const status = st?.status ?? (!over ? "queued" : cancelled ? "cancelled" : "failed");
    if (status === "succeeded" || status === "skipped") {
      stopped.add(s);
      read.stopped++;
      read.rows[s] = { state: "done", message: "Stopped" };
    } else if (status === "running" || status === "queued") {
      read.rows[s] = status === "running" ? { state: "running", message: "Stopping…" } : { state: "queued", message: "Waiting to stop" };
    } else if (status === "cancelled") {
      read.unsent++;
      read.rows[s] = { state: "cancelled", message: "Not stopped" };
    } else {
      read.rows[s] = { state: "failed", message: `Failed: ${why(st)}` };
    }
  });
  worktrees.forEach((w, j) => {
    const mine = w.sessions.filter((s) => stopped.has(s));
    // Every stop there failed: those rows say so, and nothing there changed.
    if (w.sessions.length && !mine.length) return;
    const st = stepAt(run.steps, `1.i${j}.0`);
    const status = st?.status ?? (!over ? "queued" : cancelled ? "cancelled" : "failed");
    let outcome: WorktreeOutcome | undefined;
    let row: Pick<JobItem, "state" | "message">;
    if (status === "queued") row = { state: "queued", message: "Stopped · waiting to archive" };
    else if (status === "running") row = { state: "running", message: "Archiving…" };
    else if (status === "succeeded") {
      outcome = st?.output === ARCHIVING ? "archiving" : "archived";
      row = { state: "done", message: `Stopped · ${outcome === "archiving" ? ARCHIVING : archivedMessage({})}` };
    } else if (status === "skipped") {
      outcome = "kept";
      row = { state: "kept", message: `Stopped · ${st?.output || "Kept"}` };
    } else if (status === "cancelled") {
      outcome = "cancelled";
      row = { state: "cancelled", message: "Stopped · Not archived" };
    } else {
      outcome = "failed";
      row = { state: "failed", message: `Stopped · Couldn't archive: ${why(st)}` };
    }
    if (outcome) {
      read.worktrees[w.path] = outcome;
      read.said[w.path] = row.message!.replace(/^Stopped · /, "");
    }
    for (const s of mine) read.rows[s] = row;
  });
  return read;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// followStopRun reads a box's stop run until it's over, telling onRead
// each time; onRead answering false stops following. A box that doesn't
// answer is asked again, so the laptop sleeping or losing touch fails
// nothing. Once cancelled() says so, the box is asked to stop the rest: the
// step in flight finishes there. Undefined is a run the box no longer has.
export async function followStopRun(runs: StopRuns, box: string, id: string, o: { every?: number; onRead(read: StopRead, run: StopRun): void | false; cancelled?(): boolean }): Promise<StopRead | undefined> {
  const every = o.every ?? 1500;
  let asked = false;
  for (;;) {
    if (!asked && o.cancelled?.()) {
      asked = true;
      runs.cancel(box, id).catch(() => (asked = false));
    }
    let run: StopRun;
    try {
      run = await runs.get(box, id);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return undefined;
      await sleep(every * 2);
      continue;
    }
    const read = readStopRun(run);
    if (o.onRead(read, run) === false || read.over) return read;
    await sleep(every);
  }
}

// followJobRun keeps a job's rows on box in step with its stop run.
async function followJobRun(job: number, box: string, id: string, runs: StopRuns, every?: number, params?: StopRunParams): Promise<Tally> {
  const read = await followStopRun(runs, box, id, {
    every,
    cancelled: () => isCancelling(job),
    onRead: (r, run) => {
      if (!jobOf(job)) return false;
      for (const [s, item] of Object.entries(r.rows)) setItem(job, `${box}/${s}`, item);
      for (const w of (run.params?.worktrees ?? []) as StopRunParams["worktrees"]) {
        // Archived, its worktree.removed clears the mark; one the run left
        // as it was, or never got to, is unmarked here.
        const o = r.worktrees[w.path];
        if (o === "archiving") markScript(box, w.path);
        else if (o ? o !== "archived" : r.over) clearRemoving(box, w.path);
      }
    },
  });
  if (!read) {
    for (const i of jobOf(job)?.items ?? []) if (i.group === box && i.state !== "done") setItem(job, i.key, { state: "failed", message: `Failed: ${box} no longer has this run` });
    // Its worktrees were marked Archiving… for it: no word will come now.
    for (const w of params?.worktrees ?? []) clearRemoving(box, w.path);
    return { stopped: 0, unsent: 0, worktrees: {} };
  }
  const worktrees: Record<string, WorktreeOutcome> = {};
  for (const [path, o] of Object.entries(read.worktrees)) worktrees[removalKey(box, path)] = o;
  return { stopped: read.stopped, unsent: read.unsent, worktrees };
}

// appStop is the app's own loop, for the rows of boxes that don't run it.
async function appStop(job: number, rows: StopItem[], archive: boolean, deps: StopDeps): Promise<Tally> {
  const stopped = new Set<string>();
  const unsent = await runPool(
    rows,
    CONCURRENCY,
    async (r) => {
      setItem(job, r.key, { state: "running", message: "Stopping…" });
      try {
        await deps.stop(r.box, r.session);
        stopped.add(r.key);
        setItem(job, r.key, willArchive(archive)(r) ? { state: "running", message: "Stopped" } : { state: "done", message: "Stopped" });
      } catch (err) {
        setItem(job, r.key, { state: "failed", message: `Failed: ${deps.errorText(err)}` });
      }
    },
    () => isCancelling(job),
  );
  for (const r of unsent) setItem(job, r.key, { state: "cancelled", message: "Not stopped" });

  const worktrees: Record<string, WorktreeOutcome> = {};
  const candidates = rows.filter(willArchive(archive));
  if (candidates.length) {
    // Only a worktree's stopped rows: one kept because a stop failed there
    // also has rows that say Failed.
    const setRows = (w: WorktreeTarget, item: Pick<JobItem, "state" | "message">) => {
      for (const k of w.rows) if (stopped.has(k)) setItem(job, k, item);
    };
    const report = (w: WorktreeTarget, o: WorktreeOutcome, message: string) => {
      worktrees[w.key] = o;
      setRows(w, { state: o === "archived" || o === "archiving" ? "done" : o, message: `Stopped · ${message}` });
    };
    // planArchive over the box's own listing, fresh, so an agent started a
    // moment ago counts. A box that doesn't answer keeps its worktrees.
    const check = async (targets: StopItem[], box?: string) => {
      const boxes = box ? [box] : [...new Set(targets.map((r) => r.box))];
      const listed = await Promise.all(boxes.map(async (b) => ({ box: b, agents: await deps.liveAgents(b).catch(() => undefined) })));
      const live = listed.flatMap(({ box: b, agents }) => (agents ?? []).map((a) => ({ box: b, ...a })));
      return planArchive(targets, stopped, live, new Set(listed.filter((l) => !l.agents).map((l) => l.box)));
    };
    const plan = await check(candidates);
    for (const k of plan.kept) report(k, "kept", `Kept: ${k.why}`);
    const queued = plan.archive.filter((w) => {
      // Already on its way out (Archive… from the sidebar): its box needn't
      // hear it twice.
      if (removalOf(useRemovals.getState().byKey, w.box, w.wt.path)) {
        report(w, "archiving", "Already being archived");
        return false;
      }
      // Marked from now, so nothing else asks for it while it waits its turn.
      markRemoving(w.box, w.wt.path, "archive", w.wt.name);
      // Queued: not sent, so Stop the rest can still hold it back.
      setRows(w, { state: "queued", message: "Stopped · waiting to archive" });
      return true;
    });
    await Promise.all(
      queued.map((w) =>
        inTurn(w.box, async () => {
          const leave = (o: WorktreeOutcome, message: string) => {
            clearRemoving(w.box, w.wt.path);
            report(w, o, message);
          };
          if (isCancelling(job)) return leave("cancelled", "Not archived");
          setRows(w, { state: "running", message: "Archiving…" });
          // Its turn may come minutes later: look again for an agent
          // started there meanwhile.
          const again = await check(
            candidates.filter((r) => w.rows.includes(r.key)),
            w.box,
          );
          if (again.kept.length) return leave("kept", `Kept: ${again.kept[0].why}`);
          // Stop the rest may have come while it looked.
          if (isCancelling(job)) return leave("cancelled", "Not archived");
          try {
            const res = await deps.archive(w.box, w.location, w.wt);
            report(w, res.archive ? "archiving" : "archived", archivedMessage(res));
            if (res.archive && deps.settled) {
              const how = await deps.settled(w.box, w.wt.path);
              if (how === "gone") report(w, "archived", archivedMessage({}));
              else if (how === "failed") report(w, "failed", "Couldn't archive: its archive script failed");
            }
          } catch (err) {
            if (keepsWork(err)) leave("kept", KEPT_DIRTY);
            else leave("failed", `Couldn't archive: ${deps.errorText(err)}`);
          }
        }),
      ),
    );
  }
  return { stopped: stopped.size, unsent: unsent.length, worktrees };
}

// The jobs whose runs the boxes carry on with, kept from before their start
// is sent until they're dismissed, so a relaunch brings them back.
const KEPT_JOBS = "berth.jobs.stopRuns";
// A run's journal goes after a while; a job that old isn't brought back,
// dismissed or not.
const KEEP_MS = 24 * 60 * 60 * 1000;

interface KeptJob {
  ref: string;
  title: string;
  started: number;
  // Stop the rest was pressed: brought back, it sends nothing, and a share
  // whose start went unanswered is only looked up, to be cancelled.
  cancelled?: boolean;
  // Each box's share: id once the box answered the start; params to ask
  // again with, under the same group and key, and for its worktrees.
  runs: { box: string; id?: string; params?: StopRunParams }[];
  // The rows of those runs.
  items: Omit<JobItem, "state">[];
}

const keptJobs = () => load<KeptJob[]>(KEPT_JOBS, []).filter((k) => Date.now() - k.started < KEEP_MS);
const remember = (k: KeptJob) => save(KEPT_JOBS, [...keptJobs().filter((x) => x.ref !== k.ref), k]);
// keptRun notes box's run for the job ref, or, without an id, that box has
// none (it refused, or nothing was sent): its share and rows aren't kept.
function keptRun(ref: string, box: string, id: string | undefined) {
  save(
    KEPT_JOBS,
    keptJobs().flatMap((k) => {
      if (k.ref !== ref) return [k];
      if (id) return [{ ...k, runs: k.runs.map((r) => (r.box === box ? { ...r, id } : r)) }];
      const runs = k.runs.filter((r) => r.box !== box);
      return runs.length ? [{ ...k, runs, items: k.items.filter((i) => i.group !== box) }] : [];
    }),
  );
}
onDismiss((j) => {
  if (j.ref) save(KEPT_JOBS, keptJobs().filter((k) => k.ref !== j.ref));
});
// Kept at once, so a relaunch, even before the box answers, doesn't undo it.
onCancel((j) => {
  if (j.ref) save(KEPT_JOBS, keptJobs().map((k) => (k.ref === j.ref ? { ...k, cancelled: true } : k)));
});

// reattachStopJobs brings back the stop jobs the boxes carried on with
// while the app was closed, each as its runs are now or as they ended. A
// row only says what its box says; until a box answers it waits for it. A
// share whose start was never answered is asked for again, under the same
// key: the box has it, or takes it now.
export async function reattachStopJobs(deps: { runs: StopRuns; every?: number }) {
  const kept = keptJobs();
  save(KEPT_JOBS, kept);
  await Promise.all(
    kept
      .filter((k) => !useJobs.getState().jobs.some((j) => j.ref === k.ref))
      .map(async (k) => {
        const job = startJob({ title: k.title, items: k.items.map((i) => ({ ...i, message: "Waiting for its box" })), cancellable: true, ref: k.ref });
        if (k.cancelled) cancelJob(job);
        const none: Tally = { stopped: 0, unsent: 0, worktrees: {} };
        const tallies = await Promise.all(
          k.runs.map(async (r) => {
            if (r.id) return followJobRun(job, r.box, r.id, deps.runs, deps.every, r.params);
            if (!r.params) return none;
            const keys = k.items.filter((i) => i.group === r.box).map((i) => i.key);
            const t = await onTheBox(job, { ref: k.ref, title: k.title, box: r.box, params: r.params, keys, asked: true }, deps.runs, deps.every);
            if (t) return t;
            for (const key of keys) setItem(job, key, { state: "failed", message: `Failed: ${r.box} can't run it` });
            return none;
          }),
        );
        const worktrees = Object.values(Object.assign({}, ...tallies.map((t) => t.worktrees)) as Record<string, WorktreeOutcome>);
        if (jobOf(job))
          finishJob(
            job,
            stopSummary(
              k.items.length,
              tallies.reduce((n, t) => n + t.stopped, 0),
              tallies.reduce((n, t) => n + t.unsent, 0),
              worktrees,
            ),
          );
      }),
  );
}

// stopSummary is what a finished job says: "17 stopped, 15 archived", and
// what was kept, failed or never sent.
export function stopSummary(total: number, stopped: number, unsent: number, worktrees: WorktreeOutcome[]) {
  const count = (o: WorktreeOutcome) => worktrees.filter((w) => w === o).length;
  const failed = total - stopped - unsent + count("failed");
  return [
    `${stopped} stopped`,
    count("archived") && `${count("archived")} archived`,
    count("archiving") && `${count("archiving")} archiving`,
    count("kept") && `${count("kept")} kept`,
    failed && `${failed} failed`,
    unsent && `${unsent} not stopped`,
    count("cancelled") && `${count("cancelled")} not archived`,
  ]
    .filter(Boolean)
    .join(", ");
}
