import {
  ChevronRightIcon,
  FolderGitIcon,
  GitBranchIcon,
  HomeIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ServerOffIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WorkflowIcon,
  UsersRoundIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentIcon, BoxStateDot, StateGlyph } from "@/components/agent-glyph";
import { type Action, Armed, boxActions, useArmed, ContextRow, DotsMenu, newSection, projectActions, projectGroupActions, removeWorktree, worktreeActions } from "@/components/sidebar/actions";
import { ReviewNotice, ReviewTag } from "@/views/pr-review/review-marks";
import { confirm } from "@/components/sidebar/confirm";
import { type Project, projectActions as groupActions, useProjects } from "@/lib/project-groups";
import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { agentPresets, startSession } from "@/lib/actions";
import { type BoxStatus, type Location, type Session, type Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionName, sessionState, worktreeSessions } from "@/lib/derive";
import { load, save } from "@/lib/storage";
import { type BoxData, NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { addGroup, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { armDrag } from "@/components/workspace/tab-drag";
import { WtDot } from "@/components/workspace/worktree-tone";
import { BOX_WORDS, boxState, WORKTREE_WORDS } from "@/lib/state-model";
import { useNotifications } from "@/lib/notifications";
import { usePrefs } from "@/lib/prefs";
import { removalLabel, removalOf, useRemoval, useRemovals } from "@/lib/removing";
import { WorktreeNameField } from "@/components/sidebar/rename-worktree";
import { renameKey, startRenamingWorktree, stopRenamingWorktree, useRenamingWorktree, worktreeLabel } from "@/lib/worktree-names";
import { below, MAX_INDENT, nest, prune, size, type TreeNode } from "@/lib/worktree-tree";
import { useTeamSuggestions } from "@/lib/team-suggest";
import { orgName, suggestionFor } from "@/lib/team-suggest-model";

// Projects lists repositories, as Orca does: one group per repository on a
// box (the same repository on two boxes is two groups, told apart by the
// box), the repository row opening its main checkout, and its worktrees under
// it with one status each. By default only worktrees with something in them
// show; the rest are a click away.

export type GroupBy = "project" | "box";
export type Show = "active" | "all";

interface SidebarPrefs {
  groupBy: GroupBy;
  show: Show;
  collapsed: Record<string, boolean>;
  expanded: Record<string, boolean>;
}

const KEY = "berth.sidebar";
const saved = load<Partial<SidebarPrefs> & { groupBy?: string }>(KEY, {});
// "repo" was the old name for grouping by project.
const initial: SidebarPrefs = { show: "active", collapsed: {}, expanded: {}, ...saved, groupBy: saved.groupBy === "box" ? "box" : "project" };

// The sidebar's own preferences, kept on this computer.
export function useSidebarPrefs() {
  const [prefs, set] = useState<SidebarPrefs>(initial);
  const update = (patch: Partial<SidebarPrefs>) =>
    set((p) => {
      const next = { ...p, ...patch };
      Object.assign(initial, next);
      save(KEY, next);
      return next;
    });
  return [prefs, update] as const;
}

const urgency: Record<SessionState, number> = { waiting: 0, running: 1, finished: 2, ready: 3, idle: 4, exited: 5 };

// summary is the one status a row shows: its most urgent session's.
function summary(sessions: Session[], data?: BoxData): { state?: SessionState; count: number } {
  const states = sessions.map((s) => sessionState(s, data?.stats)).filter((s) => s !== "exited");
  states.sort((a, b) => urgency[a] - urgency[b]);
  return { state: states[0], count: sessions.length };
}

interface Repo {
  key: string;
  box: BoxStatus;
  loc: Location;
  main?: Worktree;
  worktrees: Worktree[];
}

export function Projects({ prefs, update }: { prefs: SidebarPrefs; update(p: Partial<SidebarPrefs>): void }) {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);

  const repos = useMemo(() => {
    const out: Repo[] = [];
    for (const b of boxes) {
      for (const loc of data[b.name]?.locations ?? []) {
        const wts = loc.worktrees ?? [];
        out.push({ key: `${b.name}/${loc.name}`, box: b, loc, main: wts.find((w) => w.main), worktrees: wts.filter((w) => !w.main).sort((x, y) => worktreeLabel(x).localeCompare(worktreeLabel(y))) });
      }
    }
    return out.sort((a, b) => a.loc.name.localeCompare(b.loc.name) || a.box.name.localeCompare(b.box.name));
  }, [boxes, data]);

  const group = (list: Repo[], chip: boolean) => list.map((r) => <RepoGroup key={r.key} repo={r} chip={chip} prefs={prefs} update={update} />);

  // By repository, boxes only appear when there is something to say: an
  // empty box, one that is not online, or one whose link is slow (below the
  // projects, so nothing above it moves).
  const notable = boxes.filter((b) => b.state !== "online" || b.link?.slow || !data[b.name]?.locations?.length);

  return (
    <>
      {prefs.groupBy === "project" ? (
        <>
          <ProjectSections prefs={prefs} update={update} />
          {notable.length > 0 && (
            <div className="mt-3">
              {notable.map((b) => (
                <BoxHeader key={b.name} box={b} empty={!data[b.name]?.locations?.length} />
              ))}
            </div>
          )}
        </>
      ) : (
        boxes.map((b) => (
          <div key={b.name} className="mb-3">
            <BoxHeader box={b} empty={!data[b.name]?.locations?.length} />
            <SidebarMenu className="gap-px">
              {group(
                repos.filter((r) => r.box.name === b.name),
                false,
              )}
            </SidebarMenu>
          </div>
        ))
      )}
    </>
  );
}

// BoxHeader heads a box: its name, state and latency, with a way to add a
// project to it, or to reconnect when it is not online.
function BoxHeader({ box, empty }: { box: BoxStatus; empty: boolean }) {
  const online = box.state === "online";
  return (
    <ContextRow items={() => boxActions(box)}>
      {/* Focusable for its menu (Shift-F10 or the menu key). */}
      <div
        tabIndex={0}
        role="group"
        aria-label={`${box.name}, ${online ? (box.link?.slow ? "online, slow link" : "online") : awayText(box)}`}
        className="group/row relative flex h-7 outline-none focus-visible:ring-2 focus-visible:ring-ring items-center gap-1.5 rounded-md pr-1 pl-2 font-medium text-[11px] text-muted-foreground hover:bg-sidebar-accent"
      >
        {online ? <ServerIcon className="size-3" /> : <ServerOffIcon className="size-3" />}
        <span className="truncate normal-case tracking-normal">{box.name}</span>
        {online ? (
          <span className="ml-auto flex items-center gap-1.5 font-normal normal-case tracking-normal tabular-nums">
            {empty && <span>no projects</span>}
            {/* A slow link says so instead of its latency: still online, not alarming. */}
            {box.link?.slow ? <span data-testid="box-slow">slow</span> : box.latency_ms !== undefined && <span>{box.latency_ms} ms</span>}
            <BoxStateDot box={box.name} />
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 font-normal normal-case tracking-normal">
            {awayText(box)}
            <BoxStateDot box={box.name} />
          </span>
        )}
        <RowOverlay className="rounded-r-md">
          {online ? (
            <RowButton label={`Add a project on ${box.name}`} onClick={() => useStore.getState().openAddLocation(box.name)}>
              <PlusIcon />
            </RowButton>
          ) : (
            <RowButton label={`Reconnect to ${box.name}`} onClick={() => void useStore.getState().refreshAll()}>
              <RefreshCwIcon />
            </RowButton>
          )}
          <DotsMenu label={`${box.name} actions`} items={() => boxActions(box)} />
        </RowOverlay>
      </div>
    </ContextRow>
  );
}

// BoxChip names the box a repository is on; it only draws attention when the
// box is not online.
function BoxChip({ box }: { box: BoxStatus }) {
  const online = box.state === "online";
  const chip = (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 font-mono font-normal text-[10px] leading-none",
        online ? "bg-sidebar-accent/70 text-muted-foreground" : "bg-sidebar-accent/40 text-muted-foreground",
      )}
    >
      {!online && <span className="size-1.5 rounded-full bg-muted-foreground/50" />}
      {online && box.link?.slow && <span className="size-1.5 rounded-full bg-success/45" />}
      {box.name}
    </span>
  );
  // The name says it all while the box is up; otherwise say why it is dim.
  if (online && box.link?.slow) return <Tip label={`${box.name}'s link is slow; requests still go through`}>{chip}</Tip>;
  return online ? chip : <Tip label={`${box.name} is ${awayText(box)}`}>{chip}</Tip>;
}

function RepoGroup({ repo, chip, prefs, update }: { repo: Repo; chip: boolean; prefs: SidebarPrefs; update(p: Partial<SidebarPrefs>): void }) {
  const { box, loc, main, worktrees } = repo;
  const data = useStore((s) => s.boxes[box.name]);
  const removals = useRemovals((s) => s.byKey);
  const current = useWorkspaces((s) => s.current);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const online = box.state === "online";
  const collapsed = prefs.collapsed[repo.key] ?? false;
  const all = prefs.show === "all";
  const expanded = all || (prefs.expanded[repo.key] ?? false);

  const mainSessions = main ? worktreeSessions(data?.sessions, main) : [];
  const mainSel = !!main && inWorkspace && current === wsKey(box.name, main.path);
  const rows: TreeRow[] = worktrees.map((wt) => ({
    key: wt.path,
    box: box.name,
    loc,
    wt,
    data,
    sessions: worktreeSessions(data?.sessions, wt),
    selected: inWorkspace && current === wsKey(box.name, wt.path),
    away: online ? undefined : box,
  }));
  const isActive = (r: TreeRow) => r.sessions.some((s) => !s.exited) || r.selected || !!removalOf(removals, box.name, r.wt.path);
  const active = rows.filter(isActive);
  const tree = nest(rows, (r) => r.key, (r) => r.wt.parent);
  const shown = expanded ? tree : prune(tree, isActive);
  const hidden = rows.length - size(shown);
  const open = (wt: Worktree) => selectWorktree(refOf(box.name, loc, wt));
  const toggle = () => update({ collapsed: { ...prefs.collapsed, [repo.key]: !collapsed } });

  return (
    <SidebarMenuItem>
      <ContextRow items={() => projectActions(box.name, loc)} className="group/row relative">
        <Tip side="right" delay={700} wrapClassName="flex w-full min-w-0" label={<PlaceTip name={`${loc.name} on ${box.name}`} lines={[loc.path]} />}>
          <SidebarMenuButton
            size="sm"
            isActive={mainSel && !all}
            disabled={!online || !main}
            onClick={() => main && open(main)}
            // → shows its worktrees, ← hides them, as in a tree.
            aria-expanded={!collapsed}
            onKeyDown={(e: React.KeyboardEvent) => {
              if ((e.key === "ArrowRight" && collapsed) || (e.key === "ArrowLeft" && !collapsed)) {
                e.preventDefault();
                toggle();
              }
            }}
            className={cn("h-[calc(var(--side-row)+0.125rem)] gap-1.5 font-medium text-[13px] text-foreground", !online && "text-muted-foreground")}
          >
            {/* The pointer's way; the keyboard's is ← and → on the row. */}
            <Tip label={collapsed ? `Show ${loc.name}` : `Hide ${loc.name}`} side="right">
              <span
                aria-hidden
                data-fold=""
                className="-ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", !collapsed && "rotate-90")} />
              </span>
            </Tip>
            <LeadIcon sessions={!all && main ? mainSessions : []} data={data} icon={<FolderGitIcon />} />
            <span className="min-w-0 truncate">{loc.name}</span>
            <TeamSuggestMark places={[{ box: box.name, location: loc.name }]} />
            {chip && <BoxChip box={box} />}
            <span className="ml-auto" />
            {!all && main && <Glyphs sessions={mainSessions} data={data} />}
          </SidebarMenuButton>
        </Tip>
        {online && main && (
          <RowActions box={box.name} loc={loc} wt={main} project onNewWorktree={() => useStore.getState().openNewWorktree({ box: box.name, location: loc.name })} />
        )}
      </ContextRow>

      {!collapsed && (all || shown.length > 0 || hidden > 0) && (
        <SidebarMenuSub className="mx-0 ml-[17px] gap-px py-0.5 pr-0 pl-1.5">
          {all && main && <WorktreeRow box={box.name} loc={loc} wt={main} sessions={mainSessions} data={data} selected={mainSel} onOpen={() => open(main)} away={online ? undefined : box} />}
          <WorktreeNodes nodes={shown} depth={0} prefs={prefs} update={update} />
          {hidden > 0 && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full text-muted-foreground/80"
                onClick={() => update({ expanded: { ...prefs.expanded, [repo.key]: true } })}
              >
                <span>
                  {hidden} more {hidden === 1 ? "worktree" : "worktrees"}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {!all && expanded && rows.length > active.length && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full text-muted-foreground/80"
                onClick={() => update({ expanded: { ...prefs.expanded, [repo.key]: false } })}
              >
                <span>Show fewer</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

interface WorktreeRowProps {
  box: string;
  loc: Location;
  wt: Worktree;
  sessions: Session[];
  data?: BoxData;
  selected: boolean;
  onOpen(): void;
  // Shown when the project spans boxes, to tell its copies apart.
  chip?: BoxStatus;
  // The row's box when it is not online. The row stays, dimmed and marked,
  // so the worktree you have open never vanishes from under you; what it
  // last ran is not shown, since the box cannot say whether it still runs.
  away?: BoxStatus;
}

// A row is drawn again only when what it shows changed: its worktree, its
// sessions, the box's report of its agents, whether it is selected, and its
// box chip's name and state. onOpen opens the worktree it was given, and
// the store keeps what a refresh didn't change (lib/share.ts), so a rename
// or an agent's new state draws one row, not hundreds.
const sameList = (a: Session[], b: Session[]) => a.length === b.length && a.every((s, i) => s === b[i]);
const sameRow = (a: Omit<WorktreeRowProps, "onOpen">, b: Omit<WorktreeRowProps, "onOpen">) =>
  a.box === b.box &&
  a.loc === b.loc &&
  a.wt === b.wt &&
  a.selected === b.selected &&
  a.away === b.away &&
  a.chip?.name === b.chip?.name &&
  a.chip?.state === b.chip?.state &&
  a.data?.stats?.agents === b.data?.stats?.agents &&
  sameList(a.sessions, b.sessions);

const WorktreeRow = memo(function WorktreeRow({ box, loc, wt, sessions, data, selected, onOpen, chip, away }: WorktreeRowProps) {
  // Its agents by what they work on ("Fix checkout webhook · Claude Code").
  const agents = away ? [] : sessions.filter((s) => agentOf(s) && !s.exited).map((s) => sessionName(s, { sessions, agent: true }));
  // A renamed worktree's tip says its own name and branch under the title.
  const own = `${wt.name}${wt.branch && wt.branch !== wt.name ? ` · ${wt.branch}` : ""}`;
  const where = (
    <PlaceTip
      name={wt.main ? `Main checkout${wt.branch && wt.branch !== wt.name ? ` · ${wt.branch}` : ""}` : wt.title ? wt.title : own}
      sub={!wt.main && wt.title ? own : undefined}
      work={agents}
      lines={[wt.path, ...(away ? [`${away.name} is ${awayText(away)}`] : [])]}
    />
  );
  // On its way out (lib/removing.ts): dimmed, with nothing to open or do,
  // until the box says it went or puts it back.
  const removal = useRemoval(box, wt.path);
  const labs = usePrefs((p) => p.labs);
  const editing = useRenamingWorktree((s) => s.key === renameKey(box, wt.path));
  if (removal) return <LeavingRow wt={wt} label={removalLabel(removal)} script={removal.script} />;
  const key = wsKey(box, wt.path);
  const name = wt.main ? (wt.branch ?? "main") : worktreeLabel(wt);
  // A worktree on an away box can still be renamed: the name waits for it.
  const canRename = !wt.main && !away;
  if (editing && canRename)
    return (
      <SidebarMenuSubItem>
        <WorktreeNameField box={box} loc={loc} wt={wt} onDone={stopRenamingWorktree} />
      </SidebarMenuSubItem>
    );
  return (
    <SidebarMenuSubItem>
      <ContextRow items={() => (away ? awayActions(away) : worktreeActions(box, loc, wt))} className="group/row relative">
        <Tip side="right" delay={700} label={where}>
          <SidebarMenuSubButton
            render={<button type="button" />}
            data-testid="worktree-row"
            data-worktree={`${box}/${wt.main ? loc.name : wt.name}`}
            data-title={wt.title || undefined}
            isActive={selected}
            // Labs: ⌥-click adds its tabs to the strip as a group; dragged
            // onto the strip it does the same, onto a pane it splits its
            // agent in (tab-drag.tsx).
            onClick={(e: React.MouseEvent) => (e.altKey && labs ? void addGroup(key) : onOpen())}
            // Double-click or F2 renames it in place.
            onDoubleClick={() => canRename && startRenamingWorktree(box, wt.path)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "F2" && canRename) {
                e.preventDefault();
                startRenamingWorktree(box, wt.path);
              }
            }}
            onPointerDown={(e: React.PointerEvent<HTMLElement>) => labs && !away && armDrag(e, { kind: "worktree", key }, wt.main ? loc.name : name, wt.main ? <HomeIcon className="size-3" /> : <GitBranchIcon className="size-3" />)}
            className={cn("h-side-row w-full text-[13px] sm:h-side-row [&>svg]:text-muted-foreground", away && "text-muted-foreground")}
          >
            <LeadIcon sessions={away ? [] : sessions} data={data} icon={wt.main ? <HomeIcon /> : <GitBranchIcon />} />
            <span className={cn("min-w-0 truncate", away && "opacity-70")}>{name}</span>
            {/* Its own name beside the title, when the sidebar is wide enough. */}
            {!wt.main && wt.title && <span data-testid="worktree-row-name" className="hidden min-w-0 max-w-max grow basis-0 truncate font-mono text-[10px] text-muted-foreground @min-[17rem]/side:inline">{wt.name}</span>}
            {/* On screen beside another worktree: its colour. */}
            <WtDot wsKey={key} className="size-1.5" />
            {/* Narrower than the default the name needs the room more; the
                tip still says which box. */}
            {chip && (
              <span className="hidden shrink-0 @min-[14rem]/side:inline-flex">
                <BoxChip box={chip} />
              </span>
            )}
            {!away && <SetupMark box={box} wt={wt} />}
            {!away && <ReviewTag box={box} wt={wt} />}
            <span className="ml-auto" />
            {away ? <AwayMark box={away} short={!!chip} /> : <Glyphs sessions={sessions} data={data} />}
          </SidebarMenuSubButton>
        </Tip>
        {!away && <RowActions box={box} loc={loc} wt={wt} />}
      </ContextRow>
      {!away && <ReviewNotice box={box} loc={loc} wt={wt} onRemove={() => removeWorktree(box, loc, wt)} />}
    </SidebarMenuSubItem>
  );
}, sameRow);

// TreeRow is one worktree as a project's tree holds it; key is unique
// across the project's boxes.
interface TreeRow {
  key: string;
  box: string;
  loc: Location;
  wt: Worktree;
  data?: BoxData;
  sessions: Session[];
  selected: boolean;
  chip?: BoxStatus;
  away?: BoxStatus;
}

// WorktreeNodes draws worktrees with the ones handed off from each under
// it (lib/worktree-tree.ts).
function WorktreeNodes({ nodes, depth, prefs, update }: { nodes: TreeNode<TreeRow>[]; depth: number; prefs: SidebarPrefs; update(p: Partial<SidebarPrefs>): void }) {
  return nodes.map((n) => <WorktreeNode key={n.key} node={n} depth={depth} prefs={prefs} update={update} />);
}

interface WorktreeNodeProps {
  node: TreeNode<TreeRow>;
  depth: number;
  prefs: SidebarPrefs;
  update(p: Partial<SidebarPrefs>): void;
}

// A worktree without children is drawn again only when its row would be
// (sameRow): a project's tree is made afresh whenever one of its agents
// changes, and its other rows stay as they are.
const sameLeaf = (a: WorktreeNodeProps, b: WorktreeNodeProps) =>
  !a.node.children.length &&
  !b.node.children.length &&
  a.depth === b.depth &&
  a.prefs === b.prefs &&
  a.update === b.update &&
  a.node.key === b.node.key &&
  sameRow(a.node.row, b.node.row);

// WorktreeNode is a worktree and, under a pill saying how many, its
// children. The pill folds them; a fold never hides the worktree you have
// open, and while folded it shows the most urgent agent inside.
const WorktreeNode = memo(function WorktreeNode({ node, depth, prefs, update }: WorktreeNodeProps) {
  const r = node.row;
  const row = (
    <WorktreeRow box={r.box} loc={r.loc} wt={r.wt} sessions={r.sessions} data={r.data} selected={r.selected} chip={r.chip} away={r.away} onOpen={() => selectWorktree(refOf(r.box, r.loc, r.wt))} />
  );
  if (!node.children.length) return row;
  const fold = `wt:${node.key}`;
  const inside = below(node);
  const closed = (prefs.collapsed[fold] ?? false) && !inside.some((c) => c.selected);
  const n = node.children.length;
  const what = `${n} ${n === 1 ? "child" : "children"}`;
  const { state } = closed ? summary(inside.flatMap((c) => (c.away ? [] : c.sessions)), r.data) : {};
  return (
    <>
      {row}
      <SidebarMenuSubItem>
        <button
          type="button"
          data-testid="worktree-children"
          aria-expanded={!closed}
          aria-label={`${closed ? "Show" : "Hide"} ${what} of ${worktreeLabel(r.wt)}`}
          onClick={() => update({ collapsed: { ...prefs.collapsed, [fold]: !closed } })}
          // A 24px target around a 20px pill.
          className="group/pill ml-6 flex h-6 w-max items-center rounded-md text-[11px] text-muted-foreground outline-none hover:text-foreground"
        >
          <span className="flex h-5 items-center gap-1 rounded-md border border-sidebar-border px-1.5 group-hover/pill:bg-sidebar-accent group-focus-visible/pill:ring-2 group-focus-visible/pill:ring-ring [&_svg]:size-3">
            <WorkflowIcon />
            <span className="tabular-nums">{what}</span>
            {(state === "running" || state === "waiting" || state === "finished") && <StateGlyph state={state} className="size-3" />}
            <ChevronRightIcon className={cn("transition-transform", !closed && "rotate-90")} />
          </span>
        </button>
      </SidebarMenuSubItem>
      {!closed && (
        <SidebarMenuSubItem>
          {/* Up to MAX_INDENT levels step in, with a guide; deeper ones line
              up with their parent. */}
          <SidebarMenuSub className={cn("mx-0 gap-px py-0 pr-0", depth + 1 < MAX_INDENT ? "ml-[9px] pl-1.5" : "ml-0 border-l-0 pl-0")}>
            <WorktreeNodes nodes={node.children} depth={depth + 1} prefs={prefs} update={update} />
          </SidebarMenuSub>
        </SidebarMenuSubItem>
      )}
    </>
  );
}, sameLeaf);

// LeavingRow is a worktree being archived or removed, in the row's place
// and size so nothing shifts when it goes.
function LeavingRow({ wt, label, script }: { wt: Worktree; label: string; script?: boolean }) {
  return (
    <SidebarMenuSubItem>
      <Tip side="right" delay={400} label={script ? "The repo's archive script is running on the box. The worktree goes when it finishes, or comes back if it fails." : "Waiting for the box."}>
        <div aria-disabled="true" aria-busy="true" data-leaving="" className="flex h-side-row w-full cursor-default items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate line-through decoration-muted-foreground/40 opacity-70">{worktreeLabel(wt)}</span>
          <span className="ml-auto shrink-0 text-[10px]">{label}</span>
        </div>
      </Tip>
    </SidebarMenuSubItem>
  );
}

// awayActions are what a row on an away box offers: its box's own ways
// back (Reconnect, Doctor, Copy address), not forgetting it.
function awayActions(box: BoxStatus): Action[] {
  const items = boxActions(box).filter((a) => !(a.type === "item" && a.destructive));
  while (items.length && items[items.length - 1].type === "sep") items.pop();
  return items;
}

// awayText is a box's state in the model's words: offline, unreachable,
// connecting.
function awayText(box: BoxStatus) {
  return BOX_WORDS[boxState(box)].lower;
}

// AwayMark ends a row whose box is not online: the box's state, small, or
// just its icon when the row's box chip already says which box.
function AwayMark({ box, short }: { box: BoxStatus; short?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
      <ServerOffIcon aria-label={short ? `${box.name} is ${awayText(box)}` : undefined} aria-hidden={!short} className="size-3" />
      {!short && awayText(box)}
    </span>
  );
}

// Rows never change size or position on hover: a row's state lives in its
// leading icon, its trailing glyphs stay put, and its actions fade in over
// them on a background of their own (RowOverlay).

// LeadIcon is a row's leading icon: the state of its most urgent agent while
// one is working, waiting or done, and the row's own icon otherwise, in the
// same 14px box.
function LeadIcon({ sessions, data, icon }: { sessions: Session[]; data?: BoxData; icon: React.ReactNode }) {
  const { state } = summary(sessions, data);
  if (state === "running" || state === "waiting" || state === "finished") return <StateGlyph state={state} className="size-3.5" />;
  return <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>;
}

// Glyphs are what runs in a row: the most urgent agent's icon, or a dot for
// shells alone, and how many sessions when more than one.
function Glyphs({ sessions, data }: { sessions: Session[]; data?: BoxData }) {
  const { state, count } = summary(sessions, data);
  if (!state) return null;
  const agent = sessions.find((s) => agentOf(s) && sessionState(s, data?.stats) === state) ?? sessions.find((s) => agentOf(s) && !s.exited);
  const shells = sessions.filter((s) => !agentOf(s)).length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {agent ? (
        <AgentIcon agent={agentOf(agent)} className="size-3 opacity-80" />
      ) : (
        <Tip label={`${shells} shell${shells === 1 ? "" : "s"} open`}>
          <span className="inline-flex size-3 items-center justify-center">
            <span className="size-1 rounded-full bg-muted-foreground/50" />
          </span>
        </Tip>
      )}
      {count > 1 && <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>}
    </span>
  );
}

// RowOverlay holds a row's actions over its trailing end. It only fades
// (opacity, 100ms), and paints the row's hover colour, opaque, with a short
// fade on its left edge, so it covers chips, counts and glyphs under it and
// nothing in the row moves. Its buttons and their menus are only made once
// the row is first pointed at or focused (Armed).
function RowOverlay({ className, children }: { className?: string; children: React.ReactNode }) {
  if (!useArmed()) return null;
  return (
    <div className={cn("pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1 pl-4 opacity-0 transition-opacity duration-100 [background:linear-gradient(var(--sidebar-accent),var(--sidebar-accent)),var(--sidebar)] [mask-image:linear-gradient(to_right,transparent,black_16px)] focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100", className)}>
      {children}
    </div>
  );
}

// RowActions are a row's buttons: start something here, and its ⋯ menu. They
// fade in over the row's trailing end on hover or keyboard focus.
function RowActions({ box, loc, wt, project, onNewWorktree }: { box: string; loc: Location; wt: Worktree; project?: boolean; onNewWorktree?: () => void }) {
  const select = () => selectWorktree(refOf(box, loc, wt));

  return (
    <RowOverlay>
      {onNewWorktree && (
        <RowButton label={`New task in ${loc.name}`} onClick={onNewWorktree}>
          <PlusIcon />
        </RowButton>
      )}
      {!onNewWorktree && (
        <Menu>
          <MenuTrigger render={<RowButton label={`Start in ${worktreeLabel(wt, loc)}`} />}>
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>Start in {worktreeLabel(wt, loc)}</MenuGroupLabel>
              {agentPresets(box, loc).map((p) => (
                <MenuItem
                  key={p.id}
                  onClick={() => {
                    select();
                    void startSession(p.command, { kind: "tab" }, p.name, wsKey(box, wt.path));
                  }}
                >
                  <span className="flex size-4 items-center justify-center">
                    <AgentIcon agent={p.id} />
                  </span>
                  {p.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  select();
                  void startSession("", { kind: "tab" }, "Terminal", wsKey(box, wt.path));
                }}
              >
                <SquareTerminalIcon />
                Shell
              </MenuItem>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      )}
      <DotsMenu label={`${worktreeLabel(wt, loc)} actions`} items={() => (project ? projectActions(box, loc) : worktreeActions(box, loc, wt))} />
    </RowOverlay>
  );
}

function RowButton({ label, ...props }: React.ComponentProps<"button"> & { label: string }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        {...props}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent [&_svg]:size-3.5"
      />
    </Tip>
  );
}

// ProjectSections lists projects under their sections (Work, Personal…);
// projects in none come first. Drag a project onto a section to move it.
function ProjectSections({ prefs, update }: { prefs: SidebarPrefs; update(p: Partial<SidebarPrefs>): void }) {
  const { projects, sections } = useProjects();
  const multiBox = useStore((s) => (s.status?.boxes.length ?? 0) > 1);
  const [over, setOver] = useState<string>();
  const loose = projects.filter((p) => !p.section);
  const drop = (section?: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-berth-project")) return;
      e.preventDefault();
      setOver(section ?? "");
    },
    onDragLeave: () => setOver(undefined),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData("application/x-berth-project");
      setOver(undefined);
      const p = projects.find((x) => x.id === id);
      if (p && p.section !== section) void groupActions.setSection(p, section);
    },
  });
  const list = (ps: Project[]) => ps.map((p) => <ProjectGroup key={p.id} project={p} chips={multiBox} prefs={prefs} update={update} />);

  return (
    <>
      <div {...drop(undefined)} className={cn("rounded-md", over === "" && "bg-sidebar-accent/40 ring-1 ring-ring/40")}>
        <SidebarMenu className="gap-px">{list(loose)}</SidebarMenu>
      </div>
      {sections.map((name) => {
        const inside = projects.filter((p) => p.section === name);
        const key = `section:${name}`;
        const closed = prefs.collapsed[key] ?? false;
        return (
          <div key={name} {...drop(name)} className={cn("mt-2 rounded-md", over === name && "bg-sidebar-accent/40 ring-1 ring-ring/40")}>
            <ContextRow items={() => sectionActions(name)}>
              <div className="group/row flex h-7 items-center gap-1 rounded-md pr-1 pl-1.5 hover:bg-sidebar-accent/40">
                <button
                  type="button"
                  onClick={() => update({ collapsed: { ...prefs.collapsed, [key]: !closed } })}
                  className="flex min-w-0 flex-1 items-center gap-1 font-medium text-[11px] text-muted-foreground"
                >
                  <ChevronRightIcon className={cn("size-3 transition-transform", !closed && "rotate-90")} />
                  <span className="truncate">{name}</span>
                  <span className="font-normal normal-case tracking-normal">{inside.length || ""}</span>
                </button>
                <span className="opacity-0 group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100">
                  <Armed>
                    <DotsMenu label={`${name} section`} items={() => sectionActions(name)} />
                  </Armed>
                </span>
              </div>
            </ContextRow>
            {!closed &&
              (inside.length ? <SidebarMenu className="gap-px">{list(inside)}</SidebarMenu> : <p className="px-6 py-1 text-muted-foreground text-xs">Drag a project here.</p>)}
          </div>
        );
      })}
    </>
  );
}

function sectionActions(name: string): Action[] {
  return [
    {
      type: "item",
      label: "Rename section…",
      icon: <PencilIcon />,
      run: () =>
        confirm({
          title: `Rename ${name}`,
          description: "Its projects move with it.",
          input: { label: "Name", initial: name },
          confirm: "Rename",
          run: (_c, v) => groupActions.renameSection(name, v),
        }),
    },
    { type: "item", label: "New section…", icon: <PlusIcon />, run: () => newSection() },
    { type: "sep" },
    {
      type: "item",
      label: "Remove section",
      icon: <Trash2Icon />,
      destructive: true,
      run: () => void groupActions.removeSection(name),
      hint: "projects stay",
    },
  ];
}

// ProjectGroup is one project: its row (name, its boxes, how its agents are
// doing), and under it the worktrees from all its boxes.
// A project is drawn again only when what it shows changed: its members'
// locations, and their boxes' names and states (not their latency, which
// changes with every status read).
const sameMember = (a: Project["members"][number], b: Project["members"][number]) => a.loc === b.loc && a.box.name === b.box.name && a.box.state === b.box.state && !!a.box.link?.slow === !!b.box.link?.slow;
const sameProject = (a: Project, b: Project) =>
  a === b ||
  (a.id === b.id && a.name === b.name && a.slug === b.slug && a.section === b.section && a.defaultBox === b.defaultBox && a.remote === b.remote && a.members.length === b.members.length && a.members.every((m, i) => sameMember(m, b.members[i])));

function ProjectGroupBody({ project: p, chips, prefs, update }: { project: Project; chips: boolean; prefs: SidebarPrefs; update(p: Partial<SidebarPrefs>): void }) {
  // Only its own boxes' data: agents changing on another box leave it be.
  const memberData = useStore(useShallow((s) => p.members.map((m) => s.boxes[m.box.name])));
  const boxes = useMemo(() => Object.fromEntries(p.members.map((m, i) => [m.box.name, memberData[i]])) as Record<string, BoxData | undefined>, [p.members, memberData]);
  const removals = useRemovals((s) => s.byKey);
  const current = useWorkspaces((s) => s.current);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const key = `project:${p.id}`;
  const collapsed = prefs.collapsed[key] ?? false;
  const all = prefs.show === "all";
  const expanded = all || (prefs.expanded[key] ?? false);
  const multi = p.members.length > 1;
  const def = p.members.find((m) => m.box.name === p.defaultBox) ?? p.members[0];
  const defMain = def.loc.worktrees?.find((w) => w.main);

  // A member whose box is away keeps its rows, dimmed (WorktreeRow).
  const rows = useMemo(
    () =>
      p.members.flatMap((m) => {
        const data = boxes[m.box.name];
        return (m.loc.worktrees ?? [])
          .filter((w) => (multi ? true : !w.main))
          .sort((a, b) => Number(!!b.main) - Number(!!a.main) || worktreeLabel(a).localeCompare(worktreeLabel(b)))
          .map(
            (wt): TreeRow => ({
              key: `${m.box.name}:${wt.path}`,
              box: m.box.name,
              loc: m.loc,
              wt,
              data,
              sessions: worktreeSessions(data?.sessions, wt),
              selected: inWorkspace && current === wsKey(m.box.name, wt.path),
              chip: multi ? m.box : undefined,
              away: m.box.state === "online" ? undefined : m.box,
            }),
          );
      }),
    [p.members, multi, boxes, inWorkspace, current],
  );
  const { active, shown, hidden } = useMemo(() => {
    const isActive = (r: TreeRow) => r.sessions.some((s) => !s.exited) || r.selected || !!removalOf(removals, r.box, r.wt.path);
    const tree = nest(rows, (r) => r.key, (r) => (r.wt.parent ? `${r.box}:${r.wt.parent}` : undefined));
    const shown = expanded ? tree : prune(tree, isActive);
    return { active: rows.filter(isActive), shown, hidden: rows.length - size(shown) };
  }, [rows, removals, expanded]);
  // With one box, the row itself is the main checkout.
  const mainSel = !multi && !!defMain && inWorkspace && current === wsKey(def.box.name, defMain.path);
  const glyphSessions = useMemo(
    () =>
      multi
        ? collapsed
          ? p.members.flatMap((m) => (boxes[m.box.name]?.sessions ?? []).filter((s) => !s.service && m.loc.worktrees?.some((w) => w.path === s.dir)))
          : NO_SESSIONS
        : defMain
          ? worktreeSessions(boxes[def.box.name]?.sessions, defMain)
          : NO_SESSIONS,
    [multi, collapsed, p.members, boxes, def.box.name, defMain],
  );
  const online = p.members.some((m) => m.box.state === "online");

  return (
    <SidebarMenuItem>
      <ContextRow items={() => projectGroupActions(p)} className="group/row relative">
        <Tip side="right" delay={700} wrapClassName="flex w-full min-w-0" label={<PlaceTip name={`${p.name}${p.slug ? ` (${p.slug})` : ""}`} lines={p.members.map((m) => `${m.box.name}: ${m.loc.path}`)} />}>
          <SidebarMenuButton
            size="sm"
            draggable
            onDragStart={(e: React.DragEvent) => {
              e.dataTransfer.setData("application/x-berth-project", p.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            isActive={mainSel && !all}
            disabled={!online}
            onClick={() => defMain && def.box.state === "online" && selectWorktree(refOf(def.box.name, def.loc, defMain))}
            aria-expanded={!collapsed}
            onKeyDown={(e: React.KeyboardEvent) => {
              if ((e.key === "ArrowRight" && collapsed) || (e.key === "ArrowLeft" && !collapsed)) {
                e.preventDefault();
                update({ collapsed: { ...prefs.collapsed, [key]: !collapsed } });
              }
            }}
            className={cn("h-[calc(var(--side-row)+0.125rem)] gap-1.5 font-medium text-[13px] text-foreground", !online && "text-muted-foreground")}
          >
            <Tip label={collapsed ? `Show ${p.name}` : `Hide ${p.name}`} side="right">
              <span
                aria-hidden
                data-fold=""
                className="-ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  update({ collapsed: { ...prefs.collapsed, [key]: !collapsed } });
                }}
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", !collapsed && "rotate-90")} />
              </span>
            </Tip>
            <LeadIcon sessions={!all ? glyphSessions : []} data={boxes[def.box.name]} icon={<FolderGitIcon />} />
            <span className="min-w-0 truncate">{p.name}</span>
            <TeamSuggestMark places={p.members.map((m) => ({ box: m.box.name, location: m.loc.name }))} />
            {chips && (
              <span className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
                {p.members.slice(0, 3).map((m) => (
                  <BoxChip key={m.box.name} box={m.box} />
                ))}
                {p.members.length > 3 && <span className="text-[10px] text-muted-foreground">+{p.members.length - 3}</span>}
              </span>
            )}
            <span className="ml-auto" />
            {!all && <Glyphs sessions={glyphSessions} data={boxes[def.box.name]} />}
          </SidebarMenuButton>
        </Tip>
        {online && (
          <RowOverlay>
            <RowButton
              label={multi ? `New task on ${p.defaultBox}` : `New task in ${p.name}`}
              onClick={() => useStore.getState().openNewWorktree({ box: def.box.name, location: def.loc.name })}
            >
              <PlusIcon />
            </RowButton>
            <DotsMenu label={`${p.name} actions`} items={() => projectGroupActions(p)} />
          </RowOverlay>
        )}
      </ContextRow>

      {!collapsed && (all || shown.length > 0 || hidden > 0) && (
        <SidebarMenuSub className="mx-0 ml-[17px] gap-px py-0.5 pr-0 pl-1.5">
          {!multi && all && defMain && (
            <WorktreeRow
              box={def.box.name}
              loc={def.loc}
              wt={defMain}
              sessions={glyphSessions}
              data={boxes[def.box.name]}
              selected={mainSel}
              onOpen={() => selectWorktree(refOf(def.box.name, def.loc, defMain))}
              away={def.box.state === "online" ? undefined : def.box}
            />
          )}
          <WorktreeNodes nodes={shown} depth={0} prefs={prefs} update={update} />
          {hidden > 0 && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full text-muted-foreground/80"
                onClick={() => update({ expanded: { ...prefs.expanded, [key]: true } })}
              >
                <span>
                  {hidden} more {hidden === 1 ? "worktree" : "worktrees"}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {!all && expanded && rows.length > active.length && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="h-6 w-full text-muted-foreground/80"
                onClick={() => update({ expanded: { ...prefs.expanded, [key]: false } })}
              >
                <span>Show fewer</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

const ProjectGroup = memo(ProjectGroupBody, (a, b) => a.chips === b.chips && a.prefs === b.prefs && a.update === b.update && sameProject(a.project, b.project));

const NO_SESSIONS: Session[] = [];

// PlaceTip says where a sidebar row is: its name, then its path on each box.
function PlaceTip({ name, sub, lines, work = [] }: { name: string; sub?: string; lines: string[]; work?: string[] }) {
  return (
    <span className="flex max-w-96 flex-col gap-0.5">
      <span>{name}</span>
      {sub && <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>}
      {work.map((w, i) => (
        <span key={i} className="truncate text-[12px]">
          {w}
        </span>
      ))}
      {lines.map((l) => (
        <span key={l} className="break-all font-mono text-[11px] text-muted-foreground">
          {l}
        </span>
      ))}
    </span>
  );
}

// SetupMark says a worktree is still setting up, or that its setup failed
// (until the notification about it is dealt with), in the model's words.
function SetupMark({ box, wt }: { box: string; wt: Worktree }) {
  // Setup and archive failures share a category; the title tells them apart.
  const failed = useNotifications((s) => s.notes.find((n) => n.category === "setupFailed" && !n.resolved && n.box === box && n.path === wt.path));
  if (wt.setting_up) return <span className="shrink-0 text-[10px] text-muted-foreground">{WORKTREE_WORDS["setting-up"].lower}</span>;
  if (wt.setup_on_open && !failed) {
    return (
      <Tip label="It was there before Shipyard set this repo up. Its setup runs the first time you open a terminal or start an agent in it; its files are as you left them.">
        <span data-testid="setup-on-open" className="shrink-0 text-[10px] text-muted-foreground">
          set up on first open
        </span>
      </Tip>
    );
  }
  if (!failed) return null;
  const archive = failed.title.startsWith("Archiving");
  return (
    <Tip label={`Its ${archive ? "archive" : "setup"} script failed. The notification has its output.`}>
      <span className="flex shrink-0 items-center gap-1 text-[10px] text-destructive-foreground">
        <span className="size-1.5 rounded-full bg-destructive" />
        {archive ? "archive failed" : WORKTREE_WORDS["setup-failed"].lower}
      </span>
    </Tip>
  );
}

// TeamSuggestMark is a project row's quiet note that its org publishes a
// team setup the person hasn't looked at (lib/team-suggest.ts): one small
// muted icon, and the row's menu says the rest.
function TeamSuggestMark({ places }: { places: { box: string; location: string }[] }) {
  const list = useTeamSuggestions();
  if (!list.length) return null;
  const found = places.map((p) => suggestionFor(list, p.box, p.location)).find(Boolean);
  if (!found) return null;
  const name = orgName(found.suggestion);
  return (
    <Tip label={`${name} has a team setup for this project. Review it from the project's menu.`} side="right">
      <span data-testid="team-suggest-mark" role="img" aria-label={`${name} has a team setup`} className="inline-flex shrink-0 items-center text-muted-foreground/60">
        <UsersRoundIcon className="size-3" />
      </span>
    </Tip>
  );
}
