import { ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, GitBranchIcon, HouseIcon, InboxIcon, SquarePenIcon } from "lucide-react";
import { useReviewCount } from "@/views/review/review-store";
import { showCommandKeys } from "@/components/command/hint-layer";
import { useEffect, useMemo, useRef, useState } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { NotificationBell } from "@/components/notifications/notification-center";
import { useNavItems } from "@/components/sidebar/nav";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { type SessionEntry, useAgentCounts, useAllSessions } from "@/hooks/use-agent-counts";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/ui/preview-card";
import { AskActions } from "@/components/command/switcher";
import { useScreenTail } from "@/views/dashboard/use-screen-tail";
import { runShortcut } from "@/hooks/use-shortcuts";
import { hasTrafficLights } from "@/lib/api";
import { markSeen, setViewSlot, step, useCommandNav, useKnown, useSeen, waitKey } from "@/lib/command-nav";
import { agentOf, type SessionState, sessionState, worktreeOf } from "@/lib/derive";
import { ago } from "@/lib/format";
import { leaves } from "@/lib/layout";
import { usePrefs } from "@/lib/prefs";
import { AGENT_WORDS, sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession, homeBox, useHereKey, useHereRef, useWorkspaces } from "@/lib/workspaces";
import { useTitleAt, worktreeLabel } from "@/lib/worktree-names";

// The command layout's one line across the top (Labs › Layout › Command):
// where you are, which opens the switcher (⌘K), and how the agents are
// doing, which says when one needs you. In a worktree it shares the line
// with the worktree's tabs (TabStrip's lead and trail); on Home and the
// other views it stands alone above them.

const openSwitcher = () => useStore.getState().setPaletteOpen(true);

// useFocusedState is the state of the agent in the focused pane, if any.
function useFocusedState(): SessionState | undefined {
  const ws = useWorkspaces((s) => (s.current ? s.spaces[s.current] : undefined));
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  const c = tab ? leaves(tab.root).find((l) => l.id === tab.focus)?.content : undefined;
  return useStore((s) => {
    if (c?.kind !== "terminal") return undefined;
    const session = s.boxes[c.box]?.sessions?.find((x) => x.name === c.session);
    return session ? sessionState(session, s.boxes[c.box]?.stats) : undefined;
  });
}

// BackForward are ⌘[ and ⌘], as buttons for the mouse and to teach the keys.
function BackForward() {
  const back = useCommandNav((s) => s.back.length > 0);
  const forward = useCommandNav((s) => s.forward.length > 0);
  const btn = "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 items-center">
      <Tip label={<KeyTip what="Back" keys="⌘[" />} side="bottom">
        <button type="button" aria-label="Back" disabled={!back} onClick={() => step(-1)} className={btn}>
          <ChevronLeftIcon className="size-4" />
        </button>
      </Tip>
      <Tip label={<KeyTip what="Forward" keys="⌘]" />} side="bottom">
        <button type="button" aria-label="Forward" disabled={!forward} onClick={() => step(1)} className={btn}>
          <ChevronRightIcon className="size-4" />
        </button>
      </Tip>
    </div>
  );
}

export function KeyTip({ what, keys }: { what: React.ReactNode; keys: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {what} <Kbd>{keys}</Kbd>
    </span>
  );
}

// Where names what the window shows, and opens the switcher.
function Where({ compact }: { compact?: boolean }) {
  const view = useStore((s) => s.view);
  const nav = useNavItems();
  const key = useHereKey();
  const ref = useHereRef();
  const title = useTitleAt(ref?.box, ref?.path);
  const state = useFocusedState();
  const pins = usePrefs((p) => p.pins);
  const current = useWorkspaces((s) => s.current);
  const pin = current ? pins.indexOf(current) + 1 : 0;
  const knownK = useKnown("palette");
  const knownPin = useKnown("pinned");
  let body: React.ReactNode;
  if (view.kind === "workspace" && ref && key && !homeBox(key)) {
    body = (
      <>
        {state && state !== "idle" && state !== "ready" ? <StateGlyph state={state} className="size-3.5" /> : <GitBranchIcon className="size-3.5 text-muted-foreground" />}
        <span className="min-w-0 truncate">
          {!compact && <span className="text-muted-foreground">{ref.location}</span>}
          {!ref.main && (
            <>
              {!compact && <span className="px-1 text-muted-foreground/60">/</span>}
              <span className="font-medium">{title ?? ref.worktree}</span>
            </>
          )}
          {ref.main && compact && <span className="font-medium">{ref.location}</span>}
        </span>
        {!compact && <span className="shrink-0 rounded bg-accent/70 px-1 py-px font-mono text-[10px] text-muted-foreground">{ref.box}</span>}
        {pin > 0 && knownK && !knownPin && !compact && (
          <Kbd aria-label={`Pinned to ⌘${pin}`} className="h-4.5 shrink-0 text-[10px] text-foreground/70">
            ⌘{pin}
          </Kbd>
        )}
      </>
    );
  } else if (view.kind === "workspace") {
    body = (
      <>
        <HouseIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Home</span>
      </>
    );
  } else {
    const item = nav.find((n) => n.active);
    const label = view.kind === "settings" ? "Settings" : view.kind === "project" ? `${view.location} settings` : (item?.label ?? "Shipyard");
    body = (
      <>
        {item?.icon && <span className="flex size-3.5 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{item.icon}</span>}
        <span className="font-medium">{label}</span>
      </>
    );
  }
  return (
    <Tip label={<KeyTip what="Switch to anything" keys="⌘K" />} side="bottom">
      <button
        type="button"
        data-testid="command-where"
        aria-label="Where you are. Open the switcher"
        aria-keyshortcuts="Meta+K"
        onClick={openSwitcher}
        className="flex h-7 min-w-0 max-w-80 items-center gap-1.5 rounded-lg border border-border/70 bg-background/60 px-2 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
        {/* Until ⌘K is known, the button says it; then a quiet chevron. */}
        {knownK || compact ? <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" /> : <Kbd className="h-4.5 shrink-0 text-[10px] text-foreground/70">⌘K</Kbd>}
      </button>
    </Tip>
  );
}

// CommandLead is the line's left: room for the window's buttons, back and
// forward, and where you are.
export function CommandLead({ compact, divider }: { compact?: boolean; divider?: boolean }) {
  return (
    <div data-tauri-drag-region className={cn("flex min-w-0 shrink-0 items-center gap-0.5 pr-2", divider && "mr-px border-r", hasTrafficLights() ? "pl-[80px]" : "pl-2")}>
      <BackForward />
      <Where compact={compact} />
      <Summary compact={compact} />
    </div>
  );
}

// Summary is the agents at a glance, beside where you are: how many need
// you, how many work. A click opens the switcher; hovering peeks at them
// without covering the work. When one more needs you it glows a moment, the
// window's top edge with it, and it stays lit until you've looked: gone to
// the agent, or opened the switcher.
function Summary({ compact }: { compact?: boolean }) {
  const counts = useAgentCounts();
  const all = useAllSessions();
  const waiting = useMemo(() => all.filter((e) => e.state === "waiting" && agentOf(e.session)).sort((a, b) => (a.session.state_since ?? "").localeCompare(b.session.state_since ?? "")), [all]);
  const working = useMemo(() => all.filter((e) => e.state === "running" && agentOf(e.session)), [all]);
  const seenKeys = useSeen((s) => s.keys);
  const unseen = waiting.filter((e) => !seenKeys.has(waitKey(e.box, e.session))).length;
  const paletteOpen = useStore((s) => s.paletteOpen);
  const focused = useFocusedSession();
  // Looked at: everything waiting once the switcher opens, and the agent in
  // front once it's the one you're on.
  useEffect(() => {
    if (paletteOpen) markSeen(waiting.map((e) => waitKey(e.box, e.session)));
  }, [paletteOpen, waiting]);
  useEffect(() => {
    const e = focused && waiting.find((w) => w.box === focused.box && w.session.name === focused.name);
    if (e) markSeen([waitKey(e.box, e.session)]);
  }, [focused, waiting]);

  const [glow, setGlow] = useState(false);
  const [tip, setTip] = useState(false);
  const seen = useRef(counts.waiting);
  // What is already waiting as the window opens is not news.
  const since = useRef(Date.now());
  useEffect(() => {
    const more = counts.waiting > seen.current && Date.now() - since.current > 4000;
    seen.current = counts.waiting;
    if (!more) return;
    setGlow(true);
    // The first time, it says which key takes you there.
    const teach = !usePrefs.getState().commandTips.includes("next-waiting");
    if (teach) {
      setTip(true);
      usePrefs.setState((p) => ({ commandTips: [...p.commandTips, "next-waiting"] }));
    }
    const t = window.setTimeout(() => setGlow(false), 2600);
    const u = window.setTimeout(() => setTip(false), 8000);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(u);
    };
  }, [counts.waiting]);
  // The agent in front isn't news: the pill counts the others ("1 more").
  const here = focused ? waiting.some((w) => w.box === focused.box && w.session.name === focused.name) : false;
  const need = counts.waiting - (here ? 1 : 0);
  const knownE = useKnown("next-waiting");
  // One keycap on the line at a time: ⌘K is taught first, then ⌘E.
  const knownK = useKnown("palette");
  const toReview = useReviewCount();
  const lit = unseen > 0;
  const quiet = need <= 0 && !counts.running;
  return (
    <span className="relative flex shrink-0">
      <span aria-hidden data-testid="command-glow" data-on={glow || undefined} className={cn("pointer-events-none fixed inset-x-0 top-0 z-40 h-0.5 bg-warning opacity-0 shadow-[0_0_18px_3px] shadow-warning/50 transition-opacity duration-700", glow && "opacity-100")} />
      <PreviewCard>
        <PreviewCardTrigger
          delay={350}
          render={
            <button
              type="button"
              data-testid="command-summary"
              data-unseen={unseen || undefined}
              onClick={openSwitcher}
              aria-label={`${need} ${AGENT_WORDS["needs-you"].lower}${unseen ? ` (${unseen} new)` : ""}, ${counts.running} ${AGENT_WORDS.working.lower}. Open the switcher`}
              className={cn(
                "relative flex h-6.5 shrink-0 items-center gap-1.5 rounded-full border border-border/70 px-2.5 text-xs tabular-nums outline-none transition-[background-color,box-shadow] duration-500 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                need ? "text-foreground" : "text-muted-foreground",
                lit && "border-warning/50 bg-warning/10",
                glow && "bg-warning/16 ring-warning/70",
              )}
            />
          }
        >
          {need > 0 && (
            <span className="flex items-center gap-1.5 text-warning-foreground dark:text-warning">
              <span className={cn("size-1.5 rounded-full bg-warning", glow && "motion-safe:animate-pulse")} />
              {need} {here ? "more " : ""}
              {AGENT_WORDS["needs-you"].lower}
            </span>
          )}
          {need > 0 && counts.running > 0 && !compact && <span className="text-muted-foreground/50">·</span>}
          {counts.running > 0 && !(compact && need > 0) && (
            <span className="flex items-center gap-1.5">
              <StateGlyph state="running" className="size-3" />
              {counts.running}
              {!compact && ` ${AGENT_WORDS.working.lower}`}
            </span>
          )}
          {quiet && <span>{here ? "This one needs you" : "All quiet"}</span>}
          {toReview > 0 && !compact && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-muted-foreground">{toReview} to review</span>
            </>
          )}
          {need > 0 && knownK && !knownE && !compact && <Kbd className="ml-0.5 h-4.5 text-[10px] text-foreground/70">⌘E</Kbd>}
        </PreviewCardTrigger>
        <PreviewCardPopup align="start" className="w-[26rem] p-0" data-testid="command-peek">
          <AgentPeek waiting={waiting} working={working} all={all} toReview={toReview} />
        </PreviewCardPopup>
      </PreviewCard>
      {tip && (
        <span role="status" data-testid="command-tip" className="pointer-events-none absolute top-full left-0 z-50 mt-1.5 flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-warning/40 bg-popover px-2.5 py-1.5 text-popover-foreground text-xs shadow-lg/10">
          Something needs you: <Kbd>⌘E</Kbd> takes you there
        </span>
      )}
    </span>
  );
}

// AgentPeek is the summary's hover card: who needs you, then who works, a
// click away, without leaving or covering what you're on.
function AgentPeek({ waiting, working, all, toReview }: { waiting: SessionEntry[]; working: SessionEntry[]; all: SessionEntry[]; toReview: number }) {
  const boxes = useStore((s) => s.boxes);
  // Every project's agents as dots, by state: the fleet at a glance.
  const projects = useMemo(() => {
    const by = new Map<string, { label: string; agents: SessionEntry[] }>();
    for (const e of all) {
      if (!agentOf(e.session) || !["waiting", "running", "finished", "ready"].includes(e.state)) continue;
      const at = worktreeOf(boxes[e.box]?.locations, e.session);
      const k = `${at?.location.name ?? "?"} · ${e.box}`;
      const p = by.get(k) ?? { label: k, agents: [] };
      p.agents.push(e);
      by.set(k, p);
    }
    const rank: Record<string, number> = { waiting: 0, running: 1, finished: 2, ready: 3 };
    return [...by.values()].map((p) => ({ ...p, agents: p.agents.sort((a, b) => rank[a.state] - rank[b.state]) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [all, boxes]);
  const row = (e: SessionEntry) => <PeekRow key={`${e.box}/${e.session.name}`} e={e} place={placeOf(e)} />;
  const placeOf = (e: SessionEntry) => {
    const at = worktreeOf(boxes[e.box]?.locations, e.session);
    return at ? (at.worktree.main ? at.location.name : `${at.location.name} / ${worktreeLabel(at.worktree)}`) : e.session.name;
  };
  return (
    <div className="flex w-full flex-col p-1.5">
      {waiting.length > 0 && <div className="px-2 pt-1 pb-0.5 font-medium text-[11px] text-muted-foreground">{sessionWord("waiting")} · {waiting.length}</div>}
      {waiting.slice(0, 5).map(row)}
      {working.length > 0 && <div className="px-2 pt-2 pb-0.5 font-medium text-[11px] text-muted-foreground">{sessionWord("running")} · {working.length}</div>}
      {working.slice(0, 5).map(row)}
      {!waiting.length && !working.length && <div className="px-2 py-3 text-muted-foreground text-xs">Nothing needs you and nothing is working.</div>}
      {toReview > 0 && (
        <button type="button" onClick={() => useStore.getState().setView({ kind: "review" })} className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <InboxIcon className="size-3.5 text-muted-foreground" />
          <span className="flex-1">{toReview} to review</span>
          <span className="text-muted-foreground text-xs">Review</span>
        </button>
      )}
      {projects.length > 0 && (
        <div data-testid="peek-projects" className="mt-1 flex flex-col gap-1 border-t px-2 pt-2">
          {projects.map((p) => (
            <div key={p.label} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate text-muted-foreground">{p.label}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {p.agents.map((e) => (
                  <Tip key={`${e.box}/${e.session.name}`} label={`${e.session.title?.trim() || placeOf(e)} · ${sessionWord(e.state)}`} side="bottom">
                    <button type="button" aria-label={`${e.session.title?.trim() || placeOf(e)}: ${sessionWord(e.state)}`} onClick={() => void focusSession(e.box, e.session.name)} className="flex size-4 items-center justify-center rounded outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                      <StateGlyph state={e.state} className="size-3" />
                    </button>
                  </Tip>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3 border-t px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>⌘E</Kbd> next that needs you
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘K</Kbd> everything
        </span>
        <button type="button" onClick={showCommandKeys} className="ml-auto rounded px-1 hover:text-foreground">
          All keys
        </button>
      </div>
    </div>
  );
}

// PeekRow is one agent in the peek: what it asks, with Allow once and Deny
// right there; or for one working, the last thing on its screen.
function PeekRow({ e, place }: { e: SessionEntry; place: string }) {
  const ask = e.state === "waiting" ? e.session.ask : undefined;
  const { tail } = useScreenTail(e.box, e.session, 1, false, e.state === "running");
  const line = e.state === "running" ? tail?.[0] : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <button type="button" onClick={() => void focusSession(e.box, e.session.name)} className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StateGlyph state={e.state} className="size-3" />
        <span className="min-w-0 flex-1 truncate">{e.session.title?.trim() || place}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{ago(e.session.state_since ?? e.session.created).replace(" ago", "")}</span>
      </button>
      <span className="flex min-w-0 flex-col items-stretch gap-1 pl-5 text-[11px] text-muted-foreground">
        <span className={cn("min-w-0", ask ? "line-clamp-3 [overflow-wrap:anywhere]" : "truncate")}>
          {ask?.input || ask?.message ? <span className="font-mono">{`${ask.tool ? `${ask.tool}: ` : ""}${ask.input ?? ask.message}`}</span> : line ? <span className="font-mono">{line}</span> : `${place} · ${e.box}`}
        </span>
        {e.state === "waiting" && (
          <span className="flex justify-end">
            <AskActions e={e} keys={false} />
          </span>
        )}
      </span>
    </div>
  );
}

// useFocusedSession is the agent in the focused pane, by box and name.
function useFocusedSession(): { box: string; name: string } | undefined {
  const ws = useWorkspaces((s) => (s.current ? s.spaces[s.current] : undefined));
  const workspace = useStore((s) => s.view.kind === "workspace");
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  const c = tab ? leaves(tab.root).find((l) => l.id === tab.focus)?.content : undefined;
  return useMemo(() => (workspace && c?.kind === "terminal" ? { box: c.box, name: c.session } : undefined), [workspace, c]);
}

// CommandTrail is the line's right: a new task, and the bell.
export function CommandTrail({ compact }: { compact?: boolean }) {
  return (
    <div data-tauri-drag-region className="flex shrink-0 items-center gap-1 pr-2 pl-1">
      <Tip label={<KeyTip what="New task: an agent in a new worktree" keys="⌘N" />} side="bottom">
        <button
          type="button"
          aria-label="New task"
          onClick={() => runShortcut("new-worktree", "menu")}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SquarePenIcon className="size-3.5" />
          {!compact && "New task"}
        </button>
      </Tip>
      <NotificationBell />
    </div>
  );
}

// CommandBar stands alone on Home and the views: the same line without tabs.
export function CommandBar({ compact }: { compact?: boolean }) {
  return (
    <header data-tauri-drag-region data-testid="command-bar" className="flex h-10 shrink-0 items-center border-b bg-sidebar">
      <CommandLead compact={compact} />
      {/* A view's own header (views/view-header.tsx) moves up into the line. */}
      <div data-tauri-drag-region ref={(el) => {
        setViewSlot(el);
      }} className="flex min-w-4 flex-1 items-center justify-end gap-3 self-stretch overflow-hidden px-2" />
      <CommandTrail compact={compact} />
    </header>
  );
}
