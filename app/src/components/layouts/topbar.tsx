import { ChevronDownIcon, ChevronRightIcon, FolderIcon, GitBranchIcon, GitBranchPlusIcon, HouseIcon, LayoutGridIcon, PlusIcon, XIcon } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { StateGlyph } from "@/components/agent-glyph";
import { openItem, useItems } from "@/components/layouts/model";
import { MorePlaces, PlaceButton, SearchButton, SettingsButton, trafficPad, usePlaces } from "@/components/layouts/parts";
import { openSwitcher } from "@/components/layouts/switcher";
import { NotificationBell } from "@/components/notifications/notification-center";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from "@/components/ui/menu";
import type { Location, Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionState } from "@/lib/derive";
import { useProjects } from "@/lib/project-groups";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { goHome, homeBox, refOf, selectWorktree, useWorkspaces, type WorktreeRef, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";
import { platformKeys } from "@/lib/platform";

// The top bar (Labs › Layout › Top bar) puts the way around across the top
// and gives the work the window's whole width, as a browser does:
//
//   ⌂ / shop ▾ ›  [● checkout-fix] [✓ search-perf] [judge-v2] +     ● 2  ▦  Review  Automations ⋯  ⌕ 🔔 ⚙
//
// Home, then the project you're in, which switches to any worktree of any
// project; then the worktrees you have open, as tabs, each with its agents'
// state; then what needs you, the switcher (⌃⇥) and the places. Under it
// the worktree's own tabs, as ever, name the agent: project ▸ worktree ▸
// agent, top to bottom.

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

// useWorktreeStates is each worktree's most urgent agent state.
function useWorktreeStates(): Record<string, SessionState> {
  const boxes = useStore((s) => s.boxes);
  return useMemo(() => {
    const out: Record<string, SessionState> = {};
    for (const [box, d] of Object.entries(boxes)) {
      for (const s of d.sessions ?? []) {
        if (s.service || s.exited || !agentOf(s)) continue;
        const st = sessionState(s, d.stats);
        const key = wsKey(box, s.dir);
        if (URGENCY[st] === undefined) continue;
        if (out[key] === undefined || URGENCY[st]! < URGENCY[out[key]]!) out[key] = st;
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

  return (
    <header
      data-tauri-drag-region
      data-testid="topbar"
      aria-label="Top bar"
      className={cn("@container/top flex h-10 shrink-0 items-center gap-1 border-b bg-sidebar pr-2 text-sidebar-foreground", trafficPad())}
    >
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
      <span aria-hidden className="select-none text-muted-foreground/40">/</span>
      <ProjectCrumb />
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" />
      <WorktreeTabs />
      <div className="flex shrink-0 items-center gap-0.5 pl-2">
        <NeedsYou />
        <Tip label={<span className="flex items-center gap-1.5">Every agent at a glance <Kbd>⌃⇥</Kbd></span>}>
          <button
            type="button"
            aria-label="Switch agents"
            data-testid="topbar-switcher"
            onClick={openSwitcher}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <LayoutGridIcon className="size-4" />
          </button>
        </Tip>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <nav aria-label="Places" className="flex items-center gap-0.5">
          {pinned.map((n) => (
            <span key={n.id} className="contents">
              <span className="hidden @[1180px]/top:contents">
                <PlaceButton n={n} />
              </span>
              <span className="contents @[1180px]/top:hidden">
                <PlaceButton n={n} iconOnly />
              </span>
            </span>
          ))}
          <MorePlaces more={more} />
        </nav>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <span className="hidden @[1180px]/top:contents">
          <SearchButton wide className="w-36" />
        </span>
        <span className="contents @[1180px]/top:hidden">
          <SearchButton />
        </span>
        <NotificationBell />
        <SettingsButton />
      </div>
    </header>
  );
}

// NeedsYou says how many agents wait for you, and goes to the one that has
// waited longest.
function NeedsYou() {
  const items = useItems();
  const waiting = items.filter((i) => i.lane === "waiting");
  if (!waiting.length) return null;
  const next = waiting.find((i) => !i.selected) ?? waiting[0];
  return (
    <Tip label={`Go to the agent that has waited longest: ${next.title}`}>
      <button
        type="button"
        data-testid="topbar-needs-you"
        onClick={() => openItem(next)}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 font-medium text-warning-foreground text-xs hover:bg-warning/20"
      >
        <span className="size-1.5 rounded-full bg-warning" />
        <span className="tabular-nums">{waiting.length}</span>
        <span className="hidden @[1000px]/top:inline">need you</span>
      </button>
    </Tip>
  );
}

// ---- Project ▾ ----------------------------------------------------------

// ProjectCrumb names the project in front and switches to any worktree of
// any project, each project a submenu of its worktrees on every box.
function ProjectCrumb() {
  const ref = useWorkspaces((s) => (s.current && !homeBox(s.current) ? s.spaces[s.current]?.ref : undefined));
  const view = useStore((s) => s.view);
  const { projects } = useProjects();
  const boxes = useStore((s) => s.boxes);
  const states = useWorktreeStates();
  const project = ref ? (projects.find((p) => p.members.some((m) => m.box.name === ref.box && m.loc.name === ref.location))?.name ?? ref.location) : undefined;
  const placeName = view.kind === "workspace" ? undefined : view.kind === "settings" ? "Settings" : undefined;
  const label = project ?? placeName ?? "Projects";

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-testid="topbar-project"
            className="inline-flex h-7 min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-[13px] outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent"
          />
        }
      >
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("truncate", !project && "text-muted-foreground")}>{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-60">
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          {projects.map((p) => {
            const online = p.members.filter((m) => m.box.state === "online");
            const wts = online.flatMap((m) => (boxes[m.box.name]?.locations?.find((l) => l.name === m.loc.name)?.worktrees ?? []).map((wt) => ({ box: m.box.name, loc: m.loc, wt })));
            const waiting = wts.filter((w) => states[wsKey(w.box, w.wt.path)] === "waiting").length;
            const spans = new Set(p.members.map((m) => m.box.name)).size > 1;
            return (
              <MenuSub key={p.id}>
                <MenuSubTrigger data-testid="topbar-project-item" data-project={p.name} disabled={!online.length}>
                  <FolderIcon />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {waiting > 0 && <span className="text-warning-foreground text-xs tabular-nums">{waiting}</span>}
                  <span className="font-mono text-[10px] text-muted-foreground">{online.length ? p.members.map((m) => m.box.name).join(" ") : "offline"}</span>
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-60">
                  {wts.map(({ box, loc, wt }) => (
                    <WorktreeItem key={`${box}:${wt.path}`} box={box} loc={loc} wt={wt} state={states[wsKey(box, wt.path)]} spans={spans} />
                  ))}
                  <MenuSeparator />
                  <MenuItem onClick={() => useStore.getState().openNewWorktree({ box: online[0]?.box.name, location: online[0]?.loc.name })}>
                    <GitBranchPlusIcon />
                    New task in {p.name}…
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => useStore.getState().openAddLocation()}>
          <PlusIcon />
          Add a project…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function WorktreeItem({ box, loc, wt, state, spans }: { box: string; loc: Location; wt: Worktree; state?: SessionState; spans: boolean }) {
  return (
    <MenuItem data-testid="topbar-worktree-item" data-worktree={`${box}/${wt.main ? loc.name : wt.name}`} onClick={() => selectWorktree(refOf(box, loc, wt))}>
      {state ? <StateGlyph state={state} /> : wt.main ? <HouseIcon /> : <GitBranchIcon />}
      <span className="min-w-0 flex-1 truncate">{wt.main ? "main" : worktreeLabel(wt)}</span>
      {spans && <span className="font-mono text-[10px] text-muted-foreground">{box}</span>}
    </MenuItem>
  );
}

// ---- Worktree tabs ------------------------------------------------------

function WorktreeTabs() {
  const keys = useTopTabs((s) => s.keys);
  const spaces = useWorkspaces((s) => s.spaces);
  const current = useWorkspaces((s) => s.current);
  const workspace = useStore((s) => s.view.kind === "workspace");
  const states = useWorktreeStates();
  const { projects } = useProjects();
  const strip = useRef<HTMLDivElement>(null);
  // Tabs whose worktree is still known.
  const tabs = keys.map((k) => ({ key: k, ref: spaces[k]?.ref })).filter((t): t is { key: string; ref: WorktreeRef } => !!t.ref);
  const manyProjects = new Set(tabs.map((t) => t.ref.location)).size > 1;
  const spansBox = (ref: WorktreeRef) => new Set(projects.find((p) => p.members.some((m) => m.box.name === ref.box && m.loc.name === ref.location))?.members.map((m) => m.box.name)).size > 1;

  // ⌃1–⌃9 go to worktree tab 1–9.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // The one in front stays in sight.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, tabs.length]);

  return (
    <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1">
      <div ref={strip} role="tablist" aria-label="Open worktrees" data-tauri-drag-region className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t, i) => {
          const selected = workspace && current === t.key;
          const state = states[t.key];
          const name = t.ref.main ? t.ref.location : worktreeLabel({ name: t.ref.worktree, title: useStore.getState().boxes[t.ref.box]?.locations?.find((l) => l.name === t.ref.location)?.worktrees?.find((w) => w.path === t.ref.path)?.title });
          const close = (e: MouseEvent) => {
            e.stopPropagation();
            closeTab(t.key);
          };
          return (
            <Tip key={t.key} label={<span className="flex items-center gap-1.5">{`${t.ref.location}${t.ref.main ? " · main checkout" : ` / ${name}`} · ${t.ref.box}`}{i < 9 && <Kbd>⌃{i + 1}</Kbd>}</span>}>
              <div
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                data-testid="topbar-tab"
                data-ws={t.key}
                onClick={() => selectWorktree(t.ref)}
                onAuxClick={(e) => e.button === 1 && close(e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectWorktree(t.ref);
                  }
                }}
                className={cn(
                  "group relative flex h-7 min-w-0 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-md border pr-1 pl-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-border bg-background text-foreground shadow-xs" : "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                )}
              >
                {state ? <StateGlyph state={state} /> : t.ref.main ? <HouseIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0" />}
                {manyProjects && !t.ref.main && <span className="shrink-0 text-muted-foreground/80">{t.ref.location} /</span>}
                <span className="min-w-0 truncate">{name}</span>
                {spansBox(t.ref) && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{t.ref.box}</span>}
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  tabIndex={-1}
                  onClick={close}
                  className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground", selected ? "opacity-70" : "opacity-0 group-hover:opacity-70")}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            </Tip>
          );
        })}
      </div>
      <Tip label={<span className="flex items-center gap-1.5">New task <Kbd>{platformKeys("⌘N")}</Kbd></span>}>
        <button
          type="button"
          data-testid="layout-new-task"
          aria-label="New task"
          onClick={() => useStore.getState().openNewWorktree()}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            !tabs.length && "border border-dashed px-2",
          )}
        >
          <PlusIcon className="size-4" />
          {!tabs.length && "New task"}
        </button>
      </Tip>
      <div data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
    </div>
  );
}
