import { boxOffline } from "@/lib/queue";
import { boxHasRuns, runs, scheduleRuns } from "@/lib/runs";
import { fitsRun, followStopRun, type Started, type StopRead, type StopRun, type StopRunParams, type StopRuns, startStopRun } from "@/lib/stop-job";

// The boxes' stop runs (lib/stop-job.ts): what the board's bulk Stop, the
// Worktrees table's Stop sessions and Archive, the sidebar's Stop
// everything and Archive… ask a box with runs to do, so it carries on while
// the laptop sleeps.
export const stopRuns: StopRuns = {
  onBox: (box) => boxHasRuns(box) && !boxOffline(box),
  start: async (box, req) => {
    const run = await runs.start(box, { template: "stop", title: req.title, group: req.group, params: { ...req.params } }, req.idemKey);
    scheduleRuns(box, 0);
    return run;
  },
  find: async (box, group) => (await runs.list(box, { template: "stop", group, limit: 1 }))[0],
  get: (box, id) => runs.get(box, id) as Promise<StopRun>,
  cancel: (box, id) => runs.cancel(box, id),
};

// startStopOnBox asks box to stop sessions and archive worktrees as one
// run (startStopRun), or answers "refused" when the box can't run it (no
// runs, offline, or from before stop runs): the caller does it itself. A box
// that doesn't answer is asked again until cancelled says so.
export function startStopOnBox(box: string, title: string, params: StopRunParams, o: { cancelled?(): boolean; waiting?(): void } = {}): Promise<Started> {
  if (!stopRuns.onBox(box) || !fitsRun(params)) return Promise.resolve("refused");
  return startStopRun(stopRuns, box, { title, group: `stop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, params }, o);
}

// How long stopOnBox, which a dialog waits on, asks a box that doesn't
// answer before looking the run up instead.
const PATIENCE_MS = 15_000;

// stopOnBox is startStopOnBox, then the run followed to its end: its last
// read, or undefined when the box didn't take it, so the caller does it. It
// throws when the box never answered, which may have the run all the same.
export async function stopOnBox(box: string, title: string, params: StopRunParams, o: { onRead?(read: StopRead): void; cancelled?(): boolean } = {}): Promise<StopRead | undefined> {
  const t0 = Date.now();
  const started = await startStopOnBox(box, title, params, { cancelled: () => !!o.cancelled?.() || Date.now() - t0 > PATIENCE_MS });
  if (started === "unknown") throw new Error(`${box} didn't answer, so it may still do it`);
  if (typeof started === "string") return undefined;
  return followStopRun(stopRuns, box, started.id, { onRead: (r) => o.onRead?.(r), cancelled: o.cancelled });
}
