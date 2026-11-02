import type { Location, Session, Stats, Worktree } from "@/lib/api";

// What the app shows for a session: the agent's last reported state ("ready"
// is an agent open with nothing to do yet), "exited" once the program ended,
// or "idle" for a plain shell. A finished turn that turn check read as work
// still running (a build, a deploy, a watcher) shows as running, and one it
// read as parked until a reply or a later time as ready (Idle).
export type SessionState = "ready" | "running" | "waiting" | "finished" | "exited" | "idle";

export const AGENTS = ["claude", "codex", "opencode", "gemini", "pi", "omp", "cursor-agent"];

export function agentOf(s: Session): string | undefined {
  // A service's terminal runs no agent, whatever its command.
  if (s.service) return undefined;
  if (s.agent) return s.agent;
  const program = s.command?.trim().split(/\s+/)[0]?.split("/").pop();
  return program && AGENTS.includes(program) ? program : undefined;
}

// atQuestion says an agent shown as waiting waits on a question of its own,
// on its screen or from its hooks. Turn check's wait (soft_wait) is not one:
// its question is its last message, and a prompt typed then is a new turn.
export const atQuestion = (s: Session | undefined, state: string | undefined): boolean => state === "waiting" && !s?.soft_wait;

export function sessionState(s: Session, stats?: Stats): SessionState {
  if (s.exited) return "exited";
  // Never another agent's state in the same worktree.
  if (s.service) return "idle";
  if (s.agent_state === "finished" && s.unfinished) return "running";
  if (s.agent_state === "finished" && s.parked) return "ready";
  if (s.agent_state) return s.agent_state === "idle" ? "ready" : s.agent_state;
  // The box's report is per folder: a state from before this session began
  // is another agent's in the same worktree, not this one's (a new agent
  // would show the last one's question or "finished").
  const born = Date.parse(s.created);
  const reported = stats?.agents?.find((a) => a.path === s.dir && a.state !== "running" && !(born && a.since && Date.parse(a.since) < born));
  if (reported) return reported.state === "idle" ? "ready" : reported.state;
  return agentOf(s) ? "running" : "idle";
}

// onItsWork says a session shown as running is not in a turn: its turn
// ended, and turn check read its work as running on without it (a delegated
// task it waits on, a build, a deploy, a watcher). It is drawn with an
// hourglass, not a live turn's spinner, and says why in ON_ITS_WORK.
export const onItsWork = (s: Session | undefined): boolean => !!s && !s.exited && !s.service && s.agent_state === "finished" && !!s.unfinished;

export const ON_ITS_WORK = "Its turn ended while its work runs on: a delegated task, a build, a deploy or a watcher. It picks up by itself.";

// allOnItsWork says every session of these shown as running is on its work,
// with no live turn among them: a row that sums them up shows the hourglass.
export function allOnItsWork(sessions: Session[], stats?: Stats): boolean {
  const running = sessions.filter((s) => sessionState(s, stats) === "running");
  return running.length > 0 && running.every(onItsWork);
}

// chatState is the state a chat draws a session in: one on its work is
// between turns, so its chat is a finished turn's (Send; no spinner, timer
// or Stop), with the hourglass at its foot. Everywhere else it is running.
export function chatState(s: Session, stats?: Stats): SessionState {
  return onItsWork(s) ? "finished" : sessionState(s, stats);
}

// replyMode is what a chat's reply box does at a state: queue a message
// for when a live turn ends, answer the agent's question, or send it.
export const replyMode = (state: string | undefined): "send" | "queue" | "answer" => (state === "running" ? "queue" : state === "waiting" ? "answer" : "send");

export function worktreeSessions(sessions: Session[] | undefined, wt: Worktree): Session[] {
  // A service's terminal is the service, not work in the worktree.
  return (sessions ?? []).filter((s) => s.dir === wt.path && !s.service);
}

// worktreeOf finds the worktree a session runs in.
export function worktreeOf(locations: Location[] | undefined, s: Session): { location: Location; worktree: Worktree } | undefined {
  for (const location of locations ?? []) {
    for (const worktree of location.worktrees ?? []) {
      if (worktree.path === s.dir) return { location, worktree };
    }
  }
  return undefined;
}

// offBoard is whether a session runs in a location kept off the Agent
// Dashboard (Settings → Agents). hidden holds "box/location" names; a
// session outside every known worktree stays on the board.
export function offBoard(locations: Location[] | undefined, box: string, s: Session, hidden: ReadonlySet<string>): boolean {
  if (!hidden.size) return false;
  const where = worktreeOf(locations, s);
  return !!where && hidden.has(`${box}/${where.location.name}`);
}

// sessionName is what the app calls a session everywhere it lists one: its
// title, the work it was started for ("Fix checkout webhook"), or without
// one the agent's name, or "Shell", numbered when its worktree has more
// than one of the same ("Claude Code 2", by when they started). agent adds
// the agent after a title, for text with no agent icon beside it ("Fix
// checkout webhook · Claude Code"); sessionAgent is that part alone, for
// secondary text. Pass sessions (the box's) for the number, and locations
// with place to say where it runs, for lists outside the worktree's own
// tabs: "shop / checkout-fix · Codex". The raw session id belongs in
// tooltips and developer surfaces only.
export function sessionName(s: Session, opts: { sessions?: Session[]; locations?: Location[]; place?: boolean; agent?: boolean } = {}): string {
  const title = s.title?.trim();
  const agent = agentOf(s);
  let name = title || (agent ? agentLabel(agent) : s.service || "Shell");
  if (title && opts.agent) name += ` · ${agent ? agentLabel(agent) : "Shell"}`;
  const same = title ? [] : (opts.sessions ?? []).filter((o) => o.dir === s.dir && agentOf(o) === agent && !o.exited && !o.title?.trim());
  if (same.length > 1) {
    const order = same.sort((a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name));
    const n = order.findIndex((o) => o.name === s.name) + 1;
    if (n > 1) name += ` ${n}`;
  }
  if (!opts.place) return name;
  return `${sessionPlace(s, opts.locations)} · ${name}`;
}

// TITLE_MAX is how long a title made from a prompt is, as the box makes it.
export const TITLE_MAX = 48;

// titleOf is the box's title for a prompt: its first line with words in it,
// spaces collapsed, cut at a word near TITLE_MAX with an ellipsis. The demo
// names its sessions with it; the box does the same for real ones
// (internal/integrations/adapters/title.go).
export function titleOf(prompt: string, max = TITLE_MAX): string {
  const line = prompt
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .find(Boolean);
  if (!line) return "";
  const chars = [...line];
  if (chars.length <= max) return line;
  const cut = chars.slice(0, max - 1);
  let at = cut.length;
  if (chars[max - 1] !== " ") {
    for (let i = cut.length - 1; i >= Math.floor((max * 2) / 3); i--) {
      if (cut[i] === " ") {
        at = i;
        break;
      }
    }
  }
  return `${cut.slice(0, at).join("").replace(/[\s.,;:-]+$/, "")}…`;
}

// sessionAgent is the secondary text beside a titled session's name: the
// agent ("Claude Code") or "Shell". Untitled sessions are named after their
// agent already, so it is empty for them.
export function sessionAgent(s: Session): string {
  if (s.service) return "Service";
  if (!s.title?.trim()) return "";
  const agent = agentOf(s);
  return agent ? agentLabel(agent) : "Shell";
}

// guessSessionName names a session the box doesn't list (it has gone, or
// its box is away) from its id, which berthd makes from where and what it
// runs: "evals-judge-claude-3k9" → "evals-judge · Claude Code". An id that
// doesn't follow that shape comes back as it is.
export function guessSessionName(id: string): string {
  const at = programIn(id);
  if (!at) return id;
  const name = at.prog === "shell" ? "Shell" : agentLabel(at.prog);
  return at.place ? `${at.place} · ${name}` : name;
}

// guessAgent is the agent a session id names, for an icon.
export const guessAgent = (id: string): string | undefined => {
  const prog = programIn(id)?.prog;
  return prog === "shell" ? undefined : prog;
};

function programIn(id: string): { prog: string; place: string } | undefined {
  const parts = id.split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const two = parts.slice(i, i + 2).join("-");
    const prog = AGENTS.includes(two) ? two : AGENTS.includes(parts[i]) || parts[i] === "shell" ? parts[i] : undefined;
    if (prog) return { prog, place: parts.slice(0, i).join("-") };
  }
  return undefined;
}

// sessionPlace is where a session runs: "shop" for a main checkout, "shop /
// checkout-fix" for a worktree, or "shop / Fix checkout" once it was given
// a display name.
export function sessionPlace(s: Session, locations?: Location[]): string {
  const where = worktreeOf(locations, s);
  if (!where) return s.location ?? s.name;
  return where.worktree.main ? where.location.name : `${where.location.name} / ${where.worktree.title?.trim() || where.worktree.name}`;
}

// Worktrees are listed main first, then by name.
export function sortedWorktrees(loc: Location): Worktree[] {
  return [...(loc.worktrees ?? [])].sort((a, b) => Number(!!b.main) - Number(!!a.main) || a.name.localeCompare(b.name));
}

const labels: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", pi: "Pi", omp: "oh-my-pi", "cursor-agent": "Cursor Agent", cursor: "Cursor Agent" };

// agentLabel is an agent's product name: "claude" → "Claude Code".
export const agentLabel = (a: string) => labels[a] ?? a.charAt(0).toUpperCase() + a.slice(1);

// restartCommand is how to start an agent again: its command without the
// first prompt it was given (berth adds it last, shell-quoted, after
// --prompt or -i for the agents that take one), so starting again doesn't
// run the old task a second time. A structured agent's command (berthd's
// agent host) has no prompt in it, and is never run again as it was: its
// conversation is carried on instead (conversationOf).
export function restartCommand(command?: string): string | undefined {
  if (!command || conversationOf(command)) return undefined;
  return command.replace(/(?:\s+(?:--prompt|-i))?\s+'(?:[^']|'\\'')*'\s*$/, "");
}

// conversationOf is the structured conversation a session's command runs
// berthd's agent host for (its --dir is the conversation's folder), or
// undefined for any other command.
export function conversationOf(command?: string): string | undefined {
  const m = command && /'agent-host'.*?\s--dir\s+'([^']+)'/.exec(command);
  return m ? m[1].split("/").filter(Boolean).pop() : undefined;
}

// firstPrompt is that prompt, unquoted, for a session Shipyard started with
// an agent preset (whose command it wrote); undefined for anything else.
export function firstPrompt(s?: Pick<Session, "command" | "preset">): string | undefined {
  if (!s?.preset || !s.command || conversationOf(s.command)) return undefined;
  const m = s.command.match(/\s'((?:[^']|'\\'')*)'\s*$/);
  return m ? m[1].replaceAll("'\\''", "'") : undefined;
}
