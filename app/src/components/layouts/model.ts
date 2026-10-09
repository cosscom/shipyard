import { useMemo } from "react";

import { useRailAgents } from "@/components/sidebar/rail";
import type { Location, Session, Worktree } from "@/lib/api";
import { agentOf, type SessionState, sessionState } from "@/lib/derive";
import { useProjects } from "@/lib/project-groups";
import { NONE, useStore } from "@/lib/store";
import { openSession, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";

// The Labs layouts (Settings › Labs › Layout) all list the same thing: the
// agents, by what they need from you, and the worktrees you were last in.
// The sidebar's tree is organised by where work lives; these are organised
// by what to do next.

export type Lane = "waiting" | "running" | "finished" | "recent" | "away";
export const LANE_ORDER: Lane[] = ["waiting", "running", "finished", "recent", "away"];
export const LANE_WORDS: Record<Lane, string> = { waiting: "Needs you", running: "Working", finished: "Done", recent: "Recent", away: "Box away" };

export interface Item {
  // box/session for an agent, wt:<key> for a worktree with no agent to show.
  id: string;
  lane: Lane;
  box: string;
  project: string;
  loc: Location;
  wt: Worktree;
  // The worktree's workspace key (lib/workspaces).
  key: string;
  session?: Session;
  agent?: string;
  state?: SessionState;
  // The work, when it has a name ("Fix checkout webhook retries"), else
  // the place.
  title: string;
  // "shop / checkout-fix", or "shop" for a main checkout.
  place: string;
  since?: string;
  // On screen now.
  selected: boolean;
  // The project lives on more than one box, so the box is worth naming.
  spansBoxes: boolean;
}

const placeOf = (project: string, wt: Worktree) => (wt.main ? project : `${project} / ${worktreeLabel(wt)}`);

// useItems is every agent worth a look, in lanes, then the worktrees you
// were in last (and agents sitting ready) as Recent.
export function useItems(): Item[] {
  const agents = useRailAgents();
  const { projects } = useProjects();
  const status = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const spaces = useWorkspaces((s) => s.spaces);
  const current = useWorkspaces((s) => s.current);
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  return useMemo(() => {
    const spans = new Map<string, boolean>();
    const projectOf = new Map<string, string>();
    for (const p of projects) {
      const many = new Set(p.members.map((m) => m.box.name)).size > 1;
      for (const m of p.members) {
        projectOf.set(`${m.box.name}/${m.loc.name}`, p.name);
        spans.set(`${m.box.name}/${m.loc.name}`, many);
      }
    }
    const out: Item[] = agents.map((e) => ({
      id: e.id,
      lane: e.lane,
      box: e.box,
      project: e.project,
      loc: e.loc,
      wt: e.wt,
      key: e.key,
      session: e.session,
      agent: e.agent,
      state: e.state,
      title: e.session.title?.trim() || placeOf(e.project, e.wt),
      place: placeOf(e.project, e.wt),
      since: e.session.state_since ?? e.session.created,
      selected: e.selected,
      spansBoxes: spans.get(`${e.box}/${e.loc.name}`) ?? false,
    }));
    const listed = new Set(out.map((i) => i.key));
    // Recent: worktrees visited, and agents sitting ready with nothing to do.
    const recent: (Item & { at: number })[] = [];
    const online = new Set(status.filter((b) => b.state === "online").map((b) => b.name));
    for (const b of online) {
      const d = data[b];
      for (const loc of d?.locations ?? []) {
        for (const wt of loc.worktrees ?? []) {
          const key = wsKey(b, wt.path);
          if (listed.has(key)) continue;
          const visited = spaces[key]?.visitedAt;
          const ready = (d?.sessions ?? []).find((s) => s.dir === wt.path && !s.service && !s.exited && agentOf(s) && sessionState(s, d?.stats) === "ready");
          if (!visited && !ready) continue;
          const project = projectOf.get(`${b}/${loc.name}`) ?? loc.name;
          listed.add(key);
          recent.push({
            id: ready ? `${b}/${ready.name}` : `wt:${key}`,
            lane: "recent",
            box: b,
            project,
            loc,
            wt,
            key,
            session: ready,
            agent: ready ? agentOf(ready) : undefined,
            state: ready ? "ready" : undefined,
            title: ready?.title?.trim() || placeOf(project, wt),
            place: placeOf(project, wt),
            since: ready?.state_since ?? ready?.created,
            selected: inWorkspace && current === key,
            spansBoxes: spans.get(`${b}/${loc.name}`) ?? false,
            at: visited ?? Date.parse(ready?.state_since ?? ready?.created ?? "") ?? 0,
          });
        }
      }
    }
    recent.sort((a, b) => b.at - a.at);
    // Done: the newest first, since what just finished is what you look at.
    const time = (i: Item) => Date.parse(i.since ?? "") || 0;
    const lanes = LANE_ORDER.map((lane) => {
      if (lane === "recent") return recent.map(({ at: _at, ...i }) => i);
      const list = out.filter((i) => i.lane === lane);
      // What has waited longest needs you first; work by place, so rows
      // only move when their state changes.
      if (lane === "waiting") return list.sort((a, b) => time(a) - time(b));
      if (lane === "finished") return list.sort((a, b) => time(b) - time(a));
      return list;
    });
    return lanes.flat();
  }, [agents, projects, status, data, spaces, current, inWorkspace]);
}

// openItem goes to an item: its agent's pane, or its worktree.
export function openItem(i: Item) {
  if (i.session) openSession(i.box, i.session);
  else selectWorktree(refOf(i.box, i.loc, i.wt));
}

// askText is what a waiting agent asks, in a few words.
export function askText(s?: Session): string | undefined {
  const ask = s?.ask;
  if (!ask) return undefined;
  if (ask.tool === "Bash" && ask.input) return `Run ${ask.input}`;
  if (ask.message) return ask.message;
  if (ask.input) return ask.tool ? `${ask.tool}: ${ask.input}` : ask.input;
  return ask.tool ? `Allow ${ask.tool}?` : undefined;
}

// shortAgo is "4m", "2h", "3d": a time for a narrow row.
export function shortAgo(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
