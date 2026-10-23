import { useCallback, useRef, useState } from "react";

import { boxApi } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { keepsWork, removeWorktreeOnBox } from "@/lib/remove-worktree";
import { removalOf, useRemovals } from "@/lib/removing";
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

// useBulk runs one action over many worktrees, one at a time, so a slow or
// failing one never leaves others half done, and keeps each row's outcome.
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
      for (const r of rows) {
        if (cancelled.current) {
          set(r.key, { state: "skipped", message: "cancelled" });
          continue;
        }
        // One already on its way out (lib/removing.ts) is left to that, so
        // its box never gets a second request for it.
        const leaving = action.kind === "archive" && removalOf(useRemovals.getState().byKey, r.box, r.path);
        const why = skipReason(action, r) ?? (leaving ? "already on its way out" : undefined);
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
