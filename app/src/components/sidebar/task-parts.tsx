import { EllipsisIcon, ServerIcon, ServerOffIcon, SettingsIcon, PlusIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { WorkGlyph } from "@/components/agent-glyph";
import { type Action, ActionItems, boxActions, ContextRow } from "@/components/sidebar/actions";
import { boxLoad } from "@/components/sidebar/box-load";
import { ink } from "@/components/sidebar/ink";
import { Tip } from "@/components/tip";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type { BoxStatus } from "@/lib/api";
import { viaRoute } from "@/lib/box-routes";
import type { SessionState } from "@/lib/derive";
import { useOutdatedBoxes } from "@/lib/outdated";
import { boxesLine, shortAgo } from "@/lib/sidebar-task";
import { BOX_WORDS, type BoxState, boxState, sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openAddBox } from "@/views/onboarding/add-box-dialog";

// The pieces a task row in the sidebar is made of, and its foot. A row is
// a fixed status lane, the task's title and a fixed time lane, so titles
// and times line up down the list; no logos, the lane says how it's going.

// The row you have open: a soft tint a step past the hover colour, from
// the theme's own sidebar and text colours, and full ink. Never a heavier
// weight: that moves where a long title is cut off (coss ui's menu button
// adds one, so this sets it back).
export const selectedRow = "data-[active=true]:bg-[color-mix(in_srgb,var(--sidebar-accent),var(--foreground)_4%)] data-[active=true]:font-normal data-[active=true]:text-foreground";

// A task row is a place row's height (28px at the default density), and so
// is a child's, under its parent on the guide.
// It stays lit while the pointer is on its + and ⋯, which sit on that light.
export const taskRowClass = cn("h-side-row w-full translate-x-0 gap-2 px-2 text-desc font-normal sm:h-side-row group-hover/row:not-data-[active=true]:bg-sidebar-accent", selectedRow);
export const childRowClass = "h-side-row gap-2 pr-2 pl-1.5 text-desc sm:h-side-row";

// toneOf is how much a row's title asks of you: waiting for you in full
// ink, working as an ordinary row, done or idle quiet.
export function toneOf(state?: SessionState) {
  if (state === "waiting") return ink.strong;
  if (state === "running") return ink.row;
  return ink.quiet;
}

// TaskGlyph is a row's status lane: an amber dot while its agent needs you,
// a blue arc while it works, a quiet check once it's done, and nothing at
// all otherwise (the lane keeps its width, so titles line up). small is a
// child row's narrower lane. onWork is a row whose agents' turns ended while
// their work runs on (allOnItsWork): an hourglass with why in its tip, not
// the arc of a turn still going.
export function TaskGlyph({ state, small, onWork }: { state?: SessionState; small?: boolean; onWork?: boolean }) {
  if (state === "running" && onWork) return <WorkGlyph className={cn("w-3.5", small ? "h-[11px]" : "h-3")} />;
  const label = state && state !== "exited" ? sessionWord(state) : "Idle";
  return (
    <span role="img" aria-label={label} className={cn("inline-flex shrink-0 items-center justify-center", "w-3.5")}>
      {state === "waiting" ? (
        <span className="size-[7px] rounded-full bg-warning" />
      ) : state === "running" ? (
        <svg viewBox="0 0 24 24" aria-hidden className={cn("text-info motion-safe:animate-spin motion-safe:[animation-duration:1.4s]", small ? "size-[11px]" : "size-3")}>
          <path d="M21 12a9 9 0 1 1-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : state === "finished" ? (
        <svg viewBox="0 0 24 24" aria-hidden className={cn(ink.glyph, small ? "size-[11px]" : "size-3")}>
          <path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

// BranchMark is the small fork an orchestrator's row shows before the
// count of worktrees it handed work to.
export function BranchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-3 shrink-0", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M6 8.5V14a4 4 0 0 0 4 4h5.5" />
      </g>
    </svg>
  );
}

// One clock for every time lane: it ticks each 30 seconds while any lane
// is on screen.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
const useNow = () => useSyncExternalStore(subscribe, () => now);

// A finished agent's time shows for an hour; after that it is just done.
const RECENT_MS = 60 * 60_000;

// timed says whether a row's time lane says anything: while its agent
// needs you or works, and for an hour after it finished. Idle rows are
// quiet.
export function timed(state: SessionState | undefined, since: string | undefined, at: number) {
  if (state === "waiting" || state === "running") return true;
  if (state !== "finished" || !since) return false;
  const t = new Date(since).getTime();
  return !Number.isNaN(t) && at - t < RECENT_MS;
}

// TimeLane is how long a row's agent has been as it is ("now", "4m", "1h"),
// right-aligned in a fixed lane; tip says what runs there. An idle row's
// lane is empty, and keeps its width.
export function TimeLane({ since, tip, state }: { since?: string; tip?: string; state?: SessionState }) {
  const t = useNow();
  const at = Math.max(t, Date.now() - 30_000);
  const text = timed(state, since, at) ? shortAgo(since, at) : "";
  const lane = (
    <span data-testid="row-time" className={cn("w-7 shrink-0 text-right text-tag tabular-nums", ink.faint, "in-data-[active=true]:text-(color:--ink-row)")}>
      {text}
    </span>
  );
  return tip && text ? <Tip label={tip}>{lane}</Tip> : lane;
}

// awayText is a box's state in the model's words (offline, unreachable,
// connecting), with how long it has been so when the agent knows:
// "offline for 10h".
export function awayText(box: BoxStatus) {
  const word = BOX_WORDS[boxState(box)].lower;
  const long = box.since ? shortAgo(box.since, Date.now()) : "";
  return long && long !== "now" ? `${word} for ${long}` : word;
}

// BoxDot is a box's dot in the foot and over Group by: Box: the one ink,
// full while it is up, fainter while its link is slow, faintest while it
// is away. Amber only when it needs something from you: an older berthd
// to update, or it answers but can't be used.
export function BoxDot({ state }: { state: BoxState }) {
  const tone = {
    online: "bg-foreground/70",
    slow: "bg-foreground/45",
    outdated: "bg-warning",
    unreachable: "bg-warning",
    connecting: "bg-foreground/45 animate-pulse motion-reduce:animate-none",
    offline: "bg-foreground/25",
  }[state];
  return <span role="img" aria-label={BOX_WORDS[state].word} className={cn("inline-block size-1.5 shrink-0 rounded-full", tone)} />;
}

// footActions are the foot's menu: each box as a submenu of what it
// offers, then adding one.
function footActions(list: BoxStatus[]): Action[] {
  const st = useStore.getState();
  return [
    ...list.map((b): Action => ({ type: "sub", label: b.name, icon: b.state === "online" ? <ServerIcon /> : <ServerOffIcon />, items: boxActions(b) })),
    ...(list.length ? [{ type: "sep" } as Action] : []),
    { type: "item", label: "Add a box…", icon: <PlusIcon />, run: openAddBox },
    { type: "item", label: "Settings › Boxes", icon: <SettingsIcon />, run: () => st.setView({ kind: "settings", section: "boxes" }) },
  ];
}

// BoxesTip is the foot's tip: a line per box with its state and how busy
// it is, and the route Shipyard reaches it by.
function BoxesTip({ list, states }: { list: BoxStatus[]; states: BoxState[] }) {
  return (
    <span className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-0.5">
      {list.map((b, i) => {
        const online = b.state === "online";
        const load = online ? boxLoad(b.name, { cpu: true }) : "";
        const route = online ? viaRoute(b) : undefined;
        return (
          <span key={b.name} data-testid="boxes-tip-line" className="contents">
            <span className="flex items-center gap-1.5 font-medium">
              <BoxDot state={states[i]} />
              {b.name}
            </span>
            <span className="text-muted-foreground">{online ? BOX_WORDS[states[i]].lower : awayText(b)}</span>
            <span className="text-muted-foreground tabular-nums">{[load, route].filter(Boolean).join(" · ")}</span>
          </span>
        );
      })}
    </span>
  );
}

// BoxesFoot is the sidebar's foot: one quiet line, a dot for each box and
// which are online. A click opens Settings → Boxes; its tip says how each
// box is, and its ⋯ (or a right-click) holds each box's actions.
export function BoxesFoot() {
  const status = useStore((s) => s.status);
  const boxes = useStore((s) => s.boxes);
  const outdated = useOutdatedBoxes();
  const list = status?.boxes ?? [];
  const states = list.map((b) => boxState(b, boxes[b.name], outdated.includes(b.name)));
  const line = boxesLine(list.map((b) => ({ name: b.name, online: b.state === "online" })));
  const slow = list.filter((b) => b.state === "online" && b.link?.slow);
  const items = () => footActions(useStore.getState().status?.boxes ?? []);
  return (
    <ContextRow items={items} className="group/foot relative flex h-full min-w-0 flex-1 items-center rounded-lg">
      <Tip side="top" align="start" label={list.length ? <BoxesTip list={list} states={states} /> : "Add a box in Settings → Boxes"}>
        <button
          type="button"
          data-testid="sidebar-boxes"
          onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })}
          className={cn("flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-desc outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring", ink.faint)}
        >
          {states.length > 0 && (
            <span className="flex shrink-0 items-center gap-1">
              {states.slice(0, 6).map((st, i) => (
                <BoxDot key={list[i].name} state={st} />
              ))}
            </span>
          )}
          <span className="min-w-0 truncate">{line}</span>
          {/* A slow link is still online: said in the line's own ink. */}
          {slow.length > 0 && (
            <span data-testid="boxes-slow" className="shrink-0">
              · {slow.length === 1 && list.length > 1 ? `${slow[0].name} slow` : "slow"}
            </span>
          )}
        </button>
      </Tip>
      {list.length > 0 && (
        <Menu>
          <Tip label="Boxes" side="top">
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Box actions"
                  className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/foot:opacity-100 data-popup-open:bg-sidebar-accent data-popup-open:opacity-100 [&_svg]:size-3.5",
                    ink.glyph,
                  )}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
          </Tip>
          <MenuPopup side="top" align="start" className="min-w-52">
            <ActionItems items={items} />
          </MenuPopup>
        </Menu>
      )}
    </ContextRow>
  );
}
