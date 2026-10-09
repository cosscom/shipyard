import { GitBranchIcon, GitBranchPlusIcon, HomeIcon, ListIcon, ServerOffIcon, SettingsIcon } from "lucide-react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuShortcut } from "@/components/ui/menu";
import { sessionName } from "@/lib/derive";
import { ago } from "@/lib/format";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openSession } from "@/lib/workspaces";
import { LANE_WORDS, LANES, type ProjectEntry, openWt, type WtEntry } from "@/components/rail-layout/model";

// How many quiet worktrees a list shows before "All worktrees".
const QUIET_MAX = 5;

// BoxTag names a worktree's box, only where a project lives on more than
// one, or the box is away.
export function BoxTag({ box, away }: { box: string; away?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded bg-accent/70 px-1 py-px font-mono text-[10px] text-muted-foreground leading-none", away && "opacity-70")}>
      {away && <ServerOffIcon className="size-2.5" />}
      {box}
    </span>
  );
}

function Lead({ w }: { w: WtEntry }) {
  if (w.away) return <ServerOffIcon className="size-3.5 text-muted-foreground" />;
  if (w.state === "waiting" || w.state === "running" || w.state === "finished") return <StateGlyph state={w.state} className="size-4" />;
  return <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{w.wt.main ? <HomeIcon /> : <GitBranchIcon />}</span>;
}

// WorktreeItem is one worktree as a peek or the breadcrumb lists it: its
// state, its name (and box, when that matters), and under it what it is
// doing; a second line in mono for what its agent waits on.
function WorktreeItem({ w, chip }: { w: WtEntry; chip: boolean }) {
  const since = w.agents[0]?.session.state_since;
  return (
    <MenuItem
      data-testid="rail-wt"
      data-worktree={`${w.box}/${w.wt.main ? w.loc.name : w.wt.name}`}
      data-lane={w.lane}
      aria-current={w.selected || undefined}
      disabled={!!w.away}
      onClick={() => openWt(w)}
      className={cn("items-start gap-2.5 py-1.5", w.selected && "bg-accent/50")}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <Lead w={w} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate", w.selected && "font-medium")}>{w.name}</span>
          {(chip || w.away) && <BoxTag box={w.box} away={w.away} />}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-muted-foreground text-xs">
            {w.agents.slice(0, 3).map((a) => (
              <AgentIcon key={a.session.name} agent={a.agent} className="size-3" />
            ))}
            {w.agents.length > 3 && <span className="tabular-nums">+{w.agents.length - 3}</span>}
            {since && w.lane !== "quiet" && <span className="tabular-nums">{ago(since).replace(" ago", "")}</span>}
          </span>
        </span>
        {w.doing && <span className={cn("truncate text-muted-foreground text-xs", w.lane === "quiet" && "text-muted-foreground/80")}>{w.doing}</span>}
        {w.ask && <span className="truncate rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{w.ask}</span>}
      </span>
    </MenuItem>
  );
}

// AgentSubItems are a worktree's agents, when it has more than one, each
// its own way in.
function AgentSubItems({ w }: { w: WtEntry }) {
  if (w.away || w.agents.length < 2) return null;
  const sessions = w.agents.map((a) => a.session);
  return w.agents.map((a) => (
    <MenuItem key={a.session.name} data-testid="rail-agent-item" onClick={() => openSession(a.box, a.session)} className="min-h-6 gap-2 py-0.5 ps-9 text-xs sm:min-h-6 sm:text-xs">
      <StateGlyph state={a.state} className="size-3" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{sessionName(a.session, { sessions })}</span>
      <AgentIcon agent={a.agent} className="size-3 opacity-70" />
    </MenuItem>
  ));
}

// WorktreeItems lists a project's worktrees by what they need from you.
export function WorktreeItems({ p, compact }: { p: ProjectEntry; compact?: boolean }) {
  const groups = LANES.map((lane) => ({ lane, list: p.worktrees.filter((w) => w.lane === lane) })).filter((g) => g.list.length);
  return (
    <>
      {groups.map(({ lane, list }) => {
        const shown = lane === "quiet" ? list.slice(0, compact ? 2 : QUIET_MAX) : list;
        const more = list.length - shown.length;
        return (
          <MenuGroup key={lane} data-testid="rail-lane" data-lane={lane}>
            <MenuGroupLabel className={cn("pt-2 pb-1", lane === "waiting" && "text-warning-foreground")}>{LANE_WORDS[lane]}</MenuGroupLabel>
            {shown.map((w) => (
              <div key={w.key}>
                <WorktreeItem w={w} chip={p.multiBox} />
                {!compact && <AgentSubItems w={w} />}
              </div>
            ))}
            {more > 0 && (
              <MenuItem onClick={() => useStore.getState().setView({ kind: "worktrees" })} className="ps-8.5 text-muted-foreground text-xs">
                {more} more quiet worktree{more === 1 ? "" : "s"}…
              </MenuItem>
            )}
          </MenuGroup>
        );
      })}
    </>
  );
}

// ProjectFooter is a peek's ways onward: new work in the project, its
// worktrees in full, its settings.
export function ProjectFooter({ p }: { p: ProjectEntry }) {
  const def = p.project.members.find((m) => m.box.name === p.project.defaultBox) ?? p.project.members[0];
  return (
    <>
      <MenuSeparator />
      <MenuItem data-testid="rail-new-task" onClick={() => useStore.getState().openNewWorktree({ box: def?.box.name, location: def?.loc.name })}>
        <GitBranchPlusIcon />
        New task in {p.name}…<MenuShortcut>{keysFor("new-worktree")}</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => useStore.getState().setView({ kind: "worktrees" })}>
        <ListIcon />
        All worktrees
      </MenuItem>
      {def && (
        <MenuItem onClick={() => useStore.getState().setView({ kind: "project", box: def.box.name, location: def.loc.name })}>
          <SettingsIcon />
          Project settings
        </MenuItem>
      )}
    </>
  );
}

// ProjectHead heads a peek: the project, its boxes, and how its agents are.
// Its counts are of agents (the badge's and the pips'), where the lists
// under it are of worktrees.
export function ProjectHead({ p, hint }: { p: ProjectEntry; hint?: React.ReactNode }) {
  const agents = p.waiting + p.running + p.finished;
  return (
    <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
      <span className="font-medium text-sm">{p.name}</span>
      <span className="truncate text-muted-foreground text-xs">{p.project.members.map((m) => m.box.name).join(" · ")}</span>
      <span className="ml-auto shrink-0 text-muted-foreground text-xs">{agents ? `${agents} agent${agents === 1 ? "" : "s"} at work` : "Nothing running"}</span>
      {hint}
    </div>
  );
}

