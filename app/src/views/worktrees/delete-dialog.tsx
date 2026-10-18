import { AlertTriangleIcon, CheckIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AlertDialog, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { BulkAction, RowProgress } from "@/views/worktrees/use-bulk";
import type { Row } from "@/views/worktrees/use-worktrees";

// DeleteDialog removes several worktrees after one confirmation that names
// every one, then stays open with each one's outcome.
// With archive, it archives them instead: each one's archive script runs,
// then it goes, and its branch stays.
export function DeleteDialog({ rows, progress, running, onRun, onClose, archive }: { rows?: Row[]; progress: Record<string, RowProgress>; running: boolean; onRun(a: BulkAction): void; onClose(): void; archive?: boolean }) {
  const [branch, setBranch] = useState(false);
  const [force, setForce] = useState(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (rows) {
      setBranch(false);
      setForce(false);
      setStarted(false);
    }
  }, [rows]);

  const targets = (rows ?? []).filter((r) => !r.main);
  const skipped = (rows ?? []).length - targets.length;
  const dirty = targets.filter((r) => r.changed || r.untracked).length;
  const done = started && !running;
  const failed = targets.filter((r) => progress[r.key]?.state === "failed").length;

  return (
    <AlertDialog open={!!rows} onOpenChange={(o) => !o && !running && onClose()}>
      <AlertDialogPopup className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {done
              ? failed
                ? `${archive ? "Archived" : "Removed"} ${targets.length - failed} of ${targets.length}`
                : `${archive ? "Archived" : "Removed"} ${targets.length} worktree${targets.length === 1 ? "" : "s"}`
              : `${archive ? "Archive" : "Delete"} ${targets.length} worktree${targets.length === 1 ? "" : "s"}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {done
              ? failed
                ? "The rest were left as they were."
                : archive
                  ? "Their branches are kept; their folders, services and sessions are gone."
                  : "Their folders, services and sessions are gone."
              : archive
                ? "Each one's sessions and services stop, the repo's archive script runs, then its folder goes. Branches stay, so nothing committed is lost; one with uncommitted work is left as it is."
                : "Each folder is deleted after the repo's teardown runs, and its services and sessions stop."}
            {skipped > 0 && !done && ` Main checkouts are skipped (${skipped}).`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="mx-6 max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg border">
          {targets.map((r) => {
            const p = progress[r.key];
            return (
              <li key={r.key} className="flex items-center gap-2.5 px-3 py-1.5 text-body">
                <span className="flex w-4 justify-center">
                  {p?.state === "running" ? (
                    <Spinner className="size-3.5" />
                  ) : p?.state === "ok" ? (
                    <CheckIcon className="size-3.5 text-success" />
                  ) : p?.state === "failed" ? (
                    <XIcon className="size-3.5 text-destructive-foreground" />
                  ) : r.changed || r.untracked ? (
                    <AlertTriangleIcon className="size-3.5 text-warning" aria-label="Has uncommitted changes" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.name}</span>
                  {p?.state === "failed" ? (
                    <span className="block whitespace-normal break-words text-meta text-destructive-foreground">
                      {p.message}
                    </span>
                  ) : (
                    <span className="block truncate font-mono text-meta text-muted-foreground">{r.branch}</span>
                  )}
                </span>
                {(r.changed > 0 || r.untracked > 0) && !p && (
                  <span className="shrink-0 text-meta text-warning-foreground tabular-nums">{[r.changed && `${r.changed} changed`, r.untracked && `${r.untracked} untracked`].filter(Boolean).join(", ")}</span>
                )}
                <span className="shrink-0 font-mono text-tag text-muted-foreground">{r.box}</span>
              </li>
            );
          })}
        </ul>

        {!started && !archive && (
          <div className="mx-6 mt-3 mb-2 space-y-2.5">
            <label className="flex items-start gap-2.5 text-body">
              <Checkbox checked={branch} onCheckedChange={(v) => setBranch(!!v)} className="mt-0.5" />
              Also delete their branches
            </label>
            <label className="flex items-start gap-2.5 text-body">
              <Checkbox checked={force} onCheckedChange={(v) => setForce(!!v)} className="mt-0.5" />
              <span>
                Even with uncommitted changes
                <span className={cn("block text-meta text-muted-foreground", dirty && !force && "text-warning-foreground")}>
                  {dirty ? `${dirty} ${dirty === 1 ? "has" : "have"} work git would lose; without this, ${dirty === 1 ? "it is" : "they are"} kept.` : "Without this, git refuses when there is work it would lose."}
                </span>
              </span>
            </label>
          </div>
        )}

        <AlertDialogFooter>
          {done ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={running} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant={archive ? "default" : "destructive"}
                loading={running}
                disabled={!targets.length}
                onClick={() => {
                  setStarted(true);
                  onRun(archive ? { kind: "archive" } : { kind: "delete", force, branch });
                }}
              >
                {archive ? "Archive" : "Delete"} {targets.length}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
