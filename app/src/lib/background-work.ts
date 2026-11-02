// The work an agent left running in the background, as the chat's chip and
// its panel show it (components/conversation/chat-controls.tsx): what the
// chip says, each row's badge, and how long each took.

import type { ChatJob } from "./chat-controls.ts";

export type Job = Pick<ChatJob, "kind" | "state" | "since" | "until" | "exit">;

// Work that ended this long ago still shows, so its end is seen.
const RECENT = 5 * 60_000;

export const isRunning = (j: Job) => j.state === "running" || j.state === "starting";

// backgroundLabel is what the chip says: only what is still running is
// counted; with none, how many ended a moment ago; null hides it.
export function backgroundLabel(jobs: Job[], now: number): string | null {
  const running = jobs.filter(isRunning);
  if (running.length) {
    const n = running.length;
    const shells = running.filter((j) => j.kind === "shell").length === n;
    return `${n} ${shells ? (n === 1 ? "shell" : "shells") : n === 1 ? "task" : "tasks"} running`;
  }
  const recent = jobs.filter((j) => j.until && now - j.until < RECENT).length;
  return recent ? `${recent} finished` : null;
}

export function jobBadge(job: Job): { text: string; tone: "running" | "done" | "failed" | "stopped" } {
  const code = job.exit === undefined ? "" : ` · exit ${job.exit}`;
  switch (job.state) {
    case "running":
    case "starting":
      return { text: "Running", tone: "running" };
    case "done":
      return { text: `Done${code}`, tone: "done" };
    case "failed":
      return { text: `Failed${code}`, tone: "failed" };
    default:
      return { text: "Stopped", tone: "stopped" };
  }
}

// jobTook is how long a job has run, or ran: frozen once it ended.
export function jobTook(job: Job, now: number): string {
  const end = job.until ?? (isRunning(job) ? now : job.since);
  return fmtDur(end - job.since);
}

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
