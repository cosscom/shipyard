import type { Location, Session, Worktree } from "@/lib/api";
import { agentLabel, agentOf, sessionName, worktreeOf } from "@/lib/derive";
import { isStructured } from "@/lib/structured";

export interface AgentNames {
  where?: { location: Location; worktree: Worktree };
  // The worktree it works in ("checkout-fix"), or the repository for a main
  // checkout.
  place: string;
  // What the app calls the session: "Claude Code", "Claude Code 2".
  name: string;
  // More than one agent works in the same worktree, so the place alone
  // doesn't say which card is which.
  crowded: boolean;
  // The prompt it was started with, when its command carries one: never
  // an agent's in chat, whose command line is its host's.
  prompt?: string;
  // What its work is called (Session.title), and then its agent, as
  // secondary text: "Fix checkout webhook" · "Claude Code".
  title?: string;
  agent: string;
}

// describeAgent is how the board tells agents apart: where each works, and
// when several share a worktree, which one this is.
export function describeAgent(session: Session, sessions: Session[] | undefined, locations: Location[] | undefined): AgentNames {
  const where = worktreeOf(locations, session);
  const place = where?.worktree.main ? where.location.name : (where?.worktree.name ?? session.location ?? session.name);
  const crowded = (sessions ?? []).filter((o) => o.dir === session.dir && !o.exited && agentOf(o)).length > 1;
  const agent = agentOf(session);
  return { where, place, name: sessionName(session, { sessions }), crowded, prompt: isStructured(session.driver) ? undefined : promptOf(session.command), title: session.title?.trim() || undefined, agent: agent ? agentLabel(agent) : "Shell" };
}

// promptOf is the prompt in an agent's command line: `claude --model x
// 'Review the diff'` → "Review the diff".
export function promptOf(command?: string): string | undefined {
  const rest = command
    ?.trim()
    .replace(/^\S+\s*/, "")
    .replace(/^(?:-{1,2}[\w-]+(?:=\S+)?\s*)+/, "")
    .trim();
  if (!rest) return undefined;
  // A quoted argument is the prompt; flags with values come before it.
  const quoted = [...rest.matchAll(/(['"])([\s\S]*?)\1/g)].pop()?.[2];
  return (quoted ?? rest).replace(/\s+/g, " ").trim() || undefined;
}

// startedAt is a session's start as a clock time, with the day when it
// wasn't today: "14:32", "Mon 09:10".
export function startedAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
