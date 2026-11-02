// Where switching to another project in the sidebar lands
// (components/sidebar/columns.tsx and rail-layout.tsx): on the agent in it
// that worked last, so you are back where its work is; with none working or
// waiting on you, on the worktree of it you were in last; and with nothing
// open in it at all (inUse), on a new task too. Pure, so it is tested on
// its own (project-landing.test.ts).

import type { Location, Session, Stats, Worktree } from "@/lib/api";

import { agentOf, sessionState } from "./derive.ts";

// A project's place on one online box: its repository there, and that box's
// sessions.
export interface LandingPlace {
  box: string;
  loc: Location;
  sessions: readonly Session[];
  stats?: Stats;
}

// landingAgent is the agent to show when switching to a project: of those
// in its worktrees that are working or waiting on you, the one whose state
// changed last. Undefined when none is (landingWorktree then).
export function landingAgent(places: readonly LandingPlace[]): { box: string; session: Session } | undefined {
  let best: { box: string; session: Session; at: number } | undefined;
  for (const p of places) {
    const paths = new Set((p.loc.worktrees ?? []).map((w) => w.path));
    for (const s of p.sessions) {
      if (!paths.has(s.dir) || !agentOf(s)) continue;
      const st = sessionState(s, p.stats);
      if (st !== "running" && st !== "waiting") continue;
      const at = Date.parse(s.state_since ?? s.created) || 0;
      if (!best || at > best.at) best = { box: p.box, session: s, at };
    }
  }
  return best && { box: best.box, session: best.session };
}

// inUse says whether a project has a session open in any of its
// worktrees: an agent, at work, idle or done, or a shell. One that ended
// and a service's terminal don't count. A project without one is grayed
// out in the sidebar, and switching to it opens a new task.
export function inUse(places: readonly Pick<LandingPlace, "loc" | "sessions">[]): boolean {
  return places.some((p) => {
    const paths = new Set((p.loc.worktrees ?? []).map((w) => w.path));
    return p.sessions.some((s) => !s.exited && !s.service && paths.has(s.dir));
  });
}

// landingWorktree is where switching to a project with no agent at work
// lands: the worktree of it you were in last (visitedAt gives when, by box
// and path), else its main checkout on the box home names.
export function landingWorktree(
  places: readonly Pick<LandingPlace, "box" | "loc">[],
  visitedAt: (box: string, path: string) => number | undefined,
  home?: string,
): { box: string; loc: Location; wt: Worktree } | undefined {
  let best: { box: string; loc: Location; wt: Worktree; at: number } | undefined;
  for (const p of places) {
    for (const wt of p.loc.worktrees ?? []) {
      const at = visitedAt(p.box, wt.path);
      if (at !== undefined && (!best || at > best.at)) best = { box: p.box, loc: p.loc, wt, at };
    }
  }
  if (best) return { box: best.box, loc: best.loc, wt: best.wt };
  const p = places.find((x) => x.box === home) ?? places[0];
  const wt = p?.loc.worktrees?.find((w) => w.main);
  return p && wt && { box: p.box, loc: p.loc, wt };
}
