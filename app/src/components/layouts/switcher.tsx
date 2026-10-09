import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { AgentIcon } from "@/components/agent-glyph";
import { type Item, type Lane, LANE_WORDS, openItem, shortAgo, useItems } from "@/components/layouts/model";
import { BoxTag, ItemGlyph, useDoing } from "@/components/layouts/parts";
import { Kbd } from "@/components/ui/kbd";
import { type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";
import { useScreenTail } from "@/views/dashboard/use-screen-tail";

// The switcher (Labs layouts): hold ⌃ and press ⇥, as ⌘-Tab switches apps,
// and every agent shows as a card with the last lines of its screen, the
// ones that need you first. ⇥ and the arrows move, letting go of ⌃ opens
// the one picked, esc puts it away. Opened by a click instead, it stays
// until a card is picked.

const useSwitcher = create<{ open: boolean; index: number; held: boolean }>()(() => ({ open: false, index: 0, held: false }));

export function openSwitcher() {
  useSwitcher.setState({ open: true, index: 0, held: false });
}

const LANES: Lane[] = ["waiting", "running", "finished", "recent"];
const ROW = 2;

// The pointer picks a card only once it moves: the switcher opening under a
// resting pointer mustn't take the pick from the keyboard.
let rest: { x: number; y: number } | undefined;
function pointerMoved(e: React.MouseEvent) {
  if (!rest) {
    rest = { x: e.clientX, y: e.clientY };
    return false;
  }
  return Math.abs(e.clientX - rest.x) + Math.abs(e.clientY - rest.y) > 4;
}

const close = () => useSwitcher.setState({ open: false, held: false });

export function AgentSwitcher() {
  const all = useItems();
  // Away boxes can't be opened; a long tail of Recent isn't switching.
  // Everything that needs you or works; a row each of the newest done and
  // recent, so the picture fits one screen. The rest are a type away in
  // the project switcher (⌘E).
  const items = useMemo(() => {
    const lane = (l: Lane) => all.filter((i) => i.lane === l);
    return [...lane("waiting"), ...lane("running"), ...lane("finished").slice(0, ROW), ...lane("recent").slice(0, ROW)];
  }, [all]);
  const more = { finished: all.filter((i) => i.lane === "finished").length - ROW, recent: all.filter((i) => i.lane === "recent").length - ROW } as Partial<Record<Lane, number>>;
  const { open, index, held } = useSwitcher();
  const grid = useRef<HTMLDivElement>(null);
  const list = useRef(items);
  list.current = items;

  useEffect(() => {
    const cols = () => {
      const el = grid.current;
      if (!el) return 4;
      return getComputedStyle(el).gridTemplateColumns.split(" ").length || 4;
    };
    const go = (i: number) => {
      const it = list.current[i];
      close();
      if (it) openItem(it);
    };
    const onDown = (e: KeyboardEvent) => {
      const s = useSwitcher.getState();
      const n = list.current.length;
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && (s.open || !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (!s.open) {
          // As ⌘-Tab picks the app you were in last: the worktree before
          // this one, else the first that isn't on screen.
          const spaces = useWorkspaces.getState().spaces;
          const here = useWorkspaces.getState().current;
          const last = Object.entries(spaces)
            .filter(([k, w]) => k !== here && w.visitedAt)
            .sort((a, b) => (b[1].visitedAt ?? 0) - (a[1].visitedAt ?? 0))[0]?.[0];
          const prev = last ? list.current.findIndex((i) => i.key === last) : -1;
          const other = list.current.findIndex((i) => !i.selected);
          useSwitcher.setState({ open: true, held: true, index: prev >= 0 ? prev : Math.max(0, other) });
        } else if (n) useSwitcher.setState({ index: (s.index + (e.shiftKey ? -1 : 1) + n) % n });
        return;
      }
      if (!s.open) return;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() }[e.key];
      if (step !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        useSwitcher.setState({ index: Math.max(0, Math.min(n - 1, s.index + step)) });
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        go(s.index);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const s = useSwitcher.getState();
      if (s.open && s.held && e.key === "Control") go(s.index);
    };
    // Capture, so a focused terminal doesn't take ⌃⇥ first.
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, []);

  if (!open) {
    rest = undefined;
    return null;
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch to an agent"
      data-testid="agent-switcher"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/55 p-6 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in-0"
      onClick={close}
    >
      <div className="flex max-h-full w-full max-w-[860px] flex-col gap-3 rounded-2xl border bg-popover/95 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between px-1">
          <span className="font-medium text-sm">Switch to</span>
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            {held ? (
              <>
                <Kbd>⇥</Kbd> next · <Kbd>⇧⇥</Kbd> back · let go of <Kbd>⌃</Kbd> to open
              </>
            ) : (
              <>
                <Kbd>←→</Kbd> to move · <Kbd>↵</Kbd> to open · <Kbd>⌃⇥</Kbd> any time
              </>
            )}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="px-1 py-8 text-center text-muted-foreground text-sm">No agents yet. Start a task with ⌘N.</p>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-0.5">
            {LANES.map((lane) => {
              const inLane = items.map((it, i) => ({ it, i })).filter(({ it }) => it.lane === lane);
              if (!inLane.length) return null;
              return (
                <section key={lane} aria-label={LANE_WORDS[lane]} data-testid="switcher-lane" data-lane={lane}>
                  <h3 className={cn("px-1 pb-1.5 font-medium text-[11px]", lane === "waiting" ? "text-warning-foreground" : "text-muted-foreground")}>
                    {LANE_WORDS[lane]} <span className="tabular-nums">{inLane.length + Math.max(0, more[lane] ?? 0)}</span>
                    {(more[lane] ?? 0) > 0 && <span className="ml-2 font-normal">the newest {ROW}; ⌘E finds the rest</span>}
                  </h3>
                  <div ref={lane === items[0]?.lane ? grid : undefined} className="grid grid-cols-2 gap-2">
                    {inLane.map(({ it, i }) => (
                      <Card key={it.id} it={it} picked={i === index} onPick={() => useSwitcher.setState({ index: i })} onOpen={() => (close(), openItem(it))} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ it, picked, onPick, onOpen }: { it: Item; picked: boolean; onPick(): void; onOpen(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (picked) ref.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  const doing = useDoing(it, false);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="switcher-card"
      data-item={it.id}
      data-picked={picked || undefined}
      onMouseMove={(e) => pointerMoved(e) && onPick()}
      onClick={onOpen}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-2.5 text-left outline-none transition-colors",
        it.lane === "waiting" && "bg-warning/[0.06]",
        picked ? "border-primary ring-2 ring-primary/35" : "hover:border-ring/50",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <ItemGlyph i={it} />
        <span className="min-w-0 flex-1 truncate font-medium text-[13px]">{it.title}</span>
        <span className={cn("shrink-0 text-[11px] tabular-nums", it.lane === "waiting" ? "text-warning-foreground" : "text-muted-foreground")}>{it.since ? shortAgo(it.since) : LANE_WORDS[it.lane]}</span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {it.agent && <AgentIcon agent={it.agent} className="size-3" />}
        <span className="min-w-0 flex-1 truncate">{it.place}</span>
        <BoxTag i={it} always />
      </span>
      {it.session ? <Tail box={it.box} session={it.session} working={it.lane === "running"} fallback={doing} /> : <span className="mt-1 flex h-[48px] items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground">No agent here</span>}
    </button>
  );
}

// Tail is the last lines of the agent's screen: a live thumbnail in words.
function Tail({ box, session, working, fallback }: { box: string; session: Session; working: boolean; fallback?: string }) {
  const { tail } = useScreenTail(box, session, 3, working);
  // An agent that has said nothing yet shows only its banner: say what it
  // is for instead.
  const banner = !tail?.length || tail.some((l) => /[▐▛▜▙▟█]/.test(l));
  const lines = !banner ? tail! : [fallback ?? (session.title ? `Ready: ${session.title}` : "Ready for a prompt")];
  return (
    <span className="mt-1 flex h-[48px] flex-col overflow-hidden rounded-md bg-muted/50 px-2 py-1 font-mono text-[10.5px] text-muted-foreground leading-[14px]">
      {lines.map((l, i) => (
        <span key={i} className="truncate whitespace-pre">
          {l}
        </span>
      ))}
    </span>
  );
}
