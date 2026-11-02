import { EllipsisIcon, PanelLeftIcon, PanelLeftOpenIcon, PenLineIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { memo, type ReactNode, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { NotificationBell } from "@/components/notifications/notification-center";
import { ContextRow, DotsMenu, projectGroupActions } from "@/components/sidebar/actions";
import { BackForward } from "@/components/sidebar/back-forward";
import { switchTo, useIdle, usePicked } from "@/components/sidebar/columns";
import { ink, inkScale } from "@/components/sidebar/ink";
import { MoreItems, type NavItem, useArrangedNav } from "@/components/sidebar/nav";
import { AwayWord, PlaceTip, ProjectTreeRows, RowButton, type SidebarPrefs, summary, useProjectTree } from "@/components/sidebar/projects";
import { SidebarResizeHandle } from "@/components/sidebar/resize-handle";
import { RowLayer } from "@/components/sidebar/row-layer";
import { SkillsNotices } from "@/components/sidebar/skills-notice";
import { awayText, BoxesFoot } from "@/components/sidebar/task-parts";
import { Tip } from "@/components/tip";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { SidebarMenuSub } from "@/components/ui/sidebar";
import { WhatsNewNudge } from "@/components/whats-new/whats-new-dialog";
import type { Location, Session } from "@/lib/api";
import type { SessionState } from "@/lib/derive";
import { identicon } from "@/lib/identicon";
import { usePrefs } from "@/lib/prefs";
import { avatarUrl, githubOwner } from "@/lib/project-avatar";
import { type Project, useProjects } from "@/lib/project-groups";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar-width";
import { openComposer } from "@/lib/composer";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TeamSidebarCard } from "@/views/team/team-entry";

// The rail sidebar, the default layout: a narrow rail of the places and
// every project's avatar, and beside it, on its own sheet, the picked
// project's worktrees. With one project there is nothing to switch between,
// so the rail stays away and the places sit at the top of the sheet.

type Update = (p: Partial<SidebarPrefs>) => void;

// RAIL is the rail's width; the sheet beside it is as wide as the list
// sidebar would be, and its edge sizes it the same way.
const RAIL = 60; // w-rail, as a number for the sheet's width

const inWorktrees = (loc: Location, s: Session) => !s.service && !!loc.worktrees?.some((w) => w.path === s.dir);

export function RailSidebar({ prefs, update, places }: { prefs: SidebarPrefs; update: Update; places: ReactNode }) {
  const { projects, sections } = useProjects();
  const noBoxes = useStore((s) => !!s.status && s.status.boxes.length === 0);
  // Loose projects, then each section's, as the other layouts list them.
  const ordered = useMemo(() => [...projects.filter((p) => !p.section), ...sections.flatMap((name) => projects.filter((p) => p.section === name))], [projects, sections]);
  const picked = usePicked("project");
  const project = picked?.kind === "project" ? picked.project : undefined;
  const rail = ordered.length > 1;
  const sheet = `clamp(${SIDEBAR_MIN}px, var(--sidebar-live, var(--sidebar-w, ${SIDEBAR_DEFAULT}px)), max(${SIDEBAR_DEFAULT}px, min(${SIDEBAR_MAX}px, 40vw)))`;

  return (
    <aside
      aria-label="Sidebar"
      data-testid="sidebar"
      data-layout="rail"
      style={{ width: rail ? `calc(${RAIL}px + ${sheet})` : sheet }}
      className={cn("@container/side relative flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground", inkScale)}
    >
      <SidebarResizeHandle />
      <TopStrip />
      <div className="flex min-h-0 flex-1">
        {rail && <ProjectRail projects={ordered} picked={project?.id} />}
        {/* The sheet's top border is the tab bar's bottom one carried on:
            both bands are h-bar, the tab bar's border on its last pixel. */}
        <div
          data-testid="sidebar-sheet"
          className={cn("flex min-w-0 flex-1 flex-col", rail ? "-mt-px rounded-tl-xl border-sidebar-border border-t border-l bg-background" : "pl-px")}
        >
          {/* The places' own gutters are the list sidebar's, from the
              aside's edge: the sheet's pixel in comes off them. */}
          {!rail && <div className="-ml-px">{places}</div>}
          <TeamSidebarCard />
          {noBoxes ? null : project ? <ProjectSheet key={project.id} project={project} prefs={prefs} update={update} /> : <NoProjects />}
          <SkillsNotices />
          <WhatsNewNudge />
          <div className={cn("flex h-[34px] shrink-0 items-center gap-1", lanes.box)}>
            <BoxesFoot />
            {!rail && <SettingsButton />}
          </div>
        </div>
      </div>
    </aside>
  );
}

// TopStrip is the window's strip over both: room for the traffic lights,
// then Back and Forward, the notifications and the way to fold the sidebar.
// It drags the window.
function TopStrip() {
  return (
    <div data-tauri-drag-region className="flex h-bar shrink-0 items-center justify-end gap-0.5 px-edge">
      <BackForward />
      <NotificationBell className="size-7 rounded-lg [&_svg]:size-4" />
      <Tip label={"Hide the sidebar (⌘\\)"} side="bottom" align="end">
        <button
          type="button"
          aria-label="Hide the sidebar"
          onClick={() => usePrefs.setState({ sidebarCollapsed: true })}
          className={cn("inline-flex size-7 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-[18px]", ink.glyph)}
        >
          <PanelLeftIcon strokeWidth={1.8} />
        </button>
      </Tip>
    </div>
  );
}

// ---- The rail ------------------------------------------------------------------

// FoldedRail is the rail sidebar folded away (⌘\): the rail alone, wide
// enough for the traffic lights over it, with search and the
// notifications (the strip that held them is folded away too) and a way
// back. A tile opens the sheet again on its project.
export function FoldedRail() {
  const { projects, sections } = useProjects();
  const ordered = useMemo(() => [...projects.filter((p) => !p.section), ...sections.flatMap((name) => projects.filter((p) => p.section === name))], [projects, sections]);
  const picked = usePicked("project");
  return (
    <aside aria-label="Sidebar" data-testid="sidebar-rail" data-layout="rail" className={cn("relative flex w-rail-folded shrink-0 flex-col border-sidebar-border border-r bg-sidebar", inkScale)}>
      <SidebarResizeHandle folded />
      <div data-tauri-drag-region className="h-bar w-full shrink-0" />
      <ProjectRail projects={ordered} picked={picked?.kind === "project" ? picked.project.id : undefined} folded />
    </aside>
  );
}

// ProjectRail is the column of icons: the pinned places (More holds the
// rest), then a tile per project and a way to add one, and Settings at the
// foot.
function ProjectRail({ projects, picked, folded }: { projects: Project[]; picked?: string; folded?: boolean }) {
  const { pinned, more } = useArrangedNav();
  // Projects of one GitHub owner have the same avatar; a letter tells them
  // apart.
  const shared = useMemo(() => {
    const owners = projects.map((p) => githubOwner(p.slug, p.remote));
    return new Set(projects.filter((_, i) => owners[i] && owners.indexOf(owners[i]) !== owners.lastIndexOf(owners[i])).map((p) => p.id));
  }, [projects]);
  return (
    <nav aria-label="Places and projects" data-testid="project-rail" style={folded ? undefined : { width: RAIL }} className={cn("flex shrink-0 flex-col items-center pt-1 pb-2", folded && "min-h-0 w-full flex-1")}>
      <div className="flex flex-col items-center gap-1">
        {folded && (
          <>
            <Tip label="Search (⌘K)" side="right">
              <button type="button" aria-label="Search" onClick={() => useStore.getState().setPaletteOpen(true)} className={cn(railButton, ink.row)}>
                <SearchIcon />
              </button>
            </Tip>
            <NotificationBell size="rail" />
          </>
        )}
        {pinned.map((n) => (
          <PlaceIcon key={n.id} item={n} />
        ))}
        {more.length > 0 && <MorePlaces more={more} />}
      </div>
      <span aria-hidden className="my-2.5 h-px w-5 shrink-0 bg-sidebar-border" />
      <div role="group" aria-label="Projects" className="-mx-px flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-px pt-0.5 pb-1 [scrollbar-width:none]">
        {projects.map((p) => (
          <ProjectTile key={p.id} project={p} selected={p.id === picked} shared={shared.has(p.id)} folded={!!folded} />
        ))}
        <Tip label="Add a project…" side="right">
          <button
            type="button"
            aria-label="Add a project"
            onClick={() => useStore.getState().openAddLocation()}
            className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-sidebar-border border-dashed hover:border-solid hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-3.5", ink.glyph)}
          >
            <PlusIcon strokeWidth={2} />
          </button>
        </Tip>
      </div>
      <SettingsButton rail />
      {folded && (
        <Tip label={"Show the sidebar (⌘\\)"} side="right">
          <button type="button" aria-label="Show the sidebar" onClick={() => usePrefs.setState({ sidebarCollapsed: false })} className={cn(railButton, "mt-1 shrink-0 [&_svg]:size-[17px]", ink.glyph)}>
            <PanelLeftOpenIcon strokeWidth={1.8} />
          </button>
        </Tip>
      )}
    </nav>
  );
}

const railButton = "relative inline-flex size-9 items-center justify-center rounded-[10px] hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-[18px]";

// PlaceIcon is a place as an icon, its count as a badge: amber and numbered
// when something needs you, a quiet dot otherwise.
function PlaceIcon({ item: n }: { item: NavItem }) {
  const count = n.badge?.count ?? 0;
  return (
    <Tip label={n.badge?.title ? `${n.label} · ${n.badge.title}` : n.label} side="right">
      <button
        type="button"
        aria-label={n.label}
        data-testid={`nav-${n.id}`}
        aria-current={n.active ? "page" : undefined}
        onClick={n.go}
        className={cn(railButton, ink.row, n.active && "bg-sidebar-accent text-foreground")}
      >
        {n.icon}
        {count > 0 &&
          (n.badge?.loud ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-sidebar bg-warning px-1 font-semibold text-tag text-white tabular-nums leading-none">
              {count > 99 ? "99+" : count}
            </span>
          ) : (
            <span className="absolute top-1 right-1 size-2 rounded-full border-[1.5px] border-sidebar bg-foreground/45" />
          ))}
      </button>
    </Tip>
  );
}

function MorePlaces({ more }: { more: NavItem[] }) {
  return (
    <Menu>
      <Tip label="More" side="right">
        <MenuTrigger
          render={<button type="button" aria-label="More places" className={cn(railButton, ink.row, "data-popup-open:bg-sidebar-accent", more.some((n) => n.active) && "bg-sidebar-accent text-foreground")} />}
        >
          <EllipsisIcon />
        </MenuTrigger>
      </Tip>
      <MenuPopup side="right" align="start" className="min-w-52">
        <MoreItems more={more} />
      </MenuPopup>
    </Menu>
  );
}

function SettingsButton({ rail }: { rail?: boolean }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const on = view.kind === "settings";
  return (
    <Tip label="Settings · ⇧-click for Developer" side={rail ? "right" : "top"} align={rail ? "center" : "end"}>
      <button
        type="button"
        data-testid="nav-settings"
        aria-label="Settings"
        aria-current={on ? "page" : undefined}
        // Shift-click goes straight to Developer.
        onClick={(e) => setView({ kind: "settings", section: e.shiftKey ? "developer" : undefined })}
        className={cn(
          rail ? railButton : "inline-flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4",
          rail ? "mt-1 shrink-0 [&_svg]:size-[17px]" : "",
          ink.glyph,
          on && "bg-sidebar-accent text-foreground",
        )}
      >
        <SettingsIcon strokeWidth={1.8} />
      </button>
    </Tip>
  );
}

// tileState is what a project's tile says: amber while an agent in it needs
// you, blue while one works, nothing otherwise; and how many of each.
function useTileState(p: Project): { state?: SessionState; waiting: number; running: number } {
  // Only its own boxes' data: agents changing on another box leave it be.
  const memberData = useStore(useShallow((s) => p.members.map((m) => s.boxes[m.box.name])));
  return useMemo(() => {
    let waiting = 0;
    let running = 0;
    p.members.forEach((m, i) => {
      if (m.box.state !== "online") return;
      for (const s of (memberData[i]?.sessions ?? []).filter((s) => inWorktrees(m.loc, s))) {
        const st = summary([s], memberData[i]).state;
        if (st === "waiting") waiting++;
        else if (st === "running") running++;
      }
    });
    return { state: waiting ? "waiting" : running ? "running" : undefined, waiting, running };
  }, [p.members, memberData]);
}

// ProjectTile is a project on the rail: its avatar on a tile. The picked
// one sits on a raised tile with a bar at the rail's edge; a dot at its
// corner is amber while an agent in it needs you, blue while one works.
// One with no session open in it (useIdle) is grayed out until pointed at.
// Its menu is the project's, as on its header.
const ProjectTile = memo(function ProjectTile({ project: p, selected, shared, folded }: { project: Project; selected: boolean; shared: boolean; folded: boolean }) {
  const { state, waiting, running } = useTileState(p);
  const online = p.members.some((m) => m.box.state === "online");
  const idle = useIdle(p.members);
  const what = [waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : "", running ? `${running} working` : "", online ? "" : awayText(p.members[0].box)].filter(Boolean);
  return (
    <ContextRow items={() => projectGroupActions(p)} className="relative flex w-full shrink-0 justify-center rounded-none data-popup-open:bg-transparent">
      <Tip side="right" label={<PlaceTip name={p.name} sub={p.members.map((m) => m.box.name).join(" · ")} lines={what} />}>
        <button
          type="button"
          data-testid="rail-project"
          data-project={p.name}
          data-state={state}
          data-idle={idle || undefined}
          aria-label={what.length ? `${p.name}, ${what.join(", ")}` : p.name}
          aria-current={selected ? "true" : undefined}
          // Folded away, a tile opens the sheet again on its project. Switching
          // to it from another lands on its agent that worked last, or the
          // worktree of it you were in last, with a new task on top when
          // nothing is open in it (switchTo).
          onClick={() => {
            usePrefs.setState({ sidebarPick: p.id, tasksFolded: false, ...(folded ? { sidebarCollapsed: false } : {}) });
            if (!selected) switchTo(p.members, p.members.find((m) => m.box.name === p.defaultBox) ?? p.members[0]);
          }}
          className={cn(
            "relative flex size-9 items-center justify-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border border-sidebar-border bg-background shadow-xs" : "hover:bg-sidebar-accent",
            !online && "opacity-55",
            idle && !selected && "opacity-60 grayscale transition-[opacity,filter,background-color] hover:opacity-100 hover:grayscale-0 focus-visible:opacity-100 focus-visible:grayscale-0",
          )}
        >
          <Avatar project={p} />
          {shared && (
            <span
              aria-hidden
              data-testid="rail-project-letter"
              className="pointer-events-none absolute right-0 bottom-0 flex size-4 items-center justify-center rounded-[5px] border-[1.5px] border-sidebar bg-foreground font-semibold text-tag text-background leading-none"
            >
              {(p.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
            </span>
          )}
        </button>
      </Tip>
      {selected && <span aria-hidden className="pointer-events-none absolute top-2.5 left-0 h-4 w-[3px] rounded-r-[3px] bg-foreground" />}
      {state && (
        <span
          aria-hidden
          data-testid="rail-project-dot"
          className={cn("pointer-events-none absolute top-0.5 left-[calc(50%+9px)] size-[11px] rounded-full border-2 border-sidebar", state === "waiting" ? "bg-warning" : "bg-info")}
        />
      )}
    </ContextRow>
  );
});

// Avatar is a project's picture: its GitHub owner's avatar, or an
// identicon from its name when it has none or the avatar doesn't load
// (offline, blocked, gone).
function Avatar({ project: p, size = 28 }: { project: Project; size?: number }) {
  const owner = githubOwner(p.slug, p.remote);
  const src = owner ? avatarUrl(owner) : undefined;
  const [broken, setBroken] = useState<string>();
  return (
    <span style={{ width: size, height: size }} className="relative flex shrink-0 overflow-hidden rounded-[8px] bg-foreground/[0.06]">
      {src && broken !== src ? (
        <img src={src} alt="" draggable={false} referrerPolicy="no-referrer" data-testid="project-avatar" onError={() => setBroken(src)} className="size-full object-cover" />
      ) : (
        <IdenticonFace name={p.name} />
      )}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[8px] border border-foreground/10" />
    </span>
  );
}

function IdenticonFace({ name }: { name: string }) {
  const { cells, hue } = useMemo(() => identicon(name), [name]);
  return (
    <svg data-testid="project-identicon" viewBox="0 0 6 6" shapeRendering="crispEdges" className="size-full" aria-hidden>
      <rect width="6" height="6" className="fill-[color-mix(in_oklab,var(--foreground)_6%,var(--background))]" />
      <g style={{ fill: `oklch(0.62 0.15 ${hue})` }}>
        {cells.map((on, i) => (on ? <rect key={i} x={(i % 5) + 0.5} y={Math.floor(i / 5) + 0.5} width="1" height="1" /> : null))}
      </g>
    </svg>
  );
}

// ---- The sheet -----------------------------------------------------------------

// The sheet's two lanes (index.css, the grid), so everything on it lines
// up: boxes (the avatar, search, a row's highlight, the boxes' line) on the
// edge, their content (search's icon, a row's glyph, the label, the boxes'
// dots) on the lane. The sheet's left border is a pixel of the way in.
const lanes = {
  box: "pr-edge pl-[calc(var(--spacing-edge)-1px)]",
  content: "pr-edge pl-[calc(var(--spacing-lane)-1px)]",
};


// ProjectSheet is the picked project: its avatar, name, how many worktrees
// on which boxes, a new task and its menu; then search, and its worktrees as
// the list sidebar draws them.
function ProjectSheet({ project: p, prefs, update }: { project: Project; prefs: SidebarPrefs; update: Update }) {
  const id = useId();
  const t = useProjectTree(p, prefs, false, false);
  const { def, online } = t;
  const count = p.members.reduce((n, m) => n + (m.loc.worktrees?.filter((w) => !w.main).length ?? 0), 0);
  const boxes = p.members.map((m) => m.box.name).join(", ");
  const onNew = online ? () => useStore.getState().openNewWorktree({ box: def.box.name, location: def.loc.name }) : undefined;
  const onWorktree = online ? () => openComposer({ noAgent: true, box: def.box.name, location: def.loc.name }) : undefined;
  return (
    <section aria-labelledby={id} data-testid="sidebar-tasks" className="flex min-h-0 flex-1 flex-col">
      <ContextRow items={() => projectGroupActions(p)} className="group/row relative shrink-0 rounded-none data-popup-open:bg-transparent">
        <div data-testid="tasks-heading" className={cn("flex items-center gap-2.5 pt-3.5 pb-2.5", lanes.box)}>
          <Avatar project={p} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={id} className={cn("truncate font-semibold text-subtitle leading-5 tracking-[-0.01em]", ink.strong)}>
              {p.name}
            </h2>
            <span data-testid="tasks-box" className={cn("truncate text-tag", ink.faint)}>
              {count === 1 ? "1 worktree" : `${count} worktrees`} · {boxes}
            </span>
          </div>
          {!online && <AwayWord boxes={p.members.map((m) => m.box)} />}
          <span className="flex shrink-0 items-center">
            {onNew && (
              <RowButton label={`New task in ${p.name} (⌘N)`} onClick={onNew}>
                <PenLineIcon />
              </RowButton>
            )}
            <DotsMenu label={`${p.name} actions`} items={() => projectGroupActions(p)} />
          </span>
        </div>
      </ContextRow>
      <div className={cn("shrink-0 pb-1", lanes.box)}>
        <button
          type="button"
          data-testid="sheet-search"
          onClick={() => useStore.getState().setPaletteOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background px-[calc(var(--spacing-lane)-var(--spacing-edge)-1px)] text-left shadow-xs/5 hover:border-foreground/15"
        >
          <SearchIcon className={cn("size-3.5 shrink-0", ink.glyph)} strokeWidth={2} />
          <span className={cn("flex-1 text-desc", ink.faint)}>Search</span>
          <kbd className={cn("font-sans text-tag", ink.faint)}>⌘K</kbd>
        </button>
      </div>
      <div className={cn("flex h-7 shrink-0 items-center pt-3", lanes.content)}>
        <h3 className={cn("flex-1 text-label", ink.faint)}>Worktrees</h3>
        {onWorktree && (
          <Tip label={`New worktree in ${p.name}`} side="bottom" align="end">
            <button
              type="button"
              aria-label={`New worktree in ${p.name}`}
              onClick={onWorktree}
              className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-3.5", ink.glyph)}
            >
              <PlusIcon strokeWidth={2} />
            </button>
          </Tip>
        )}
      </div>
      {/* One context menu and one tooltip for every row in it. */}
      <RowLayer className={cn("min-h-0 flex-1 overflow-y-auto pt-1.5 pb-3", lanes.box)}>
        {t.any ? (
          <SidebarMenuSub className="mx-0 translate-x-0 gap-px border-l-0 px-0 py-0">
            <ProjectTreeRows t={t} prefs={prefs} update={update} />
          </SidebarMenuSub>
        ) : (
          <p data-testid="tasks-empty" className={cn("px-2 pt-1 text-desc", ink.faint)}>
            {online ? "No tasks here yet." : `${p.members[0].box.name} is ${awayText(p.members[0].box)}.`}
          </p>
        )}
      </RowLayer>
    </section>
  );
}

function NoProjects() {
  return (
    <div className="flex-1 px-3.5 pt-5">
      <p className={cn("px-2 py-1 text-desc", ink.faint)}>No projects yet.</p>
      <button
        type="button"
        onClick={() => useStore.getState().openAddLocation()}
        className={cn("flex h-side-row w-full items-center gap-2 rounded-md px-2 text-desc hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-3.5", ink.row)}
      >
        <PlusIcon className={ink.glyph} />
        Add a project…
      </button>
    </div>
  );
}

