import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HomeIcon,
  HouseIcon,
  InboxIcon,
  ListFilterIcon,
  PanelLeftCloseIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  ServerOffIcon,
  SettingsIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { StateGlyph } from "@/components/agent-glyph";
import { AppSidebar } from "@/components/app-sidebar";
import { NotificationBell } from "@/components/notifications/notification-center";
import { type Action, boxActions, ContextRow, worktreeActions } from "@/components/sidebar/actions";
import { type NavItem, useNavItems } from "@/components/sidebar/nav";
import { AgentCard, type RailAgent, useRailAgents } from "@/components/sidebar/rail";
import { SidebarResizeHandle } from "@/components/sidebar/resize-handle";
import { RowLayer } from "@/components/sidebar/row-layer";
import { Tip } from "@/components/tip";
import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { WhatsNewNudge } from "@/components/whats-new/whats-new-dialog";
import { WtDot } from "@/components/workspace/worktree-tone";
import { type BoxStatus, boxApi, type Location, type Session, type Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionState, worktreeSessions } from "@/lib/derive";
import { ago } from "@/lib/format";
import { findLeaf, leaves } from "@/lib/layout";
import { platformKeys } from "@/lib/platform";
import { permissionChoices } from "@/lib/screen";
import { usePrefs } from "@/lib/prefs";
import { type Project, useProjects } from "@/lib/project-groups";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar-width";
import { BOX_WORDS, boxState } from "@/lib/state-model";
import { load, save } from "@/lib/storage";
import { type BoxData, NONE, useStore } from "@/lib/store";
import { useAsk } from "@/lib/transcript-feed";
import { cn } from "@/lib/utils";
import { openSession, refOf, selectWorktree, splitKey, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";
import { MAX_INDENT, nest, type TreeNode } from "@/lib/worktree-tree";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { TeamSidebarCard } from "@/views/team/team-entry";

// Sidebar2 (Labs › Sidebar › Agents first) is the sidebar remade around the
// agents rather than the tree they live in. From the top: a way to start
// work and to search, and the places (Home, Review, More) in one short row;
// then what needs you, with what each agent asks for; what is working and
// what you had open, a line each; and, docked below them so it is always in
// reach, the projects for everything else. Settings, and any box that went
// away, are the footer. Box names only show where they tell copies apart.

// ---- What it remembers, on this computer -------------------------------

type Scope = "all" | `p:${string}` | `b:${string}`;

interface Sidebar2Prefs {
  // Worktrees kept at hand, as workspace keys (box:path).
  pinned: string[];
  // Only one project's or one box's agents and worktrees.
  scope: Scope;
  // Projects unfolded in the Projects panel, and the ones showing their
  // quiet worktrees too.
  open: Record<string, boolean>;
  quiet: Record<string, boolean>;
  // Sections folded away (the Projects panel among them), and the ones
  // showing all their rows.
  folded: Record<string, boolean>;
  all: Record<string, boolean>;
}

const KEY = "berth.sidebar2";
const useS2 = create<Sidebar2Prefs>()(() => ({ pinned: [], scope: "all", open: {}, quiet: {}, folded: {}, all: {}, ...load<Partial<Sidebar2Prefs>>(KEY, {}) }));
useS2.subscribe((s) => save(KEY, s));
const setS2 = (patch: Partial<Sidebar2Prefs> | ((s: Sidebar2Prefs) => Partial<Sidebar2Prefs>)) => useS2.setState(patch);
const togglePin = (key: string) => setS2((s) => ({ pinned: s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [...s.pinned, key] }));
const toggleIn = (field: "open" | "quiet" | "folded" | "all", key: string) => setS2((s) => ({ [field]: { ...s[field], [key]: !s[field][key] } }));

// ---- Words ---------------------------------------------------------------

const since = (iso?: string) => (iso ? ago(iso).replace(" ago", "").replace("just now", "now") : "");
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// asks says, in a few calm words, what a waiting agent wants from you: "Wants
// to run" and the command, "Wants to edit" and the file, or its own words.
export function asks(s: Session): { text: string; code?: string } {
  const a = s.ask;
  if (a?.tool === "Bash" && a.input) return { text: "Wants to run", code: clip(a.input) };
  if ((a?.tool === "Edit" || a?.tool === "Write" || a?.tool === "MultiEdit") && a.input) return { text: "Wants to edit", code: base(a.input) };
  if (a?.message) return { text: clip(a.message) };
  if (a?.tool === "AskUserQuestion") return { text: "Has a question for you" };
  if (a?.tool) return { text: `Wants to use ${a.tool}` };
  return { text: "Waiting for you" };
}
const askWords = (a: { text: string; code?: string }) => (a.code ? `${a.text} ${a.code}` : a.text);

// wtName is a worktree as every row names it: its display name, or the main
// checkout's branch.
const wtName = (loc: Location, wt: Worktree) => (wt.main ? (wt.branch ?? "main") : worktreeLabel(wt, loc));

// ---- What is in front ------------------------------------------------------

// useFront is the agent in front, as box/session: the focused pane of the
// current worktree's active tab. Only its row is marked as selected; a
// worktree's row is marked faintly when an agent row already marks it.
function useFront(): string | undefined {
  return useWorkspaces((s) => {
    if (!s.current) return undefined;
    const w = s.spaces[s.current];
    const tab = w?.tabs.find((t) => t.id === w.active) ?? w?.tabs[0];
    if (!tab) return undefined;
    const c = (findLeaf(tab.root, tab.focus) ?? leaves(tab.root)[0])?.content;
    return c?.kind === "terminal" ? `${splitKey(s.current).box}/${c.session}` : undefined;
  });
}
const MarkedCtx = createContext(false);

// ---- The sidebar ------------------------------------------------------------

export function Sidebar2() {
  const collapsed = usePrefs((p) => p.sidebarCollapsed);
  // Folded (⌘\), it is the same rail as the classic sidebar's.
  if (collapsed) return <AppSidebar />;
  return (
    <aside
      aria-label="Sidebar"
      data-testid="sidebar"
      data-layout="sidebar2"
      style={{ width: `clamp(${SIDEBAR_MIN}px, var(--sidebar-live, var(--sidebar-w, ${SIDEBAR_DEFAULT}px)), max(${SIDEBAR_DEFAULT}px, min(${SIDEBAR_MAX}px, 40vw)))` }}
      className="@container/side relative flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground"
    >
      <SidebarResizeHandle />
      {/* Room for the macOS traffic lights; the strip drags the window. */}
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center justify-end gap-0.5 pr-2 pl-20">
        <ScopeButton />
        <NotificationBell />
        <Tip label={"Hide the sidebar (⌘\\)"}>
          <button type="button" aria-label="Hide the sidebar" onClick={() => usePrefs.setState({ sidebarCollapsed: true })} className={iconBtn}>
            <PanelLeftCloseIcon />
          </button>
        </Tip>
      </div>
      <StartRow />
      <PlacesRow />
      <TeamSidebarCard />
      <Body />
      <WhatsNewNudge />
      <Footer />
    </aside>
  );
}

const iconBtn = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent [&_svg]:size-4";
const field = "h-8 rounded-lg border border-sidebar-border bg-background/60 text-[13px] shadow-xs/5 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring";

// StartRow: a new task (⌘N), in the filter's project or box when one is
// picked, and search (⌘K) beside it.
function StartRow() {
  const scope = useS2((s) => s.scope);
  const { projects } = useProjects();
  const start = () => {
    const p = scope.startsWith("p:") ? projects.find((x) => x.id === scope.slice(2)) : undefined;
    const m = p && (p.members.find((x) => x.box.name === p.defaultBox) ?? p.members[0]);
    useStore.getState().openNewWorktree(m ? { box: m.box.name, location: m.loc.name } : scope.startsWith("b:") ? { box: scope.slice(2) } : {});
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1">
      <button type="button" data-testid="s2-new-task" onClick={start} className={cn(field, "flex min-w-0 flex-1 items-center gap-2 px-2.5 font-medium text-foreground")}>
        <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">New task</span>
        <Kbd className="ml-auto hidden h-4.5 text-[10px] @min-[13.5rem]/side:inline-flex">{platformKeys("⌘N")}</Kbd>
      </button>
      <Tip label="Search (⌘K)">
        <button type="button" aria-label="Search" data-testid="s2-search" onClick={() => useStore.getState().setPaletteOpen(true)} className={cn(field, "flex shrink-0 items-center gap-1.5 px-2 text-muted-foreground")}>
          <SearchIcon className="size-3.5" />
          <Kbd className="h-4.5 text-[10px]">{platformKeys("⌘K")}</Kbd>
        </button>
      </Tip>
    </div>
  );
}

// PlacesRow is the app's other screens in one short labelled row: Home,
// Review, and More (Automations, Worktrees, Kits, plugins…). Settings is the
// footer's; everything is in ⌘K too.
function PlacesRow() {
  const items = useNavItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  const home = byId.get("home");
  const review = byId.get("review");
  const autos = byId.get("automations");
  const order = ["automations", "worktrees", "dashboard", "kits"];
  const more = items.filter((i) => i.id !== "home" && i.id !== "review").sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  const here = more.find((n) => n.active);
  // Three even places, each an icon and a word (the icon alone, named by
  // its tip, when the sidebar is at its narrowest).
  const place = (active: boolean) =>
    cn(
      "inline-flex h-7 min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1 text-[12.5px] text-muted-foreground outline-none hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&>[data-word]]:hidden @min-[14.5rem]/side:[&>[data-word]]:inline",
      active && "bg-sidebar-accent text-foreground",
    );
  return (
    <nav aria-label="Places" className="flex shrink-0 items-center gap-0.5 px-2 pt-0.5 pb-1">
      {home && (
        <button type="button" data-testid="nav-home" aria-label="Home" aria-current={home.active ? "page" : undefined} onClick={home.go} className={place(home.active)}>
          <HouseIcon />
          <span data-word className="truncate">Home</span>
        </button>
      )}
      {review && (
        <button type="button" data-testid="nav-review" aria-label={review.badge ? `Review, ${review.badge.count} to review` : "Review"} aria-current={review.active ? "page" : undefined} onClick={review.go} className={place(review.active)}>
          <span className={cn("relative flex items-center", review.badge && "@max-[14.5rem]/side:mr-1.5")}>
            <InboxIcon />
            {/* How many wait, as a small count on the icon. */}
            {review.badge ? (
              <span aria-hidden className="absolute -top-1.5 -right-2.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-sidebar px-0.5 font-medium text-[9px] text-foreground tabular-nums ring-1 ring-sidebar-border @min-[14.5rem]/side:hidden">
                {review.badge.count}
              </span>
            ) : null}
          </span>
          <span data-word className="truncate">Review</span>
          {review.badge ? (
            <span data-word aria-hidden className="rounded-full bg-sidebar-accent px-1.5 font-medium text-[10.5px] text-foreground tabular-nums leading-4">
              {review.badge.count}
            </span>
          ) : null}
        </button>
      )}
      {/* Wide enough, Automations is a place of its own too. */}
      {autos && (
        <button type="button" data-testid="nav-automations" aria-label="Automations" aria-current={autos.active ? "page" : undefined} onClick={autos.go} className={cn(place(autos.active), "hidden @min-[22rem]/side:inline-flex")}>
          <WorkflowIcon />
          <span data-word className="truncate">Automations</span>
        </button>
      )}
      <Menu>
        <MenuTrigger render={<button type="button" data-testid="nav-more" aria-label={here ? `More: ${here.label}` : "More"} className={place(!!here)} />}>
          {here ? here.icon : <EllipsisIcon />}
          <span data-word className="truncate">{here ? here.label : "More"}</span>
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-52">
          <MoreMenu more={more} />
        </MenuPopup>
      </Menu>
    </nav>
  );
}

function MoreMenu({ more }: { more: NavItem[] }) {
  return more.map((n) => (
    <MenuItem key={n.id} data-testid={`nav-${n.id}`} onClick={n.go} aria-current={n.active ? "page" : undefined} className={cn(n.active && "bg-accent/50 font-medium")}>
      <span className="flex size-4 items-center justify-center [&_svg]:size-4">{n.icon}</span>
      <span className="min-w-0 flex-1 truncate">{n.label}</span>
    </MenuItem>
  ));
}

// ScopeButton, in the window's top strip, narrows every list to one project
// or one box, and New task starts there. While it does, it names what it
// shows, with a way out.
function ScopeButton() {
  const scope = useS2((s) => s.scope);
  const { projects } = useProjects();
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const name = scope === "all" ? undefined : scope.startsWith("p:") ? projects.find((p) => p.id === scope.slice(2))?.name : scope.slice(2);
  return (
    <span className="mr-1 flex min-w-0 shrink items-center">
      <Menu>
        <Tip label={name ? `Showing ${name} only` : "Show one project or box"}>
          <MenuTrigger
            render={
              <button
                type="button"
                data-testid="s2-scope"
                aria-label={name ? `Showing ${name}. Change` : "Show one project or box"}
                className={cn(iconBtn, "h-6.5 w-auto min-w-7 gap-1 border px-1.5 text-[12px] [&_svg]:size-3.5", name ? "max-w-28 rounded-r-none border-transparent bg-sidebar-accent text-foreground" : "border-sidebar-border")}
              />
            }
          >
            <ListFilterIcon />
            {name ? (
              <span className="truncate">{name}</span>
            ) : (
              <span className="hidden @min-[14.5rem]/side:inline">
                All<span className="hidden @min-[17rem]/side:inline"> projects</span>
              </span>
            )}
            {!name && <ChevronRightIcon className="size-3! rotate-90 opacity-70" />}
          </MenuTrigger>
        </Tip>
        <MenuPopup align="end" className="min-w-52">
          <MenuRadioGroup value={scope} onValueChange={(v) => setS2({ scope: v as Scope })}>
            <MenuRadioItem value="all">All projects</MenuRadioItem>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Project</MenuGroupLabel>
              {projects.map((p) => (
                <MenuRadioItem key={p.id} value={`p:${p.id}`}>
                  {p.name}
                </MenuRadioItem>
              ))}
            </MenuGroup>
            {boxes.length > 1 && (
              <MenuGroup>
                <MenuGroupLabel>Box</MenuGroupLabel>
                {boxes.map((b) => (
                  <MenuRadioItem key={b.name} value={`b:${b.name}`}>
                    {b.name}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {name && (
        <Tip label="Show everything">
          <button type="button" aria-label="Show everything" onClick={() => setS2({ scope: "all" })} className={cn(iconBtn, "h-6.5 w-5 rounded-l-none bg-sidebar-accent [&_svg]:size-3")}>
            <XIcon />
          </button>
        </Tip>
      )}
    </span>
  );
}

// Fade is a scrolling area with a fade at an edge there is more past, so a
// cut-off row reads as "more", not as a bug.
function Fade({ children, className, testid, top = true }: { children: ReactNode; className?: string; testid?: string; top?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  };
  useEffect(() => {
    const el = ref.current;
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
  }, []);
  return (
    <RowLayer
      ref={ref}
      onScroll={update}
      data-testid={testid}
      className={cn("overflow-y-auto overscroll-contain px-2", !top && "border-t", !top && (edges.top ? "border-sidebar-border" : "border-transparent"), className)}
      style={{ maskImage: `linear-gradient(to bottom, ${edges.top && top ? "transparent, black 24px" : "black, black"}, ${edges.bottom ? "black calc(100% - 28px), transparent" : "black, black"})` }}
    >
      {children}
    </RowLayer>
  );
}

// ---- The lists ------------------------------------------------------------

interface Place {
  box: string;
  loc: Location;
  wt: Worktree;
  project: Project | undefined;
}

// usePlaceIndex finds a workspace key's worktree, and every location's
// project, for the filter and the rows' words.
function usePlaceIndex() {
  const data = useStore((s) => s.boxes);
  const { projects } = useProjects();
  return useMemo(() => {
    const byMember = new Map<string, Project>();
    for (const p of projects) for (const m of p.members) byMember.set(`${m.box.name}/${m.loc.name}`, p);
    const find = (key: string): Place | undefined => {
      const { box, path } = splitKey(key);
      for (const loc of data[box]?.locations ?? []) {
        const wt = loc.worktrees?.find((w) => w.path === path);
        if (wt) return { box, loc, wt, project: byMember.get(`${box}/${loc.name}`) };
      }
      return undefined;
    };
    return { find, projectOf: (box: string, loc: string) => byMember.get(`${box}/${loc}`) };
  }, [data, projects]);
}

function inScope(scope: Scope, box: string, project?: Project) {
  if (scope === "all") return true;
  if (scope.startsWith("b:")) return box === scope.slice(2);
  return project?.id === scope.slice(2);
}

// How many rows a section shows before "N more".
const CAP = { running: 6, recent: 5 };
// How many agents that need you show their ask in full.
const ASKS = 3;

// Body is the agents' lists and, under them, the projects. The lists come
// first: they take what they need, up to 60% of the height (half while a project is unfolded),
// and scroll past that; the projects take the rest and scroll, or are their
// header alone, docked at the bottom, while folded.
function Body() {
  const all = useRailAgents();
  const scope = useS2((s) => s.scope);
  const pinned = useS2((s) => s.pinned);
  const showAll = useS2((s) => s.all);
  const projectsOpen = useS2((s) => !s.folded.projects);
  // A project unfolded wants more of the height.
  const anyProject = useS2((s) => Object.values(s.open).some(Boolean));
  const spaces = useWorkspaces((s) => s.spaces);
  const index = usePlaceIndex();
  const front = useFront();
  // The agent in front stays in sight: its row scrolls into view when it
  // changes.
  useEffect(() => {
    if (!front) return;
    const id = requestAnimationFrame(() => document.querySelector('[data-testid="s2-lists"] [data-selected="strong"]')?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(id);
  }, [front]);

  const agents = all.filter((e) => inScope(scope, e.box, index.projectOf(e.box, e.loc.name)));
  const waiting = agents.filter((e) => e.lane === "waiting");
  const running = agents.filter((e) => e.lane === "running");
  const away = agents.filter((e) => e.lane === "away");
  const busy = new Set([...waiting, ...running].map((e) => e.key));

  // Pinned worktrees, wherever they are.
  const pins = pinned.map((k) => ({ key: k, place: index.find(k) })).filter((p): p is { key: string; place: Place } => !!p.place && inScope(scope, p.place.box, p.place.project));

  // Recent: agents that finished, and worktrees you opened, newest first;
  // nothing already above.
  const recent = useMemo(() => {
    const out: { key: string; t: number; agent?: RailAgent; extra?: number; place?: Place }[] = [];
    const seen = new Set<string>([...busy, ...pins.map((p) => p.key)]);
    // One row per worktree: its latest finished agent (or the one in
    // front), and how many more finished there.
    const at = (e: RailAgent) => Date.parse(e.session.state_since ?? "") || 0;
    const byWt = new Map<string, RailAgent[]>();
    for (const e of agents.filter((x) => x.lane === "finished" && !seen.has(x.key))) byWt.set(e.key, [...(byWt.get(e.key) ?? []), e]);
    for (const [key, list] of byWt) {
      list.sort((a, b) => at(b) - at(a));
      const e = list.find((x) => x.id === front) ?? list[0];
      out.push({ key: e.id, t: at(list[0]), agent: e, extra: list.length - 1 });
      seen.add(key);
    }
    for (const [key, w] of Object.entries(spaces)) {
      if (!w.visitedAt || seen.has(key)) continue;
      const place = index.find(key);
      if (!place || !inScope(scope, place.box, place.project)) continue;
      out.push({ key, t: w.visitedAt, place });
      seen.add(key);
    }
    return out.sort((a, b) => b.t - a.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, spaces, index, scope, pinned, front]);

  // A capped list keeps the agent in front, wherever it falls.
  const capped = <T,>(id: keyof typeof CAP, list: T[], isFront: (x: T) => boolean) => (showAll[id] ? list : list.filter((x, i) => i < CAP[id] || isFront(x)));
  const more = (id: keyof typeof CAP, n: number, shownN: number, word: string) =>
    n > shownN || (showAll[id] && n > CAP[id]) ? <MoreRow label={showAll[id] ? "Show fewer" : `${n - shownN} more ${word}`} onClick={() => toggleIn("all", id)} /> : null;
  const shownRunning = capped("running", running, (e) => e.id === front);
  const shownRecent = capped("recent", recent, (r) => r.agent?.id === front);
  const shown = [...waiting, ...shownRunning, ...shownRecent.flatMap((r) => (r.agent ? [r.agent] : [])), ...away];
  const marked = !!front && shown.some((e) => e.id === front);

  return (
    <MarkedCtx.Provider value={marked}>
      <Fade testid="s2-lists" top={false} className={cn("min-h-16 pb-2", projectsOpen ? (anyProject ? "max-h-[50%] shrink-0" : "max-h-[60%] shrink-0") : "flex-1")}>
        {waiting.length > 0 && (
          <Section id="waiting" label="Needs you" count={waiting.length} loud>
            {/* The first few with their ask; past that, a line each. */}
            {waiting.map((e, i) => (i < ASKS ? <NeedsRow key={e.id} e={e} front={front} /> : <AgentLine key={e.id} e={e} front={front} />))}
          </Section>
        )}
        {running.length > 0 && (
          <Section id="running" label="Working" count={running.length}>
            {shownRunning.map((e) => (
              <AgentLine key={e.id} e={e} front={front} two />
            ))}
            {more("running", running.length, shownRunning.length, "working")}
          </Section>
        )}
        {!waiting.length && !running.length && <p className="px-2 pt-3 pb-1 text-[12px] text-muted-foreground leading-snug">Nothing needs you and nothing is running. Start a task, or pick up where you left off.</p>}
        {pins.length > 0 && (
          <Section id="pinned" label="Pinned" count={pins.length}>
            {pins.map((p) => (
              <WorktreeLine key={p.key} place={p.place} />
            ))}
          </Section>
        )}
        {recent.length > 0 && (
          <Section id="recent" label="Recent" count={recent.length}>
            {shownRecent.map((r) => (r.agent ? <AgentLine key={r.key} e={r.agent} front={front} extra={r.extra} at={r.extra ? r.t : undefined} /> : <WorktreeLine key={r.key} place={r.place!} at={r.t} />))}
            {more("recent", recent.length, shownRecent.length, "recent")}
          </Section>
        )}
        {away.length > 0 && (
          <Section id="away" label="On a box that's away" count={away.length}>
            {away.map((e) => (
              <AgentLine key={e.id} e={e} front={front} />
            ))}
          </Section>
        )}
      </Fade>
      <ProjectsPanel open={projectsOpen} />
    </MarkedCtx.Provider>
  );
}

function SectionHead({ id, label, count, loud, folded, right, sticky }: { id: string; label: string; count?: number; loud?: boolean; folded: boolean; right?: ReactNode; sticky?: boolean }) {
  return (
    <div className={cn("group/head flex h-6 items-center pr-1 pl-2", sticky && "sticky top-0 z-20 bg-sidebar")}>
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => toggleIn("folded", id)}
        className="-ml-1 flex min-w-0 items-center gap-1.5 rounded px-1 font-medium text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Amber is "needs you" and nothing else: the dot, not the words. */}
        {loud && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
        <span className={cn("truncate", loud && "text-foreground")}>{label}</span>
        {count !== undefined && count > 0 && <span className="font-normal tabular-nums">{count}</span>}
        <ChevronRightIcon className={cn("size-3 opacity-0 transition group-hover/head:opacity-100 group-focus-within/head:opacity-100", !folded && "rotate-90", folded && "opacity-100")} />
      </button>
      <span className="ml-auto flex items-center">{right}</span>
    </div>
  );
}

function Section({ id, label, count, loud, children }: { id: string; label: string; count?: number; loud?: boolean; children: ReactNode }) {
  const folded = useS2((s) => s.folded[id] ?? false);
  return (
    <section aria-label={label} data-testid="s2-section" data-section={id} className="pt-2">
      {/* Sticky, so a row scrolled half away still says what it is. */}
      <SectionHead id={id} label={label} count={count} loud={loud} folded={folded} sticky />
      {!folded && <ul className="flex flex-col gap-px">{children}</ul>}
    </section>
  );
}

function MoreRow({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <li>
      <button type="button" data-testid="s2-more" onClick={onClick} className="flex h-6 w-full items-center rounded-md pl-8 text-left text-[12px] text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </button>
    </li>
  );
}

// A row marked strongly (tint and an edge) is the agent in front; faintly,
// a third of the tint, a worktree in front whose agent row already says so.
const rowBase =
  "group/r relative flex w-full scroll-my-8 gap-2 rounded-md px-2 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[selected=strong]:bg-sidebar-accent data-[selected=strong]:before:absolute data-[selected=strong]:before:inset-y-1 data-[selected=strong]:before:left-0 data-[selected=strong]:before:w-0.5 data-[selected=strong]:before:rounded-full data-[selected=strong]:before:bg-foreground/60 data-[selected=faint]:bg-sidebar-accent/35";

function pinAction(key: string): Action {
  const on = useS2.getState().pinned.includes(key);
  return { type: "item", label: on ? "Unpin" : "Pin to the sidebar", icon: on ? <PinOffIcon /> : <PinIcon />, run: () => togglePin(key) };
}

function agentMenu(e: RailAgent): Action[] {
  const box = useStore.getState().status?.boxes.find((b) => b.name === e.box);
  return [pinAction(e.key), { type: "sep" }, ...(e.away && box ? boxActions(box) : worktreeActions(e.box, e.loc, e.wt))];
}

const titleOf = (e: RailAgent) => e.session.title ?? (e.wt.main ? e.project : worktreeLabel(e.wt, e.loc));

// Rows say which box only when there is more than one, and then always,
// as one muted word.
function useSeveralBoxes() {
  return useStore((s) => (s.status?.boxes.length ?? 0) > 1);
}

// RowName is how every agent row begins: its worktree, the name you switch
// by and the one the tree uses (the main checkout by its project), then,
// dimmed, its box and what its work is called.
function RowName({ e, extra, away }: { e: RailAgent; extra?: number; away?: boolean }) {
  const several = useSeveralBoxes();
  const name = wtName(e.loc, e.wt);
  // The main checkout is its branch, as in the tree, with its project.
  const project = e.wt.main ? e.project : "";
  const box = several ? e.box : "";
  return (
    <>
      <span className={cn("min-w-0 max-w-[70%] shrink-0 truncate text-[13px] leading-[18px]", away ? "text-muted-foreground" : "text-foreground")}>{name}</span>
      {/* Where is only shown whole: a box name cut to "de…" says nothing.
          The box stays at every width; a main checkout's project from 13.5rem. */}
      {project && <span className="hidden shrink-0 text-[12px] text-muted-foreground @min-[13.5rem]/side:inline">· {project}</span>}
      {box && <span className="shrink-0 text-[12px] text-muted-foreground">· {box}</span>}
      <WtDot wsKey={e.key} className="size-1.5" />
      {extra ? (
        <span aria-label={`and ${extra} more finished here`} className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          +{extra}
        </span>
      ) : null}
    </>
  );
}
const placeWords = (e: RailAgent) => `${e.wt.main ? e.project : `${e.project}/${worktreeLabel(e.wt, e.loc)}`} on ${e.box}`;

// NeedsRow is an agent that needs you: the row every agent has (RowName)
// and for how long, then what it asks for, in words, over up to two lines.
function NeedsRow({ e, front }: { e: RailAgent; front?: string }) {
  const title = titleOf(e);
  const ask = asks(e.session);
  const where = placeWords(e);
  const selected = e.id === front;
  return (
    <li className="group/li relative">
      <ContextRow items={() => agentMenu(e)}>
        {/* The tint and edge are the whole row's, its answer buttons too. */}
        <div data-selected={selected ? "strong" : undefined} className={cn(rowBase, "flex-col gap-0 px-0 hover:bg-sidebar-accent/60 has-[button:focus-visible]:ring-0")}>
        <Tip side="right" align="start" delay={500} className="max-w-none" label={<AgentCard e={e} />}>
          <button
            type="button"
            data-testid="s2-agent"
            data-session={`${e.box}/${e.session.name}`}
            data-agent-state={e.state}
            aria-current={selected || undefined}
            aria-label={`${title}. ${askWords(ask)}. ${where}`}
            onClick={() => openSession(e.box, e.session)}
            className={cn(rowBase, "items-start py-[5px] hover:bg-transparent")}
          >
            <span className="flex h-[18px] w-4 shrink-0 items-center justify-center">
              <StateGlyph state={e.state} className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <RowName e={e} />
                <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums">{since(e.session.state_since)}</span>
              </span>
              <span data-testid="s2-ask" className="line-clamp-2 break-words text-[12px] text-foreground/75 leading-4">
                {ask.text}
                {ask.code && <span className="ml-1 font-mono text-[11px] text-foreground/85">{ask.code}</span>}
              </span>
            </span>
          </button>
        </Tip>
        <Answer e={e} />
        </div>
      </ContextRow>
    </li>
  );
}

const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;

// Answer is a permission ask's Deny and Allow once, right in the row, as
// Home has them: read from the agent's screen while it waits. A question
// has none; the row opens it.
function Answer({ e }: { e: RailAgent }) {
  const client = useStore((st) => st.client);
  const s = e.session;
  const permission = !!s.ask?.tool && !QUESTION_TOOLS.test(s.ask.tool);
  const ask = useAsk(e.box, s.name, permission, s.state_since);
  const choices = ask && !ask.form ? permissionChoices(ask.choices) : undefined;
  const allow = choices?.find((c) => c.label === "Allow");
  const deny = choices?.find((c) => c.label === "Deny");
  const [sent, setSent] = useState<{ at?: string; label: string }>();
  const answered = sent && sent.at === s.state_since ? sent.label : undefined;
  if (!allow || !deny) return null;
  const answer = (key: string, label: string) => {
    if (!client) return;
    setSent({ at: s.state_since, label });
    // The person answered, so the box may type into a waiting agent.
    boxApi.send(client, e.box, s.name, key, false, { when: "now", force: true }).catch((err) => {
      setSent(undefined);
      toastError(err, { title: "Couldn't answer", box: e.box });
    });
  };
  const title = titleOf(e);
  return (
    <span data-testid="s2-answer" className="flex items-center justify-end gap-1 pr-2 pb-1.5 pl-8">
      {answered ? (
        <span className="text-[11px] text-muted-foreground">{answered === "Deny" ? "Denied" : "Allowed"} · resuming</span>
      ) : (
        <>
          <Button size="xs" variant="outline" className="h-5 rounded-[5px] px-1.5 text-[11px]" onClick={() => answer(deny.key, "Deny")} aria-label={`Deny: ${title}`}>
            Deny
          </Button>
          <Button size="xs" variant="outline" className="h-5 rounded-[5px] px-1.5 font-medium text-[11px]" onClick={() => answer(allow.key, "Allow")} aria-label={`Allow once: ${title}`}>
            Allow once
          </Button>
        </>
      )}
    </span>
  );
}

// AgentLine is an agent on one line: its state, its RowName and when, with
// how many more finished in the same worktree; in Working (two), what its
// work is called under it, whole. The hover card has the rest.
const quietCheck = "[&_svg]:text-muted-foreground!";
function AgentLine({ e, front, extra, two, at }: { e: RailAgent; front?: string; extra?: number; two?: boolean; at?: number }) {
  const title = titleOf(e);
  const name = wtName(e.loc, e.wt);
  const where = placeWords(e);
  const selected = e.id === front;
  const time = e.away ? `${e.box} is ${e.away}` : since(at ? new Date(at).toISOString() : e.session.state_since);
  return (
    <li className="group/li relative">
      <ContextRow items={() => agentMenu(e)}>
        <Tip side="right" align="start" delay={500} className="max-w-none" label={<AgentCard e={e} />}>
          <button
            type="button"
            data-testid="s2-agent"
            data-session={`${e.box}/${e.session.name}`}
            data-agent-state={e.away ? "away" : e.state}
            data-selected={selected ? "strong" : undefined}
            aria-current={selected || undefined}
            aria-label={`${title}. ${where}, ${time}`}
            onClick={() => openSession(e.box, e.session)}
            className={cn(rowBase, two ? "items-start py-[5px]" : "h-side-row items-center")}
          >
            <span className={cn("flex w-4 shrink-0 items-center justify-center", two && "h-[18px]", e.state === "finished" && quietCheck)}>{e.away ? <ServerOffIcon className="size-3 text-muted-foreground" /> : <StateGlyph state={e.state} className="size-3.5" />}</span>
            {two ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <RowName e={e} extra={extra} away={!!e.away} />
                  <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums">{time}</span>
                </span>
                {title !== name && <span className="truncate text-[12px] text-muted-foreground leading-4">{title}</span>}
              </span>
            ) : (
              <>
                <RowName e={e} extra={extra} away={!!e.away} />
                <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums">{time}</span>
              </>
            )}
          </button>
        </Tip>
      </ContextRow>
      <PinButton wsKey={e.key} />
    </li>
  );
}

// PinButton shows on a row's hover or focus, at its end, so pinning can be
// found without the right-click menu.
function PinButton({ wsKey: key }: { wsKey: string }) {
  const on = useS2((s) => s.pinned.includes(key));
  return (
    <Tip label={on ? "Unpin" : "Pin to the sidebar"}>
      <button
        type="button"
        aria-label={on ? "Unpin" : "Pin to the sidebar"}
        onClick={() => togglePin(key)}
        className="absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded bg-sidebar-accent text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/li:opacity-100 [&_svg]:size-3"
      >
        {on ? <PinOffIcon /> : <PinIcon />}
      </button>
    </Tip>
  );
}

// The most urgent state among a worktree's agents.
const urgency: Record<SessionState, number> = { waiting: 0, running: 1, finished: 2, ready: 3, idle: 4, exited: 5 };
function stateOf(sessions: Session[], data?: BoxData): SessionState | undefined {
  return sessions
    .filter((s) => !s.exited && agentOf(s))
    .map((s) => sessionState(s, data?.stats))
    .sort((a, b) => urgency[a] - urgency[b])[0];
}

// WorktreeLine is one worktree on one line: its state or icon and its name;
// in Pinned and Recent its project, dimmed; in the tree, the work its lead
// agent is on, when there is room, so the tree and the lists share words.
function WorktreeLine({ place, at, depth = 0, inProject }: { place: Place; at?: number; depth?: number; inProject?: boolean }) {
  const { box, loc, wt } = place;
  const key = wsKey(box, wt.path);
  const data = useStore((s) => s.boxes[box]);
  const isCurrent = useWorkspaces((s) => s.current === key);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const marked = useContext(MarkedCtx);
  const online = useStore((s) => s.status?.boxes.find((b) => b.name === box)?.state === "online");
  const sessions = worktreeSessions(data?.sessions, wt).filter((s) => !s.exited && !s.service);
  const state = online ? stateOf(sessions, data) : undefined;
  const project = place.project?.name ?? loc.name;
  const name = wt.main && !inProject ? project : wtName(loc, wt);
  const lead = sessions.filter((s) => agentOf(s) && s.title).sort((a, b) => urgency[sessionState(a, data?.stats)] - urgency[sessionState(b, data?.stats)])[0];
  const selected = isCurrent && inWorkspace ? (marked ? "faint" : "strong") : undefined;
  const glyph = state && state !== "idle" && state !== "ready" ? <StateGlyph state={state} className="size-3.5" /> : wt.main ? <HomeIcon /> : <GitBranchIcon />;
  const dim = inProject ? lead?.title : wt.main ? "main checkout" : project;
  return (
    <li className="group/li relative">
      <ContextRow items={() => [pinAction(key), { type: "sep" }, ...worktreeActions(box, loc, wt)]}>
        <button
          type="button"
          data-testid="s2-worktree"
          data-worktree={`${box}/${wt.main ? loc.name : wt.name}`}
          data-selected={selected}
          aria-current={!!selected || undefined}
          aria-label={`${name}${dim ? `, ${dim}` : ""}${at ? `, ${since(new Date(at).toISOString())}` : ""}`}
          disabled={!online}
          onClick={() => selectWorktree(refOf(box, loc, wt))}
          style={depth ? { paddingLeft: `${8 + Math.min(depth, MAX_INDENT) * 12}px` } : undefined}
          className={cn(rowBase, "h-side-row items-center disabled:opacity-60")}
        >
          <span className={cn("flex w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5", quietCheck)}>{glyph}</span>
          <span className="min-w-0 shrink truncate text-[13px]">{name}</span>
          <WtDot wsKey={key} className="size-1.5" />
          {dim && <span className={cn("ml-auto max-w-[50%] shrink-0 truncate pl-1 text-right text-[11.5px] text-muted-foreground", inProject ? "hidden @min-[18rem]/side:inline" : "hidden @min-[15rem]/side:inline")}>{dim}</span>}
        </button>
      </ContextRow>
      {!inProject && <PinButton wsKey={key} />}
    </li>
  );
}

// ---- Projects -----------------------------------------------------------

// ProjectsPanel is everything else, by project, folded: a project unfolds
// to its worktrees with something going on (children under their parent),
// and its quiet ones are one more click. Docked under the lists.
function ProjectsPanel({ open }: { open: boolean }) {
  const { projects } = useProjects();
  const scope = useS2((s) => s.scope);
  const list = projects.filter((p) => scope === "all" || (scope.startsWith("p:") ? p.id === scope.slice(2) : p.members.some((m) => m.box.name === scope.slice(2))));
  return (
    <section aria-label="Projects" data-testid="s2-section" data-section="projects" className={cn("flex flex-col border-sidebar-border border-t pt-1", open ? "min-h-18 flex-1 basis-0" : "mt-auto shrink-0")}>
      <div className="px-2">
        <SectionHead
          id="projects"
          label="Projects"
          folded={!open}
          right={
            <Menu>
              <Tip label="Projects and boxes">
                <MenuTrigger render={<button type="button" aria-label="Projects options" className={cn(iconBtn, "size-6 [&_svg]:size-3.5")} />}>
                  <EllipsisIcon />
                </MenuTrigger>
              </Tip>
              <MenuPopup align="end" className="min-w-52">
                <MenuItem onClick={() => useStore.getState().setView({ kind: "worktrees" })}>
                  <GitBranchIcon />
                  All worktrees
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => useStore.getState().openAddLocation()}>
                  <FolderPlusIcon />
                  Add a project…
                </MenuItem>
                <MenuItem onClick={openAddBox}>
                  <ServerIcon />
                  Add a box…
                </MenuItem>
              </MenuPopup>
            </Menu>
          }
        />
      </div>
      {open && (
        <Fade testid="s2-projects" top={false} className="min-h-0 flex-1 pb-2">
          <ul className="flex flex-col gap-px">
            {list.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        </Fade>
      )}
    </section>
  );
}

interface Node {
  key: string;
  place: Place;
  live: boolean;
}

function ProjectRow({ p }: { p: Project }) {
  const open = useS2((s) => s.open[p.id] ?? false);
  const quiet = useS2((s) => s.quiet[p.id] ?? false);
  const data = useStore((s) => s.boxes);
  const current = useWorkspaces((s) => s.current);
  const boxCount = useStore((s) => s.status?.boxes.length ?? 0);
  const multi = p.members.length > 1;
  const rows: Node[] = p.members.flatMap((m) =>
    (m.loc.worktrees ?? [])
      .slice()
      .sort((a, b) => Number(!!b.main) - Number(!!a.main) || worktreeLabel(a).localeCompare(worktreeLabel(b)))
      .map((wt) => {
        const key = wsKey(m.box.name, wt.path);
        const live = m.box.state === "online" && worktreeSessions(data[m.box.name]?.sessions, wt).some((s) => !s.exited && !s.service);
        return { key, place: { box: m.box.name, loc: m.loc, wt, project: p }, live: live || current === key };
      }),
  );
  // What its row says folded: how many need you, else how many work.
  const states = rows.flatMap((r) => (r.live ? worktreeSessions(data[r.place.box]?.sessions, r.place.wt).filter((s) => !s.exited && agentOf(s)).map((s) => sessionState(s, data[r.place.box]?.stats)) : []));
  const needs = states.filter((s) => s === "waiting").length;
  const works = states.filter((s) => s === "running").length;
  const tree = nest(
    rows.filter((r) => quiet || r.live || r.place.wt.main),
    (r) => r.key,
    (r) => (r.place.wt.parent ? wsKey(r.place.box, r.place.wt.parent) : undefined),
  );
  const quietCount = rows.filter((r) => !r.live && !r.place.wt.main).length;
  return (
    <li>
      {/* Sticky while its worktrees scroll under it, so they keep their parent. */}
      <button
        type="button"
        data-testid="s2-project"
        data-project={p.name}
        aria-expanded={open}
        onClick={() => toggleIn("open", p.id)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
            e.preventDefault();
            toggleIn("open", p.id);
          }
        }}
        className={cn(rowBase, "sticky top-0 z-10 h-side-row items-center bg-sidebar hover:bg-[color-mix(in_oklab,var(--sidebar-accent)_60%,var(--sidebar))]")}
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </span>
        <span className="min-w-0 truncate font-medium text-[13px]">{p.name}</span>
        {/* Where it is, muted and on every project alike, when there is more than one box. */}
        {boxCount > 1 && <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">{p.members.map((m) => m.box.name).join(", ")}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
          {needs > 0 ? (
            <span aria-label={`${needs} ${needs === 1 ? "needs" : "need"} you`} className="flex items-center gap-1 text-warning-foreground">
              <span className="size-1.5 rounded-full bg-warning" />
              {needs}
            </span>
          ) : works > 0 ? (
            <span aria-label={`${works} working`} className="flex items-center gap-1">
              <StateGlyph state="running" className="size-3" />
              {works}
            </span>
          ) : null}
        </span>
      </button>
      {open && (
        <ul className="ml-[15px] flex flex-col gap-px border-sidebar-border border-l pl-1">
          {/* On several boxes: each box's worktrees under its name, once,
              rather than a chip on every row. */}
          {multi ? (
            p.members.map((m) => {
              const mine = tree.filter((n) => n.row.place.box === m.box.name);
              if (!mine.length) return null;
              return (
                <li key={m.box.name}>
                  <span className="flex h-6 items-end px-2 pb-1 font-medium text-[11px] text-muted-foreground">on {m.box.name}</span>
                  <ul className="flex flex-col gap-px">
                    <Nodes nodes={mine} depth={0} />
                  </ul>
                </li>
              );
            })
          ) : (
            <Nodes nodes={tree} depth={0} />
          )}
          {quietCount > 0 && <MoreRow label={quiet ? "Hide quiet worktrees" : `${quietCount} quiet ${quietCount === 1 ? "worktree" : "worktrees"}`} onClick={() => toggleIn("quiet", p.id)} />}
        </ul>
      )}
    </li>
  );
}

function Nodes({ nodes, depth }: { nodes: TreeNode<Node>[]; depth: number }) {
  return nodes.map((n) => <NodeRows key={n.key} n={n} depth={depth} />);
}

function NodeRows({ n, depth }: { n: TreeNode<Node>; depth: number }) {
  return (
    <>
      <WorktreeLine place={n.row.place} depth={depth} inProject />
      {n.children.length > 0 && <Nodes nodes={n.children} depth={depth + 1} />}
    </>
  );
}

// ---- Footer -----------------------------------------------------------------

// Footer: Settings, and a box that isn't online, said once, with a way back.
function Footer() {
  const view = useStore((s) => s.view);
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const away = boxes.filter((b) => b.state !== "online");
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-sidebar-border border-t px-2">
      <Tip label="⇧-click for Developer settings" side="top" align="start">
        <button
          type="button"
          data-testid="nav-settings"
          aria-current={view.kind === "settings" ? "page" : undefined}
          onClick={(e) => useStore.getState().setView({ kind: "settings", section: e.shiftKey ? "developer" : undefined })}
          className={cn("inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", view.kind === "settings" && "bg-sidebar-accent text-foreground")}
        >
          <SettingsIcon className="size-3.5" />
          Settings
        </button>
      </Tip>
      <span className="ml-auto" />
      {away.length === 1 ? <AwayBox box={away[0]} /> : away.length > 1 ? <AwayBoxes boxes={away} /> : null}
    </div>
  );
}

function AwayBox({ box }: { box: BoxStatus }) {
  const word = BOX_WORDS[boxState(box)].lower;
  return (
    <ContextRow items={() => boxActions(box)} className="min-w-0">
      <Tip label={`${box.name} is ${word}. Click to reconnect; right-click for more.`} side="top" align="end">
        <button
          type="button"
          data-testid="s2-away-box"
          aria-label={`${box.name} is ${word}. Reconnect`}
          onClick={() => void useStore.getState().refreshAll()}
          className="inline-flex h-6.5 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ServerOffIcon className="size-3 shrink-0" />
          <span className="hidden truncate @min-[14.5rem]/side:inline">
            {box.name} {word}
          </span>
          <span className="@min-[14.5rem]/side:hidden">1 {word}</span>
        </button>
      </Tip>
    </ContextRow>
  );
}

function AwayBoxes({ boxes }: { boxes: BoxStatus[] }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-testid="s2-away-box"
            className="inline-flex h-6.5 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent"
          />
        }
      >
        <ServerOffIcon className="size-3" />
        {boxes.length} boxes away
      </MenuTrigger>
      <MenuPopup side="top" align="end" className="min-w-52">
        {boxes.map((b) => (
          <MenuItem key={b.name} onClick={() => void useStore.getState().refreshAll()}>
            <ServerOffIcon />
            {b.name} is {BOX_WORDS[boxState(b)].lower}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
