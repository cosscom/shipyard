import { ChevronRightIcon, PencilIcon, ServerOffIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { ContextRow } from "@/components/sidebar/actions";
import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import { RowLayer } from "@/components/sidebar/row-layer";
import { Tip } from "@/components/tip";
import { useTones } from "@/components/workspace/worktree-tone";
import type { Location, Session, Worktree } from "@/lib/api";
import { agentLabel, agentOf, type SessionState, sessionState } from "@/lib/derive";
import { ago } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { useProjects } from "@/lib/project-groups";
import { load, save } from "@/lib/storage";
import { BOX_WORDS, boxState, sessionWord } from "@/lib/state-model";
import { NONE, useStore } from "@/lib/store";
import { toneVar } from "@/lib/groups";
import { cn } from "@/lib/utils";
import { addGroup, openSession, useWorkspaces, wsKey } from "@/lib/workspaces";
import { renameWorktree, worktreeLabel } from "@/lib/worktree-names";

// ---- What the rail knows -------------------------------------------------

export type Lane = "waiting" | "running" | "finished" | "away";
export const LANES: Lane[] = ["waiting", "running", "finished", "away"];
const NO_SESSIONS: Session[] = [];

export interface RailAgent {
  id: string;
  box: string;
  loc: Location;
  wt: Worktree;
  project: string;
  session: Session;
  state: SessionState;
  lane: Lane;
  agent: string;
  key: string;
  selected: boolean;
  tone?: string;
  // The box's state when it is not online: what it ran is last seen.
  away?: string;
}

const LANE_WORDS: Record<Lane, string> = { waiting: "Needs you", running: "Working", finished: "Done", away: "Box away" };

// useRailAgents is every agent worth a glance: one that needs you, is
// working or is done, on every box, and the ones on a box that went away.
// Idle agents and plain shells say nothing, so the rail stays quiet.
export function useRailAgents(): RailAgent[] {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const current = useWorkspaces((s) => s.current);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const { projects } = useProjects();
  const tones = useTones();
  return useMemo(() => {
    const projectOf = new Map<string, string>();
    for (const p of projects) for (const m of p.members) projectOf.set(`${m.box.name}/${m.loc.name}`, p.name);
    const out: RailAgent[] = [];
    for (const b of boxes) {
      const d = data[b.name];
      const away = b.state === "online" ? undefined : BOX_WORDS[boxState(b, d)].lower;
      // A box's sessions by where they run, so each worktree finds its own
      // without going through them all.
      const byDir = new Map<string, Session[]>();
      for (const s of d?.sessions ?? []) {
        if (s.service || s.exited || !s.dir) continue;
        const list = byDir.get(s.dir);
        if (list) list.push(s);
        else byDir.set(s.dir, [s]);
      }
      for (const loc of d?.locations ?? []) {
        for (const wt of loc.worktrees ?? []) {
          for (const s of byDir.get(wt.path) ?? NO_SESSIONS) {
            const agent = agentOf(s);
            if (!agent) continue;
            const state = sessionState(s, d?.stats);
            const lane: Lane | undefined = away ? "away" : state === "waiting" || state === "running" || state === "finished" ? state : undefined;
            if (!lane) continue;
            const key = wsKey(b.name, wt.path);
            out.push({
              id: `${b.name}/${s.name}`,
              box: b.name,
              loc,
              wt,
              project: projectOf.get(`${b.name}/${loc.name}`) ?? loc.name,
              session: s,
              state,
              lane,
              agent,
              key,
              selected: inWorkspace && current === key,
              tone: tones[key] ? toneVar(tones[key]) : undefined,
              away,
            });
          }
        }
      }
    }
    // Lanes in order, and inside one by place, so a tile only moves when
    // its agent changes state.
    const order = (e: RailAgent) => LANES.indexOf(e.lane);
    return out.sort((x, y) => order(x) - order(y) || x.project.localeCompare(y.project) || worktreeLabel(x.wt).localeCompare(worktreeLabel(y.wt)) || x.box.localeCompare(y.box) || x.session.name.localeCompare(y.session.name));
  }, [boxes, data, current, inWorkspace, projects, tones]);
}

// A worktree by its display name, when it was given one (lib/worktree-names).
const wtName = (e: Pick<RailAgent, "wt" | "loc">) => worktreeLabel(e.wt, e.loc);
const place = (e: RailAgent) => (e.wt.main ? `${e.project}` : `${e.project} / ${worktreeLabel(e.wt)}`);

function focus(e: RailAgent, alt = false) {
  if (alt && usePrefs.getState().labs) return void addGroup(e.key);
  openSession(e.box, e.session);
}

// label is a tile's name for screen readers: what, where, and its state.
function label(e: RailAgent) {
  const what = e.session.title ? `: ${e.session.title}` : "";
  if (e.away) return `${agentLabel(e.agent)} in ${place(e)} on ${e.box}${what}. ${e.box} is ${e.away}`;
  return `${agentLabel(e.agent)} in ${place(e)} on ${e.box}${what}. ${sessionWord(e.state)}`;
}

// AgentCard is the hover card: the agent, its state and for how long, what
// it works on, what it waits for, and where it is.
export function AgentCard({ e }: { e: RailAgent }) {
  const since = e.session.state_since ? ago(e.session.state_since).replace(" ago", "") : "";
  const ask = e.state === "waiting" && !e.away ? e.session.ask : undefined;
  return (
    <span data-testid="rail-card" className="flex w-64 flex-col gap-1 py-1">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <AgentIcon agent={e.agent} className="size-3.5" />
        <span>{agentLabel(e.agent)}</span>
        <span className="ml-auto flex items-center gap-1">
          {e.away ? (
            <>
              <ServerOffIcon className="size-3" />
              {e.box} {e.away}
            </>
          ) : (
            <>
              <StateGlyph state={e.state} className="size-3" />
              <span className={cn(e.state === "waiting" && "text-warning-foreground", e.state === "running" && "text-info-foreground", e.state === "finished" && "text-success-foreground")}>{sessionWord(e.state)}</span>
              {since && <span>· {since}</span>}
            </>
          )}
        </span>
      </span>
      <span className="font-medium text-[13px] text-foreground leading-snug">{e.session.title ?? (e.wt.main ? "Main checkout" : worktreeLabel(e.wt))}</span>
      {ask && (ask.input || ask.message) && (
        <span className="line-clamp-2 break-words rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
          {ask.tool ? `${ask.tool}: ` : ""}
          {ask.input ?? ask.message}
        </span>
      )}
      <span className="flex items-center gap-1 text-muted-foreground">
        {e.tone && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: e.tone }} />}
        <span className="truncate">{e.wt.main ? `${e.project} · main checkout` : place(e)}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px]">{e.box}</span>
      </span>
      {/* A renamed worktree's own name, which its branch and folder keep. */}
      {!e.wt.main && e.wt.title && <span className="truncate font-mono text-[11px] text-muted-foreground">{e.wt.name}</span>}
      {!e.wt.main && !e.away && <span className="text-[11px] text-muted-foreground/80">Right-click or F2 to rename the worktree</span>}
      {e.away && <span className="text-muted-foreground">Last seen {sessionWord(e.state, true)}. It may have moved on.</span>}
    </span>
  );
}

// useRoving gives a list one tab stop and arrow keys between its items.
function useRoving() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (ev: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[data-rail-item]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, to))];
    for (const it of items) it.tabIndex = it === next ? 0 : -1;
    next.focus();
  };
  // The first item is the tab stop until arrows move it.
  useEffect(() => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[data-rail-item]") ?? [])];
    if (items.length && !items.some((it) => it.tabIndex === 0)) items[0].tabIndex = 0;
  });
  return { ref, onKeyDown };
}

// Scroller is the rail's middle: it scrolls when there is more than fits,
// with a fade at an edge there is more past.
function Scroller({ children, label: name }: { children: ReactNode; label: string }) {
  const roving = useRoving();
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const update = () => {
    const el = roving.ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  };
  // Its own size, and what is in it, change what is past an edge.
  useEffect(() => {
    const el = roving.ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    update();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // One context menu and tooltip for every tile (RowLayer).
  return (
    <RowLayer
      ref={roving.ref}
      data-rail-scroll
      role="navigation"
      aria-label={name}
      onKeyDown={roving.onKeyDown}
      onScroll={update}
      className="h-full scroll-pt-7 overflow-y-auto overscroll-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        maskImage: `linear-gradient(to bottom, ${edges.top ? "transparent, black 20px" : "black, black"}, ${edges.bottom ? "black calc(100% - 20px), transparent" : "black, black"})`,
      }}
    >
      {children}
    </RowLayer>
  );
}

// Ring is a tile's state in the sidebar's own language, drawn round the
// agent's icon: a blue arc that turns while it works, an amber ring when it
// needs you, a green one when it is done, a dashed grey one when its box is
// away.
function Ring({ e }: { e: RailAgent }) {
  const base = "pointer-events-none absolute -inset-[3px] rounded-full";
  if (e.away) return <span aria-hidden className={cn(base, "border-[1.5px] border-muted-foreground/50 border-dashed")} />;
  if (e.state === "running") return <span aria-hidden className={cn(base, "animate-spin border-2 border-info border-t-transparent border-r-transparent [animation-duration:1.4s] motion-reduce:animate-none")} />;
  if (e.state === "waiting") return <span aria-hidden className={cn(base, "border-2 border-warning")} />;
  return <span aria-hidden className={cn(base, "border-[1.5px] border-success/70")} />;
}

// tileActions are a tile's menu: go to it, and name its worktree.
function tileActions(e: RailAgent) {
  const rename = () => openRenameWorktree(e.box, e.loc, e.wt, { inPlace: false });
  return [
    { type: "item" as const, label: "Open", icon: <SquareArrowOutUpRightIcon />, run: () => focus(e) },
    ...(e.wt.main || e.away
      ? []
      : [
          { type: "sep" as const },
          { type: "item" as const, label: "Rename worktree…", icon: <PencilIcon />, shortcut: "F2", run: rename },
          ...(e.wt.title ? [{ type: "item" as const, label: `Show as ${e.wt.name}`, icon: <span className="size-4" />, run: () => void renameWorktree(e.box, e.loc, e.wt, "") }] : []),
        ]),
  ];
}

// A tile draws again only when what it shows changed: the list is made afresh
// whenever any agent changes, and the others keep their objects (a session,
// a worktree) and their words.
const sameAgent = (a: RailAgent, b: RailAgent) => a === b || (Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof RailAgent)[]).every((k) => a[k] === b[k]));

const AgentTile = memo(function AgentTile({ e }: { e: RailAgent }) {
  return (
    <li className="relative">
      {/* On screen: a bar at the rail's edge, in its tab group's colour. */}
      {e.selected || e.tone ? <span aria-hidden className="absolute top-2 -left-1 h-5 w-[3px] rounded-r-full" style={{ background: e.tone ?? "var(--foreground)" }} /> : null}
      <ContextRow items={() => tileActions(e)}>
        <Tip side="right" align="start" className="max-w-none" label={<AgentCard e={e} />}>
          <button
            type="button"
            data-rail-item
            data-testid="rail-agent"
            data-agent-state={e.away ? "away" : e.state}
            data-session={`${e.box}/${e.session.name}`}
            tabIndex={-1}
            aria-label={label(e)}
            aria-current={e.selected || undefined}
            onClick={(ev) => focus(e, ev.altKey)}
            onKeyDown={(ev) => {
              if (ev.key !== "F2" || e.wt.main || e.away) return;
              ev.preventDefault();
              openRenameWorktree(e.box, e.loc, e.wt, { inPlace: false });
            }}
            className="group flex w-full flex-col items-center gap-1 rounded-lg px-0.5 pt-1.5 pb-1 outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn("relative inline-flex size-7 items-center justify-center rounded-full bg-sidebar-accent", e.lane === "waiting" && "bg-warning/12", e.selected && "bg-foreground/12", e.away && "opacity-60")}>
              <AgentIcon agent={e.agent} className="size-3.5" />
              <Ring e={e} />
            </span>
            <span
              className={cn("line-clamp-2 w-full text-center text-[10px] leading-[11px] [overflow-wrap:anywhere]", e.selected ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground", e.away && "opacity-70")}
              style={e.tone ? { color: e.tone } : undefined}
            >
              {wtName(e)}
            </span>
          </button>
        </Tip>
      </ContextRow>
    </li>
  );
}, (a, b) => sameAgent(a.e, b.e));

// LaneHead heads a lane with its glyph and count, so how many need you
// stays in sight however far the rail scrolls. It folds the lane away.
function LaneHead({ lane, count, folded, onFold }: { lane: Lane; count: number; folded: boolean; onFold(): void }) {
  const what = lane === "away" ? `${count} on a box that is away` : `${count} ${LANE_WORDS[lane].toLowerCase()}`;
  return (
    <Tip side="right" label={`${what} · ${folded ? "show" : "fold"}`}>
      <button
        type="button"
        data-rail-item
        data-testid="rail-lane"
        data-lane={lane}
        tabIndex={-1}
        aria-expanded={!folded}
        aria-label={`${LANE_WORDS[lane]}: ${count}`}
        onClick={onFold}
        className="sticky top-0 z-10 flex h-6 w-full items-center justify-center gap-1 rounded-md bg-sidebar font-medium text-[10px] tabular-nums outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {lane === "away" ? <ServerOffIcon className="size-3 text-muted-foreground" /> : <StateGlyph state={lane} className="size-3" />}
        <span className={cn(lane === "waiting" ? "text-warning-foreground" : "text-muted-foreground")}>{count}</span>
        {folded && <ChevronRightIcon aria-hidden className="-mr-1 size-3 text-muted-foreground" />}
      </button>
    </Tip>
  );
}

// Lanes folded away, on this computer.
const FOLD_KEY = "berth.rail";

// Rail lists the agents in the folded sidebar, by what they need from you:
// those that need you, then those working, then those done, then those on
// a box that went away. Each is its agent's icon in a ring of its state,
// over its worktree's name; the hover card says the rest, and a click goes
// to it. Nothing at all while nothing is happening.
export function RailAgents() {
  const all = useRailAgents();
  const [folded, setFolded] = useState<Lane[]>(() => load<Lane[]>(FOLD_KEY, []));
  const fold = (lane: Lane) =>
    setFolded((f) => {
      const next = f.includes(lane) ? f.filter((l) => l !== lane) : [...f, lane];
      save(FOLD_KEY, next);
      return next;
    });
  if (!all.length) return null;
  return (
    <div className="h-full border-sidebar-border border-t pt-1">
      <Scroller label="Agents">
        {LANES.map((lane) => {
          const list = all.filter((e) => e.lane === lane);
          if (!list.length) return null;
          const shut = folded.includes(lane);
          return (
            <section key={lane} aria-label={`${LANE_WORDS[lane]}, ${list.length}`} data-testid="rail-section" data-lane={lane} className="pb-1">
              <LaneHead lane={lane} count={list.length} folded={shut} onFold={() => fold(lane)} />
              {!shut && (
                <ul className="flex flex-col gap-0.5">
                  {list.map((e) => (
                    <AgentTile key={e.id} e={e} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </Scroller>
    </div>
  );
}
