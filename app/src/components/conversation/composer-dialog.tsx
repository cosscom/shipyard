import { AlertTriangleIcon, CheckIcon, CircleDashedIcon, CircleIcon, CircleXIcon, ClockIcon, CloudOffIcon, ListStartIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { type ComposerKind, TaskComposer } from "@/components/conversation/task-composer";
import { useTargetLabel } from "@/components/prompts/shared";
import { StepHeader } from "@/components/step-header";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogPanel, DialogPopup } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ENDED, type RowState, type RunRow, clearBroadcast, queueRow, stopBroadcast, summarize, useBroadcastRun } from "@/lib/broadcast";
import { type ComposerDraft, closeComposer, openComposer, useComposer } from "@/lib/composer";
import { agentOf } from "@/lib/derive";
import { openQueue } from "@/lib/queue";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";

// ComposerDialog is the composer in a dialog (⌘N and every "start" or
// "send" entry): the same frame as on home, its options open, and, after a
// prompt to several agents, how each of them got on.
export function ComposerDialog() {
  const draft = useComposer((s) => s.draft);
  const seq = useComposer((s) => s.seq);
  const run = useBroadcastRun((s) => s.run);
  useEffect(() => {
    if (draft) useStore.getState().setPaletteOpen(false);
  }, [draft]);
  return (
    <Dialog open={!!draft} onOpenChange={(open) => !open && closeComposer()}>
      {/* Anchored at the top: options open below, and a centred dialog would
          move its title as they do. */}
      <DialogPopup anchored className="max-h-[min(calc(88vh-2rem),60rem)] sm:max-w-[40rem]" showCloseButton={false}>
        {draft && (draft.results && run ? <Results /> : <Compose key={seq} draft={draft} />)}
      </DialogPopup>
    </Dialog>
  );
}

const titles = {
  start: { title: "New task", description: "One agent is a task; pick several to try it several ways. No agent makes the worktree alone." },
  worktree: { title: "New worktree", description: "Just the worktree, from a name, a branch, a pull request or an issue. Pick an agent to start one in it too." },
  attempts: { title: "Try N ways", description: "Each agent tries the task in its own worktree; a check verifies them, a judge ranks them, and you pick one." },
  send: { title: "Prompt running agents", description: "One prompt, filled in for each agent, typed in one after another." },
  loop: { title: "Loop until a check passes", description: "Prompt, wait for the turn to end, run the check. While it fails, the failure goes back. Stops if the agent asks you something." },
  handoff: { title: "Hand off", description: "Another agent picks up the work, beside this one or in a new worktree." },
  review: { title: "Review with another agent", description: "A second agent reads this worktree's changes and lists problems. It opens beside this one." },
} as const;

function Compose({ draft }: { draft: ComposerDraft }) {
  const [mode, setMode] = useState(draft.mode ?? "start");
  const [kind, setKind] = useState<ComposerKind>(draft.mode === "send" ? (draft.loop ? "loop" : "send") : draft.noAgent ? "worktree" : draft.attempts ? "attempts" : "start");
  const [more, setMore] = useState(false);
  const which = draft.from?.kind ?? kind;
  const t = titles[which];
  return (
    <>
      <StepHeader title={t.title} description={t.description} />
      <DialogPanel className="px-5 pb-4">
        <TaskComposer
          draft={draft}
          dialog
          autoFocus
          keepOpen={more}
          onMode={setMode}
          onKind={setKind}
          onDone={(how) => {
            if (how.results) openComposer({ results: true });
            else closeComposer();
          }}
        />
      </DialogPanel>
      <DialogFooter className="items-center px-5 py-2.5 sm:justify-between">
        <span className="flex items-center gap-3 text-muted-foreground text-meta">
          <span className="flex items-center gap-1">
            <Kbd>⇧⏎</Kbd> new line
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </span>
        {mode === "start" && !draft.from && (
          <label className="flex cursor-pointer items-center gap-2 text-desc text-muted-foreground">
            <Switch checked={more} onCheckedChange={setMore} />
            Start more
          </label>
        )}
      </DialogFooter>
    </>
  );
}

const stateInfo: Record<RowState, { label: string; Icon?: typeof CheckIcon; className: string; spin?: boolean }> = {
  queued: { label: "Queued", Icon: CircleDashedIcon, className: "text-muted-foreground" },
  sending: { label: "Sending", className: "text-muted-foreground", spin: true },
  sent: { label: "Sent", Icon: CheckIcon, className: "text-success-foreground" },
  working: { label: "Working", className: "text-info-foreground", spin: true },
  finished: { label: "Done", Icon: CheckIcon, className: "text-success-foreground" },
  waiting: { label: "Needs you", Icon: MessageCircleQuestionIcon, className: "text-warning-foreground" },
  "timed-out": { label: "Still going", Icon: ClockIcon, className: "text-muted-foreground" },
  exited: { label: "Exited", Icon: CircleIcon, className: "text-muted-foreground" },
  failed: { label: "Failed", Icon: CircleXIcon, className: "text-destructive-foreground" },
  stopped: { label: "Not sent", Icon: CircleIcon, className: "text-muted-foreground" },
  offline: { label: "Box offline", Icon: CloudOffIcon, className: "text-warning-foreground" },
  deferred: { label: "Queued for later", Icon: ListStartIcon, className: "text-info-foreground" },
};

// Results is a prompt to several agents as it goes: each one's state, and
// once its turn ends, the last thing on its screen.
function Results() {
  const run = useBroadcastRun((s) => s.run)!;
  const sent = run.rows.filter((r) => !["queued", "sending", "stopped", "failed", "offline", "deferred"].includes(r.state)).length;
  const offline = run.rows.flatMap((r, i) => (r.state === "offline" ? [i] : []));
  const ended = run.rows.filter((r) => ENDED.includes(r.state) || (!run.wait && r.state === "sent")).length;
  const problems = run.rows.some((r) => r.state === "failed");
  return (
    <>
      <StepHeader
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            {run.done ? problems ? <AlertTriangleIcon aria-hidden className="size-4 shrink-0 text-warning" /> : <CheckIcon aria-hidden className="size-4 shrink-0 text-success" /> : <Spinner className="size-4 shrink-0" />}
            <span className="min-w-0 truncate">{run.title}</span>
          </span>
        }
        description={
          <span className="tabular-nums" aria-live="polite">
            {run.done ? summarize(run.rows) : `Sent to ${sent} of ${run.rows.length}${run.wait ? ` · ${ended} done` : ""}`}
          </span>
        }
      />
      <DialogPanel className="flex flex-col gap-2 px-5 pb-5">
        {run.rows.map((r, i) => (
          <ResultRow key={`${r.box}/${r.session}`} row={r} onQueue={() => void queueRow(run.id, i)} />
        ))}
      </DialogPanel>
      <DialogFooter className="items-center px-5 py-3">
        {!run.done ? (
          <>
            <Button type="button" variant="ghost" onClick={stopBroadcast}>
              Stop
            </Button>
            <Button type="button" variant="outline" onClick={closeComposer}>
              Keep going in the background
            </Button>
          </>
        ) : (
          <>
            {offline.length > 0 && (
              <Button type="button" variant="outline" onClick={() => offline.forEach((i) => void queueRow(run.id, i))}>
                <ListStartIcon />
                Queue {offline.length} for when {offline.length === 1 ? "its box is" : "their boxes are"} back
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const targets = run.rows.map((r) => ({ box: r.box, session: r.session }));
                clearBroadcast();
                openComposer({ mode: "send", targets });
              }}
            >
              Send another
            </Button>
            <Button
              type="button"
              autoFocus
              onClick={() => {
                clearBroadcast();
                closeComposer();
              }}
            >
              Done
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function ResultRow({ row, onQueue }: { row: RunRow; onQueue(): void }) {
  const { session, title, detail } = useTargetLabel(row.box, row.session);
  const info = stateInfo[row.state];
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <AgentIcon agent={session && agentOf(session)} />
        <span className="min-w-0 truncate font-medium text-desc">{title}</span>
        <span className="min-w-0 shrink truncate text-muted-foreground text-meta">{detail}</span>
        <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-meta", info.className)}>
          {info.spin ? <Spinner className="size-3" /> : info.Icon && <info.Icon className="size-3.5" />}
          {info.label}
        </span>
        {row.state === "offline" && (
          <Tip label={`Send it when ${row.box} is back`}>
            <Button type="button" size="xs" variant="outline" className="h-6 text-tag" onClick={onQueue}>
              Queue
            </Button>
          </Tip>
        )}
        {row.state === "deferred" ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 text-tag"
            onClick={() => {
              closeComposer();
              openQueue();
            }}
          >
            View queue
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 text-tag"
            onClick={() => {
              closeComposer();
              void focusSession(row.box, row.session);
            }}
          >
            Open
          </Button>
        )}
      </div>
      {row.error && <p className="border-t px-3 py-1.5 text-destructive-foreground text-meta">{row.error}</p>}
      {row.tail && row.tail.length > 0 && (
        <div className="space-y-px border-t bg-muted/40 px-3 py-2 font-mono text-tag text-foreground/80">
          {row.tail.map((l, i) => (
            <div key={i} className="truncate whitespace-pre" title={l}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
