import {
  EllipsisIcon,
  FolderPlusIcon,
  InboxIcon,
  ListFilterIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { compose, useInbox, useInboxItems } from "@/components/inbox/inbox-state";
import { InboxRow } from "@/components/inbox/inbox-row";
import { NotificationBell } from "@/components/notifications/notification-center";
import { MoreItems, useArrangedNav } from "@/components/sidebar/nav";
import { Projects, useSidebarPrefs } from "@/components/sidebar/projects";
import { RailAgents } from "@/components/sidebar/rail";
import { RowLayer } from "@/components/sidebar/row-layer";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarContext, type SidebarContextProps } from "@/components/ui/sidebar";
import { toastManager } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import { afterDone, arrange, filterOn, type Hold, holdOf, type InboxItem, type InboxSection, markDone, prune, SECTION_WORDS, step, undone } from "@/lib/inbox";
import { usePrefs } from "@/lib/prefs";
import { useProjects } from "@/lib/project-groups";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { homeBox, openSession, useWorkspaces, wsKey } from "@/lib/workspaces";
import { openAddBox } from "@/views/onboarding/add-box-dialog";

// The inbox layout (Labs › Layout › Inbox): instead of a sidebar of places
// and projects, one list of every agent by what it needs from you, beside
// the worktree you open from it. j and k move, ↵ opens, e marks done, z
// undoes, c starts new work, ⌘J comes back to the list from anywhere.
// The projects tree is a tab away; Review, Automations and the rest are
// at the foot, Settings beside them.
//
// ⌘\ folds the list into a strip of the agents by state (the sidebar's
// rail). A narrow window folds it on its own while a worktree is open, and
// the strip's inbox button lays the list over the worktree until a row is
// picked.

const alwaysOpen: SidebarContextProps = {
  state: "expanded",
  open: true,
  setOpen: () => {},
  openMobile: false,
  setOpenMobile: () => {},
  isMobile: false,
  toggleSidebar: () => {},
};

// Recent shows this many until asked for the rest.
const RECENT = 3;

export function InboxPane() {
  const collapsed = usePrefs((p) => p.sidebarCollapsed);
  const narrow = useMediaQuery("max-lg");
  const hasWorktree = useWorkspaces((s) => !!s.current && !homeBox(s.current));
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const worktreeOpen = hasWorktree && inWorkspace;
  const peek = useInbox((s) => s.peek);
  const focusAsk = useInbox((s) => s.focusAsk);
  const folded = collapsed || (narrow && worktreeOpen);

  // ⌘J: unfold (or lay the list over a narrow window), then the list takes
  // the keyboard once drawn.
  useEffect(() => {
    if (!focusAsk) return;
    if (collapsed && !narrow) usePrefs.setState({ sidebarCollapsed: false });
    else if (narrow && worktreeOpen) useInbox.setState({ peek: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsk]);
  useEffect(() => {
    if (!folded) useInbox.setState({ peek: false });
  }, [folded]);

  if (!folded) return <InboxList />;
  return (
    <>
      <InboxStrip />
      {peek && (
        <>
          <div aria-hidden className="fixed inset-0 z-40 bg-black/30" onClick={() => useInbox.setState({ peek: false })} />
          <div className="fixed top-0 bottom-[var(--berth-status-h,26px)] left-0 z-50 flex shadow-2xl" onKeyDown={(e) => e.key === "Escape" && useInbox.setState({ peek: false })}>
            <InboxList overlay />
          </div>
        </>
      )}
    </>
  );
}

// ---- The list ---------------------------------------------------------------

function InboxList({ overlay }: { overlay?: boolean }) {
  const tab = useInbox((s) => s.tab);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const context = useMemo(() => alwaysOpen, []);
  const noBoxes = useStore((s) => !!s.status && s.status.boxes.length === 0);

  return (
    <SidebarContext.Provider value={context}>
      <aside
        aria-label="Inbox"
        data-testid="inbox"
        data-inbox
        className={cn("@container/side relative flex w-[clamp(288px,26vw,360px)] shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground", overlay && "w-[min(360px,92vw)]")}
      >
        <div data-tauri-drag-region className="flex h-10 shrink-0 items-center justify-end gap-0.5 px-2">
          <NotificationBell />
          {overlay ? (
            <Tip label="Close the list (esc)">
              <button type="button" aria-label="Close the list" onClick={() => useInbox.setState({ peek: false })} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
                <XIcon className="size-3.5" />
              </button>
            </Tip>
          ) : (
            <Tip label={"Fold the list (⌘\\)"}>
              <button type="button" aria-label="Fold the list" onClick={() => usePrefs.setState({ sidebarCollapsed: true })} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
                <PanelLeftCloseIcon className="size-3.5" />
              </button>
            </Tip>
          )}
        </div>

        <div className="flex flex-col gap-1.5 px-2.5 pb-2">
          <button
            type="button"
            data-testid="inbox-compose"
            onClick={compose}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background px-2.5 font-medium text-[13px] text-foreground shadow-xs/5 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SquarePenIcon className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">New task</span>
            <Kbd className="h-4.5 text-[10px]">C</Kbd>
          </button>
          <button
            type="button"
            onClick={() => useStore.getState().setPaletteOpen(true)}
            className="flex h-7 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background/50 px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent"
          >
            <SearchIcon className="size-3.5" />
            <span className="flex-1 text-left">Search</span>
            <Kbd className="h-4.5 text-[10px]">⌘K</Kbd>
          </button>
        </div>

        <div className={cn("flex items-center gap-1 border-sidebar-border border-b px-2.5 pb-1.5", noBoxes && "hidden")}>
          <TabButton id="inbox" label="Inbox" />
          <TabButton id="projects" label="Projects" />
          <span className="ml-auto flex items-center">{tab === "inbox" ? <FilterMenu /> : <ProjectsMenu />}</span>
        </div>

        {tab === "inbox" ? <TriageList /> : <ProjectsTree />}

        <Foot view={view.kind} onSettings={(dev) => setView({ kind: "settings", section: dev ? "developer" : undefined })} />
      </aside>
    </SidebarContext.Provider>
  );
}

function TabButton({ id, label }: { id: "inbox" | "projects"; label: string }) {
  const tab = useInbox((s) => s.tab);
  const items = useInboxItems();
  const needs = items.filter((i) => i.section === "needs").length;
  const on = tab === id;
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={`inbox-tab-${id}`}
      onClick={() => useInbox.setState({ tab: id })}
      className={cn("inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 font-medium text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", on ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
      {id === "inbox" && needs > 0 && <span className="rounded-full bg-warning/15 px-1.5 text-[10px] text-warning-foreground tabular-nums leading-4">{needs}</span>}
    </button>
  );
}

// ---- Triage -----------------------------------------------------------------

function TriageList() {
  const items = useInboxItems();
  const done = useInbox((s) => s.done);
  const filter = useInbox((s) => s.filter);
  const showDone = useInbox((s) => s.showDone);
  const cursor = useInbox((s) => s.cursor);
  const focusAsk = useInbox((s) => s.focusAsk);
  const current = useWorkspaces((s) => s.current);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const loading = useStore((s) => !s.status || s.status.boxes.some((b) => b.state === "online" && !s.boxes[b.name]?.sessions));
  const statusBoxes = useStore((s) => s.status?.boxes ?? NONE);
  const offline = useMemo(() => statusBoxes.filter((b) => b.state !== "online").map((b) => b.name), [statusBoxes]);
  const [allRecent, setAllRecent] = useState(false);
  // ? shows every key at the list's foot, until pressed again.
  const [allKeys, setAllKeys] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Rows hold their places while the pointer or the keyboard is in the list.
  const [hold, setHold] = useState<Hold>();
  const inside = useRef({ pointer: false, focus: false });
  const { sections, hidden } = useMemo(() => arrange(items, { done, filter, showDone, hold }), [items, done, filter, showDone, hold]);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const holdOn = (what: "pointer" | "focus", on: boolean) => {
    const was = inside.current.pointer || inside.current.focus;
    inside.current[what] = on;
    const now = inside.current.pointer || inside.current.focus;
    if (now && !was) setHold(holdOf(sectionsRef.current.flatMap((x) => x.items)));
    else if (!now && was) setHold(undefined);
  };
  const shown = useMemo(() => sections.map((s) => (s.section === "recent" && !allRecent ? { ...s, more: Math.max(0, s.items.length - RECENT), items: s.items.slice(0, RECENT) } : { ...s, more: 0 })), [sections, allRecent]);
  const order = useMemo(() => shown.flatMap((s) => s.items), [shown]);

  // Marks for rows that moved on are let go of.
  useEffect(() => {
    if (loading) return;
    const next = prune(done, items);
    if (Object.keys(next).length !== Object.keys(done).length) useInbox.setState({ done: next });
  }, [items, done, loading]);

  const focusRow = useCallback((id: string | undefined) => {
    useInbox.setState({ cursor: id });
    if (!id) return;
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));
  }, []);

  const open = useCallback((it: InboxItem) => {
    useInbox.setState({ cursor: it.id, peek: false });
    openSession(it.box, it.session);
  }, []);

  const toggleDone = useCallback(
    (it: InboxItem) => {
      const s = useInbox.getState();
      if (s.done[it.id] === it.since) {
        useInbox.setState({ done: undone(s.done, it.id) });
        return;
      }
      const next = afterDone(order, it.id);
      useInbox.setState({ done: markDone(s.done, it), last: { id: it.id, since: it.since } });
      if (listRef.current?.contains(document.activeElement)) focusRow(next);
      else useInbox.setState({ cursor: next });
      toastManager.add({
        title: "Marked done",
        description: `${it.title}. It comes back if the agent needs you again.`,
        actionProps: { children: "Undo", onClick: () => undoDone() },
      });
    },
    [order, focusRow],
  );

  // On arrival, with the keyboard nowhere else, the list takes it.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || !order.length) return;
    arrived.current = true;
    if (document.activeElement === document.body || !document.activeElement) focusRow(order[0].id);
  }, [order, focusRow]);

  // ⌘J and the strip's button: the list takes the keyboard.
  useEffect(() => {
    if (!focusAsk) return;
    const id = order.some((o) => o.id === cursor) ? cursor : order[0]?.id;
    focusRow(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsk]);

  // The keys. On the window, but only while the keyboard is in the list or
  // nowhere at all (a click on empty page), never in a terminal, a text
  // field or a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inList = !!t?.closest("[data-inbox]");
      if (t && t !== document.body && !inList) return;
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog]")) return;
      if (document.querySelector('[data-slot="dialog-popup"], [data-slot="alert-dialog-popup"], [data-slot="sheet-popup"]')) return;
      const cur = order.find((o) => o.id === useInbox.getState().cursor);
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          focusRow(step(order, cur?.id, 1));
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          focusRow(step(order, cur?.id, -1));
          return;
        case "Enter":
          if (t?.closest("button") || !cur) return;
          e.preventDefault();
          open(cur);
          return;
        case "o":
          if (!cur) return;
          e.preventDefault();
          open(cur);
          return;
        case "e":
        case "Backspace":
          if (!cur) return;
          e.preventDefault();
          toggleDone(cur);
          return;
        case "z":
          e.preventDefault();
          undoDone();
          return;
        case "c":
          e.preventDefault();
          compose();
          return;
        case "/":
          e.preventDefault();
          useStore.getState().setPaletteOpen(true);
          return;
        case "?":
          e.preventDefault();
          setAllKeys((v) => !v);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, focusRow, open, toggleDone]);

  const cursorId = order.some((o) => o.id === cursor) ? cursor : order[0]?.id;
  const openKey = inWorkspace ? current : undefined;
  const needsEmpty = !sections.some((s) => s.section === "needs");

  return (
    <>
    <RowLayer
      ref={listRef}
      role="navigation"
      aria-label="Agents"
      data-testid="inbox-list"
      onPointerEnter={() => holdOn("pointer", true)}
      onPointerLeave={() => holdOn("pointer", false)}
      onFocus={() => holdOn("focus", true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && holdOn("focus", false)}
      className="peer/list min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-3"
    >
      {loading && !items.length ? (
        <div className="flex flex-col gap-2 px-2 pt-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-sidebar-accent/60" />
          ))}
        </div>
      ) : !order.length && !filterOn(filter) ? (
        <Empty hidden={hidden} />
      ) : (
        <>
          {needsEmpty && (
            <Section section="needs" count={0}>
              <p data-testid="inbox-zero" className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                Nothing needs you right now.
              </p>
            </Section>
          )}
          {shown.map((s) => (
            <Section key={s.section} section={s.section} count={s.section === "recent" ? s.items.length + s.more : s.items.length}>
              <ul className="flex flex-col gap-px">
                {s.items.map((it) => (
                  <InboxRow
                    key={it.id}
                    it={it}
                    cursor={it.id === cursorId}
                    open={openKey === wsKey(it.box, it.path)}
                    done={done[it.id] === it.since}
                    live
                    onOpen={open}
                    onDone={toggleDone}
                    onFocus={(x) => useInbox.getState().cursor !== x.id && useInbox.setState({ cursor: x.id })}
                  />
                ))}
              </ul>
              {s.more > 0 && (
                <button type="button" onClick={() => setAllRecent(true)} className="mt-0.5 ml-[42px] rounded px-1 text-[11px] text-muted-foreground hover:text-foreground">
                  {s.more} more
                </button>
              )}
            </Section>
          ))}
          {!order.length && filterOn(filter) && <p className="px-2 py-3 text-[12px] text-muted-foreground">No agents match the filter.</p>}
        </>
      )}
      {(hidden > 0 || offline.length > 0) && (
        <div className="mt-3 flex flex-col gap-1 px-2 text-[11px] text-muted-foreground">
          {hidden > 0 && (
            <button type="button" data-testid="inbox-show-done" onClick={() => useInbox.setState((s) => ({ showDone: !s.showDone }))} className="self-start hover:text-foreground">
              {showDone ? `Hide ${hidden} marked done` : `${hidden} marked done · show`}
            </button>
          )}
          {offline.length > 0 && <span>{offline.length === 1 ? `${offline[0]} is offline: its agents aren't listed` : `${offline.length} boxes offline: their agents aren't listed`}</span>}
        </div>
      )}
    </RowLayer>
    {/* While the list has the keyboard: its keys, quietly, at its foot. */}
    <div
      data-testid="inbox-keys"
      className={cn("shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 overflow-hidden border-sidebar-border border-t px-3 py-1.5 text-[11px] text-muted-foreground", allKeys ? "flex" : "hidden flex-nowrap peer-focus-within/list:flex")}
    >
      {(allKeys ? ALL_KEYS : HINTS).map(([k, w]) => (
        <span key={k} className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <Kbd className="h-4 min-w-4 px-1 text-[10px]">{k}</Kbd>
          {w}
        </span>
      ))}
    </div>
    </>
  );
}

const HINTS: [string, string][] = [
  ["j k", "move"],
  ["↵", "open"],
  ["e", "done"],
  ["y n", "answer"],
  ["?", "keys"],
];

const ALL_KEYS: [string, string][] = [
  ["j k", "move"],
  ["↵", "open"],
  ["e", "done"],
  ["z", "undo"],
  ["y", "allow"],
  ["n", "deny"],
  ["c", "new task"],
  ["/", "search"],
  ["⌘J", "back to the list"],
  ["⌘\\", "fold"],
  ["?", "fewer keys"],
];

export function undoDone() {
  const s = useInbox.getState();
  if (!s.last) return;
  useInbox.setState({ done: undone(s.done, s.last.id), cursor: s.last.id, last: undefined });
}

function Section({ section, count, children }: { section: InboxSection; count: number; children: ReactNode }) {
  return (
    <section aria-label={`${SECTION_WORDS[section]}, ${count}`} data-testid="inbox-section" data-section={section} className="pb-2">
      <h2 className="sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-sidebar px-2 font-medium text-[11px] text-muted-foreground">
        {SECTION_WORDS[section]}
        {count > 0 && <span className={cn("tabular-nums", section === "needs" ? "text-warning-foreground" : "text-muted-foreground/70")}>{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Empty({ hidden }: { hidden: number }) {
  return (
    <div data-testid="inbox-empty" className="flex flex-col items-center gap-2 px-4 pt-10 text-center">
      <Scene name="calm" width={112} />
      <p className="font-medium text-[13px]">{hidden ? "All done" : "No agents yet"}</p>
      <p className="text-[12px] text-muted-foreground">An agent that needs you, is working or just finished shows here.</p>
      <button type="button" onClick={compose} className="mt-1 text-[12px] text-foreground underline-offset-2 hover:underline">
        Start a task (c)
      </button>
    </div>
  );
}

// ---- Filters ----------------------------------------------------------------

function FilterMenu() {
  const filter = useInbox((s) => s.filter);
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const { projects } = useProjects();
  const names = useMemo(() => [...new Set(projects.map((p) => p.name))].sort((a, b) => a.localeCompare(b)), [projects]);
  const on = filterOn(filter);
  const set = (f: Partial<typeof filter>) => useInbox.setState((s) => ({ filter: { ...s.filter, ...f } }));
  const words = [filter.project, filter.hiddenBoxes.length ? `${boxes.length - filter.hiddenBoxes.length} of ${boxes.length} boxes` : ""].filter(Boolean).join(" · ");
  return (
    <span className="flex items-center gap-0.5">
      {on && (
        <button type="button" data-testid="inbox-filter-clear" onClick={() => set({ hiddenBoxes: [], project: undefined })} className="inline-flex h-6 max-w-32 items-center gap-1 rounded-md bg-sidebar-accent px-1.5 text-[11px] text-foreground hover:bg-sidebar-accent/70">
          <span className="truncate">{words}</span>
          <XIcon className="size-3 shrink-0 text-muted-foreground" />
        </button>
      )}
      <Menu>
        <Tip label="Filter by box or project">
          <MenuTrigger
            render={<button type="button" aria-label="Filter" data-testid="inbox-filter" className={cn("inline-flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent", on && "text-foreground")} />}
          >
            <ListFilterIcon className="size-3.5" />
          </MenuTrigger>
        </Tip>
        <MenuPopup align="end" className="min-w-52">
          {boxes.length > 1 && (
            <MenuGroup>
              <MenuGroupLabel>Boxes</MenuGroupLabel>
              {boxes.map((b) => {
                const shown = !filter.hiddenBoxes.includes(b.name);
                return (
                  <MenuCheckboxItem
                    key={b.name}
                    checked={shown}
                    closeOnClick={false}
                    onCheckedChange={(v) => {
                      const hidden = v ? filter.hiddenBoxes.filter((h) => h !== b.name) : [...filter.hiddenBoxes, b.name];
                      // The last box shown stays shown.
                      if (hidden.length < boxes.length) set({ hiddenBoxes: hidden });
                    }}
                  >
                    {b.name}
                  </MenuCheckboxItem>
                );
              })}
            </MenuGroup>
          )}
          {boxes.length > 1 && <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel>Project</MenuGroupLabel>
            <MenuRadioGroup value={filter.project ?? ""} onValueChange={(v) => set({ project: (v as string) || undefined })}>
              <MenuRadioItem value="">All projects</MenuRadioItem>
              {names.map((n) => (
                <MenuRadioItem key={n} value={n}>
                  {n}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </span>
  );
}

// ---- Projects, the tree a tab away -------------------------------------------

function ProjectsTree() {
  const [prefs, update] = useSidebarPrefs();
  return (
    <RowLayer data-testid="inbox-projects" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
      <Projects prefs={prefs} update={update} />
    </RowLayer>
  );
}

function ProjectsMenu() {
  const [prefs, update] = useSidebarPrefs();
  return (
    <Menu>
      <MenuTrigger render={<button type="button" aria-label="Projects options" className="inline-flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent" />}>
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem onClick={() => useStore.getState().openAddLocation()}>
          <FolderPlusIcon />
          Add a project…
        </MenuItem>
        <MenuItem onClick={openAddBox}>
          <ServerIcon />
          Add a box…
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Show</MenuGroupLabel>
          <MenuRadioGroup value={prefs.show} onValueChange={(v) => update({ show: v as typeof prefs.show })}>
            <MenuRadioItem value="active">Active worktrees</MenuRadioItem>
            <MenuRadioItem value="all">All worktrees</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <MenuGroupLabel>Group by</MenuGroupLabel>
          <MenuRadioGroup value={prefs.groupBy} onValueChange={(v) => update({ groupBy: v as typeof prefs.groupBy })}>
            <MenuRadioItem value="project">Project</MenuRadioItem>
            <MenuRadioItem value="box">Box</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

// ---- The foot: the other places, and Settings ---------------------------------

function Foot({ view, onSettings }: { view: string; onSettings(dev: boolean): void }) {
  const { pinned, more } = useArrangedNav();
  // Home is the list itself and the composer; the projects tree is a tab.
  const places = pinned.filter((n) => n.id !== "home" && n.id !== "worktrees");
  const rest = [...pinned.filter((n) => n.id === "worktrees"), ...more];
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-sidebar-border border-t px-1.5">
      {places.map((n) => (
        <button
          key={n.id}
          type="button"
          data-testid={`inbox-nav-${n.id}`}
          aria-current={n.active ? "page" : undefined}
          onClick={n.go}
          className={cn(
            "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
            n.active && "bg-sidebar-accent text-foreground",
          )}
        >
          {n.icon}
          <span className="truncate @max-[250px]/side:hidden">{n.label}</span>
          {n.badge && <span className={cn("text-[10px] tabular-nums", n.badge.loud ? "text-warning-foreground" : "text-muted-foreground")}>{n.badge.count}</span>}
        </button>
      ))}
      <Menu>
        <Tip label="More places">
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="More"
                className={cn("inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent", rest.some((n) => n.active) && "text-foreground")}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
        </Tip>
        <MenuPopup side="top" align="start" className="min-w-52">
          <MoreItems more={rest} />
        </MenuPopup>
      </Menu>
      <Tip label="⇧-click for Developer settings" side="top">
        <button
          type="button"
          data-testid="nav-settings"
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={(e) => onSettings(e.shiftKey)}
          className={cn("ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground", view === "settings" && "bg-sidebar-accent text-foreground")}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </Tip>
    </div>
  );
}

// ---- Folded: the strip ---------------------------------------------------------

function InboxStrip() {
  const view = useStore((s) => s.view);
  const narrow = useMediaQuery("max-lg");
  const collapsed = usePrefs((p) => p.sidebarCollapsed);
  const items = useInboxItems();
  const needs = items.filter((i) => i.section === "needs").length;
  const unfold = () => {
    if (collapsed && !narrow) usePrefs.setState({ sidebarCollapsed: false });
    else useInbox.setState({ peek: true });
    useInbox.setState((s) => ({ tab: "inbox", focusAsk: s.focusAsk + 1 }));
  };
  const item = (label: string, icon: ReactNode, onClick: () => void, opts: { active?: boolean; badge?: number; testid?: string } = {}) => (
    <Tip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        data-testid={opts.testid}
        onClick={onClick}
        className={cn("relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4", opts.active && "bg-sidebar-accent text-foreground")}
      >
        {icon}
        {opts.badge ? <span className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-warning px-1 text-[9px] text-warning-foreground leading-3.5 tabular-nums dark:text-background">{opts.badge}</span> : null}
      </button>
    </Tip>
  );
  return (
    <aside aria-label="Inbox, folded" data-testid="inbox-strip" data-inbox className="relative flex w-19 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar">
      <div data-tauri-drag-region className="h-10 w-full shrink-0" />
      <div className="flex flex-col items-center gap-1">
        {item(narrow && !collapsed ? "Show the list (⌘J)" : "Show the list (⌘\\)", collapsed && !narrow ? <PanelLeftOpenIcon /> : <InboxIcon />, unfold, { badge: needs, testid: "inbox-unfold" })}
        {item("New task (c)", <SquarePenIcon />, compose)}
        {item("Search (⌘K)", <SearchIcon />, () => useStore.getState().setPaletteOpen(true))}
        <NotificationBell size="rail" />
      </div>
      <div className="mt-2 min-h-0 w-full flex-1">
        <RailAgents />
      </div>
      <div className="flex flex-col items-center gap-1 pt-1 pb-2">{item("Settings", <SettingsIcon />, () => useStore.getState().setView({ kind: "settings" }), { active: view.kind === "settings" })}</div>
    </aside>
  );
}
