import { useCallback, useRef, useState } from "react";

import { boxApi } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { removeWorktreeOnBox } from "@/lib/remove-worktree";
import { archivedMessage, clearRemoving, keepsWork, markRemoving, markScript, removalOf, useRemovals } from "@/lib/removing";
import { followStopRun, type StopRead, type StopRunParams } from "@/lib/stop-job";
import { startStopOnBox, stopRuns } from "@/lib/stop-on-box";
import { scheduleRefresh, useStore } from "@/lib/store";
import { type SyncMode, worktreesApi } from "@/lib/worktrees";
import type { Row } from "@/views/worktrees/use-worktrees";

// A sync leaves paused worktrees alone unless paused is set.
export type BulkAction = { kind: "sync"; mode: SyncMode; paused?: boolean } | { kind: "pause" } | { kind: "resume" } | { kind: "stop" } | { kind: "archive" };

export interface RowProgress {
  state: "queued" | "running" | "ok" | "conflict" | "failed" | "skipped";
  message?: string;
  conflicts?: string[];
}

export interface BulkSummary {
  action: BulkAction;
  rows: Row[];
  // Set once every row has its result.
  done: boolean;
}

export const actionLabel = (a: BulkAction) =>
  a.kind === "sync" ? (a.mode === "rebase" ? "Rebase" : a.mode === "merge" ? "Merge" : "Fast-forward") : a.kind === "pause" ? "Pause" : a.kind === "resume" ? "Resume" : a.kind === "stop" ? "Stop sessions" : "Archive";

// skipReason says why an action doesn't apply to a row, or nothing.
export function skipReason(a: BulkAction, r: Row): string | undefined {
  if (r.main && (a.kind === "pause" || a.kind === "resume" || a.kind === "archive")) return "the main checkout";
  if (a.kind === "sync" && r.paused && !a.paused) return "paused";
  if (a.kind === "pause" && r.paused) return "already paused";
  if (a.kind === "resume" && !r.paused) return "not paused";
  if (a.kind === "stop" && r.sessions === 0) return "no sessions";
  return undefined;
}

// The sessions live in a worktree, and for an archive in folders under it,
// which archiving ends too.
const liveIn = (r: Row, under: boolean) => (useStore.getState().boxes[r.box]?.sessions ?? []).filter((s) => !s.exited && (s.dir === r.path || (under && s.dir.startsWith(`${r.path}/`))));

// A box's share of Stop sessions or Archive, done there as one stop run.
interface BoxShare {
  box: string;
  id: string;
  rows: Row[];
  // By row: the sessions it stops.
  sessions: Record<string, string[]>;
  // Set when the box never answered the start.
  error?: string;
  // Cancelled before the box had it: nothing was done.
  unsent?: boolean;
}

// startOnBoxes hands each box with runs its rows as one stop run
// (lib/stop-job.ts), so it keeps going while the laptop sleeps, and answers
// with the shares the boxes took. An archive stops the worktree's sessions
// first, as archiving always ended them, and keeps it, as the box does,
// where something new runs or there's uncommitted work: a row that failed,
// in the box's words. A box that doesn't answer is asked again until it
// does, or until cancelled says so (startStopRun); waiting hears of its rows
// meanwhile.
async function startOnBoxes(kind: "stop" | "archive", rows: Row[], cancelled: () => boolean, waiting: (rows: Row[]) => void): Promise<BoxShare[]> {
  const byBox = new Map<string, Row[]>();
  for (const r of rows) if (stopRuns.onBox(r.box)) byBox.set(r.box, [...(byBox.get(r.box) ?? []), r]);
  const shares = await Promise.all(
    [...byBox].map(async ([box, mine]): Promise<BoxShare | undefined> => {
      const sessions = Object.fromEntries(mine.map((r) => [r.key, liveIn(r, kind === "archive").map((s) => s.name)]));
      const params: StopRunParams = {
        sessions: mine.flatMap((r) => sessions[r.key]),
        worktrees: kind === "archive" ? mine.map((r) => ({ location: r.location, name: r.name, path: r.path, sessions: sessions[r.key] })) : [],
      };
      const started = await startStopOnBox(box, kind === "stop" ? `Stop sessions in ${plural(mine.length, "worktree")}` : `Archive ${plural(mine.length, "worktree")}`, params, { cancelled, waiting: () => waiting(mine) });
      if (started === "refused") return undefined;
      if (started === "unsent") return { box, id: "", rows: mine, sessions, unsent: true };
      // It may have the run all the same: the app doesn't do it as well.
      if (started === "unknown") return { box, id: "", rows: mine, sessions, error: `${box} didn't answer, so it may still do it` };
      return { box, id: started.id, rows: mine, sessions };
    }),
  );
  return shares.filter((s): s is BoxShare => !!s);
}

// rowOf is what a row of a box's share says, from its run.
function rowOf(kind: "stop" | "archive", read: StopRead, r: Row, sessions: string[]): RowProgress | undefined {
  const states = sessions.map((s) => read.rows[s]);
  const failed = states.find((x) => x?.state === "failed");
  if (kind === "archive") {
    const o = read.worktrees[r.path];
    const said = read.said[r.path];
    if (o === "archived" || o === "archiving") return { state: "ok", message: archivedMessage(o === "archiving" ? { archive: "yes" } : {}) };
    if (o === "kept") return { state: "failed", message: said };
    if (o === "failed") return { state: "failed", message: said };
    if (o === "cancelled") return { state: "skipped", message: "cancelled" };
  }
  if (failed) return { state: "failed", message: failed.message?.replace(/^Failed: /, "") };
  if (kind === "stop" && states.every((x) => x?.state === "done")) return { state: "ok", message: `Stopped ${sessions.length}` };
  if (read.over) return { state: "skipped", message: "cancelled" };
  return undefined;
}

// useBulk runs one action over many worktrees, one at a time, so a slow or
// failing one never leaves others half done, and keeps each row's outcome.
// Stop sessions and Archive on a box with runs are the box's to do, as one
// run for its rows (startOnBoxes).
export function useBulk(onRowDone: (r: Row, patch: Partial<Row>) => void) {
  const [progress, setProgress] = useState<Record<string, RowProgress>>({});
  const [summary, setSummary] = useState<BulkSummary>();
  const cancelled = useRef(false);

  const set = (key: string, p: RowProgress) => setProgress((s) => ({ ...s, [key]: p }));

  const run = useCallback(
    async (action: BulkAction, rows: Row[]) => {
      const client = useStore.getState().client;
      if (!client) return;
      cancelled.current = false;
      setProgress(Object.fromEntries(rows.map((r) => [r.key, { state: "queued" } as RowProgress])));
      setSummary({ action, rows, done: false });
      // Left to the loop below: rows it skips, and an archive git would
      // refuse, which it answers at once with the sessions left running.
      const leaving = (r: Row) => action.kind === "archive" && !!removalOf(useRemovals.getState().byKey, r.box, r.path);
      const forBoxes = rows.filter((r) => !skipReason(action, r) && !leaving(r) && !(action.kind === "archive" && r.changed + r.untracked > 0));
      const shares =
        action.kind === "stop" || action.kind === "archive"
          ? await startOnBoxes(
              action.kind,
              forBoxes,
              () => cancelled.current,
              (waiting) => waiting.forEach((r) => set(r.key, { state: "queued", message: `Waiting for ${r.box}` })),
            )
          : [];
      const following = shares.map(async (sh) => {
        const kind = action.kind as "stop" | "archive";
        if (sh.error) return void sh.rows.forEach((r) => set(r.key, { state: "failed", message: sh.error }));
        if (sh.unsent) return void sh.rows.forEach((r) => set(r.key, { state: "skipped", message: "cancelled" }));
        for (const r of sh.rows) {
          set(r.key, { state: "running" });
          // Archiving… in the sidebar and elsewhere until the box says.
          if (kind === "archive") markRemoving(r.box, r.path, "archive", r.name);
        }
        const read = await followStopRun(stopRuns, sh.box, sh.id, {
          cancelled: () => cancelled.current,
          onRead: (read) => {
            for (const r of sh.rows) {
              const p = rowOf(kind, read, r, sh.sessions[r.key]);
              if (p) set(r.key, p);
              if (read.over && kind === "stop" && p?.state === "ok") onRowDone(r, { sessions: 0 });
              const o = read.worktrees[r.path];
              if (kind === "archive" && o === "archiving") markScript(r.box, r.path);
              else if (kind === "archive" && (o ? o !== "archived" : read.over)) clearRemoving(r.box, r.path);
            }
          },
        });
        if (!read)
          for (const r of sh.rows) {
            set(r.key, { state: "failed", message: `${sh.box} no longer has this run` });
            if (kind === "archive") clearRemoving(r.box, r.path);
          }
        scheduleRefresh(sh.box, ["sessions", "locations", "services"]);
      });
      const taken = new Set(shares.flatMap((sh) => sh.rows.map((r) => r.key)));
      for (const r of rows) {
        if (taken.has(r.key)) continue;
        if (cancelled.current) {
          set(r.key, { state: "skipped", message: "cancelled" });
          continue;
        }
        // One already on its way out (lib/removing.ts) is left to that, so
        // its box never gets a second request for it.
        const why = skipReason(action, r) ?? (leaving(r) ? "already on its way out" : undefined);
        if (why) {
          set(r.key, { state: "skipped", message: why });
          continue;
        }
        set(r.key, { state: "running" });
        try {
          switch (action.kind) {
            case "sync": {
              const res = await worktreesApi.sync(client, r.box, r.location, r.name, action.mode);
              if (res.ok) {
                set(r.key, { state: "ok", message: res.output.split("\n").filter(Boolean).pop() });
                onRowDone(r, { ahead: res.ahead, behind: res.behind });
              } else if (res.conflicts?.length) {
                set(r.key, { state: "conflict", message: "Conflicts; left as it was", conflicts: res.conflicts });
              } else {
                set(r.key, { state: "failed", message: res.output.split("\n").filter(Boolean).pop() ?? "Sync failed" });
              }
              break;
            }
            case "pause":
            case "resume": {
              const st = await worktreesApi.pause(client, r.box, r.location, r.name, action.kind === "pause");
              set(r.key, { state: "ok", message: action.kind === "pause" ? "Paused" : "Resumed" });
              onRowDone(r, { paused: st.paused, sessions: st.sessions });
              break;
            }
            case "stop": {
              const sessions = (useStore.getState().boxes[r.box]?.sessions ?? []).filter((s) => s.dir === r.path && !s.exited);
              for (const s of sessions) await boxApi.stopSession(client, r.box, s.name);
              set(r.key, { state: "ok", message: `Stopped ${sessions.length}` });
              onRowDone(r, { sessions: 0 });
              scheduleRefresh(r.box, ["sessions"]);
              break;
            }
            case "archive": {
              // Archive keeps the branch and never discards work: git refuses
              // a worktree with uncommitted changes, and that is the answer.
              let res: { archive?: string };
              try {
                res = await removeWorktreeOnBox(client, r.box, r.location, { name: r.name, path: r.path }, "archive");
              } catch (err) {
                if (keepsWork(err)) throw new Error("Has uncommitted changes: commit them first, or delete it instead");
                throw err;
              }
              set(r.key, { state: "ok", message: res.archive ? "Archiving: its archive script runs, then it goes" : "Archived; its branch is kept" });
              break;
            }
          }
        } catch (err) {
          set(r.key, { state: "failed", message: plainError(err) });
        }
      }
      await Promise.all(following);
      setSummary({ action, rows, done: true });
    },
    [onRowDone],
  );

  const cancel = () => {
    cancelled.current = true;
  };
  const clear = () => {
    setProgress({});
    setSummary(undefined);
  };

  return { progress, summary, run, cancel, clear };
}
