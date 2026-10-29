import { EllipsisIcon, FolderPlusIcon, PanelLeftIcon, PanelLeftOpenIcon, PenLineIcon, SearchIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { useMemo } from "react";

import { NotificationBell } from "@/components/notifications/notification-center";
import { newSection } from "@/components/sidebar/actions";
import { BackForward } from "@/components/sidebar/back-forward";
import { MoreItems, Nav as PlacesNav, RowKeys, rowClass, useArrangedNav } from "@/components/sidebar/nav";
import { ProjectsColumn, ShowTasks, TasksColumn, usePicked } from "@/components/sidebar/columns";
import { Projects, useSidebarPrefs } from "@/components/sidebar/projects";
import { RailAgents } from "@/components/sidebar/rail";
import { FoldedRail, RailSidebar } from "@/components/sidebar/rail-layout";
import { SidebarResizeHandle } from "@/components/sidebar/resize-handle";
import { RowLayer } from "@/components/sidebar/row-layer";
import { RailSkillsNotices, SkillsNotices } from "@/components/sidebar/skills-notice";
import { fade, ink, inkScale } from "@/components/sidebar/ink";
import { BoxesFoot } from "@/components/sidebar/task-parts";
import { Tip } from "@/components/tip";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarContext, type SidebarContextProps, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { PROJECTS_COLUMN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar-width";
import { WhatsNewNudge } from "@/components/whats-new/whats-new-dialog";
import { cn } from "@/lib/utils";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { TeamSidebarCard } from "@/views/team/team-entry";
import { AlphaBadge } from "@/components/alpha-badge";
import { LINUX_ALPHA } from "@/lib/platform";

// The sidebar is always open on a desktop window; coss ui's menu pieces only
// need to know that.
const alwaysOpen: SidebarContextProps = {
  state: "expanded",
  open: true,
  setOpen: () => {},
  openMobile: false,
  setOpenMobile: () => {},
  isMobile: false,
  toggleSidebar: () => {},
};

// AppSidebar: by default a rail of the places and projects with the picked
// project's worktrees beside it (sidebar/rail-layout.tsx). The list layout
// has the window's controls, a short list of places, the tasks in every
// project on every box, and at its foot the boxes and Settings; the
// two-column one sets the projects and the tasks of the one picked side by
// side (ColumnsSidebar).
export function AppSidebar() {
  const [prefs, update] = useSidebarPrefs();
  const context = useMemo(() => alwaysOpen, []);
  const collapsed = usePrefs((p) => p.sidebarCollapsed);
  const layout = usePrefs((p) => p.sidebarLayout);

  if (collapsed) return layout === "rail" ? <FoldedRail /> : <Rail />;

  return (
    <SidebarContext.Provider value={context}>
      {layout === "rail" ? (
        <RailSidebar prefs={prefs} update={update} places={<Places prefs={prefs} update={update} />} />
      ) : layout === "columns" ? (
        <ColumnsSidebar prefs={prefs} update={update} />
      ) : (
        // Its width is --sidebar-w (prefs), or --sidebar-live as a drag
        // runs, held to the narrowest and widest (lib/sidebar-width) even as
        // the window shrinks; a container, so rows show more of a worktree
        // when there is room.
        <aside
          aria-label="Sidebar"
          data-testid="sidebar"
          style={{ width: `clamp(${SIDEBAR_MIN}px, var(--sidebar-live, var(--sidebar-w, ${SIDEBAR_DEFAULT}px)), max(${SIDEBAR_DEFAULT}px, min(${SIDEBAR_MAX}px, 40vw)))` }}
          className={cn("@container/side relative flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar pb-2 text-sidebar-foreground", inkScale)}
        >
          <SidebarResizeHandle />
          <WindowStrip />
          <Places prefs={prefs} update={update} />
          {/* A team setup while it runs, or a newer commit of one to review. */}
          <TeamSidebarCard />

          {/* One context menu and one tooltip for every row in it. */}
          <RowLayer className={cn("min-h-0 flex-1 overflow-y-auto px-edge pt-5 pb-3", fade)}>
            <Projects prefs={prefs} update={update} />
          </RowLayer>

          <Foot />
        </aside>
      )}
    </SidebarContext.Provider>
  );
}

type SidebarPrefsProps = { prefs: ReturnType<typeof useSidebarPrefs>[0]; update: ReturnType<typeof useSidebarPrefs>[1] };

// ColumnsSidebar is the two-column sidebar (Settings › Labs): the first
// column a fixed width with the window's controls, the places, a row per
// project and the foot; the second the picked project's tasks, sized by its
// own edge and folded away from its strip. One background, the sidebar's
// border between them.
function ColumnsSidebar({ prefs, update }: SidebarPrefsProps) {
  const folded = usePrefs((p) => p.tasksFolded);
  const noBoxes = useStore((s) => !!s.status && s.status.boxes.length === 0);
  const picked = usePicked(prefs.groupBy);
  return (
    <aside aria-label="Sidebar" data-testid="sidebar" data-layout="columns" className={cn("relative flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar pb-2 text-sidebar-foreground", inkScale)}>
      <div className="mb-1 flex min-h-0 flex-1 border-sidebar-border border-b">
        <div data-testid="sidebar-projects" style={{ width: PROJECTS_COLUMN }} className={cn("relative flex shrink-0 flex-col", !folded && !noBoxes && "border-sidebar-border border-r")}>
          <WindowStrip extra={folded && !noBoxes ? <ShowTasks /> : undefined} />
          <Places prefs={prefs} update={update} />
          <TeamSidebarCard />
          <ProjectsColumn prefs={prefs} update={update} picked={picked?.key} />
        </div>
        {!folded && !noBoxes && <TasksColumn picked={picked} prefs={prefs} update={update} />}
      </div>
      {/* The foot runs under both columns, so its notices and the boxes'
          line have the whole width; its pieces sit in the sidebar itself,
          which the notices' height is a share of. */}
      <Foot />
    </aside>
  );
}

// WindowStrip is the sidebar's top: room for the macOS traffic lights, then
// Back and Forward, the notifications and the way to fold the sidebar; the
// strip drags the window. The Linux app has no lights, and says it is an
// alpha there instead. extra goes before the fold (the two-column sidebar's
// way back to its tasks).
function WindowStrip({ extra }: { extra?: React.ReactNode }) {
  return (
    <div data-tauri-drag-region className="flex h-bar shrink-0 items-center justify-end gap-0.5 px-edge">
      {LINUX_ALPHA && <AlphaBadge link className="mr-auto" />}
      <BackForward />
      <NotificationBell className="size-7 rounded-lg [&_svg]:size-4" />
      {extra}
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

// Places are the sidebar's places, with More's menu holding ways to add to
// the projects below and how they show and group.
function Places({ prefs, update }: SidebarPrefsProps) {
  // A new account has no projects to list; onboarding fills the main area.
  const noBoxes = useStore((s) => !!s.status && s.status.boxes.length === 0);
  const labs = usePrefs((p) => p.labs);
  return (
    <div className="px-edge pt-5">
      <PlacesNav
        lead={
          <>
            {/* With Labs, Home is where a task starts and is New task. */}
            {!labs && <TopAction label="New task" keys="⌘N" icon={<PenLineIcon />} onClick={() => useStore.getState().openNewWorktree()} />}
            <TopAction label="Search" keys="⌘K" icon={<SearchIcon />} onClick={() => useStore.getState().setPaletteOpen(true)} />
          </>
        }
        extra={
          noBoxes ? undefined : (
            // How the tasks below show and group, and ways to add to them.
            <>
              <MenuSeparator />
              <MenuItem onClick={() => useStore.getState().openAddLocation()}>
                <FolderPlusIcon />
                Add a project…
              </MenuItem>
              <MenuItem onClick={openAddBox}>
                <ServerIcon />
                Add a box…
              </MenuItem>
              <MenuItem onClick={() => newSection()}>
                <FolderPlusIcon />
                New section…
              </MenuItem>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Group by</MenuGroupLabel>
                <MenuRadioGroup value={prefs.groupBy} onValueChange={(v) => update({ groupBy: v as typeof prefs.groupBy })}>
                  <MenuRadioItem value="project">Project</MenuRadioItem>
                  <MenuRadioItem value="box">Box</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </>
          )
        }
      />
    </div>
  );
}

// Foot is the sidebar's foot. Notices are a quiet line each, above it and
// never over the list: a box whose Shipyard skills aren't installed or are
// out of date, and what's new. Then the boxes and Settings.
function Foot() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <>
      <SkillsNotices />
      <WhatsNewNudge />
      <div className="flex h-[34px] shrink-0 items-center gap-1 px-edge">
        <BoxesFoot />
        <Tip label="Settings · ⇧-click for Developer" side="top" align="end">
          <button
            type="button"
            data-testid="nav-settings"
            aria-label="Settings"
            aria-current={view.kind === "settings" ? "page" : undefined}
            // Shift-click goes straight to Developer.
            onClick={(e) => setView({ kind: "settings", section: e.shiftKey ? "developer" : undefined })}
            className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4", ink.glyph, view.kind === "settings" && "bg-sidebar-accent text-foreground")}
          >
            <SettingsIcon strokeWidth={1.8} />
          </button>
        </Tip>
      </div>
    </>
  );
}

// TopAction is one of the sidebar's own rows among the places: start a
// task (without Labs) and search. A place's row, its shortcut at the end.
function TopAction({ label, keys, icon, onClick }: { label: string; keys: string; icon: React.ReactNode; onClick(): void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="sm" onClick={onClick} className={rowClass}>
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      <RowKeys keys={keys} />
    </SidebarMenuItem>
  );
}

// Rail is the sidebar folded away (⌘\): the window's controls, the places
// in the sidebar's own order, the agents by state (sidebar/rail.tsx), and a
// way back. It keeps clear of the traffic lights like the full one, which is
// why it is w-rail-folded, 88px at the least.
function Rail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const { pinned, more } = useArrangedNav();
  const item = (label: string, icon: React.ReactNode, active: boolean, onClick: () => void, badge?: { count: number; loud?: boolean }) => (
    <Tip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn("relative inline-flex size-8 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4", ink.row, active && "bg-sidebar-accent text-foreground")}
      >
        {icon}
        {/* Amber only when something needs you, as in the sidebar. */}
        {badge?.count ? <span className={cn("absolute top-0.5 right-0.5 size-2 rounded-full", badge.loud ? "bg-warning" : "bg-foreground/45")} /> : null}
      </button>
    </Tip>
  );
  return (
    <aside aria-label="Sidebar" data-testid="sidebar-rail" className={cn("relative flex w-rail-folded shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar", inkScale)}>
      <SidebarResizeHandle folded />
      <div data-tauri-drag-region className="h-bar w-full shrink-0" />
      <div className="flex flex-col items-center gap-1">
        {item("Search (⌘K)", <SearchIcon />, false, () => useStore.getState().setPaletteOpen(true))}
        <NotificationBell size="rail" />
        {pinned.map((n) => (
          <span key={n.id}>{item(n.label, n.icon, n.active, n.go, n.badge)}</span>
        ))}
        <Menu>
          <Tip label="More" side="right">
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More"
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent",
                    ink.row,
                    more.some((n) => n.active) && "bg-sidebar-accent text-foreground",
                  )}
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
          </Tip>
          <MenuPopup side="right" align="start" className="min-w-52">
            <MoreItems more={more} />
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-2 min-h-0 w-full flex-1">
        <RailAgents />
      </div>
      <div className="flex flex-col items-center gap-1 pt-1 pb-2">
        <RailSkillsNotices />
        {item("Settings", <SettingsIcon />, view.kind === "settings", () => setView({ kind: "settings" }))}
        {item("Show the sidebar (⌘\\)", <PanelLeftOpenIcon />, false, () => usePrefs.setState({ sidebarCollapsed: false }))}
      </div>
    </aside>
  );
}
