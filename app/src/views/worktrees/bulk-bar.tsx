import { AlertTriangleIcon, CheckIcon, CornerDownLeftIcon, GitMergeIcon, PauseIcon, PlayIcon, SendIcon, SquareIcon, Trash2Icon, XIcon, ArchiveIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { agentOf } from "@/lib/derive";
import { openBroadcast } from "@/lib/prompts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { SyncMode } from "@/lib/worktrees";
import { SyncButton } from "@/views/worktrees/sync-button";
import { type BulkAction, actionLabel, type BulkSummary, type RowProgress, skipReason } from "@/views/worktrees/use-bulk";
import { openWorktree, type Row } from "@/views/worktrees/use-worktrees";
import { liftToasts } from "@/hooks/lift-toasts";

// BulkBar floats over the table: what you can do with the selection, then
// how it is going, then what happened.
export function BulkBar({
  selected,
  summary,
  progress,
  onSync,
  onPause,
  onResume,
  onStop,
  onDelete,
  onArchive,
  onClear,
  onCancel,
  onDismiss,
  onRetry,
}: {
  selected: Row[];
  summary?: BulkSummary;
  progress: Record<string, RowProgress>;
  onSync(mode: SyncMode, paused: boolean): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onDelete(): void;
  onArchive(): void;
  onClear(): void;
  onCancel(): void;
  onDismiss(): void;
  // Runs another action over some of the last one's rows.
  onRetry(a: BulkAction, rows: Row[]): void;
}) {
  const [details, setDetails] = useState(false);
  const [includePaused, setIncludePaused] = useState(false);
  const boxes = useStore((s) => s.boxes);
  const running = summary && !summary.done;
  if (!selected.length && !summary) return null;

  const shell = "pointer-events-auto flex max-w-[calc(100%-2rem)] flex-col gap-2 rounded-xl border bg-popover px-3 py-2 shadow-lg/10";

  if (summary && summary.action.kind !== "delete") {
    const states = summary.rows.map((r) => progress[r.key]);
    const count = (s: RowProgress["state"]) => states.filter((p) => p?.state === s).length;
    const done = count("ok") + count("failed") + count("conflict") + count("skipped");
    const problems = summary.rows.filter((r) => progress[r.key]?.state === "failed" || progress[r.key]?.state === "conflict");
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div ref={liftToasts} className={shell} role="status" aria-live="polite">
          <div className="flex items-center gap-3 text-body">
            {running ? <Spinner className="size-4" /> : problems.length ? <AlertTriangleIcon className="size-4 text-warning" /> : <CheckIcon className="size-4 text-success" />}
            <span className="tabular-nums">
              {running
                ? `${actionLabel(summary.action)}: ${done} of ${summary.rows.length}`
                : [
                    `${actionLabel(summary.action)}: ${count("ok")} done`,
                    count("conflict") && `${count("conflict")} with conflicts`,
                    count("failed") && `${count("failed")} failed`,
                    count("skipped") && `${count("skipped")} skipped`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
            {!running && problems.length > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setDetails(!details)}>
                {details ? "Hide details" : "Details"}
              </Button>
            )}
            {running ? (
              <Button size="xs" variant="ghost" onClick={onCancel}>
                Stop after this one
              </Button>
            ) : (
              <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
                <XIcon />
              </Button>
            )}
          </div>
          {details && !running && (
            <ul className="max-h-56 divide-y overflow-y-auto border-t text-meta">
              {problems.map((r) => {
                const p = progress[r.key]!;
                const agents = (boxes[r.box]?.sessions ?? []).filter((x) => x.dir === r.path && !x.exited && agentOf(x));
                const sync = summary.action.kind === "sync" ? summary.action : undefined;
                return (
                  <li key={r.key} className="flex items-start gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{r.name}</span>
                      <span className={cn("ml-2", p.state === "conflict" ? "text-warning-foreground" : "text-destructive-foreground")}>{p.state === "conflict" ? "conflicts, left as it was" : p.message}</span>
                      {p.conflicts && <div className="mt-0.5 truncate font-mono text-meta text-muted-foreground">{p.conflicts.join(", ")}</div>}
                    </div>
                    {/* What to do about it, without leaving the table. */}
                    <div className="flex shrink-0 items-center gap-1">
                      {sync && p.state === "conflict" && sync.mode === "rebase" && (
                        <Button size="xs" variant="ghost" onClick={() => onRetry({ ...sync, mode: "merge" }, [r])}>
                          <GitMergeIcon />
                          Try merge
                        </Button>
                      )}
                      {sync && p.state === "conflict" && agents.length > 0 && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            openBroadcast({
                              targets: agents.map((x) => ({ box: r.box, session: x.name })),
                              text: `Sync this worktree with ${r.base ?? "its base"} (git ${sync.mode === "pull" ? "pull --ff-only" : sync.mode} ${r.base ?? ""}) and resolve the conflicts in ${p.conflicts?.join(", ") ?? "the files git reports"}. Keep both sides' intent, run the tests, and commit.`,
                            })
                          }
                        >
                          <SendIcon />
                          Ask agent
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => openWorktree(r)}>
                        <CornerDownLeftIcon />
                        Open
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // What each action would touch: rows it skips (main checkouts, paused
  // ones for a sync) don't count, so the button says what it will do.
  const eligible = (a: BulkAction) => selected.filter((r) => !skipReason(a, r)).length;
  const counted = (n: number) => (n < selected.length ? n : undefined);
  const anyPaused = selected.some((r) => r.paused);
  const anyRunning = selected.some((r) => !r.paused && !r.main);
  const sessions = selected.reduce((n, r) => n + r.sessions, 0);
  const deletable = selected.filter((r) => !r.main).length;
  // The agents working in the selected worktrees, to prompt them all.
  const agents = selected.flatMap((r) => (boxes[r.box]?.sessions ?? []).filter((x) => x.dir === r.path && !x.exited && agentOf(x)).map((x) => ({ box: r.box, session: x.name })));

  const pausedCount = selected.filter((r) => r.paused).length;
  const toSync = eligible({ kind: "sync", mode: "rebase", paused: includePaused });
  const toPause = eligible({ kind: "pause" });
  const toResume = eligible({ kind: "resume" });

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div ref={liftToasts} className={cn(shell, "flex-row flex-wrap items-center")}>
        <span className="pr-1 text-body tabular-nums">{selected.length} selected</span>
        <span className="h-5 w-px bg-border" />
        <SyncButton
          size="xs"
          count={counted(toSync)}
          onSync={(mode) => onSync(mode, includePaused)}
          paused={{ count: pausedCount, include: includePaused, onChange: setIncludePaused }}
        />
        {anyRunning && (
          <Button size="xs" variant="outline" onClick={onPause}>
            <PauseIcon />
            Pause
            {counted(toPause) !== undefined && <span className="tabular-nums">{toPause}</span>}
          </Button>
        )}
        {anyPaused && (
          <Button size="xs" variant="outline" onClick={onResume}>
            <PlayIcon />
            Resume
            {counted(toResume) !== undefined && <span className="tabular-nums">{toResume}</span>}
          </Button>
        )}
        <Hint text={agents.length ? `Send one prompt to ${agents.length} agent${agents.length === 1 ? "" : "s"}` : "No agents in these worktrees"}>
          <Button size="xs" variant="outline" disabled={!agents.length} onClick={() => openBroadcast({ targets: agents })}>
            <SendIcon />
            Prompt agents…
          </Button>
        </Hint>
        <Hint text={sessions ? `Stop ${sessions} session${sessions === 1 ? "" : "s"}` : "No sessions running"}>
          <Button size="xs" variant="outline" disabled={!sessions} onClick={onStop}>
            <SquareIcon />
            Stop sessions
          </Button>
        </Hint>
        <Hint text={deletable ? "Run their archive scripts and remove them; their branches stay" : "Main checkouts can't be archived"}>
          <Button size="xs" variant="outline" disabled={!deletable} onClick={onArchive}>
            <ArchiveIcon />
            {counted(deletable) !== undefined ? `Archive ${deletable}…` : "Archive…"}
          </Button>
        </Hint>
        <Hint text={deletable ? (deletable < selected.length ? `Main checkouts are skipped (${selected.length - deletable})` : undefined) : "Main checkouts can't be deleted"}>
          <Button size="xs" variant="outline" className="text-destructive-foreground" disabled={!deletable} onClick={onDelete}>
            <Trash2Icon />
            {counted(deletable) !== undefined ? `Delete ${deletable}…` : "Delete…"}
          </Button>
        </Hint>
        <span className="h-5 w-px bg-border" />
        <Button size="xs" variant="ghost" onClick={onClear}>
          Clear
          <Kbd>Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}

// Hint explains a button, disabled or not: a disabled button gets no
// pointer events, so the tooltip hangs on a wrapper.
function Hint({ text, children }: { text?: string; children: ReactNode }) {
  return (
    <Tip label={text}>
      <span className="inline-flex">{children}</span>
    </Tip>
  );
}
