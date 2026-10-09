import { useMemo } from "react";

import type { Location, Session, Worktree } from "@/lib/api";
import { agentLabel, agentOf, type SessionState, sessionState, worktreeSessions } from "@/lib/derive";
import { leaves } from "@/lib/layout";
import { type Project, useProjects } from "@/lib/project-groups";
import { BOX_WORDS, boxState } from "@/lib/state-model";
import { NONE, useStore } from "@/lib/store";
import { openSession, refOf, selectWorktree, useWorkspaces, type Workspace, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";

// The rail layout's model (Labs › Layout › Icon rail): every project with
// its worktrees, each worktree with its agents and the one line that says
// what it is doing, and the counts the rail's badges and rings draw. The
// rail, its peeks and the title bar's breadcrumb all read it, so they agree.

export type Lane = "waiting" | "running" | "finished" | "quiet";
export const LANES: Lane[] = ["waiting", "running", "finished", "quiet"];
export const LANE_WORDS: Record<Lane, string> = { waiting: "Needs you", running: "Working", finished: "Done", quiet: "Quiet" };

const urgency: Record<SessionState, number> = { waiting: 0, running: 1, finished: 2, ready: 3, idle: 4, exited: 5 };

export interface AgentEntry {
  box: string;
  session: Session;
  state: SessionState;
  agent: string;
}

export interface WtEntry {
  key: string;
  box: string;
  loc: Location;
  wt: Worktree;
  // Its agents, the one that needs you most first; then its shells and
  // dev servers.
  agents: AgentEntry[];
  others: Session[];
  // Its most urgent agent's state, when one runs.
  state?: SessionState;
  lane: Lane;
  name: string;
  // What it is doing, in one line: its lead agent's work.
  doing?: string;
  // What its lead agent waits for, when it needs you.
  ask?: string;
  selected: boolean;
  // The box's state when it is not online.
  away?: string;
  visitedAt: number;
}

export interface ProjectEntry {
  project: Project;
  id: string;
  name: string;
  initials: string;
  worktrees: WtEntry[];
  waiting: number;
  running: number;
  finished: number;
  // The worktree in front is one of its own.
  current: boolean;
  multiBox: boolean;
  online: boolean;
  section?: string;
}

// initialsFor names each project in one or two letters: its words'
// initials, or its first letter, or two when another project starts alike.
export function initialsFor(names: string[]): Record<string, string> {
  const words = (n: string) => n.split(/[\s\-_./]+/).filter(Boolean);
  const first = (n: string) => (words(n)[0]?.[0] ?? n[0] ?? "?").toUpperCase();
  const out: Record<string, string> = {};
  for (const n of names) {
    const w = words(n);
    if (w.length > 1) out[n] = (w[0][0] + w[1][0]).toUpperCase();
    else if (names.filter((o) => o !== n && first(o) === first(n)).length) out[n] = first(n) + (w[0]?.[1] ?? "").toLowerCase();
    else out[n] = first(n);
  }
  return out;
}

const laneOf = (s?: SessionState): Lane => (s === "waiting" || s === "running" || s === "finished" ? s : "quiet");

function askText(s: Session): string | undefined {
  const a = s.ask;
  if (!a) return undefined;
  const what = a.input ?? a.message;
  if (!what) return undefined;
  return a.tool && a.tool !== "AskUserQuestion" ? `${a.tool}: ${what}` : what;
}

export function useRailProjects(): ProjectEntry[] {
  const status = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const current = useWorkspaces((s) => s.current);
  const spaces = useWorkspaces((s) => s.spaces);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const { projects, sections } = useProjects();
  return useMemo(() => {
    const initials = initialsFor(projects.map((p) => p.name));
    const list = projects.map((p): ProjectEntry => {
      const worktrees: WtEntry[] = [];
      for (const m of p.members) {
        const d = data[m.box.name];
        const away = m.box.state === "online" ? undefined : BOX_WORDS[boxState(m.box, d)].lower;
        for (const wt of m.loc.worktrees ?? []) {
          const sessions = worktreeSessions(d?.sessions, wt).filter((s) => !s.exited);
          const agents = sessions
            .filter((s) => agentOf(s))
            .map((s) => ({ box: m.box.name, session: s, state: sessionState(s, d?.stats), agent: agentOf(s)! }))
            .sort((a, b) => urgency[a.state] - urgency[b.state] || a.session.created.localeCompare(b.session.created));
          const lead = away ? undefined : agents[0];
          const key = wsKey(m.box.name, wt.path);
          worktrees.push({
            key,
            box: m.box.name,
            loc: m.loc,
            wt,
            agents,
            others: sessions.filter((s) => !agentOf(s)),
            state: lead?.state,
            lane: away ? "quiet" : laneOf(lead?.state),
            name: wt.main ? (p.members.length > 1 || (m.loc.worktrees?.length ?? 0) > 1 ? "main" : p.name) : worktreeLabel(wt),
            doing: lead ? lead.session.title?.trim() || agentLabel(lead.agent) : away ? `${m.box.name} is ${away}` : undefined,
            ask: lead?.state === "waiting" ? askText(lead.session) : undefined,
            selected: inWorkspace && current === key,
            away,
            visitedAt: spaces[key]?.visitedAt ?? 0,
          });
        }
      }
      // By lane, then the main checkout first, then by name: a row only
      // moves when its agents change state.
      worktrees.sort((a, b) => LANES.indexOf(a.lane) - LANES.indexOf(b.lane) || Number(!!b.wt.main) - Number(!!a.wt.main) || a.name.localeCompare(b.name) || a.box.localeCompare(b.box));
      const count = (st: SessionState) => worktrees.reduce((n, w) => n + (w.away ? 0 : w.agents.filter((a) => a.state === st).length), 0);
      return {
        project: p,
        id: p.id,
        name: p.name,
        initials: initials[p.name] ?? p.name[0]?.toUpperCase() ?? "?",
        worktrees,
        waiting: count("waiting"),
        running: count("running"),
        finished: count("finished"),
        current: worktrees.some((w) => w.selected),
        multiBox: p.members.length > 1,
        online: p.members.some((m) => m.box.state === "online"),
        section: p.section,
      };
    });
    // The sidebar's order: projects in no section, then each section's.
    const order = (e: ProjectEntry) => (e.section ? sections.indexOf(e.section) + 1 : 0);
    return list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  }, [projects, sections, data, current, spaces, inWorkspace, status]);
}

// bestWorktree is where a project opens: a worktree with an agent that
// needs you, else the one last visited, else one where an agent works,
// else its main checkout.
export function bestWorktree(p: ProjectEntry): WtEntry | undefined {
  const live = p.worktrees.filter((w) => !w.away);
  return (
    live.find((w) => w.lane === "waiting") ??
    [...live].filter((w) => w.visitedAt).sort((a, b) => b.visitedAt - a.visitedAt)[0] ??
    live.find((w) => w.lane === "running") ??
    live.find((w) => w.wt.main && w.box === p.project.defaultBox) ??
    live[0]
  );
}

// openWt shows a worktree: with one agent in it, that agent's tab in front.
export function openWt(w: WtEntry) {
  if (w.away) return;
  if (w.agents.length === 1) return openSession(w.box, w.agents[0].session);
  selectWorktree(refOf(w.box, w.loc, w.wt));
}

export function openProject(p: ProjectEntry) {
  const w = bestWorktree(p);
  if (w) openWt(w);
}

// useFocused is the session in the focused pane, if it is one, and what
// else the pane is when not.
export function useFocused(): { box: string; session?: Session; kind?: string; title?: string } | undefined {
  const ws: Workspace | undefined = useWorkspaces((s) => (s.current ? s.spaces[s.current] : undefined));
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  const c = tab ? leaves(tab.root).find((l) => l.id === tab.focus)?.content : undefined;
  const session = useStore((s) => (c?.kind === "terminal" ? s.boxes[c.box]?.sessions?.find((x) => x.name === c.session) : undefined));
  if (!ws || !c) return undefined;
  if (c.kind === "terminal") return { box: c.box, session, kind: "terminal", title: c.title };
  return { box: ws.ref.box, kind: c.kind };
}

// waitingAgents is every agent that needs you, in the rail's order, for
// the title bar's "needs you" button to go through.
export function waitingAgents(projects: ProjectEntry[]): AgentEntry[] {
  return projects.flatMap((p) => p.worktrees.filter((w) => !w.away).flatMap((w) => w.agents.filter((a) => a.state === "waiting")));
}
