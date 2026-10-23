import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { ArchiveIcon, ArrowLeftRightIcon, BotIcon, CloudOffIcon, FileDiffIcon, GitCompareArrowsIcon, GlobeIcon, Link2Icon, Link2OffIcon, MessagesSquareIcon, SquareTerminalIcon, XIcon, LayoutGridIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/use-media-query";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { useLabel, useNarrow, useTone } from "@/components/workspace/worktree-tone";
import { agentPresets, startSession } from "@/lib/actions";
import { focusedSide, LANE_LABEL, LANES, type Lane, type SideState, shownSides, sides } from "@/lib/compare";
import { closeCompare, setCompareLane, setCompareSync, swapCompare, useLoadTimes } from "@/lib/compare-actions";
import { sessionState } from "@/lib/derive";
import { exec } from "@/lib/orchestrate";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusPane, leadAgent, splitKey, useWorkspaces, useWorktreeRef, type WsTab } from "@/lib/workspaces";
import { platformKeys } from "@/lib/platform";

// The Compare tab's chrome (lib/compare.ts): one bar over its two panes,
// with each side's worktree, its agent's state and what it changed, the
// lanes, the hinge that swaps the sides, and Sync. The panes themselves are
// PaneLayer's, so they keep running as lanes and tabs change.

// The bar's height: PaneLayer lays the panes out below it.
export const COMPARE_BAR = 40;

const LANE_ICON: Record<Lane, typeof GlobeIcon> = { chat: MessagesSquareIcon, diff: FileDiffIcon, preview: GlobeIcon, terminal: SquareTerminalIcon, artifacts: LayoutGridIcon };

const SYNC_HELP: Record<Lane, string> = {
  chat: "Scrolling one chat takes the other to the same turn",
  diff: "Scrolling one diff takes the other to the same file",
  preview: "A page opened on one side opens at the same path on the other",
  terminal: "Terminals don't sync; the other lanes do",
  artifacts: "Each side's board of what its agents made",
};

const TINY = "(max-width: 799px)";

// sideStateOf is whether a side's worktree can show: "away" while its box
// is offline, "gone" once its box no longer lists it (archived or removed).
export function sideStateOf(key: string, st: Pick<ReturnType<typeof useStore.getState>, "status" | "boxes">): SideState {
  const { box, path } = splitKey(key);
  if (st.status && st.status.boxes.find((b) => b.name === box)?.state !== "online") return "away";
  const locs = st.boxes[box]?.locations;
  if (locs && !locs.some((l) => l.worktrees?.some((w) => w.path === path))) return "gone";
  return "ok";
}

// useSideStates is sideStateOf for each of keys, kept current.
export function useSideStates(keys: string[]): SideState[] {
  const joined = useStore((s) => keys.map((k) => sideStateOf(k, s)).join(","));
  return useMemo(() => (joined ? (joined.split(",") as SideState[]) : []), [joined]);
}

export const useSideState = (key: string): SideState => useSideStates([key])[0] ?? "ok";

// useCompareShown is which of a Compare tab's sides show: one alone when
// the other is gone or away.
export function useCompareShown(tab: WsTab): [boolean, boolean] {
  const [a, b] = useSideStates(tab.compare ? [tab.compare.a, tab.compare.b] : []);
  return tab.compare ? shownSides([a ?? "ok", b ?? "ok"]) : [true, true];
}

// useCompareTitle is a Compare tab's name in the strip, "a ⇄ b".
export function useCompareTitle(tab: WsTab): string | undefined {
  const { label: a } = useLabel(tab.compare?.a);
  const { label: b } = useLabel(tab.compare?.b);
  return tab.compare ? `${a} ⇄ ${b}` : undefined;
}

export const CompareIcon = GitCompareArrowsIcon;

interface Stat {
  files: number;
  added: number;
  removed: number;
}

// parseShortstat reads git diff --shortstat: "3 files changed, 10
// insertions(+), 2 deletions(-)", or nothing for no change.
export function parseShortstat(out: string): Stat {
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?\(\+\)/), removed: n(/(\d+) deletions?\(-\)/) };
}

// What a branch changed since it left the default branch, uncommitted work
// included: what the Diff panel's "All" shows, in numbers.
const STAT = `m=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null) && git diff --shortstat "$m" # berth-compare-stat`;

function useDiffStat(key: string, on: boolean): Stat | undefined {
  const ref = useWorktreeRef(key);
  const [stat, setStat] = useState<Stat>();
  const where = ref ? (ref.main ? ref.location : `${ref.location}/${ref.worktree}`) : undefined;
  useEffect(() => {
    if (!on || !ref || !where) return;
    const ac = new AbortController();
    const look = () =>
      exec(ref.box, where, STAT, "15s", ac.signal).then(
        (r) => r.exit_code === 0 && setStat(parseShortstat(r.output)),
        () => undefined,
      );
    void look();
    const t = window.setInterval(() => !document.hidden && void look(), 30_000);
    return () => {
      ac.abort();
      window.clearInterval(t);
    };
  }, [on, ref?.box, where]); // eslint-disable-line react-hooks/exhaustive-deps
  return stat;
}

function useAgentState(key: string) {
  const { box } = splitKey(key);
  return useStore((s) => {
    const name = leadAgent(key);
    const x = name ? s.boxes[box]?.sessions?.find((y) => y.name === name) : undefined;
    return x ? sessionState(x, s.boxes[box]?.stats) : undefined;
  });
}

const btn = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-meta outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar";

export function CompareBar({ wsKey, tab }: { wsKey: string; tab: WsTab }) {
  const c = tab.compare!;
  const narrow = useNarrow();
  const tiny = useMediaQuery(TINY);
  const shown = useCompareShown(tab);
  const pair = sides(tab);
  const focused = focusedSide(tab);
  const { label: la } = useLabel(c.a);
  const { label: lb } = useLabel(c.b);
  const t0 = useLoadTimes((s) => (pair ? s[pair[0].id] : undefined));
  const t1 = useLoadTimes((s) => (pair ? s[pair[1].id] : undefined));
  const times = [t0, t1];
  const ms = times.map((t) => (t?.since ? undefined : t?.ms));
  // Faster only by enough to matter: a fifth, and 20 ms.
  const faster = ms[0] !== undefined && ms[1] !== undefined && Math.abs(ms[0] - ms[1]) > Math.max(20, 0.2 * Math.max(ms[0], ms[1])) ? (ms[0] < ms[1] ? 0 : 1) : undefined;
  const alone = !shown[0] || !shown[1];
  // The side that can't show hands the focus, and with it here, to the other.
  const handTo = pair && !shown[focused] && shown[1 - focused] ? pair[1 - focused].id : undefined;
  useEffect(() => {
    if (handTo) focusPane(wsKey, tab.id, handTo);
  }, [handTo, wsKey, tab.id]);
  if (!pair) return null;
  const Sync = c.sync ? Link2Icon : Link2OffIcon;
  return (
    <ToolbarPrimitive.Root
      aria-label={`Compare ${la} and ${lb}`}
      data-compare-bar
      className="absolute inset-x-0 top-0 z-10 grid items-center gap-2 border-b bg-sidebar px-edge"
      style={{ height: COMPARE_BAR, gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)" }}
    >
      <Side wsKey={wsKey} tab={tab} i={0} pane={pair[0].id} focused={focused === 0} shown={shown[0]} other={lb} stats={!narrow} preview={c.lane === "preview"} tiny={tiny} ms={times[0]} faster={faster === 0} />
      <div className="flex items-center gap-1">
        <ToolbarPrimitive.Group aria-label="Lanes" className="flex items-center gap-0.5 rounded-lg bg-background/60 p-0.5">
          {LANES.map((l, n) => {
            const Icon = LANE_ICON[l];
            const on = c.lane === l;
            return (
              <Tip key={l} label={<Keys label={`${LANE_LABEL[l]} lane`} keys={`⌥${n + 1}`} />} side="bottom">
                <ToolbarPrimitive.Button
                  aria-pressed={on}
                  aria-label={`${LANE_LABEL[l]} lane`}
                  onClick={() => setCompareLane(wsKey, tab.id, l)}
                  className={cn(btn, on ? "bg-background text-foreground shadow-xs/5" : "text-muted-foreground hover:text-foreground")}
                >
                  <Icon className="size-3.5" />
                  {!tiny && LANE_LABEL[l]}
                </ToolbarPrimitive.Button>
              </Tip>
            );
          })}
        </ToolbarPrimitive.Group>
        {/* With one side showing, there is nothing to swap or sync. */}
        {!alone && (
          <>
            <Tip label={<Keys label="Swap sides" keys={keysFor("compare-swap")} />} side="bottom">
              <ToolbarPrimitive.Button aria-label={`Swap sides: ${lb} on the left`} onClick={() => swapCompare(wsKey, tab.id)} className={cn(btn, "w-7 justify-center px-0 text-muted-foreground hover:bg-accent hover:text-foreground")}>
                <ArrowLeftRightIcon className="size-3.5" />
              </ToolbarPrimitive.Button>
            </Tip>
            <Tip label={c.sync ? SYNC_HELP[c.lane] : "The two sides move on their own"} side="bottom">
              <ToolbarPrimitive.Button
                aria-pressed={c.sync}
                aria-label="Sync the two sides"
                onClick={() => setCompareSync(wsKey, tab.id, !c.sync)}
                className={cn(btn, c.sync ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
              >
                <Sync className="size-3.5" />
                {!tiny && "Sync"}
              </ToolbarPrimitive.Button>
            </Tip>
          </>
        )}
      </div>
      <Side wsKey={wsKey} tab={tab} i={1} pane={pair[1].id} focused={focused === 1} shown={shown[1]} other={la} stats={!narrow} preview={c.lane === "preview"} tiny={tiny} ms={times[1]} faster={faster === 1} />
    </ToolbarPrimitive.Root>
  );
}

function Keys({ label, keys }: { label: string; keys: string }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      <span className="text-muted-foreground">{platformKeys(keys)}</span>
    </span>
  );
}

interface SideProps {
  wsKey: string;
  tab: WsTab;
  i: 0 | 1;
  pane: string;
  focused: boolean;
  shown: boolean;
  // The other side's name, for the notice when this one can't show.
  other: string;
  stats: boolean;
  // The Preview lane: the page's load time in place of the diff's numbers.
  preview: boolean;
  // A tiny window: the chip alone.
  tiny: boolean;
  ms?: { since?: number; ms?: number };
  faster: boolean;
}

// Side is one side of the bar: its worktree's chip, which focuses its pane,
// then its agent's state and what it changed (the page's load time in
// Preview). A side that is gone or away says so, and the other fills the
// tab.
function Side({ wsKey, tab, i, pane, focused, shown, other, stats, preview, tiny, ms, faster }: SideProps) {
  const c = tab.compare!;
  const key = i === 0 ? c.a : c.b;
  const tone = useTone(key) ?? "var(--foreground)";
  const { label, ref } = useLabel(key);
  const state = useSideState(key);
  const agent = useAgentState(key);
  const stat = useDiffStat(key, shown && stats);
  const right = i === 1;
  const where = right ? "right" : "left";
  if (!shown) {
    const Icon = state === "gone" ? ArchiveIcon : CloudOffIcon;
    const why = state === "gone" ? `${label} was archived` : `${ref?.box ?? splitKey(key).box} is offline`;
    return (
      <div role="status" className={cn("-m-1 flex min-w-0 items-center gap-2 overflow-hidden p-1 text-muted-foreground text-meta", right && "justify-end")}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <Tip label={`${why}, so ${other} shows alone. Pick another worktree to compare it with, or close the tab.`} side="bottom">
          <span className="truncate">{why}</span>
        </Tip>
        <span className="sr-only">, so {other} shows alone</span>
        <ToolbarPrimitive.Button className={cn(btn, "text-foreground hover:bg-accent")} onClick={() => openWorktreePicker({ kind: "compare", from: i === 0 ? c.b : c.a, replace: { key: wsKey, tab: tab.id } })}>
          Compare with…
        </ToolbarPrimitive.Button>
        <Tip label="Close this Compare tab" side="bottom">
          <ToolbarPrimitive.Button aria-label="Close this Compare tab" className={cn(btn, "w-7 justify-center px-0 hover:bg-accent hover:text-foreground")} onClick={() => closeCompare(wsKey, tab.id)}>
            <XIcon className="size-3.5" />
          </ToolbarPrimitive.Button>
        </Tip>
      </div>
    );
  }
  const chip = (
    <Tip label={ref ? `${label} on ${ref.box} · ${ref.path}` : label} side="bottom" align={right ? "end" : "start"}>
      <ToolbarPrimitive.Button
        aria-label={`${label}, ${where} side${focused ? ", focused" : ""}${state === "away" ? `, ${ref?.box} is offline` : ""}`}
        aria-pressed={focused}
        onClick={() => focusPane(wsKey, tab.id, pane)}
        className={cn(btn, "h-6 min-w-0 gap-1 px-1.5 font-medium text-tag", tiny ? "max-w-32" : "max-w-48")}
        style={focused ? { background: tone, color: "var(--background)" } : { background: `color-mix(in oklab, ${tone} 15%, transparent)`, color: tone }}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: focused ? "var(--background)" : tone }} />
        <span className="truncate">{label}</span>
        {/* Its box, unless its name already says it (the same repository on two). */}
        {ref && !tiny && !label.endsWith(` · ${ref.box}`) && <span className="shrink-0 font-mono text-tag">{ref.box}</span>}
      </ToolbarPrimitive.Button>
    </Tip>
  );
  const facts = (
    <>
      {agent && agent !== "idle" && agent !== "exited" && <StateGlyph state={agent} className="size-3" />}
      {preview ? (
        <Tip label="How long its page took to load, from asking to the load event" side="bottom">
          <span className={cn("shrink-0 tabular-nums", faster ? "text-success-foreground" : "text-muted-foreground")}>
            {ms?.since ? (
              <span className="flex items-center gap-1">
                <Spinner className="size-3" /> loading
              </span>
            ) : ms?.ms !== undefined ? (
              `${ms.ms.toLocaleString()} ms${faster ? " · faster" : ""}`
            ) : (
              "no page yet"
            )}
          </span>
        </Tip>
      ) : (
        stats &&
        stat && (
          <span className="min-w-0 truncate text-muted-foreground tabular-nums">
            {stat.files === 0 ? (
              "no changes"
            ) : (
              <>
                {stat.files} {stat.files === 1 ? "file" : "files"} · <span className="text-success-foreground">+{stat.added.toLocaleString()}</span> <span className="text-destructive-foreground">−{stat.removed.toLocaleString()}</span>
              </>
            )}
          </span>
        )
      )}
    </>
  );
  return (
    <div className={cn("-m-1 flex min-w-0 items-center gap-2 overflow-hidden p-1 text-meta", right && "flex-row-reverse")}>
      {chip}
      {tiny ? null : right ? <span className="flex min-w-0 flex-row-reverse items-center gap-2">{facts}</span> : facts}
    </div>
  );
}

// EmptySide stands in a Compare tab's side that has nothing to show: a
// worktree with no agent (it offers to start one there), or no Diff plugin.
export function EmptySide({ owner, tab, pane, label }: { owner: string; tab: string; pane: string; label: string }) {
  const ref = useWorktreeRef(owner);
  const { label: name } = useLabel(owner);
  const presets = useMemo(() => (ref ? agentPresets(ref.box, ref.location).slice(0, 3) : []), [ref]);
  if (label === "Diff")
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-body">
        <FileDiffIcon className="size-5 text-muted-foreground" />
        <p className="font-medium">The Diff plugin is off</p>
        <p className="max-w-xs text-muted-foreground text-meta">Turn it on in Settings → Plugins to compare the two diffs here.</p>
      </div>
    );
  const start = (command: string, what: string) => void startSession(command, { kind: "replace", tab, pane }, what, owner);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-body">
      <BotIcon className="size-5 text-muted-foreground" />
      <p className="font-medium">{name} has no agent running</p>
      <p className="max-w-xs text-muted-foreground text-meta">Start one here to compare its chat; its Diff and Preview lanes work without one.</p>
      <div className="flex flex-wrap justify-center gap-2">
        {presets.map((p) => (
          <Button key={p.id} size="sm" variant="outline" onClick={() => start(p.command, p.name)}>
            <AgentIcon agent={p.id} />
            {p.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => start("", "Terminal")}>
          <SquareTerminalIcon />
          Shell
        </Button>
      </div>
    </div>
  );
}

// useCompareTab is the Compare tab with id in workspace key, kept current.
export function useCompareTab(key: string, id: string): WsTab | undefined {
  return useWorkspaces((s) => s.spaces[key]?.tabs.find((t) => t.id === id && t.compare));
}
