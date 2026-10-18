import { HourglassIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { openOrchestrate, SessionActions } from "@/components/orchestrate/session-actions";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastManager } from "@/components/ui/toast";
import type { SessionEntry } from "@/hooks/use-agent-counts";
import { boxApi } from "@/lib/api";
import { agentOf } from "@/lib/derive";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";
import { describeAgent, startedAt } from "@/views/dashboard/names";
import { confirmStop, StopMenuItems } from "@/views/dashboard/stop";
import { type Choice, useScreenTail } from "@/views/dashboard/use-screen-tail";

// One clock for every card, so a board of them re-renders once a second at
// most, not once per card.
const listeners = new Set<(n: number) => void>();
let timer = 0;
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) timer = window.setInterval(() => listeners.forEach((l) => l(Date.now())), 1000);
    return () => {
      listeners.delete(setNow);
      if (!listeners.size) {
        window.clearInterval(timer);
        timer = 0;
      }
    };
  }, []);
  return now;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// AgentCard is one agent on the board: where it works, how long it has been
// in its state, the last thing it said, and what you can do about it. While
// the board is selecting (or with ⌘ or ⇧ held), a click picks it instead.
export function AgentCard({ entry, selecting, selected, onSelect }: { entry: SessionEntry; selecting?: boolean; selected?: boolean; onSelect?(): void }) {
  const { box, session, state } = entry;
  const locations = useStore((s) => s.boxes[box]?.locations);
  const sessions = useStore((s) => s.boxes[box]?.sessions);
  const { where, place, name, crowded, prompt, title: work, agent } = describeAgent(session, sessions, locations);
  // A titled agent leads with its work, its place below; otherwise its place.
  const title = work ?? place;
  const now = useNow();
  // A ready agent has said nothing yet: its screen is only a banner.
  const { tail, choices } = useScreenTail(box, session, 3, state === "running", state !== "ready");
  const since = session.state_since ?? session.created;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const open = () => void focusSession(box, session.name);
  const asking = state === "waiting" && choices.length > 0;
  // The question, without the options the chips below already show.
  const lines = asking ? (tail ?? []).filter((l) => !/^\s*(?:[❯›>]\s*)?\d[.)]\s/.test(l)) : tail;

  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selecting ? !!selected : undefined}
      onClick={(e) => (onSelect && (selecting || e.metaKey || e.shiftKey) ? onSelect() : open())}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && (selecting && onSelect ? onSelect() : open())}
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-lg border bg-card text-left outline-none transition-[opacity,translate,border-color] duration-200 hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring",
        shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        // Waiting is said by the whole outline, never a stripe down one side.
        state === "waiting" && "border-warning/45 hover:border-warning/70",
        selected && "border-primary/60 ring-1 ring-primary/30 hover:border-primary/60",
      )}
    >
      <div className="px-3 pt-row-pad">
        <div className="flex items-center gap-2">
          {selecting && <Checkbox checked={!!selected} tabIndex={-1} aria-hidden className="pointer-events-none" />}
          <AgentIcon agent={agentOf(session)} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="min-w-0 truncate text-row">{title}</span>
            {/* Several agents in one worktree: which one this is. */}
            {!work && crowded && (
              <Tip label={`Session ${session.name}`}>
                <span className="shrink-0 text-meta text-muted-foreground">{name}</span>
              </Tip>
            )}
          </span>
          <Tip label={`Since ${new Date(since).toLocaleString()}`}>
            <span className={cn("shrink-0 font-mono text-meta tabular-nums", state === "waiting" ? "text-warning-foreground" : "text-muted-foreground")}>{duration(now - new Date(since).getTime())}</span>
          </Tip>
        </div>
        <div className="mt-0.5 truncate pl-5.5 text-meta text-muted-foreground">
          {work && `${agent} · ${place} · `}
          {box}
          {where && !(work && where.worktree.main) && ` · ${where.location.name}`}
          {crowded && ` · started ${startedAt(session.created)}`}
          {where?.worktree.branch && where.worktree.branch !== place && <span className="opacity-70"> · {where.worktree.branch}</span>}
        </div>
        {/* Its turn ended, but turn check read the work as still going on. */}
        {state === "running" && session.unfinished && (
          <Tip label="Its turn ended while its work runs on: a delegated task, a build, a deploy or a watcher. It picks up by itself.">
            <div className="mt-1 flex w-fit items-center gap-1 pl-5.5 text-meta text-muted-foreground">
              <HourglassIcon className="size-3" aria-hidden />
              Waiting on its work
            </div>
          </Tip>
        )}
        {/* Turn check read the work as parked: nothing runs, nothing needs you. */}
        {state === "ready" && session.parked && (
          <Tip label="Its work is paused until someone else replies or a later time. Nothing runs and nothing needs you; it picks up by itself.">
            <div className="mt-1 flex w-fit items-center gap-1 pl-5.5 text-meta text-muted-foreground">
              <HourglassIcon className="size-3" aria-hidden />
              Parked: waiting on a reply or a later time
            </div>
          </Tip>
        )}
        {prompt && (!work || !prompt.startsWith(work.replace(/…$/, ""))) && (
          <div className="mt-1 truncate pl-5.5 text-meta text-foreground/70 italic" title={prompt}>
            “{prompt}”
          </div>
        )}
        {lines && lines.length > 0 && state !== "ready" && (
          <div className={cn("mt-2 space-y-px rounded-md bg-muted/50 px-2 py-1.5 font-mono text-tag", state === "waiting" ? "text-foreground/85" : "text-muted-foreground")}>
            {lines.map((l, i) => (
              <div key={i} className="truncate whitespace-pre" title={l}>
                {l}
              </div>
            ))}
          </div>
        )}
        {asking && <Answers box={box} session={session.name} choices={choices} />}
      </div>

      <footer className="mt-2 flex items-center gap-1 border-t px-1.5 py-1">
        {!selecting && (
          <span className="flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Tip label="Stop agent…">
              <button
                type="button"
                aria-label={`Stop ${name} in ${place}`}
                onClick={() => confirmStop(entry)}
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <SquareIcon className="size-3" />
              </button>
            </Tip>
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button size="xs" variant="ghost" className="h-6 text-tag" onClick={open}>
            Open
          </Button>
          <Button size="xs" variant="ghost" className="h-6 text-tag" onClick={() => openOrchestrate("send", box, session.name)}>
            {state === "ready" ? "Prompt…" : "Reply…"}
          </Button>
          <SessionActions box={box} session={session.name}>
            <StopMenuItems entry={entry} />
          </SessionActions>
        </span>
      </footer>
    </article>
  );
}

// Answers are the agent's numbered options as buttons: one click types the
// number into its session, which is how Claude Code takes an answer.
function Answers({ box, session, choices }: { box: string; session: string; choices: Choice[] }) {
  const client = useStore((s) => s.client);
  const [sent, setSent] = useState<string>();
  const answer = async (c: Choice) => {
    if (!client) return;
    setSent(c.key);
    try {
      // The person is answering the question, so the box may type into it.
      await boxApi.send(client, box, session, c.key, false, { when: "now", force: true });
      toastManager.add({ title: `Answered ${c.key}`, description: c.label, type: "success" });
    } catch (err) {
      setSent(undefined);
      toastManager.add({ title: "Couldn't answer", description: errorMessage(err), type: "error" });
    }
  };
  return (
    <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {choices.map((c) => (
        // The whole answer when it is cut short.
        <Tip key={c.key} label={c.label.length > 28 ? c.label : undefined} wrapClassName="max-w-full">
          <button
            type="button"
            disabled={!!sent}
            onClick={() => void answer(c)}
            className={cn(
              "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border bg-background px-2 text-tag transition-colors hover:border-ring/50 disabled:opacity-50",
              sent === c.key && "border-success/50 text-success",
            )}
          >
            <span className="font-mono text-muted-foreground">{c.key}</span>
            <span className="truncate">{c.label.length > 28 ? `${c.label.slice(0, 27)}…` : c.label}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}
