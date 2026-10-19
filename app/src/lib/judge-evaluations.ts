import type { RunEvaluation, RunVersion } from "@berth/plugin";

// How Review reads an attempts run's evaluations: the judge step's, then
// each rerun's. The last one that ended is the verdict Review shows; one
// still going is shown beside it, never instead of it.

// Kind is what an evaluation amounts to, for its wording and colour:
//   verdict   the judge agent ranked the attempts
//   checks    judged by the checks alone (judge.by "check")
//   fallback  the judge gave no valid verdict; the checks' pick stands in
//   failed    no verdict and no attempt to fall back on
//   stopped   a pick or a restart ended it before the judge answered
//   running   the judge is looking now
export type EvaluationKind = "verdict" | "checks" | "fallback" | "failed" | "stopped" | "running";

export function evaluationKind(ev: RunEvaluation): EvaluationKind {
  if (ev.status === "running") return "running";
  if (ev.source === "judge") return "verdict";
  if (ev.source === "checks") return ev.by === "check" ? "checks" : "fallback";
  if (/^(stopped|berthd restarted)/.test(ev.error ?? "")) return "stopped";
  return "failed";
}

// The verdict Review shows, the rerun in flight (if any), and the earlier
// ones, newest first.
export function splitEvaluations(evs: RunEvaluation[] | undefined): { current?: RunEvaluation; running?: RunEvaluation; earlier: RunEvaluation[] } {
  const all = [...(evs ?? [])].sort((a, b) => a.n - b.n);
  const running = all.filter((e) => e.status === "running").at(-1);
  const ended = all.filter((e) => e.status !== "running");
  const current = ended.at(-1);
  return { current, running, earlier: ended.slice(0, -1).reverse() };
}

// A short commit, and "+ uncommitted" when the worktree had more.
export function versionLabel(v: Pick<RunVersion, "head" | "dirty"> | undefined): string {
  if (!v?.head) return v?.dirty ? "uncommitted changes" : "unknown version";
  return `${v.head.slice(0, 7)}${v.dirty ? " + uncommitted" : ""}`;
}

// changedSince reports whether a worktree moved on from the version an
// evaluation saw: another commit, or uncommitted changes appearing or
// going. Unknown either side is not a change.
export function changedSince(seen: Pick<RunVersion, "head" | "dirty"> | undefined, now: { head?: string; dirty?: boolean } | undefined): boolean {
  if (!seen?.head || !now?.head) return false;
  return seen.head !== now.head || !!seen.dirty !== !!now.dirty;
}

export const attemptLabel = (index: number) => `attempt ${index + 1}`;

// What changed from one evaluation to the next, as a line that follows
// "Since evaluation N: ": the winner, or the order behind it.
export function whatChanged(prev: RunEvaluation | undefined, cur: RunEvaluation): string | undefined {
  if (!prev || prev.status === "running" || cur.status === "running") return undefined;
  if (prev.winner === undefined && cur.winner === undefined) return undefined;
  if (prev.winner !== cur.winner) {
    if (prev.winner === undefined) return `${attemptLabel(cur.winner!)} wins, where there was no winner`;
    if (cur.winner === undefined) return `no winner, where ${attemptLabel(prev.winner)} won`;
    return `the winner changed from ${attemptLabel(prev.winner)} to ${attemptLabel(cur.winner)}`;
  }
  const order = (e: RunEvaluation) => (e.ranking ?? []).join(",");
  if (prev.source === "judge" && cur.source === "judge" && order(prev) !== order(cur)) return `the same winner, but the order behind it changed`;
  if (prev.source !== cur.source) return `the same winner, now ${cur.source === "judge" ? "by the judge" : "by the checks"}`;
  return "the same winner";
}

// The previous evaluation that ended, for whatChanged.
export function previousOf(evs: RunEvaluation[] | undefined, cur: RunEvaluation): RunEvaluation | undefined {
  return [...(evs ?? [])]
    .filter((e) => e.n < cur.n && e.status !== "running")
    .sort((a, b) => a.n - b.n)
    .at(-1);
}
