import { ChevronDownIcon, FolderPlusIcon, GitBranchIcon, HomeIcon, PlusIcon, SearchIcon, SettingsIcon, SquareTerminalIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { NotificationBell } from "@/components/notifications/notification-center";
import { useNavItems } from "@/components/sidebar/nav";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/ui/menu";
import { useNarrow, useTiny } from "@/components/workspace/worktree-tone";
import { agentPresets, startSession } from "@/lib/actions";
import { hasTrafficLights } from "@/lib/api";
import { agentLabel, sessionName, sessionState } from "@/lib/derive";
import { ago } from "@/lib/format";
import { keysFor } from "@/lib/shortcuts";
import { sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { homeBox, openSession, useHereKey, useWorkspaces } from "@/lib/workspaces";
import { openProject, type ProjectEntry, useFocused, useRailProjects, waitingAgents, type WtEntry } from "@/components/rail-layout/model";
import { PEEK_COLLISION, SHORT } from "@/components/rail-layout/project-rail";
import { useMediaQuery } from "@/hooks/use-media-query";
import { BoxTag, ProjectFooter, ProjectHead, WorktreeItems } from "@/components/rail-layout/worktree-items";

// TitleBar is the rail layout's top edge, across the whole window: clear of
// the window's buttons, the breadcrumb that says where you are and switches
// at every step (Project / Worktree / Agent), then what needs you, search,
// notifications and new work. It drags the window.
export function TitleBar() {
  const narrow = useNarrow();
  const tiny = useTiny();
  return (
    <header
      data-tauri-drag-region
      data-testid="title-bar"
      className={cn("flex h-10 shrink-0 items-center gap-1 border-sidebar-border border-b bg-sidebar pr-2 text-sidebar-foreground", hasTrafficLights() ? "pl-[84px]" : "pl-3")}
    >
      <Crumbs narrow={narrow} />
      <NeedsYou compact={narrow} />
      <Button size="sm" variant="ghost" aria-label="Search" className="text-muted-foreground" onClick={() => useStore.getState().setPaletteOpen(true)}>
        <SearchIcon />
        {!narrow && (
          <>
            Search
            <Kbd>{keysFor("palette")}</Kbd>
          </>
        )}
      </Button>
      <NotificationBell />
      <Tip label={<span className="flex items-center gap-1.5">New task <Kbd>{keysFor("new-worktree")}</Kbd></span>} side="bottom">
        <Button size={tiny ? "icon-sm" : "sm"} variant="outline" data-testid="title-new-task" aria-label="New task" onClick={() => useStore.getState().openNewWorktree()}>
          <PlusIcon />
          {!tiny && "New task"}
        </Button>
      </Tip>
    </header>
  );
}

// NeedsYou goes to the next agent that needs you, round them all; quiet
// (nothing at all) when none does.
function NeedsYou({ compact }: { compact: boolean }) {
  const projects = useRailProjects();
  const waiting = useMemo(() => waitingAgents(projects), [projects]);
  const focused = useFocused();
  if (!waiting.length) return null;
  const at = waiting.findIndex((a) => focused?.session && a.box === focused.box && a.session.name === focused.session.name);
  const next = waiting[(at + 1) % waiting.length];
  const label = `${waiting.length} need${waiting.length === 1 ? "s" : ""} you`;
  return (
    <Tip label={`Go to ${next.session.title?.trim() || agentLabel(next.agent)}${waiting.length > 1 ? ", then the next" : ""}`} side="bottom">
      <Button size="sm" variant="ghost" data-testid="title-needs-you" aria-label={`${label}: go to the next`} onClick={() => openSession(next.box, next.session)} className="gap-1.5 text-warning-foreground hover:bg-warning/10">
        <StateGlyph state="waiting" />
        {compact ? waiting.length : label}
      </Button>
    </Tip>
  );
}

const crumbClass =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent";

function Slash() {
  return (
    <span aria-hidden className="shrink-0 select-none px-0.5 text-muted-foreground/50 text-sm">
      /
    </span>
  );
}

function Chevron() {
  return <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground opacity-70" />;
}

// ProjectGlyph is a project's mark, small, as the rail draws it.
function ProjectGlyph({ p, className }: { p: ProjectEntry; className?: string }) {
  return <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/12 font-semibold text-[10px] leading-none", className)}>{p.initials}</span>;
}

// Crumbs is the breadcrumb. Where no worktree is open it names the page
// you are on; in a worktree it is its project, then the worktree, then the
// agent (or other tab) in the focused pane, each a switcher.
function Crumbs({ narrow }: { narrow: boolean }) {
  const view = useStore((s) => s.view);
  const key = useHereKey();
  const current = useWorkspaces((s) => s.current);
  const projects = useRailProjects();
  const nav = useNavItems();
  const here = useMemo(() => {
    for (const p of projects) {
      const w = p.worktrees.find((x) => x.key === key);
      if (w) return { p, w };
    }
    return undefined;
  }, [projects, key]);

  if (view.kind !== "workspace" || !current || homeBox(current) || !here) {
    const item = nav.find((n) => n.active);
    const label = view.kind === "settings" ? "Settings" : view.kind === "project" ? `${view.location} settings` : view.kind === "team" ? "Team setup" : (item?.label ?? "Home");
    const icon = view.kind === "settings" || view.kind === "project" ? <SettingsIcon /> : (item?.icon ?? <HomeIcon />);
    return (
      <nav data-tauri-drag-region aria-label="Breadcrumb" data-testid="breadcrumb" className="flex min-w-0 flex-1 items-center self-stretch pr-4">
        <ProjectsCrumb projects={projects} label={label} icon={icon} narrow={narrow} />
      </nav>
    );
  }
  return (
    <nav data-tauri-drag-region aria-label="Breadcrumb" data-testid="breadcrumb" className="flex min-w-0 flex-1 items-center self-stretch pr-4">
      <ProjectsCrumb projects={projects} here={here.p} narrow={narrow} />
      <Slash />
      <WorktreeCrumb p={here.p} w={here.w} narrow={narrow} />
      {/* The agent only when there is more than one to tell apart: one
          agent's name is already on its tab. */}
      {here.w.agents.length > 1 && (
        <>
          <Slash />
          <AgentCrumb w={here.w} />
        </>
      )}
    </nav>
  );
}

// ProjectsCrumb is the first step: the project you are in (or the page),
// and every project to go to instead.
function ProjectsCrumb({ projects, here, label, icon, narrow }: { projects: ProjectEntry[]; here?: ProjectEntry; label?: string; icon?: ReactNode; narrow: boolean }) {
  return (
    <Menu>
      <MenuTrigger data-testid="crumb-project" className={cn(crumbClass, "shrink-0 font-medium")}>
        {here ? <ProjectGlyph p={here} /> : <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>}
        {(!here || !narrow) && <span className="truncate">{here ? here.name : label}</span>}
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          {projects.map((p) => (
            <MenuItem key={p.id} data-testid="crumb-project-item" data-project={p.name} disabled={!p.online} onClick={() => openProject(p)} className={cn(p.id === here?.id && "bg-accent/50")}>
              <ProjectGlyph p={p} className="size-4.5 text-[9px]" />
              <span className={cn("min-w-0 flex-1 truncate", p.id === here?.id && "font-medium")}>{p.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs tabular-nums">
                {p.waiting > 0 && (
                  <span className="flex items-center gap-1 text-warning-foreground">
                    <StateGlyph state="waiting" className="size-3" />
                    {p.waiting}
                  </span>
                )}
                {p.running > 0 && (
                  <span className="flex items-center gap-1">
                    <StateGlyph state="running" className="size-3" />
                    {p.running}
                  </span>
                )}
                {!p.online && "away"}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => useStore.getState().openAddLocation()}>
          <FolderPlusIcon />
          Add a project…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// WorktreeCrumb is the worktree you are in, by its state; its menu is the
// project's worktrees by what they need, as the rail's peek lists them.
function WorktreeCrumb({ p, w, narrow }: { p: ProjectEntry; w: WtEntry; narrow: boolean }) {
  const short = useMediaQuery(SHORT);
  return (
    <Menu>
      <MenuTrigger data-testid="crumb-worktree" className={cn(crumbClass, "shrink-0", narrow ? "max-w-44" : "max-w-72")}>
        {w.state === "waiting" || w.state === "running" || w.state === "finished" ? (
          <StateGlyph state={w.state} />
        ) : (
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{w.wt.main ? <HomeIcon /> : <GitBranchIcon />}</span>
        )}
        <span className="truncate">{w.name}</span>
        {/* The box only where it matters: a project on several, or away. */}
        {(p.multiBox || w.away) && <BoxTag box={w.box} away={w.away} />}
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" collisionPadding={PEEK_COLLISION} className="w-96">
        <ProjectHead p={p} />
        <WorktreeItems p={p} compact={short} />
        <ProjectFooter p={p} />
      </MenuPopup>
    </Menu>
  );
}

// AgentCrumb is what the focused pane shows: an agent by its work, or a
// shell, a page or a file; its menu is the worktree's agents and sessions,
// and new ones.
function AgentCrumb({ w }: { w: WtEntry }) {
  const focused = useFocused();
  const stats = useStore((s) => s.boxes[w.box]?.stats);
  const presets = useMemo(() => agentPresets(w.box, w.loc), [w.box, w.loc]);
  const sessions = [...w.agents.map((a) => a.session), ...w.others];
  const s = focused?.session;
  const state = s ? sessionState(s, stats) : undefined;
  const agent = s ? w.agents.find((a) => a.session.name === s.name)?.agent : undefined;
  const name = s ? sessionName(s, { sessions }) : focused?.kind === "browser" ? "Browser" : focused?.kind === "preview" ? "Preview" : focused?.kind === "file" ? "File" : focused?.title || (w.agents.length ? `${w.agents.length} agent${w.agents.length === 1 ? "" : "s"}` : "No agent yet");
  return (
    <Menu>
      <MenuTrigger data-testid="crumb-agent" className={cn(crumbClass, "text-muted-foreground data-popup-open:text-foreground hover:text-foreground", "min-w-12 max-w-96")}>
        {s ? agent ? <AgentIcon agent={agent} /> : <SquareTerminalIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{name}</span>
        {state && (state === "waiting" || state === "running" || state === "finished") && <span className={cn("shrink-0 text-xs", state === "waiting" && "text-warning-foreground", state === "running" && "text-info-foreground", state === "finished" && "text-success-foreground")}>{sessionWord(state)}</span>}
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" className="w-80">
        {w.agents.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel>Agents in {w.name}</MenuGroupLabel>
            {w.agents.map((a) => (
              <MenuItem key={a.session.name} data-testid="crumb-agent-item" onClick={() => openSession(a.box, a.session)} className={cn(s?.name === a.session.name && "bg-accent/50")}>
                <StateGlyph state={a.state} />
                <span className="min-w-0 flex-1 truncate">{sessionName(a.session, { sessions })}</span>
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                  <AgentIcon agent={a.agent} className="size-3" />
                  {ago(a.session.state_since ?? a.session.created).replace(" ago", "")}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        )}
        {w.others.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel>Terminals and servers</MenuGroupLabel>
            {w.others.map((o) => (
              <MenuItem key={o.name} onClick={() => openSession(w.box, o)} className={cn(s?.name === o.name && "bg-accent/50")}>
                <SquareTerminalIcon />
                <span className="min-w-0 flex-1 truncate">{sessionName(o, { sessions })}</span>
                {o.service && <span className="text-muted-foreground text-xs">server</span>}
              </MenuItem>
            ))}
          </MenuGroup>
        )}
        {(w.agents.length > 0 || w.others.length > 0) && <MenuSeparator />}
        <MenuGroup>
          <MenuGroupLabel>Start here</MenuGroupLabel>
          {presets.map((p) => (
            <MenuItem key={p.id} onClick={() => void startSession(p.command, { kind: "tab" }, p.name)}>
              <span className="flex size-4 items-center justify-center">
                <AgentIcon agent={p.id} />
              </span>
              {p.name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => void startSession("")}>
            <SquareTerminalIcon />
            Terminal
            <MenuShortcut>{keysFor("new-terminal")}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
