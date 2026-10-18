import { BrushCleaningIcon, ChevronRightIcon, ListChecksIcon, PlusIcon, SendIcon, ServerIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { BoxFilter, shownBoxes as shownOf } from "@/components/box-filter";
import { Tip } from "@/components/tip";
import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { type SessionEntry, useBoardSessions } from "@/hooks/use-agent-counts";
import { liftToasts } from "@/hooks/lift-toasts";
import { agentOf, type SessionState, worktreeOf } from "@/lib/derive";
import { ago } from "@/lib/format";
import { useProjects } from "@/lib/project-groups";
import { openBroadcast } from "@/lib/prompts";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";
import { AgentCard } from "@/views/dashboard/agent-card";
import { ColumnMenu, openStop, StopDialog } from "@/views/dashboard/stop";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { ViewHeader } from "@/views/view-header";
import { sessionWord } from "@/lib/state-model";

interface Column {
  state: SessionState;
  title: string;
  empty: string;
}

const COLUMNS: Column[] = [
  { state: "waiting", title: sessionWord("waiting"), empty: "Nothing needs you." },
  { state: "running", title: sessionWord("running"), empty: "No agent is working." },
  { state: "finished", title: sessionWord("finished"), empty: "Finished turns land here." },
  { state: "ready", title: sessionWord("ready"), empty: "Agents open with nothing to do." },
];

// Cards in a column: the longest in that state first, so what has waited
// longest is on top.
const sinceOf = (e: SessionEntry) => new Date(e.session.state_since ?? e.session.created).getTime();

// DashboardView is every agent on every box as a board, by what it needs:
// you, time, a look at what it did, or a first prompt.
export function DashboardView() {
  // Without the projects kept off it in Settings → Agents.
  const all = useBoardSessions();
  const offBoard = useProjects().projects.filter((p) => p.dashboardHidden).length;
  // With no box at all, a new worktree has nowhere to go: the way on is a box.
  const noBoxes = useStore((s) => !!s.status && s.status.boxes.length === 0);
  const boxNames = useMemo(() => [...new Set(all.map((e) => e.box))].sort(), [all]);
  const [hidden, setHidden] = useState<string[]>(() => load("berth.dashboard.hiddenBoxes", []));
  const [showRest, setShowRest] = useState(false);
  const shownBoxes = shownOf(boxNames, hidden);
  const visible = all.filter((e) => shownBoxes.includes(e.box));
  const rest = visible.filter((e) => !COLUMNS.some((c) => c.state === e.state));
  const agents = all.filter((e) => COLUMNS.some((c) => c.state === e.state));
  const filtered = shownBoxes.length < boxNames.length;
  // Picked cards, to send them all one prompt. Undefined when not picking.
  const [picked, setPicked] = useState<Set<string>>();
  const keyOf = (e: SessionEntry) => `${e.box}/${e.session.name}`;
  const pick = (keys: string[], on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      for (const k of keys) {
        if (on) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  const pickedEntries = agents.filter((e) => picked?.has(keyOf(e)));
  // Clean up offers what sits in Done and Ready on the boxes shown; it never
  // includes an agent that is working or waiting on you.
  const idle = visible.filter((e) => e.state === "finished" || e.state === "ready");
  const stopPicked = () => openStop({ kind: "stop", entries: pickedEntries });
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog or menu holds focus while open, and takes its own keys (a
      // toast is a dialog too, so its mere presence doesn't count).
      const t = e.target as HTMLElement | null;
      if (t?.closest("[role=dialog],[role=alertdialog],[role=menu]")) return;
      if (e.key === "Escape") setPicked(undefined);
      // ⌫ or Delete on a selection asks to stop it, unless typing.
      if ((e.key === "Backspace" || e.key === "Delete") && !t?.closest("input,textarea,select,[contenteditable=true]") && pickedEntries.length) {
        e.preventDefault();
        stopPicked();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hide = (next: string[]) => {
    setHidden(next);
    save("berth.dashboard.hiddenBoxes", next);
  };

  return (
    <div className="relative flex h-full flex-col">
      <ViewHeader
        title="Agent Dashboard"
        description={
          <>
            {filtered ? `Showing ${shownBoxes.join(", ")} only.` : "Every agent on every box, by what it needs."}
            {offBoard > 0 && (
              <>
                {" "}
                <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => useStore.getState().setView({ kind: "settings", section: "agents" })} data-testid="dashboard-off-board">
                  {offBoard} {offBoard === 1 ? "project" : "projects"} kept off
                </button>
              </>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {agents.length > 0 && (
              <Tip label="Pick agents to prompt or stop several at once (or ⌘-click cards)">
                <Button size="xs" variant={picked ? "secondary" : "ghost"} aria-pressed={!!picked} onClick={() => setPicked(picked ? undefined : new Set())}>
                  <ListChecksIcon />
                  {picked ? "Done selecting" : "Select"}
                </Button>
              </Tip>
            )}
            {idle.length > 0 && (
              <Tip label="Stop agents that have sat in Done or Ready for a while">
                <Button size="xs" variant="ghost" onClick={() => openStop({ kind: "cleanup", entries: idle })}>
                  <BrushCleaningIcon />
                  Clean up…
                </Button>
              </Tip>
            )}
            {filtered && (
              <Button size="xs" variant="ghost" onClick={() => hide([])}>
                Show all
              </Button>
            )}
            <BoxFilter boxes={boxNames} hidden={hidden} onChange={hide} />
          </div>
        }
      />

      {agents.length === 0 ? (
        <Empty className="mt-16">
          <EmptyHeader>
            <EmptyMedia>
              <Scene name="setting-out" />
            </EmptyMedia>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>{noBoxes ? "Agents run on your boxes, and there isn't one yet. Add a box, then start an agent in a new worktree on it." : "Start one in a new worktree, or from any worktree's + menu."}</EmptyDescription>
          </EmptyHeader>
          {noBoxes ? (
            <Button onClick={openAddBox}>
              <ServerIcon />
              Add a box
            </Button>
          ) : (
            <Button onClick={() => useStore.getState().openNewWorktree()}>
              <PlusIcon />
              New worktree
            </Button>
          )}
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] items-start gap-x-4 gap-y-6 px-6 pt-4 pb-6">
            {COLUMNS.map((c) => {
              const items = visible.filter((e) => e.state === c.state).sort((a, b) => sinceOf(a) - sinceOf(b));
              return (
                <section key={c.state} aria-label={c.title} className="min-w-0">
                  <header className="mb-2 flex min-h-5 items-center gap-2 px-0.5">
                    <StateGlyph state={c.state} />
                    <h2 className="text-section">{c.title}</h2>
                    {picked && items.length > 0 && (
                      <button type="button" className="ml-auto text-muted-foreground text-meta hover:text-foreground" onClick={() => pick(items.map(keyOf), !items.every((e) => picked.has(keyOf(e))))}>
                        {items.every((e) => picked.has(keyOf(e))) ? "None" : "All"}
                      </button>
                    )}
                    <span className={cn("font-mono text-meta tabular-nums", !(picked && items.length) && "ml-auto", items.length && c.state === "waiting" ? "text-warning-foreground" : "text-muted-foreground")}>{items.length}</span>
                    {items.length > 0 && (
                      <ColumnMenu
                        title={c.title}
                        items={items}
                        cleanup={c.state === "finished" || c.state === "ready" ? idle : undefined}
                        onPick={() => {
                          setPicked((s) => new Set([...(s ?? []), ...items.map(keyOf)]));
                        }}
                      />
                    )}
                  </header>
                  <div className="flex flex-col gap-row-gap">
                    {items.length === 0 ? (
                      <p className="rounded-lg border border-dashed px-3 py-4 text-center text-meta text-muted-foreground">{c.empty}</p>
                    ) : (
                      items.map((e) => (
                        <AgentCard
                          key={`${e.box}/${e.session.name}:${e.state}`}
                          entry={e}
                          selecting={!!picked}
                          selected={picked?.has(keyOf(e))}
                          onSelect={() => pick([keyOf(e)], !picked?.has(keyOf(e)))}
                        />
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          {rest.length > 0 && (
            <div className="border-t px-6 py-2">
              <button type="button" aria-expanded={showRest} onClick={() => setShowRest(!showRest)} className="flex items-center gap-1.5 rounded-md py-1 text-muted-foreground text-meta hover:text-foreground">
                <ChevronRightIcon className={cn("size-3 transition-transform", showRest && "rotate-90")} />
                <TerminalIcon className="size-3.5" />
                Shells & ended · {summary(rest)}
              </button>
              {showRest && (
                <div className="mt-2 mb-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                  {rest.map((e) => (
                    <QuietCard key={`${e.box}/${e.session.name}`} entry={e} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {picked && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div ref={liftToasts} className="pointer-events-auto flex items-center gap-2 rounded-xl border bg-popover px-3 py-2 shadow-lg/10">
            <span className="pr-1 text-body tabular-nums">{pickedEntries.length ? `${pickedEntries.length} selected` : "Click cards to select them"}</span>
            <Button size="xs" disabled={!pickedEntries.length} onClick={() => openBroadcast({ targets: pickedEntries.map((e) => ({ box: e.box, session: e.session.name })) })}>
              <SendIcon />
              {pickedEntries.length ? `Send to ${pickedEntries.length} agent${pickedEntries.length === 1 ? "" : "s"}…` : "Send to agents…"}
            </Button>
            <Tip label={pickedEntries.length ? "Stop the selected agents (⌫)" : undefined}>
              <Button size="xs" variant="outline" className="text-destructive-foreground" disabled={!pickedEntries.length} onClick={stopPicked}>
                <SquareIcon />
                {pickedEntries.length ? `Stop ${pickedEntries.length}…` : "Stop…"}
              </Button>
            </Tip>
            <span className="h-5 w-px bg-border" />
            <Button size="xs" variant="ghost" onClick={() => setPicked(undefined)}>
              Cancel
              <Kbd>Esc</Kbd>
            </Button>
          </div>
        </div>
      )}
      <StopDialog />
    </div>
  );
}

// QuietCard is a shell or an exited session: just where it is, one click
// from opening.
function QuietCard({ entry }: { entry: SessionEntry }) {
  const { box, session, state } = entry;
  const locations = useStore((s) => s.boxes[box]?.locations);
  const where = worktreeOf(locations, session);
  return (
    <button type="button" onClick={() => void focusSession(box, session.name)} className="flex items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-1.5 text-left text-meta hover:border-ring/40">
      <AgentIcon agent={agentOf(session)} />
      <span className="min-w-0 flex-1 truncate">{where?.worktree.main ? where.location.name : (where?.worktree.name ?? session.name)}</span>
      <span className="shrink-0 text-muted-foreground">{state === "exited" ? sessionWord("exited", true) : `${box} · ${ago(session.created)}`}</span>
    </button>
  );
}

function summary(entries: SessionEntry[]): string {
  const shells = entries.filter((e) => e.state === "idle").length;
  const exited = entries.filter((e) => e.state === "exited").length;
  return [shells && `${shells} shell${shells === 1 ? "" : "s"}`, exited && `${exited} ended`].filter(Boolean).join(", ");
}
