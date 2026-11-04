import { create } from "zustand";

import { load, save } from "./storage.ts";

// Background jobs: work a dialog starts and then lets go of, such as the
// board's bulk Stop or Archive…, so you can get on with something else. The
// tray in the corner (components/jobs-tray.tsx) shows each one's rows as
// they go, folds to a line, and keeps a report when something was kept or
// failed. A clean job sums itself up and fades. The store is the app's, not
// a view's: a job carries on when you leave the page that started it. What
// the app does itself doesn't outlive it: rows not yet sent are lost when it
// quits. What a box does as a run does, and its job comes back on the next
// start (ref, lib/stop-job.ts).
//
// No imports from "@/": pnpm test runs this file in plain node.

type ItemState = "queued" | "running" | "done" | "kept" | "failed" | "cancelled";

export interface JobItem {
  key: string;
  // Where it runs: a box. The tray groups rows by it.
  group: string;
  label: string;
  // A second name, when the label alone is ambiguous.
  aside?: string;
  state: ItemState;
  message?: string;
}

export interface Job {
  id: number;
  // What it does, while it runs: "Stopping 17 agents".
  title: string;
  items: JobItem[];
  // Whether "Stop the rest" is offered.
  cancellable: boolean;
  cancelling?: boolean;
  // Set when it ends: what it did, "17 stopped, 15 archived".
  summary?: string;
  finished?: number;
  // What its starter keeps it by across a relaunch, until it's dismissed.
  ref?: string;
}

// A clean job's summary stays this long, then goes.
export const FADE_MS = 10_000;

const FOLDED = "berth.jobs.folded";

export const useJobs = create<{ jobs: Job[]; folded: boolean }>()(() => ({ jobs: [], folded: load(FOLDED, false) }));

let nextId = 0;

// startJob puts a job on top of the tray and answers with its id.
export function startJob(job: { title: string; items: Omit<JobItem, "state">[]; cancellable?: boolean; ref?: string }): number {
  const id = ++nextId;
  const items = job.items.map((i) => ({ ...i, state: "queued" as const }));
  useJobs.setState((s) => ({ jobs: [{ id, title: job.title, items, cancellable: !!job.cancellable, ref: job.ref }, ...s.jobs] }));
  return id;
}

const patchJob = (id: number, f: (j: Job) => Job) => useJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? f(j) : j)) }));

export function setItem(id: number, key: string, patch: Partial<Pick<JobItem, "state" | "message">>) {
  patchJob(id, (j) => ({ ...j, items: j.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) }));
}

export const jobOf = (id: number) => useJobs.getState().jobs.find((j) => j.id === id);

const cancelled: ((job: Job) => void)[] = [];

// onCancel hears of each job asked to send nothing more.
export const onCancel = (fn: (job: Job) => void) => void cancelled.push(fn);

// cancelJob asks a job to send nothing more. What it already sent finishes.
export function cancelJob(id: number) {
  patchJob(id, (j) => ({ ...j, cancelling: true }));
  const j = jobOf(id);
  if (j) for (const fn of cancelled) fn(j);
}
export const isCancelling = (id: number) => !!jobOf(id)?.cancelling;

// finishJob ends a job with its summary. A clean one goes after FADE_MS; one
// with a row kept, failed or not sent stays until it's dismissed.
export function finishJob(id: number, summary: string) {
  patchJob(id, (j) => ({ ...j, summary, finished: Date.now() }));
  const j = jobOf(id);
  if (!j || outcomeOf(j) !== "clean") return;
  // unref: node (pnpm test) needn't wait for it.
  const t: unknown = setTimeout(() => dismissJob(id), FADE_MS);
  (t as { unref?: () => void }).unref?.();
}

const dismissed: ((job: Job) => void)[] = [];

// onDismiss hears of each job as it leaves the tray, dismissed or faded.
export const onDismiss = (fn: (job: Job) => void) => void dismissed.push(fn);

export function dismissJob(id: number) {
  const j = jobOf(id);
  if (!j) return;
  useJobs.setState((s) => ({ jobs: s.jobs.filter((x) => x.id !== id) }));
  for (const fn of dismissed) fn(j);
}

export function setFolded(folded: boolean) {
  useJobs.setState({ folded });
  save(FOLDED, folded);
}

const settledStates: ItemState[] = ["done", "kept", "failed", "cancelled"];
export const settled = (i: JobItem) => settledStates.includes(i.state);

export function progressOf(j: Job) {
  return { settled: j.items.filter(settled).length, total: j.items.length };
}

// The rows a report lists: whatever didn't go as asked.
export const leftOver = (j: Job) => j.items.filter((i) => i.state === "kept" || i.state === "failed" || i.state === "cancelled");

export function outcomeOf(j: Job): "running" | "clean" | "report" {
  if (j.finished === undefined) return "running";
  return leftOver(j).length ? "report" : "clean";
}

// runPool runs fn over items, a few at a time, in order. Once stop() says
// so it takes no more, and answers with the items it never sent. Any item
// counts, undefined too.
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<T[]> {
  const queue = [...items];
  const unsent: T[] = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift() as T;
      if (stop()) {
        unsent.push(item, ...queue.splice(0));
        return;
      }
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return unsent;
}
