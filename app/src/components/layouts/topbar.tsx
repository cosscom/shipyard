import { FolderIcon, FolderPlusIcon, GitBranchIcon, GitBranchPlusIcon, HouseIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { StateGlyph } from "@/components/agent-glyph";
import { type Lane, openItem, useItems } from "@/components/layouts/model";
import { MorePlaces, PlaceButton, SearchButton, SettingsButton, trafficPad, usePlaces } from "@/components/layouts/parts";
import { openSwitcher } from "@/components/layouts/switcher";
import { NotificationBell } from "@/components/notifications/notification-center";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Location, Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionState } from "@/lib/derive";
import { platformKeys } from "@/lib/platform";
import { useProjects } from "@/lib/project-groups";
import { load, save } from "@/lib/storage";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { goHome, homeBox, refOf, selectWorktree, useWorkspaces, type WorktreeRef, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";

// The top bar (Labs › Layout › Top bar) puts the way around across the top
// and gives the work the window's whole width, as a browser does:
//
//   ⌂  shop ⇅ │ [● checkout-fix] [✓ search-perf] [◌ evals / judge-v2] +    ● 2 need you ◌ 2 ✓ 5 ▦⌃⇥ │ Review 2 ⋯ │ ⌕ 🔔 ⚙
//
// Home; the project in front, which opens a switcher to any worktree of
// any project, by typing; the worktrees you have open, as tabs, each with
// its agents' state; how many agents need you, work and are done (a click
// goes to the one that has waited longest, or shows them); and the places.
// Under it the worktree's own tabs name the agent: project ▸ worktree ▸
// agent, top to bottom. ⌃⇥ shows every agent at once (switcher.tsx).

// ---- The open worktrees -------------------------------------------------

// The worktrees open as tabs, in the order they were opened, kept on this
// computer. A worktree joins when you go to it, however you got there, and
// leaves when its tab is closed (its agents carry on).
const KEY = "berth.layouts.topbar.tabs";
export const useTopTabs = create<{ keys: string[] }>()(() => ({ keys: load<string[]>(KEY, []) }));
useTopTabs.subscribe((s) => save(KEY, s.keys));

function closeTab(key: string) {
  const { keys } = useTopTabs.getState();
  const i = keys.indexOf(key);
  const rest = keys.filter((k) => k !== key);
  useTopTabs.setState({ keys: rest });
  if (useWorkspaces.getState().current !== key) return;
  // Closing the one in front shows its neighbour, as a browser does.
  const next = rest[Math.min(i, rest.length - 1)];
  const ref = next ? useWorkspaces.getState().spaces[next]?.ref : undefined;
  if (ref) selectWorktree(ref);
  else goHome();
}

const URGENCY: Partial<Record<SessionState, number>> = { waiting: 0, running: 1, finished: 2, ready: 3 };

// useWorktreeStates is each worktree's most urgent agent state, and the
// work of the agent that has it.
function useWorktreeStates(): Record<string, { state: SessionState; title?: string }> {
  const boxes = useStore((s) => s.boxes);
  return useMemo(() => {
    const out: Record<string, { state: SessionState; title?: string }> = {};
    for (const [box, d] of Object.entries(boxes)) {
      for (const s of d.sessions ?? []) {
        if (s.service || s.exited || !agentOf(s)) continue;
        const st = sessionState(s, d.stats);
        const key = wsKey(box, s.dir);
        if (URGENCY[st] === undefined) continue;
        if (out[key] === undefined || URGENCY[st]! < URGENCY[out[key].state]!) out[key] = { state: st, title: s.title?.trim() || out[key]?.title };
      }
    }
    return out;
  }, [boxes]);
}

// ---- The bar ------------------------------------------------------------

export function TopBar() {
  const current = useWorkspaces((s) => s.current);
  const workspace = useStore((s) => s.view.kind === "workspace");
  // Whatever brought a worktree to the front, it gets a tab.
  useEffect(() => {
    if (!current || homeBox(current)) return;
    const { keys } = useTopTabs.getState();
    if (!keys.includes(current)) useTopTabs.setState({ keys: [...keys, current] });
  }, [current]);
  const onHome = workspace && (!current || !!homeBox(current));
  const { home, pinned, more } = usePlaces();
  // Narrower, the places past Review fold into ⋯ rather than turn into
  // icons to guess at.
  // The tabs get the room. Review, the place people visit most, always
  // shows with its name and count; the other places do from 1600px, and
  // fold into ⋯ under it rather than turn into icons to guess at.
  const roomy = useMediaQuery({ min: 1600 });
  const hint = useMediaQuery({ min: 1280 });
  const shown = roomy ? pinned : pinned.filter((n) => n.id === "review");
  const folded = roomy ? more : [...pinned.filter((n) => n.id !== "review"), ...more];

  return (
    <header data-tauri-drag-region data-testid="topbar" aria-label="Top bar" className={cn("flex h-10 shrink-0 items-center gap-1 border-b bg-sidebar pr-2 text-sidebar-foreground", trafficPad())}>
      <Tip label="Home">
        <button
          type="button"
          data-testid="nav-home"
          aria-label="Home"
          aria-current={onHome ? "page" : undefined}
          onClick={home?.go ?? goHome}
          className={cn("relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", onHome && "bg-sidebar-accent text-foreground")}
        >
          <HouseIcon className="size-4" />
        </button>
      </Tip>
      <ProjectSwitcher />
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <WorktreeTabs />
      <div className="flex shrink-0 items-center gap-0.5 pl-2">
        <Agents wide={hint} />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <nav aria-label="Places" className="flex items-center gap-0.5">
          {shown.map((n) => (
            <PlaceButton key={n.id} n={n} />
          ))}
          <MorePlaces more={folded} />
        </nav>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        {roomy ? <SearchButton wide className="w-32" /> : <SearchButton />}
        <NotificationBell />
        <SettingsButton />
      </div>
    </header>
  );
}

// ---- What the agents are doing -----------------------------------------

// Agents counts the agents by what they need: those waiting on you (a
// click goes to the one that has waited longest), working and done (a
// click shows them all, as ⌃⇥ does).
function Agents({ wide }: { wide: boolean }) {
  const items = useItems();
  const count = (l: Lane) => items.filter((i) => i.lane === l).length;
  const waiting = items.filter((i) => i.lane === "waiting");
  const next = waiting.find((i) => !i.selected) ?? waiting[0];
  return (
    <div className="flex items-center gap-0.5">
      {next && (
        <Tip label={`Go to the agent that has waited longest: ${next.title}`}>
          <button
            type="button"
            data-testid="topbar-needs-you"
            onClick={() => openItem(next)}
            className="mr-0.5 inline-flex h-7 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 font-medium text-warning-foreground text-xs hover:bg-warning/20"
          >
            <span className="size-1.5 rounded-full bg-warning" />
            <span className="tabular-nums">{waiting.length}</span>
            need you
          </button>
        </Tip>
      )}
      <Tip label={<span className="flex items-center gap-1.5">Every agent at a glance: hold <Kbd>⌃</Kbd> and press <Kbd>⇥</Kbd> anywhere</span>}>
        <button
          type="button"
          aria-label={`Every agent: ${count("running")} working, ${count("finished")} done`}
          data-testid="topbar-switcher"
          onClick={openSwitcher}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-muted-foreground text-xs tabular-nums hover:bg-sidebar-accent hover:text-foreground"
        >
          <StateGlyph state="running" className="size-3" />
          {count("running")}
          {wide && " working"}
          {wide && <span aria-hidden className="text-muted-foreground/60">·</span>}
          <StateGlyph state="finished" className="size-3" />
          {count("finished")}
          {wide && " done"}
          {wide && <Kbd className="ml-0.5 h-4.5 text-[10px]">⌃⇥</Kbd>}
        </button>
      </Tip>
    </div>
  );
}

// ---- Go to any worktree -------------------------------------------------

interface Row {
  key: string;
  box: string;
  loc: Location;
  wt: Worktree;
  project: string;
  state?: SessionState;
  title?: string;
  spans: boolean;
}

// useRows is every worktree on every online box, by project, the ones
// with agents to see to first.
function useRows() {
  const { projects } = useProjects();
  const boxes = useStore((s) => s.boxes);
  const states = useWorktreeStates();
  return useMemo(() => {
    const groups: { name: string; rows: Row[]; waiting: number; working: number }[] = [];
    for (const p of projects) {
      const spans = new Set(p.members.map((m) => m.box.name)).size > 1;
      const rows: Row[] = [];
      for (const m of p.members) {
        if (m.box.state !== "online") continue;
        const loc = boxes[m.box.name]?.locations?.find((l) => l.name === m.loc.name) ?? m.loc;
        for (const wt of loc.worktrees ?? []) {
          const key = wsKey(m.box.name, wt.path);
          rows.push({ key, box: m.box.name, loc, wt, project: p.name, state: states[key]?.state, title: states[key]?.title, spans });
        }
      }
      const rank = (r: Row) => (r.state ? URGENCY[r.state]! : r.wt.main ? 4 : 5);
      rows.sort((a, b) => rank(a) - rank(b));
      if (rows.length) groups.push({ name: p.name, rows, waiting: rows.filter((r) => r.state === "waiting").length, working: rows.filter((r) => r.state === "running").length });
    }
    return groups;
  }, [projects, boxes, states]);
}

// ProjectSwitcher names the project in front and opens a list of every
// worktree of every project to go to, filtered as you type: one click and
// a few letters to anywhere. The boxes, online or not, are along its foot.
const useGoTo = create<{ open: boolean }>()(() => ({ open: false }));

function ProjectSwitcher() {
  const ref = useWorkspaces((s) => (s.current && !homeBox(s.current) ? s.spaces[s.current]?.ref : undefined));
  const open = useGoTo((s) => s.open);
  const setOpen = (o: boolean) => useGoTo.setState({ open: o });
  // ⌘E opens it from anywhere, a terminal included.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "e") return;
      e.preventDefault();
      e.stopPropagation();
      useGoTo.setState((s) => ({ open: !s.open }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="topbar-project"
            aria-label="Go to a worktree (⌘E)"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-sidebar-border bg-background/60 px-2 text-[13px] text-foreground/85 outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent data-popup-open:text-foreground"
          />
        }
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span>Projects</span>
        <Kbd className="h-4.5 text-[10px]">{platformKeys("⌘E")}</Kbd>
      </PopoverTrigger>
      <PopoverPopup aria-label="Go to a worktree" align="start" sideOffset={6} className="w-[27rem] max-w-[calc(100vw-2rem)] p-0 [&_[data-slot=popover-viewport]]:p-0">
        {open && <SwitcherList front={ref ? wsKey(ref.box, ref.path) : undefined} close={() => setOpen(false)} />}
      </PopoverPopup>
    </Popover>
  );
}

function SwitcherList({ front, close }: { front?: string; close(): void }) {
  const all = useRows();
  // The project in front first, the rest as they come.
  const frontProject = all.find((g) => g.rows.some((r) => r.key === front))?.name;
  const groups = frontProject ? [...all.filter((g) => g.name === frontProject), ...all.filter((g) => g.name !== frontProject)] : all;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const status = useStore((s) => s.status?.boxes ?? NONE);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (r: Row) => {
    const hay = `${r.project} ${r.wt.main ? "main" : worktreeLabel(r.wt)} ${r.wt.branch ?? ""} ${r.title ?? ""} ${r.box}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  // What needs you, from every project, heads the list; then the projects.
  const asks = groups.flatMap((g) => g.rows.filter((r) => r.state === "waiting"));
  const lists = [
    ...(asks.length ? [{ name: "Needs you", rows: asks, waiting: 0, working: 0, asks: true }] : []),
    ...groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.state !== "waiting"), asks: false })),
  ];
  const shown = lists.map((g) => ({ ...g, rows: g.rows.filter(match) })).filter((g) => g.rows.length);
  const open = new Set(useTopTabs((s) => s.keys));
  const flat = shown.flatMap((g) => g.rows);
  const go = (r: Row) => {
    close();
    selectWorktree(refOf(r.box, r.loc, r.wt));
  };
  // Opens on the worktree in front; typing starts from the top.
  useEffect(() => {
    // Enter goes somewhere: what needs you next, else the worktree before.
    const spaces = useWorkspaces.getState().spaces;
    const last = Object.entries(spaces)
      .filter(([k, w]) => k !== front && w.visitedAt && !homeBox(k))
      .sort((a, b) => (b[1].visitedAt ?? 0) - (a[1].visitedAt ?? 0))[0]?.[0];
    const ask = flat.findIndex((r) => r.state === "waiting" && r.key !== front);
    const i = q ? 0 : ask >= 0 ? ask : flat.findIndex((r) => r.key === last);
    setActive(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(flat.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      go(flat[active]);
    }
  };
  let index = -1;
  return (
    <div className="flex max-h-[min(34rem,calc(100vh-6rem))] flex-col">
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded
          aria-controls="goto-list"
          aria-activedescendant={flat[active] ? `goto-${active}` : undefined}
          placeholder="Go to a worktree or task…"
          aria-label="Go to a worktree or task"
          className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {/* The input keeps the keyboard; the list follows it (↑↓, ↵). The
          list takes focus too, so it scrolls from the keyboard. */}
      <div ref={list} id="goto-list" role="listbox" aria-label="Worktrees" tabIndex={0} onKeyDown={(e) => onKeyDown(e as unknown as KeyboardEvent<HTMLInputElement>)} className="min-h-0 flex-1 overflow-y-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        {shown.length === 0 && <div role="option" aria-selected={false} aria-disabled className="px-3 py-6 text-center text-muted-foreground text-xs">No worktree matches.</div>}
        {shown.map((g) => (
          <div key={g.name} role="group" aria-label={g.name} data-testid="topbar-project-group" data-project={g.name} className="pb-1">
            <div aria-hidden className={cn("flex items-center gap-2 px-2 pt-1.5 pb-0.5 font-medium text-[11px]", g.asks ? "text-warning-foreground" : "text-muted-foreground")}>
              <span className="flex-1 truncate">{g.name}</span>
              {g.waiting > 0 && <span className="flex items-center gap-1 text-warning-foreground"><span className="size-1.5 rounded-full bg-warning" />{g.waiting}</span>}
              {g.working > 0 && <span className="flex items-center gap-1"><StateGlyph state="running" className="size-3" />{g.working}</span>}
            </div>
            {g.rows.map((r) => {
              index++;
              const i = index;
              return (
                <div
                  key={r.key}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  id={`goto-${i}`}
                  data-testid="topbar-worktree-item"
                  data-worktree={`${r.box}/${r.wt.main ? r.loc.name : r.wt.name}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn("flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px]", i === active && "bg-accent", r.key === front && "font-medium")}
                >
                  {r.state ? <StateGlyph state={r.state} /> : r.wt.main ? <HouseIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="shrink-0">{g.asks ? `${r.project} / ` : ""}{r.wt.main ? "main" : worktreeLabel(r.wt)}</span>
                  <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{r.box}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{r.title}</span>
                  {open.has(r.key) && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{r.key === front ? "here" : "open"}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* The boxes, and which are away. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        {status.map((b) => (
          <span key={b.name} className="flex shrink-0 items-center gap-1">
            <span className={cn("size-1.5 rounded-full", b.state === "online" ? "bg-success" : "bg-muted-foreground/60")} />
            {b.name}
            {b.state !== "online" && <span className="font-sans">offline</span>}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1 border-t p-1">
        <button type="button" onClick={() => (close(), useStore.getState().openNewWorktree())} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[13px] hover:bg-accent">
          <GitBranchPlusIcon className="size-3.5" />
          New task
          <Kbd className="h-4.5 text-[10px]">{platformKeys("⌘N")}</Kbd>
        </button>
        <button type="button" onClick={() => (close(), useStore.getState().openAddLocation())} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[13px] hover:bg-accent">
          <FolderPlusIcon className="size-3.5" />
          Add a project
        </button>
        <button type="button" onClick={() => (close(), openSwitcher())} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[13px] hover:bg-accent">
          Every agent
          <Kbd className="h-4.5 text-[10px]">⌃⇥</Kbd>
        </button>
      </div>
    </div>
  );
}

// ---- Worktree tabs ------------------------------------------------------

function WorktreeTabs() {
  const roomy = useMediaQuery({ min: 1280 });
  const keys = useTopTabs((s) => s.keys);
  const spaces = useWorkspaces((s) => s.spaces);
  const current = useWorkspaces((s) => s.current);
  const workspace = useStore((s) => s.view.kind === "workspace");
  const boxes = useStore((s) => s.boxes);
  const states = useWorktreeStates();
  const strip = useRef<HTMLElement>(null);
  // Tabs whose worktree is still known.
  const tabs = keys.map((k) => ({ key: k, ref: spaces[k]?.ref })).filter((t): t is { key: string; ref: WorktreeRef } => !!t.ref);
  // Names open more than once (two projects' "main"s, say).
  const names = tabs.map((t) => (t.ref.main ? t.ref.location : t.ref.worktree));
  const twins = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // ⌃1–⌃9 go to worktree tab 1–9.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
      const t = tabsRef.current[Number(e.code.slice(5)) - 1];
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      selectWorktree(t.ref);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The one in front stays in sight.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[data-selected]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, tabs.length]);

  return (
    <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1">
      <nav ref={strip} aria-label="Open worktrees" data-tauri-drag-region className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t, i) => {
          const selected = workspace && current === t.key;
          const state = states[t.key]?.state;
          const title = boxes[t.ref.box]?.locations?.find((l) => l.name === t.ref.location)?.worktrees?.find((w) => w.path === t.ref.path)?.title;
          const name = t.ref.main ? t.ref.location : worktreeLabel({ name: t.ref.worktree, title });
          const close = (e: MouseEvent) => {
            e.stopPropagation();
            closeTab(t.key);
          };
          return (
            <div
              key={t.key}
              className={cn(
                "group relative flex h-6.5 min-w-[7.5rem] max-w-52 shrink items-center overflow-hidden rounded-full border text-[13px]",
                selected ? "border-border bg-background text-foreground shadow-xs dark:border-transparent dark:bg-sidebar-accent" : "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <Tip label={<span className="flex items-center gap-1.5">{`${t.ref.location}${t.ref.main ? " · main checkout" : ` / ${name}`} on ${t.ref.box}`}{i < 9 && <Kbd>⌃{i + 1}</Kbd>}</span>}>
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  data-testid="topbar-tab"
                  data-ws={t.key}
                  data-selected={selected || undefined}
                  onClick={() => selectWorktree(t.ref)}
                  onAuxClick={(e) => e.button === 1 && close(e)}
                  className="flex h-full min-w-0 flex-auto cursor-default items-center gap-1.5 rounded-full px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  {state ? <StateGlyph state={state} /> : t.ref.main ? <HouseIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0" />}
                  {/* Just the name: where it is shows on hover. Two of a name
                      say their project. */}
                  <span className="min-w-0 truncate">
                    {twins.has(t.ref.main ? t.ref.location : t.ref.worktree) && !t.ref.main && <span className="text-muted-foreground">{t.ref.location} / </span>}
                    {name}
                  </span>
                </button>
              </Tip>
              <button
                type="button"
                aria-label={`Close ${name}`}
                data-testid="topbar-tab-close"
                data-ws={t.key}
                tabIndex={-1}
                onClick={close}
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
                  // It shows over the tab's end on hover, so tabs are as
                  // wide as their names.
                  "absolute right-0.5 bg-sidebar-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </nav>
      <Tip label={<span className="flex items-center gap-1.5">New task <Kbd>{platformKeys("⌘N")}</Kbd></span>}>
        <button
          type="button"
          data-testid="layout-new-task"
          aria-label="New task"
          onClick={() => useStore.getState().openNewWorktree()}
          className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground", (roomy || !tabs.length) && "px-2")}
        >
          <PlusIcon className="size-4" />
          {(roomy || !tabs.length) && "New task"}
        </button>
      </Tip>
      <div data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
    </div>
  );
}

