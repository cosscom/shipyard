import { CheckIcon, GitPullRequestIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Scene } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { ago } from "@/lib/format";
import { useNotifications } from "@/lib/notifications";
import { useStore } from "@/lib/store";
import { useSessionTitle } from "@/hooks/use-session-name";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";
import { ViewHeader } from "@/views/view-header";
import { type ApproveMode, ApproveDialog, DiscardDialog, SendBackDialog } from "@/views/review/review-actions";
import { ReviewDetail } from "@/views/review/review-detail";
import { CompareStrip, CompareView } from "@/views/review/compare-view";
import { allRuns, useRuns } from "@/lib/runs";
import { markReviewed, type ReviewEntry, refreshReview, reviewName, useReview, useReviewName, visibleEntries, watchReview } from "@/views/review/review-store";
import { Tip } from "@/components/tip";
import { BoxError, NeedsUpdate } from "@/components/upgrade-box";

type Dialog = { kind: "approve"; mode: ApproveMode } | { kind: "send" } | { kind: "discard" };

// ReviewView is the inbox of agents' finished work on every box: pick an
// item, read what changed, then approve, send back or discard it.
export function ReviewView() {
  // Select the stable parts; filtering in the selector would make a new
  // array on every read.
  const all = useReview((s) => s.entries);
  const reviewed = useReview((s) => s.reviewed);
  const entries = useMemo(() => visibleEntries({ entries: all, reviewed }), [all, reviewed]);
  const loaded = useReview((s) => s.loaded);
  const loading = useReview((s) => s.loading);
  const outdated = useReview((s) => s.outdated);
  const errors = useReview((s) => s.errors);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  // Compare mode: an attempts run's attempts side by side.
  const view = useStore((s) => s.view);
  const [compare, setCompare] = useState<{ box: string; id: string } | undefined>(view.kind === "review" ? view.run : undefined);
  useEffect(() => {
    if (view.kind === "review" && view.run) setCompare(view.run);
  }, [view]);
  const byBox = useRuns((s) => s.byBox);
  const attempts = useMemo(
    () =>
      allRuns(byBox)
        .filter((r) => r.template === "attempts" && (r.candidates ?? 0) > 0 && (r.status === "waiting_gate" || Date.now() - new Date(r.updated).getTime() < 24 * 3600_000))
        .sort((a, b) => (a.status === "waiting_gate" ? -1 : 0) - (b.status === "waiting_gate" ? -1 : 0))
        .slice(0, 6),
    [byBox],
  );

  useEffect(() => {
    watchReview();
    void refreshReview();
  }, []);

  // A notification's "Open review" picks its item.
  const focus = useNotifications((s) => s.reviewFocus);
  useEffect(() => {
    if (!focus) return;
    setSelectedKey(focus);
    useNotifications.setState({ reviewFocus: undefined });
  }, [focus]);

  const selected = entries.find((e) => e.key === selectedKey) ?? entries[0];
  const index = selected ? entries.indexOf(selected) : -1;

  const actions = useMemo(
    () => ({
      approve: (mode: ApproveMode) => selected && setDialog({ kind: "approve", mode }),
      sendBack: () => selected && setDialog({ kind: "send" }),
      discard: () => selected && selected.files.length > 0 && setDialog({ kind: "discard" }),
      open: () => selected && void focusSession(selected.box, selected.session),
      markReviewed: () => {
        if (!selected) return;
        const next = entries[index + 1] ?? entries[index - 1];
        markReviewed(selected);
        setSelectedKey(next?.key);
        toastManager.add({ title: `Marked ${reviewName(selected)} reviewed`, description: "It comes back if the agent changes anything.", type: "info" });
      },
    }),
    [selected, entries, index],
  );

  // j/k move, a/s/d act, Enter opens, e marks reviewed — unless typing or a
  // dialog or menu is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (compare || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], .xterm, [data-terminal]") || document.querySelector("[data-slot=dialog-popup], [data-slot=menu-popup], [role=menu]"))) return;
      // Enter on a focused button presses it.
      if (e.key === "Enter" && t?.closest("button, a")) return;
      const move = (d: number) => {
        const next = entries[Math.min(entries.length - 1, Math.max(0, index + d))];
        if (next) {
          setSelectedKey(next.key);
          document.getElementById(`review-${next.key}`)?.scrollIntoView({ block: "nearest" });
        }
      };
      const keys: Record<string, () => void> = {
        j: () => move(1),
        ArrowDown: () => move(1),
        k: () => move(-1),
        ArrowUp: () => move(-1),
        a: () => actions.approve(selected?.files.length ? "commit" : "push"),
        s: actions.sendBack,
        d: actions.discard,
        e: actions.markReviewed,
        Enter: actions.open,
      };
      const run = keys[e.key];
      if (run && selected) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entries, index, selected, actions, dialog, compare]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Review"
        description="Agents' finished work on every box, to approve, send back or discard."
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refreshReview()} disabled={loading} aria-label="Refresh">
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <Notices outdated={outdated} errors={errors} />
      {!compare && <CompareStrip runs={attempts} onOpen={(r) => setCompare({ box: r.box, id: r.id })} />}
      {compare ? (
        <CompareView
          box={compare.box}
          id={compare.id}
          onClose={() => {
            setCompare(undefined);
            useStore.getState().setView({ kind: "review" });
          }}
        />
      ) : !loaded ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-body">
          <Spinner className="size-4" /> Reading each box's worktrees…
        </div>
      ) : entries.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia>
              <Scene name="calm" />
            </EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>When an agent finishes its turn and leaves changes, its work shows up here to approve, send back or discard.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Work to review" className="flex w-80 shrink-0 flex-col border-r max-xl:w-64">
            <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Work to review">
              {entries.map((e) => (
                <Row key={e.key} entry={e} active={e.key === selected?.key} onSelect={() => setSelectedKey(e.key)} onOpen={() => void focusSession(e.box, e.session)} />
              ))}
            </ul>
            <footer className="flex shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap border-t px-3 py-2 text-tag text-muted-foreground">
              {(
                [
                  ["J K", "move"],
                  ["A", "approve"],
                  ["S", "send back"],
                  ["D", "discard"],
                ] as const
              ).map(([keys, label]) => (
                <span key={label} className={cn("inline-flex items-center gap-1", label === "discard" && "max-xl:hidden")}>
                  {keys.split(" ").map((k) => (
                    <Kbd key={k} className="h-4 min-w-4 px-1 text-tag">
                      {k}
                    </Kbd>
                  ))}
                  {label}
                </span>
              ))}
            </footer>
          </aside>
          {selected && <ReviewDetail key={selected.key} entry={selected} actions={actions} />}
        </div>
      )}
      {selected && dialog?.kind === "approve" && <ApproveDialog entry={selected} initial={dialog.mode} onClose={() => setDialog(undefined)} />}
      {selected && dialog?.kind === "send" && <SendBackDialog entry={selected} onClose={() => setDialog(undefined)} />}
      {selected && dialog?.kind === "discard" && <DiscardDialog entry={selected} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

function Notices({ outdated, errors }: { outdated: string[]; errors: Record<string, string> }) {
  const failing = Object.entries(errors);
  if (!outdated.length && !failing.length) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b bg-muted/30 px-6 py-2 text-meta">
      {outdated.map((box) => (
        <NeedsUpdate key={box} box={box} className="py-1.5 text-meta">
          <span className="font-medium">{box}</span> runs an older berthd without Review. Update it to include its agents' work here.
        </NeedsUpdate>
      ))}
      {failing.map(([box, msg]) => (
        <BoxError key={box} box={box} error={msg} what="its work for review" />
      ))}
    </div>
  );
}

function Row({ entry, active, onSelect, onOpen }: { entry: ReviewEntry; active: boolean; onSelect(): void; onOpen(): void }) {
  const pr = useReview((s) => s.prs[entry.key]);
  const run = useReview((s) => s.runs[entry.key]);
  const files = entry.files.length || entry.committed.length;
  const added = entry.files.length ? entry.added : entry.committed.reduce((n, f) => n + f.added, 0);
  const removed = entry.files.length ? entry.removed : entry.committed.reduce((n, f) => n + f.removed, 0);
  const waiting = entry.agent_state === "waiting";
  // Led by the work the agent did, when its session has a title.
  const work = useSessionTitle(entry.box, entry.session);
  const name = useReviewName(entry);
  return (
    <li id={`review-${entry.key}`}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-current={active || undefined}
        className={cn(
          "flex w-full flex-col gap-1 rounded-lg px-3 py-row-pad text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-accent hover:bg-accent",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={entry.agent} />
          <span className="min-w-0 flex-1 truncate text-row">{work ?? name}</span>
          <span className={cn("shrink-0 text-meta tabular-nums", waiting ? "text-warning-foreground" : "text-muted-foreground")}>{waiting ? "needs you" : ago(entry.state_since)}</span>
        </span>
        <span className="truncate pl-5.5 text-meta text-muted-foreground">
          {work && `${name} · `}
          {entry.box} · {entry.location}
          {entry.branch && <span> · {entry.branch}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap pl-5.5 text-meta text-muted-foreground">
          <span>
            {files} file{files === 1 ? "" : "s"}
          </span>
          <span className="font-mono tabular-nums">
            <span className="text-success-foreground">+{added}</span> <span className="text-destructive-foreground">−{removed}</span>
          </span>
          {!entry.files.length && entry.base_ahead > 0 && <span>committed</span>}
          {run && run.status !== "running" && (
            <Tip label={`Flow ${run.flow} ${run.status}`}>
              <span className={cn("inline-flex items-center gap-0.5", run.status === "succeeded" ? "text-success-foreground" : "text-destructive-foreground")}>
                {run.status === "succeeded" ? <CheckIcon aria-label="passed" className="size-3" /> : <XIcon aria-label="failed" className="size-3" />}
                check
              </span>
            </Tip>
          )}
          {pr && (
            <Tip label={pr.title}>
              <span className="inline-flex items-center gap-0.5">
                <GitPullRequestIcon aria-label="Pull request" className="size-3" />#{pr.number}
              </span>
            </Tip>
          )}
        </span>
      </button>
    </li>
  );
}
