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
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { WhatsNewNudge } from "@/components/whats-new/whats-new-dialog";
import { WtDot } from "@/components/workspace/worktree-tone";
import type { BoxStatus, Location, Session, Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionState, worktreeSessions } from "@/lib/derive";
import { ago } from "@/lib/format";
import { findLeaf, leaves } from "@/lib/layout";
import { platformKeys } from "@/lib/platform";
import { usePrefs } from "@/lib/prefs";
import { type Project, useProjects } from "@/lib/project-groups";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar-width";
import { BOX_WORDS, boxState } from "@/lib/state-model";
import { load, save } from "@/lib/storage";
import { type BoxData, NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openSession, refOf, selectWorktree, splitKey, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";
import { MAX_INDENT, nest, type TreeNode } from "@/lib/worktree-tree";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { useReviewCount } from "@/views/review/review-store";
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
export function asks(s: Session): string {
  const a = s.ask;
  if (a?.tool === "Bash" && a.input) return `Wants to run ${clip(a.input)}`;
  if ((a?.tool === "Edit" || a?.tool === "Write" || a?.tool === "MultiEdit") && a.input) return `Wants to edit ${base(a.input)}`;
  if (a?.message) return clip(a.message);
  if (a?.tool === "AskUserQuestion") return "Has a question for you";
  if (a?.tool) return `Wants to use ${a.tool}`;
  return "Waiting for you";
}

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
  const order = ["automations", "worktrees", "dashboard", "kits"];
  const more = items.filter((i) => i.id !== "home" && i.id !== "review").sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  const here = more.find((n) => n.active);
  // Three even places, each an icon and a word (the word alone when the
  // sidebar is at its narrowest).
  const place = (active: boolean) =>
    cn(
      "inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 text-[12.5px] text-muted-foreground outline-none hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent [&_svg]:hidden [&_svg]:size-3.5 [&_svg]:shrink-0 @min-[14.5rem]/side:[&_svg]:inline",
      active && "bg-sidebar-accent text-foreground",
    );
  return (
    <nav aria-label="Places" className="flex shrink-0 items-center gap-0.5 px-2 pt-0.5 pb-1">
      {home && (
        <button type="button" data-testid="nav-home" aria-current={home.active ? "page" : undefined} onClick={home.go} className={place(home.active)}>
          <HouseIcon />
          <span className="truncate">Home</span>
        </button>
      )}
      {review && (
        <button type="button" data-testid="nav-review" aria-label={review.badge ? `Review, ${review.badge.count} to review` : "Review"} aria-current={review.active ? "page" : undefined} onClick={review.go} className={place(review.active)}>
          <InboxIcon />
          <span className="truncate">Review</span>
        </button>
      )}
      <Menu>
        <MenuTrigger render={<button type="button" data-testid="nav-more" aria-label={here ? `More: ${here.label}` : "More"} className={place(!!here)} />}>
          {here ? here.icon : <EllipsisIcon />}
          <span className="truncate">{here ? here.label : "More"}</span>
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
    <span className="flex min-w-0 shrink items-center">
      <Menu>
        <Tip label={name ? `Showing ${name} only` : "Show one project or box"}>
          <MenuTrigger
            render={
              <button
                type="button"
                data-testid="s2-scope"
                aria-label={name ? `Showing ${name}. Change` : "Show one project or box"}
                className={cn(iconBtn, "h-7 w-auto min-w-7 gap-1 px-1.5 text-[12px] [&_svg]:size-3.5", name && "max-w-28 rounded-r-none bg-sidebar-accent text-foreground")}
              />
            }
          >
            <ListFilterIcon />
            <span className={cn("truncate", !name && "hidden @min-[14.5rem]/side:inline")}>{name ?? "All projects"}</span>
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
          <button type="button" aria-label="Show everything" onClick={() => setS2({ scope: "all" })} className={cn(iconBtn, "h-7 w-5 rounded-l-none bg-sidebar-accent [&_svg]:size-3")}>
            <XIcon />
          </button>
        </Tip>
      )}
    </span>
  );
}

// Fade is a scrolling area with a fade at an edge there is more past, so a
// cut-off row reads as "more", not as a bug.
function Fade({ children, className, testid }: { children: ReactNode; className?: string; testid?: string }) {
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
      className={cn("overflow-y-auto overscroll-contain px-2", className)}
      style={{ maskImage: `linear-gradient(to bottom, ${edges.top ? "transparent, black 24px" : "black, black"}, ${edges.bottom ? "black calc(100% - 28px), transparent" : "black, black"})` }}
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

// Body is the agents' lists and, under them, the projects. The lists come
// first: they take what they need, up to about two thirds of the height,
// and scroll past that; the projects take the rest and scroll, or are their
// header alone, docked at the bottom, while folded.
function Body() {
  const all = useRailAgents();
  const scope = useS2((s) => s.scope);
  const pinned = useS2((s) => s.pinned);
  const showAll = useS2((s) => s.all);
  const projectsOpen = useS2((s) => !s.folded.projects);
  const spaces = useWorkspaces((s) => s.spaces);
  const index = usePlaceIndex();
  const toReview = useReviewCount();
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
    const out: { key: string; t: number; agent?: RailAgent; place?: Place }[] = [];
    const seen = new Set<string>([...busy, ...pins.map((p) => p.key)]);
    for (const e of agents.filter((x) => x.lane === "finished")) {
      out.push({ key: e.id, t: Date.parse(e.session.state_since ?? "") || 0, agent: e });
      seen.add(e.key);
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
  }, [agents, spaces, index, scope, pinned]);

  // A capped list keeps the agent in front, wherever it falls.
  const capped = <T,>(id: keyof typeof CAP, list: T[], isFront: (x: T) => boolean) => (showAll[id] ? list : list.filter((x, i) => i < CAP[id] || isFront(x)));
  const more = (id: keyof typeof CAP, n: number, shownN: number, word: string) =>
    n > shownN || (showAll[id] && n > CAP[id]) ? <MoreRow label={showAll[id] ? "Show fewer" : `${n - shownN} more ${word}`} onClick={() => toggleIn("all", id)} /> : null;
  const shownRunning = capped("running", running, (e) => e.id === front);
  const shownRecent = capped("recent", recent, (r) => r.agent?.id === front);
  const shown = [...waiting, ...shownRunning, ...shownRecent.flatMap((r) => (r.agent ? [r.agent] : [])), ...away];
  const marked = !!front && shown.some((e) => e.id === front);
  const review = toReview > 0 && scope === "all";

  return (
    <MarkedCtx.Provider value={marked}>
      <Fade testid="s2-lists" className={cn("min-h-16 pb-2", projectsOpen ? "max-h-[68%] shrink-0" : "flex-1")}>
        {(waiting.length > 0 || review) && (
          <Section id="waiting" label="Needs you" count={waiting.length} loud>
            {waiting.map((e) => (
              <NeedsRow key={e.id} e={e} front={front} />
            ))}
            {review && <ReviewRow count={toReview} />}
          </Section>
        )}
        {running.length > 0 && (
          <Section id="running" label="Working" count={running.length}>
            {shownRunning.map((e) => (
              <AgentLine key={e.id} e={e} front={front} />
            ))}
            {more("running", running.length, shownRunning.length, "working")}
          </Section>
        )}
        {!waiting.length && !running.length && !review && <p className="px-2 pt-3 pb-1 text-[12px] text-muted-foreground leading-snug">Nothing needs you and nothing is running. Start a task, or pick up where you left off.</p>}
        {pins.length > 0 && (
          <Section id="pinned" label="Pinned" count={pins.length}>
            {pins.map((p) => (
              <WorktreeLine key={p.key} place={p.place} />
            ))}
          </Section>
        )}
        {recent.length > 0 && (
          <Section id="recent" label="Recent" count={recent.length}>
            {shownRecent.map((r) => (r.agent ? <AgentLine key={r.key} e={r.agent} front={front} /> : <WorktreeLine key={r.key} place={r.place!} at={r.t} />))}
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

function SectionHead({ id, label, count, loud, folded, right }: { id: string; label: string; count?: number; loud?: boolean; folded: boolean; right?: ReactNode }) {
  return (
    <div className="group/head flex h-6 items-center pr-1 pl-2">
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
      <SectionHead id={id} label={label} count={count} loud={loud} folded={folded} />
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

// A row marked strongly is the agent in front; faintly (half the tint), a
// worktree in front whose agent row above already says so.
const rowBase =
  "group/r relative flex w-full gap-2 rounded-md px-2 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[selected=strong]:bg-sidebar-accent data-[selected=faint]:bg-sidebar-accent/50";

function pinAction(key: string): Action {
  const on = useS2.getState().pinned.includes(key);
  return { type: "item", label: on ? "Unpin" : "Pin to the sidebar", icon: on ? <PinOffIcon /> : <PinIcon />, run: () => togglePin(key) };
}

function agentMenu(e: RailAgent): Action[] {
  const box = useStore.getState().status?.boxes.find((b) => b.name === e.box);
  return [pinAction(e.key), { type: "sep" }, ...(e.away && box ? boxActions(box) : worktreeActions(e.box, e.loc, e.wt))];
}

const titleOf = (e: RailAgent) => e.session.title ?? (e.wt.main ? e.project : worktreeLabel(e.wt, e.loc));

function useMultiBox(project: string) {
  return useProjects().projects.some((p) => p.name === project && p.members.length > 1);
}

// NeedsRow is an agent that needs you: what its work is called and for how
// long, then what it asks for, in words, over up to two lines. Its hover
// card says where it is.
function NeedsRow({ e, front }: { e: RailAgent; front?: string }) {
  const multi = useMultiBox(e.project);
  const title = titleOf(e);
  const ask = asks(e.session);
  const where = `${wtName(e.loc, e.wt)} · ${e.project}${multi ? ` · ${e.box}` : ""}`;
  const selected = e.id === front;
  return (
    <li className="group/li relative">
      <ContextRow items={() => agentMenu(e)}>
        <Tip side="right" align="start" delay={500} className="max-w-none" label={<AgentCard e={e} />}>
          <button
            type="button"
            data-testid="s2-agent"
            data-session={`${e.box}/${e.session.name}`}
            data-agent-state={e.state}
            data-selected={selected ? "strong" : undefined}
            aria-current={selected || undefined}
            aria-label={`${title}. ${ask}. ${where}`}
            onClick={() => openSession(e.box, e.session)}
            className={cn(rowBase, "items-start py-[5px]")}
          >
            <span className="flex h-[18px] w-4 shrink-0 items-center justify-center">
              <StateGlyph state={e.state} className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-[13px] text-foreground leading-[18px]">{title}</span>
                <WtDot wsKey={e.key} className="size-1.5" />
                <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums">{since(e.session.state_since)}</span>
              </span>
              <span data-testid="s2-ask" className="line-clamp-2 break-words text-[12px] text-foreground/75 leading-4">
                {ask}
              </span>
            </span>
          </button>
        </Tip>
      </ContextRow>
    </li>
  );
}

// AgentLine is an agent on one line: its state, its worktree (the name you
// switch by, as the tree has it; the main checkout by its project), then,
// dimmed, its box when the project is on several, and what its work is
// called. The hover card has the rest.
function AgentLine({ e, front }: { e: RailAgent; front?: string }) {
  const multi = useMultiBox(e.project);
  const title = titleOf(e);
  const name = e.wt.main ? e.project : worktreeLabel(e.wt, e.loc);
  const where = `${name}${multi ? ` · ${e.box}` : ""}`;
  const dim = [multi ? e.box : "", title !== name ? title : ""].filter(Boolean).join(" · ");
  const selected = e.id === front;
  const time = e.away ? `${e.box} is ${e.away}` : since(e.session.state_since);
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
            aria-label={`${title}. ${where} in ${e.project}, ${time}`}
            onClick={() => openSession(e.box, e.session)}
            className={cn(rowBase, "h-side-row items-center")}
          >
            <span className="flex w-4 shrink-0 items-center justify-center">{e.away ? <ServerOffIcon className="size-3 text-muted-foreground" /> : <StateGlyph state={e.state} className="size-3.5" />}</span>
            <span className={cn("min-w-0 max-w-[60%] shrink-0 truncate text-[13px]", e.away && "text-muted-foreground")}>{name}</span>
            <WtDot wsKey={e.key} className="size-1.5" />
            {dim && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{dim}</span>}
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

function ReviewRow({ count }: { count: number }) {
  const active = useStore((s) => s.view.kind === "review");
  return (
    <li>
      <button type="button" data-testid="s2-review" data-selected={active ? "strong" : undefined} aria-current={active || undefined} onClick={() => useStore.getState().setView({ kind: "review" })} className={cn(rowBase, "h-side-row items-center")}>
        <span className="flex w-4 shrink-0 items-center justify-center">
          <InboxIcon className="size-3.5 text-muted-foreground" />
        </span>
        <span className="min-w-0 truncate text-[13px]">
          {count} {count === 1 ? "change" : "changes"} to review
        </span>
      </button>
    </li>
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
          <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{glyph}</span>
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
        <Fade testid="s2-projects" className="min-h-0 flex-1 pb-2">
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
        className={cn(rowBase, "h-side-row items-center")}
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </span>
        <span className="min-w-0 truncate font-medium text-[13px]">{p.name}</span>
        {/* Where it is, muted and on every project alike, when there is more than one box. */}
        {boxCount > 1 && <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">{p.members.map((m) => m.box.name).join(", ")}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
          {!open && needs > 0 ? (
            <span aria-label={`${needs} ${needs === 1 ? "needs" : "need"} you`} className="flex items-center gap-1 text-warning-foreground">
              <span className="size-1.5 rounded-full bg-warning" />
              {needs}
            </span>
          ) : !open && works > 0 ? (
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
                  <span className="flex h-6 items-center px-2 font-medium text-[11px] text-muted-foreground">on {m.box.name}</span>
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
          onClick={() => void useStore.getState().refreshAll()}
          className="inline-flex h-6.5 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ServerOffIcon className="size-3 shrink-0" />
          <span className="truncate">
            {box.name} {word}
          </span>
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
