import { EllipsisIcon, FolderPlusIcon, HouseIcon, PlusIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";

import { MoreItems, useArrangedNav } from "@/components/sidebar/nav";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/ui/menu";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { type AgentEntry, openProject, type ProjectEntry, useRailProjects } from "@/components/rail-layout/model";
import { ProjectFooter, ProjectHead, WorktreeItems } from "@/components/rail-layout/worktree-items";

export const SHORT = "(max-height: 820px)";

// The peek keeps clear of the title bar and the status bar.
export const PEEK_COLLISION = { top: 52, bottom: 34, left: 8, right: 8 };

// ProjectRail is the rail layout's left edge (Labs › Layout › Icon rail),
// in the spirit of a chat app's server rail: Home and Review at the top, one
// mark per project in the middle, and Settings at the foot. Under each mark
// is a dot per agent at work in it, in the state's colour (amber needs you,
// blue works, green is done), and an amber count when some need you, so the
// rail is an overview of every agent without a hover. A click on a mark goes
// to the project (where an agent needs you first); pointing at it, or Enter
// on it, peeks at its worktrees and agents by what they need. ⌃1–9 go to the
// first nine projects.
export function ProjectRail() {
  const projects = useRailProjects();
  const { pinned, more } = useArrangedNav();
  const view = useStore((s) => s.view);
  const top = pinned.filter((n) => n.id === "home" || n.id === "review");
  const bottom = pinned.filter((n) => n.id !== "home" && n.id !== "review");
  const empty = useStore((s) => !!s.status && s.status.boxes.length === 0);

  // ⌃1–9: the nth project, from anywhere (terminals included).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
      const p = projects[Number(e.code.slice(5)) - 1];
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      openProject(p);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [projects]);

  return (
    <nav aria-label="Projects rail" data-testid="project-rail" className="relative flex w-15 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar pt-2 text-sidebar-foreground">
      <div className="flex flex-col items-center gap-1">
        {/* Home's count of agents that need you is the title bar's "need
            you" button here, said once. */}
        {top.map((n) =>
          n.id === "home" ? (
            <HomeMark key={n.id} label={n.label} icon={n.icon} active={n.active} onClick={n.go} projects={projects} />
          ) : (
            <PlaceButton key={n.id} id={n.id} label={n.label} icon={n.icon} active={n.active} onClick={n.go} badge={n.badge && { ...n.badge, loud: false }} />
          ),
        )}
      </div>
      <span aria-hidden className="mt-2 h-px w-7 shrink-0 bg-sidebar-border" />
      <ul aria-label="Projects" className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overscroll-contain pt-2 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {projects.map((p, i) => (
          <Fragment key={p.id}>
            {/* A section's name where it starts (the sidebar's sections). */}
            {p.section && p.section !== projects[i - 1]?.section && (
              <li data-testid="rail-section" className="mt-2 flex w-full shrink-0 flex-col items-center gap-1.5">
                <span aria-hidden className="h-px w-7 bg-sidebar-border" />
                <span className="w-full truncate px-1 text-center font-medium text-[9px] text-muted-foreground uppercase tracking-wider">{p.section}</span>
              </li>
            )}
            <li className="relative flex w-full shrink-0 justify-center">
              <ProjectMark p={p} n={i + 1} />
            </li>
          </Fragment>
        ))}
        <li className="flex w-full shrink-0 justify-center pt-0.5">
          <NewMenu empty={empty || !projects.length} />
        </li>
      </ul>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-sidebar-border border-t pt-2 pb-2">
        {bottom.map((n) => (
          <PlaceButton key={n.id} id={n.id} label={n.label} icon={n.icon} active={n.active} onClick={n.go} badge={n.badge} />
        ))}
        {more.length > 0 && (
          <Menu>
            <Tip label="More" side="right">
              <MenuTrigger render={<button type="button" aria-label="More" data-testid="rail-more" className={itemClass} />}>
                <span className={cn(iconClass, more.some((n) => n.active) && "bg-sidebar-accent text-foreground")}>
                  <EllipsisIcon />
                </span>
                <Caption on={more.some((n) => n.active)}>More</Caption>
              </MenuTrigger>
            </Tip>
            <MenuPopup side="right" align="end" className="min-w-52">
              <MoreItems more={more} />
            </MenuPopup>
          </Menu>
        )}
        <PlaceButton id="settings" label="Settings" icon={<SettingsIcon />} active={view.kind === "settings"} onClick={(e) => useStore.getState().setView({ kind: "settings", section: e.shiftKey ? "developer" : undefined })} />
      </div>
    </nav>
  );
}

// A place in the rail: its icon over its name, the whole of it one target.
const itemClass = "group/item flex w-15 flex-col items-center gap-0.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring";
const iconClass =
  "relative inline-flex h-8 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors group-hover/item:bg-sidebar-accent group-hover/item:text-foreground group-data-popup-open/item:bg-sidebar-accent [&_svg]:size-[17px]";

function Caption({ children, on }: { children: ReactNode; on?: boolean }) {
  return <span className={cn("block w-full truncate text-center text-[9px] leading-3 tracking-[-0.01em]", on ? "font-medium text-foreground" : "text-muted-foreground group-hover/item:text-foreground")}>{children}</span>;
}

// Edge is the bar at the rail's left edge beside where you are.
function Edge({ on, top = "50%" }: { on: boolean; top?: string }) {
  return (
    <span
      aria-hidden
      style={{ top }}
      className={cn("absolute left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height,opacity] duration-150", on ? "h-6 opacity-90" : "h-0 opacity-0")}
    />
  );
}

function PlaceButton({ id, label, icon, active, onClick, badge }: { id: string; label: string; icon: ReactNode; active: boolean; onClick(e: React.MouseEvent): void; badge?: { count: number; loud?: boolean; title: string } }) {
  return (
    <div className="relative flex w-15 justify-center">
      <Edge on={active} top="16px" />
      <Tip label={badge ? `${label} · ${badge.title}` : label} side="right">
        <button type="button" data-testid={`nav-${id}`} aria-label={badge ? `${label}, ${badge.title}` : label} aria-current={active ? "page" : undefined} onClick={onClick} className={itemClass}>
          <span className={cn(iconClass, active && "bg-sidebar-accent text-foreground")}>
            {icon}
            {badge?.count ? <CountBadge count={badge.count} loud={badge.loud} /> : null}
          </span>
          <Caption on={active}>{label}</Caption>
        </button>
      </Tip>
    </div>
  );
}

// HomeMark is Home, and its peek is every agent at work, in every project,
// by what it needs: the whole fleet one point away.
function HomeMark({ label, icon, active, onClick, projects }: { label: string; icon: ReactNode; active: boolean; onClick(): void; projects: ProjectEntry[] }) {
  const [open, setOpen] = useState(false);
  const short = useMediaQuery(SHORT);
  const all = projects.flatMap((p) => p.worktrees).filter((w) => !w.away && w.lane !== "quiet");
  const count = (k: "waiting" | "running" | "finished") => projects.reduce((n, p) => n + p[k], 0);
  const parts = [count("waiting") && `${count("waiting")} need you`, count("running") && `${count("running")} working`, count("finished") && `${count("finished")} done`].filter(Boolean);
  return (
    <div className="relative flex w-15 justify-center">
      <Edge on={active} top="16px" />
      <Menu
        modal={false}
        open={open}
        onOpenChange={(next, d) => {
          if (d.reason === "trigger-press" && !(d.event instanceof KeyboardEvent)) {
            setOpen(false);
            onClick();
            return;
          }
          setOpen(next);
        }}
      >
        <MenuTrigger openOnHover delay={200} closeDelay={160} data-testid="nav-home" aria-label={label} aria-current={active ? "page" : undefined} className={itemClass}>
          <span className={cn(iconClass, active && "bg-sidebar-accent text-foreground")}>{icon}</span>
          <Caption on={active}>{label}</Caption>
        </MenuTrigger>
        <MenuPopup side="right" align="start" alignOffset={-6} sideOffset={6} collisionPadding={PEEK_COLLISION} data-testid="home-peek" className="w-96">
          <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
            <span className="font-medium text-sm">Everywhere</span>
            <span className="ml-auto shrink-0 text-muted-foreground text-xs">{parts.length ? parts.join(" · ") : "Nothing running"}</span>
          </div>
          <WorktreeItems worktrees={all} compact={short} everywhere />
          <MenuSeparator />
          <MenuItem onClick={onClick}>
            <HouseIcon />
            Open Home
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

// CountBadge sits on a mark's corner, cut out of the rail: solid amber only
// when something needs you, as everywhere in the app.
function CountBadge({ count, loud }: { count: number; loud?: boolean }) {
  return (
    <span aria-hidden className="absolute -top-1 -right-1.5 flex rounded-full bg-sidebar p-[2px]">
      <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-semibold text-[10px] tabular-nums leading-none", loud ? "bg-warning text-black/85" : "bg-foreground/12 text-foreground")}>
        {count > 9 ? "9+" : count}
      </span>
    </span>
  );
}

// label is a mark's name for screen readers: the project and its agents.
function markLabel(p: ProjectEntry) {
  const parts = [p.waiting && `${p.waiting} need${p.waiting === 1 ? "s" : ""} you`, p.running && `${p.running} working`, p.finished && `${p.finished} done`].filter(Boolean);
  return `${p.name}${parts.length ? `, ${parts.join(", ")}` : ""}${p.online ? "" : ", box away"}`;
}

const PIPS = 4;
// Waiting agents are the badge's; the dots are the rest at work.
const LIVE = ["running", "finished"];
const pipColor: Record<string, string> = { running: "bg-info", finished: "bg-success" };

// Pips are a dot per agent working (blue) or done (green) in a project, so
// how much is going on shows at a glance; those that need you are the
// badge's count.
function Pips({ p }: { p: ProjectEntry }) {
  const live: AgentEntry[] = p.worktrees
    .filter((w) => !w.away)
    .flatMap((w) => w.agents)
    .filter((a) => LIVE.includes(a.state))
    .sort((a, b) => LIVE.indexOf(a.state) - LIVE.indexOf(b.state));
  return (
    <span aria-hidden data-testid="rail-pips" className="flex h-1.5 items-center gap-[3px]">
      {live.slice(0, PIPS).map((a) => (
        <span key={`${a.box}/${a.session.name}`} data-state={a.state} className={cn("size-1.5 rounded-full", pipColor[a.state])} />
      ))}
      {live.length > PIPS && <span className="font-medium text-[9px] text-muted-foreground leading-none tabular-nums">+{live.length - PIPS}</span>}
    </span>
  );
}

// ProjectMark is a project's place in the rail, and its peek.
function ProjectMark({ p, n }: { p: ProjectEntry; n: number }) {
  const [open, setOpen] = useState(false);
  // A short window gets a shorter peek, so its ways onward stay in sight.
  const short = useMediaQuery(SHORT);
  return (
    <Menu
      modal={false}
      open={open}
      onOpenChange={(next, d) => {
        // A click goes there; the peek is for pointing and the keyboard.
        if (d.reason === "trigger-press" && !(d.event instanceof KeyboardEvent)) {
          setOpen(false);
          openProject(p);
          return;
        }
        setOpen(next);
      }}
    >
      <Edge on={p.current} top="20px" />
      <MenuTrigger
        openOnHover
        delay={140}
        closeDelay={160}
        data-testid="rail-project"
        data-project={p.name}
        data-waiting={p.waiting || undefined}
        aria-label={markLabel(p)}
        aria-current={p.current || undefined}
        className="group/item flex w-15 flex-col items-center gap-1 rounded-lg pt-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "relative flex size-9 items-center justify-center rounded-full bg-sidebar-accent font-semibold text-[13px] text-sidebar-foreground/80 shadow-[inset_0_0_0_1px_var(--sidebar-border)] transition-[background-color,color,box-shadow] duration-150",
            "group-hover/item:bg-foreground/12 group-hover/item:text-foreground group-data-popup-open/item:bg-foreground/12 group-data-popup-open/item:text-foreground",
            p.current && "bg-foreground/15 text-foreground",
            !p.online && "border border-muted-foreground/40 border-dashed bg-transparent text-muted-foreground shadow-none",
          )}
        >
          <span className="leading-none tracking-tight">{p.initials}</span>
          {p.waiting > 0 && <CountBadge count={p.waiting} loud />}
        </span>
        <Pips p={p} />
        <span className={cn("-mt-0.5 block w-full truncate px-0.5 text-center text-[10px] leading-3", p.current ? "font-medium text-foreground" : "text-muted-foreground group-hover/item:text-foreground")}>{p.name}</span>
      </MenuTrigger>
      <MenuPopup side="right" align="start" alignOffset={-6} sideOffset={6} collisionPadding={PEEK_COLLISION} data-testid="rail-peek" className="w-88">
        <ProjectHead p={p} hint={n <= 9 ? <Kbd className="h-4.5 text-[10px]">⌃{n}</Kbd> : undefined} />
        <WorktreeItems worktrees={p.worktrees} compact={short} />
        <ProjectFooter p={p} />
      </MenuPopup>
    </Menu>
  );
}

// NewMenu is the "+" under the projects: new work first, then the rarer
// adding of a project or a box.
function NewMenu({ empty }: { empty: boolean }) {
  return (
    <Menu>
      <Tip label="New task, project or box" side="right">
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="New"
              data-testid="rail-new"
              className="inline-flex size-9 items-center justify-center rounded-full border border-foreground/25 border-dashed text-muted-foreground outline-none transition-colors hover:border-solid hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
      </Tip>
      <MenuPopup side="right" align="start" className="min-w-52">
        {!empty && (
          <MenuItem onClick={() => useStore.getState().openNewWorktree()}>
            <PlusIcon />
            New task…
            <MenuShortcut>{keysFor("new-worktree")}</MenuShortcut>
          </MenuItem>
        )}
        <MenuItem onClick={() => useStore.getState().openAddLocation()}>
          <FolderPlusIcon />
          Add a project…
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={openAddBox}>
          <ServerIcon />
          Add a box…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
