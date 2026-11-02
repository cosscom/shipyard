import { ChevronsLeftIcon, HomeIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { type Action, ContextRow, DotsMenu, projectActions, projectGroupActions } from "@/components/sidebar/actions";
import { ink } from "@/components/sidebar/ink";
import { rowClass } from "@/components/sidebar/nav";
import {
  AwayWord,
  BoxHeader,
  PlaceTip,
  ProjectSections,
  ProjectTreeRows,
  type Repo,
  RepoTreeRows,
  RowButton,
  RowOverlay,
  type SidebarPrefs,
  summary,
  TeamSuggestMark,
  useProjectTree,
  useRepos,
  useRepoTree,
} from "@/components/sidebar/projects";
import { RowLayer } from "@/components/sidebar/row-layer";
import { awayText, TaskGlyph } from "@/components/sidebar/task-parts";
import { Tip } from "@/components/tip";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub } from "@/components/ui/sidebar";
import type { BoxStatus, Location, Session } from "@/lib/api";
import type { SessionState } from "@/lib/derive";
import { usePrefs } from "@/lib/prefs";
import { type Project, useProjects } from "@/lib/project-groups";
import { inUse, landingAgent, landingWorktree } from "@/lib/project-landing";
import { nextRow, pickedColumn } from "@/lib/sidebar-columns";
import { clampTasks, draggedTasks, PROJECTS_COLUMN, TASKS_DEFAULT, TASKS_MAX, TASKS_MIN, tasksMax, steppedTasks } from "@/lib/sidebar-width";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { homeBox, openSession, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";

// The two-column sidebar (Settings › Labs): the places and the projects in
// the first column, one quiet row each, and the tasks of the project picked
// there in the second. The task rows are the list sidebar's own
// (sidebar/projects.tsx), so everything a row does there it does here.

type Update = (p: Partial<SidebarPrefs>) => void;

// Picked is the project the tasks column shows: by project (a Project), or
// with Group by: Box, a project on one box (a Repo).
export type Picked = { kind: "project"; key: string; project: Project } | { kind: "repo"; key: string; repo: Repo };

const inWorktrees = (loc: Location, s: Session) => !s.service && !!loc.worktrees?.some((w) => w.path === s.dir);

// Opening a worktree, from anywhere (the tasks column, ⌘K, the rail, a
// notification), picks its project in the two-column and rail layouts: the pick becomes "the project of this
// worktree" (ws:<key>), which usePicked resolves. Going Home leaves it be.
useWorkspaces.subscribe((s, prev) => {
  if (s.current === prev.current || !s.current || homeBox(s.current)) return;
  if (usePrefs.getState().sidebarLayout === "list") return;
  usePrefs.setState({ sidebarPick: `ws:${s.current}` });
});

// usePicked is the project picked in the first column (lib/sidebar-columns),
// in the order the column lists them.
export function usePicked(groupBy: SidebarPrefs["groupBy"]): Picked | undefined {
  const { projects, sections } = useProjects();
  const repos = useRepos();
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const current = useWorkspaces((s) => s.current);
  const pick = usePrefs((p) => p.sidebarPick);
  const byProject = groupBy === "project";

  // The order the first column lists them in: loose projects, then each
  // section's; by box, each box's.
  const list = useMemo((): Picked[] => {
    if (byProject) {
      const ordered = [...projects.filter((p) => !p.section), ...sections.flatMap((name) => projects.filter((p) => p.section === name))];
      return ordered.map((project) => ({ kind: "project", key: project.id, project }));
    }
    return boxes.flatMap((b) => repos.filter((r) => r.box.name === b.name)).map((repo) => ({ kind: "repo", key: repo.key, repo }));
  }, [byProject, projects, sections, boxes, repos]);

  // The project a workspace's worktree is in.
  const holding = useCallback(
    (ws: string | undefined) => {
      if (!ws) return undefined;
      const has = (box: string, loc: Location) => !!loc.worktrees?.some((w) => wsKey(box, w.path) === ws);
      return list.find((x) => (x.kind === "project" ? x.project.members.some((m) => has(m.box.name, m.loc)) : has(x.repo.box.name, x.repo.loc)))?.key;
    },
    [list],
  );

  const key = pickedColumn(
    list.map((x) => x.key),
    pick?.startsWith("ws:") ? holding(pick.slice(3)) : pick,
    holding(current),
  );
  return list.find((x) => x.key === key);
}

// pickProject shows a project's tasks, unfolding the tasks column if it was
// folded away. Switching to it from another lands the main area there too
// (switchTo); picking the one shown again leaves it as it is.
function pickProject(key: string, places: Place[], home: Place | undefined, switching: boolean) {
  usePrefs.setState({ sidebarPick: key, tasksFolded: false });
  if (switching) switchTo(places, home);
}

type Place = { box: BoxStatus; loc: Location };

// switchTo lands on a project just switched to (lib/project-landing): the
// agent in it that worked last, in its worktree; with none working or
// waiting on you, the worktree of it you were in last, else its main
// checkout on home's box. Only a project with no session open at all
// (inUse) opens a new task on top, on home's box: one with agents that are
// just idle or done is only switched to. The rail's tiles do the same.
export function switchTo(places: Place[], home: Place | undefined) {
  const { boxes, openNewWorktree } = useStore.getState();
  const up = places.filter((m) => m.box.state === "online");
  const online = up.map((m) => ({ box: m.box.name, loc: m.loc, sessions: boxes[m.box.name]?.sessions ?? [], stats: boxes[m.box.name]?.stats }));
  const hit = landingAgent(online);
  if (hit) return void openSession(hit.box, hit.session);
  const { spaces } = useWorkspaces.getState();
  const to = landingWorktree(online, (box, path) => spaces[wsKey(box, path)]?.visitedAt, home?.box.name);
  if (to) selectWorktree(refOf(to.box, to.loc, to.wt));
  // Not before every box has listed its sessions: a list still on its way
  // is not an empty one.
  const listed = up.every((m) => boxes[m.box.name]?.sessions);
  if (listed && !inUse(online) && home?.box.state === "online") openNewWorktree({ box: home.box.name, location: home.loc.name });
}

// useIdle says a project is grayed out in the sidebar: up, its sessions
// listed, and none open in it (inUse). An away project has its own dimming.
export function useIdle(places: Place[]): boolean {
  const lists = useStore(useShallow((s) => places.map((m) => s.boxes[m.box.name]?.sessions)));
  const up = places.map((m, i) => ({ m, sessions: lists[i] })).filter((x) => x.m.box.state === "online");
  return up.length > 0 && up.every((x) => x.sessions) && !inUse(up.map((x) => ({ loc: x.m.loc, sessions: x.sessions ?? [] })));
}

// mostUrgent is the state a project's row says: amber while an agent in it
// needs you, else blue while one works, else nothing.
function mostUrgent(states: (SessionState | undefined)[]): SessionState | undefined {
  if (states.includes("waiting")) return "waiting";
  if (states.includes("running")) return "running";
  return undefined;
}

// ProjectsColumn is the first column's list: each project as one row, under
// its section's quiet label; by box, under each box's.
export function ProjectsColumn({ prefs, update, picked }: { prefs: SidebarPrefs; update: Update; picked?: string }) {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const repos = useRepos();
  // ↑ and ↓ go from project to project, Home and End to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-testid=column-project]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const to = nextRow(rows.length, at, e.key);
    if (to === undefined) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  return (
    <RowLayer onKeyDown={onKeyDown} aria-label="Projects" role="group" className="min-h-0 flex-1 overflow-y-auto px-edge pt-5 pb-3">
      {prefs.groupBy === "project" ? (
        <ProjectSections prefs={prefs} update={update} row={(p) => <ProjectColumnRow key={p.id} project={p} selected={picked === p.id} />} />
      ) : (
        boxes.map((b) => (
          <div key={b.name} className="mb-3">
            <BoxHeader box={b} empty={!data[b.name]?.locations?.length} />
            <SidebarMenu className="gap-px">
              {repos
                .filter((r) => r.box.name === b.name)
                .map((r) => (
                  <RepoColumnRow key={r.key} repo={r} selected={picked === r.key} />
                ))}
            </SidebarMenu>
          </div>
        ))
      )}
    </RowLayer>
  );
}

function ProjectColumnRow({ project: p, selected }: { project: Project; selected: boolean }) {
  // Only its own boxes' data: agents changing on another box leave it be.
  const memberData = useStore(useShallow((s) => p.members.map((m) => s.boxes[m.box.name])));
  const sums = p.members.map((m, i) => (m.box.state === "online" ? summary((memberData[i]?.sessions ?? []).filter((s) => inWorktrees(m.loc, s)), memberData[i]) : undefined));
  const state = mostUrgent(sums.map((x) => x?.state));
  const onWork = state === "running" && sums.every((x) => x?.state !== "running" || x.onWork);
  const online = p.members.some((m) => m.box.state === "online");
  const def = p.members.find((m) => m.box.name === p.defaultBox) ?? p.members[0];
  const idle = useIdle(p.members);
  return (
    <ColumnRow
      name={p.name}
      selected={selected}
      state={state}
      onWork={onWork}
      idle={idle}
      away={online ? undefined : p.members.map((m) => m.box)}
      tip={<PlaceTip name={`${p.name}${p.slug ? ` (${p.slug})` : ""}`} lines={[...p.members.map((m) => `${m.box.name}: ${m.loc.path}`), ...p.members.filter((m) => m.box.state !== "online").map((m) => `${m.box.name} is ${awayText(m.box)}`)]} />}
      items={() => projectGroupActions(p)}
      marks={<TeamSuggestMark places={p.members.map((m) => ({ box: m.box.name, location: m.loc.name }))} />}
      onPick={() => pickProject(p.id, p.members, def, !selected)}
      onNew={online ? () => useStore.getState().openNewWorktree({ box: def.box.name, location: def.loc.name }) : undefined}
      newLabel={p.members.length > 1 ? `New task on ${p.defaultBox}` : `New task in ${p.name}`}
      drag={p.id}
    />
  );
}

function RepoColumnRow({ repo, selected }: { repo: Repo; selected: boolean }) {
  const { box, loc } = repo;
  const data = useStore((s) => s.boxes[box.name]);
  const online = box.state === "online";
  const sum = online ? summary((data?.sessions ?? []).filter((s) => inWorktrees(loc, s)), data) : undefined;
  const state = mostUrgent([sum?.state]);
  const idle = useIdle([repo]);
  return (
    <ColumnRow
      name={loc.name}
      selected={selected}
      state={state}
      onWork={sum?.onWork}
      idle={idle}
      away={online ? undefined : [box]}
      tip={<PlaceTip name={`${loc.name} on ${box.name}`} lines={[loc.path, ...(online ? [] : [`${box.name} is ${awayText(box)}`])]} />}
      items={() => projectActions(box.name, loc)}
      marks={<TeamSuggestMark places={[{ box: box.name, location: loc.name }]} />}
      onPick={() => pickProject(repo.key, [repo], repo.main ? repo : undefined, !selected)}
      onNew={online && repo.main ? () => useStore.getState().openNewWorktree({ box: box.name, location: loc.name }) : undefined}
      newLabel={`New task in ${loc.name}`}
    />
  );
}

// ColumnRow is a project in the first column: its name, a place row's size
// and ink (fainter while nothing is open in it), and at its end amber while
// something in it needs you, blue while something works, and nothing
// otherwise. Its + and ⋯ fade in over that end,
// as on any sidebar row, and its menu is the project header's.
function ColumnRow({
  name,
  selected,
  state,
  onWork,
  idle,
  away,
  tip,
  items,
  marks,
  onPick,
  onNew,
  newLabel,
  drag,
}: {
  name: string;
  selected: boolean;
  state?: SessionState;
  // Running with no turn going: only work its agents wait on.
  onWork?: boolean;
  // No session open in it (useIdle): grayed out.
  idle?: boolean;
  away?: BoxStatus[];
  tip: ReactNode;
  items: () => Action[];
  marks?: ReactNode;
  onPick(): void;
  onNew?: () => void;
  newLabel: string;
  // The project's id, to drag it onto a section.
  drag?: string;
}) {
  return (
    <SidebarMenuItem>
      <ContextRow items={items} className="group/row relative">
        <Tip side="right" delay={700} wrapClassName="flex w-full min-w-0" label={tip}>
          <SidebarMenuButton
            size="sm"
            data-testid="column-project"
            data-project={name}
            data-idle={idle || undefined}
            isActive={selected}
            aria-current={selected ? "true" : undefined}
            draggable={!!drag}
            onDragStart={
              drag
                ? (e: React.DragEvent) => {
                    e.dataTransfer.setData("application/x-berth-project", drag);
                    e.dataTransfer.effectAllowed = "move";
                  }
                : undefined
            }
            onClick={onPick}
            className={cn(rowClass, "group-hover/row:not-data-[active=true]:bg-sidebar-accent group-hover/row:text-foreground", idle && ink.faint, away && "opacity-70")}
          >
            <span className="min-w-0 truncate">{name}</span>
            {marks}
            <span className="ml-auto" />
            {away ? <AwayWord boxes={away} /> : state ? <TaskGlyph state={state} small onWork={onWork} /> : null}
          </SidebarMenuButton>
        </Tip>
        <RowOverlay selected={selected}>
          {onNew && (
            <RowButton label={newLabel} onClick={onNew}>
              <PlusIcon />
            </RowButton>
          )}
          <DotsMenu label={`${name} actions`} items={items} />
        </RowOverlay>
      </ContextRow>
    </SidebarMenuItem>
  );
}

// ---- The tasks column -----------------------------------------------------------

// TasksColumn is the second column: the picked project's name, its box when
// there are several, its + and ⋯, and its task rows as the list sidebar
// draws them under the project; a quiet way to start one when it has none.
export function TasksColumn({ picked, prefs, update }: { picked?: Picked; prefs: SidebarPrefs; update: Update }) {
  const id = useId();
  return (
    <section
      aria-labelledby={picked ? id : undefined}
      aria-label={picked ? undefined : "Tasks"}
      data-testid="sidebar-tasks"
      style={{ width: `clamp(${TASKS_MIN}px, var(--tasks-live, var(--tasks-w, ${TASKS_DEFAULT}px)), max(${TASKS_MIN}px, min(${TASKS_MAX}px, calc(40vw - ${PROJECTS_COLUMN}px))))` }}
      className="@container/side relative flex shrink-0 flex-col pb-2"
    >
      <TasksResizeHandle />
      {/* The window's strip, as over the first column: it drags the window,
          and at its end folds this column away. */}
      <div data-tauri-drag-region className="flex h-bar shrink-0 items-center justify-end pr-edge">
        <Tip label="Hide the tasks" side="bottom" align="end">
          <button
            type="button"
            aria-label="Hide the tasks"
            data-testid="tasks-fold"
            onClick={() => usePrefs.setState({ tasksFolded: true })}
            className={cn("inline-flex size-7 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4", ink.glyph)}
          >
            <ChevronsLeftIcon strokeWidth={1.8} />
          </button>
        </Tip>
      </div>
      {picked?.kind === "project" ? (
        <ProjectTasks key={picked.key} id={id} project={picked.project} prefs={prefs} update={update} />
      ) : picked?.kind === "repo" ? (
        <RepoTasks key={picked.key} id={id} repo={picked.repo} prefs={prefs} update={update} />
      ) : (
        <div className="px-edge pt-5">
          <p className={cn("px-2 py-1 text-desc", ink.faint)}>No projects yet.</p>
          <EmptyAction icon={<PlusIcon />} label="Add a project…" onClick={() => useStore.getState().openAddLocation()} />
        </div>
      )}
    </section>
  );
}

function ProjectTasks({ id, project: p, prefs, update }: { id: string; project: Project; prefs: SidebarPrefs; update: Update }) {
  const t = useProjectTree(p, prefs, false, false);
  const multiBox = useStore((s) => (s.status?.boxes.length ?? 0) > 1);
  const { def, defMain, online } = t;
  return (
    <TasksBody
      id={id}
      name={p.name}
      boxes={multiBox ? p.members.map((m) => m.box.name) : []}
      away={online ? undefined : p.members.map((m) => m.box)}
      items={() => projectGroupActions(p)}
      onNew={online ? () => useStore.getState().openNewWorktree({ box: def.box.name, location: def.loc.name }) : undefined}
      onMain={defMain && def.box.state === "online" ? () => selectWorktree(refOf(def.box.name, def.loc, defMain)) : undefined}
      empty={!t.any}
    >
      <ProjectTreeRows t={t} prefs={prefs} update={update} />
    </TasksBody>
  );
}

function RepoTasks({ id, repo, prefs, update }: { id: string; repo: Repo; prefs: SidebarPrefs; update: Update }) {
  const t = useRepoTree(repo, prefs, false, false);
  const multiBox = useStore((s) => (s.status?.boxes.length ?? 0) > 1);
  const { box, loc, main } = repo;
  return (
    <TasksBody
      id={id}
      name={loc.name}
      boxes={multiBox ? [box.name] : []}
      away={t.online ? undefined : [box]}
      items={() => projectActions(box.name, loc)}
      onNew={t.online && main ? () => useStore.getState().openNewWorktree({ box: box.name, location: loc.name }) : undefined}
      onMain={t.online && main ? () => selectWorktree(refOf(box.name, loc, main)) : undefined}
      empty={!t.any}
    >
      <RepoTreeRows repo={repo} t={t} prefs={prefs} update={update} />
    </TasksBody>
  );
}

// TasksBody is the tasks column under its strip: the project's heading
// (lined up with the first place across), then its rows.
function TasksBody({
  id,
  name,
  boxes,
  away,
  items,
  onNew,
  onMain,
  empty,
  children,
}: {
  id: string;
  name: string;
  boxes: string[];
  away?: BoxStatus[];
  items: () => Action[];
  onNew?: () => void;
  onMain?: () => void;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="px-edge pt-5">
        <ContextRow items={items} className="group/row relative">
          <div data-testid="tasks-heading" className="flex h-side-row items-center gap-2 pr-1 pl-2">
            <h2 id={id} className={cn("min-w-0 truncate text-section", ink.strong)}>
              {name}
            </h2>
            {boxes.length > 0 && (
              <span data-testid="tasks-box" className={cn("min-w-0 shrink truncate text-tag", ink.faint)}>
                {boxes.join(" · ")}
              </span>
            )}
            <span className="ml-auto" />
            {away && <AwayWord boxes={away} />}
            <span className="flex shrink-0 items-center">
              {onNew && (
                <RowButton label={`New task in ${name}`} onClick={onNew}>
                  <PlusIcon />
                </RowButton>
              )}
              <DotsMenu label={`${name} actions`} items={items} />
            </span>
          </div>
        </ContextRow>
      </div>
      {/* One context menu and one tooltip for every row in it. */}
      <RowLayer className="min-h-0 flex-1 overflow-y-auto px-edge pt-1 pb-3">
        {empty ? (
          <div data-testid="tasks-empty" className="flex flex-col gap-px">
            <p className={cn("px-2 pt-1 pb-2 text-desc", ink.faint)}>{away ? `${away[0].name} is ${awayText(away[0])}.` : "No tasks here yet."}</p>
            {onNew && <EmptyAction icon={<PlusIcon />} label="New task" onClick={onNew} />}
            {onMain && <EmptyAction icon={<HomeIcon />} label="Open the main checkout" onClick={onMain} />}
          </div>
        ) : (
          <SidebarMenuSub className="mx-0 translate-x-0 gap-px border-l-0 px-0 py-0">{children}</SidebarMenuSub>
        )}
      </RowLayer>
    </>
  );
}

// EmptyAction is a way on from an empty tasks column, as a place's row.
function EmptyAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick(): void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="sm" onClick={onClick} className={rowClass}>
          {icon}
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

// ShowTasks brings the tasks column back from the first column's strip,
// while it is folded away.
export function ShowTasks() {
  return (
    <Tip label="Show the tasks" side="bottom" align="end">
      <button
        type="button"
        aria-label="Show the tasks"
        data-testid="tasks-unfold"
        onClick={() => usePrefs.setState({ tasksFolded: false })}
        className={cn("inline-flex size-7 items-center justify-center rounded-lg hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-4", ink.glyph)}
      >
        <ChevronsLeftIcon strokeWidth={1.8} className="rotate-180" />
      </button>
    </Tip>
  );
}

// ---- Its edge ------------------------------------------------------------------

// The tasks column's right edge is its handle, as the sidebar's is
// (resize-handle.tsx): drag to size it, double-click for the default, or
// focus it and use ← and →. Dragged in past TASKS_FOLD_AT it folds away.
// While a drag runs the width goes to the column's own --tasks-live;
// prefs keep it (--tasks-w on the root) once it ends.
const column = () => document.querySelector<HTMLElement>("[data-testid=sidebar-tasks]");
const settled = () => window.dispatchEvent(new Event("resize"));

function TasksResizeHandle() {
  const width = usePrefs((p) => p.tasksWidth);
  const [active, setActive] = useState(false);
  const max = tasksMax(typeof window === "undefined" ? Infinity : window.innerWidth);
  const now = Math.min(width, max);

  const begin = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = column()?.getBoundingClientRect().width ?? width;
    let next = { folded: false, width: startWidth };
    let moved = false;
    let frame = 0;
    let x = startX;
    const root = document.documentElement;
    root.classList.add("berth-resizing");
    setActive(true);
    const apply = () => {
      frame = 0;
      if (!moved && Math.abs(x - startX) < 2) return;
      moved = true;
      next = draggedTasks(startWidth + x - startX, window.innerWidth);
      column()?.style.setProperty("--tasks-live", `${next.width}px`);
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const end = (cancel: boolean) => {
      if (frame) cancelAnimationFrame(frame);
      if (!cancel) apply();
      root.classList.remove("berth-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", up);
      setActive(false);
      column()?.style.removeProperty("--tasks-live");
      if (!cancel && moved) usePrefs.setState(next.folded ? { tasksFolded: true } : { tasksWidth: next.width });
      requestAnimationFrame(settled);
    };
    const up = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", up);
  };

  return (
    <Tip side="right" delay={600} label="Drag to resize · double-click for the default width">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the tasks"
        aria-valuemin={TASKS_MIN}
        aria-valuemax={max}
        aria-valuenow={now}
        aria-valuetext={`${now} pixels`}
        tabIndex={0}
        data-testid="tasks-handle"
        data-dragging={active || undefined}
        onPointerDown={begin}
        onDoubleClick={() => {
          usePrefs.setState({ tasksWidth: TASKS_DEFAULT });
          requestAnimationFrame(settled);
        }}
        onKeyDown={(e) => {
          const next = steppedTasks(width, e.key, e.shiftKey, window.innerWidth);
          if (next !== undefined) {
            e.preventDefault();
            usePrefs.setState({ tasksWidth: clampTasks(next, window.innerWidth) });
            requestAnimationFrame(settled);
          } else if (e.key === "Enter") {
            e.preventDefault();
            usePrefs.setState({ tasksWidth: TASKS_DEFAULT });
          }
        }}
        className={cn(
          "group/handle absolute inset-y-0 -right-[4px] z-30 w-[8px] cursor-col-resize touch-none outline-none",
          "after:absolute after:inset-y-0 after:left-[3px] after:w-[2px] after:rounded-full after:bg-transparent after:transition-colors after:delay-75 hover:after:bg-ring focus-visible:after:bg-ring data-dragging:after:bg-ring data-dragging:after:delay-0",
        )}
      />
    </Tip>
  );
}

