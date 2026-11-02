import type { Hook } from "@/lib/api";

// The events and gates a hook can follow, from docs/reference/events.mdx. The editor's
// picker, the readable labels in the table, and the $BERTH_* variables shown
// while writing a command all come from here.

export type Where = "laptop" | "box";

export interface CatalogEntry {
  on: string;
  label: string;
  where: Where;
  fields: string[];
  // Gates run before the action and can stop it.
  gate?: boolean;
  hint?: string;
}

const agent = ["path", "agent", "session_id"];
const worktree = ["location", "name", "path", "branch"];

export const CATALOG: CatalogEntry[] = [
  { on: "agent.waiting", label: "Agent needs you", where: "box", fields: [...agent, "reason"], hint: "A permission, a question, or a startup prompt." },
  { on: "agent.substate", label: "Agent placed in a sub-state", where: "box", fields: [...agent, "sub_state", "why"], hint: "A question form sorted into a Needs you column, or couldn't be. No new wait: agent.waiting isn't sent again." },
  { on: "agent.finished", label: "Agent finished", where: "box", fields: agent, hint: "Done with its turn." },
  { on: "agent.started", label: "Agent started working", where: "box", fields: agent },
  { on: "agent.ready", label: "Agent ready", where: "box", fields: agent, hint: "A new agent sitting at its prompt." },
  { on: "worktree.created", label: "Worktree created", where: "box", fields: worktree },
  { on: "worktree.removed", label: "Worktree removed", where: "box", fields: worktree },
  { on: "worktree.setup.finished", label: "Setup finished", where: "box", fields: [...worktree.slice(0, 3), "script", "log"] },
  { on: "worktree.setup.failed", label: "Setup failed", where: "box", fields: [...worktree.slice(0, 3), "script", "log"] },
  { on: "worktree.archive.finished", label: "Archive finished", where: "box", fields: [...worktree.slice(0, 3), "script", "log"] },
  { on: "review.opened", label: "PR review opened", where: "box", fields: [...worktree.slice(0, 3), "repo", "pr", "sha", "author", "association", "box", "reviewer", "secrets", "withheld"], hint: "A review link was opened on this box, at the head commit shown." },
  { on: "review.updated", label: "PR review updated", where: "box", fields: [...worktree.slice(0, 3), "repo", "pr", "from", "sha", "author", "association", "reviewer"] },
  { on: "review.removed", label: "PR review removed", where: "box", fields: [...worktree.slice(0, 3), "repo", "pr", "reason"], hint: "Merged, closed, idle, or removed by hand." },
  { on: "review.waiting", label: "PR review waits for you", where: "box", fields: [...worktree.slice(0, 3), "repo", "pr", "reason"], hint: "Due for clean-up, but it has uncommitted changes." },
  { on: "task.created", label: "Task created", where: "box", fields: [...worktree, "session", "agent", "from_session"] },
  { on: "session.started", label: "Session started", where: "box", fields: ["name", "location", "path", "command"] },
  { on: "session.stopped", label: "Session stopped", where: "box", fields: ["name"] },
  { on: "exec.finished", label: "Command finished", where: "box", fields: ["location", "path", "command", "exit_code"] },
  { on: "location.added", label: "Repo added", where: "box", fields: ["location", "path"] },
  { on: "share.started", label: "Port shared publicly", where: "box", fields: ["id", "port", "url"] },
  { on: "share.stopped", label: "Share stopped", where: "box", fields: ["id", "port", "url"] },
  { on: "unit.restarted", label: "Unit restarted", where: "box", fields: ["name"] },
  { on: "box.upgraded", label: "Box upgraded", where: "box", fields: ["build"] },
  { on: "box.connected", label: "Box connected", where: "laptop", fields: [] },
  { on: "box.disconnected", label: "Box disconnected", where: "laptop", fields: [] },
  { on: "box.link", label: "Box link slow or steady again", where: "laptop", fields: ["slow", "reason"] },
  { on: "forward.failed", label: "Forward failed", where: "laptop", fields: ["id", "local", "remote"] },
  { on: "laptop.started", label: "Shipyard started", where: "laptop", fields: [] },
  { on: "before:worktree.create", label: "Before a worktree is made", where: "box", gate: true, fields: ["location", "name", "branch", "base"] },
  { on: "before:worktree.remove", label: "Before a worktree is removed", where: "box", gate: true, fields: ["location", "name", "path"] },
  { on: "before:task.create", label: "Before a task starts", where: "box", gate: true, fields: ["location", "name", "branch", "base", "agent", "command"] },
  { on: "before:session.start", label: "Before a session starts", where: "box", gate: true, fields: ["name", "location", "path", "command"] },
  { on: "before:session.send", label: "Before a prompt is sent", where: "box", gate: true, fields: ["name"] },
  { on: "before:exec", label: "Before a command runs", where: "box", gate: true, fields: ["location", "path", "command"] },
  { on: "before:location.add", label: "Before a repo is added", where: "box", gate: true, fields: ["location", "path"] },
];

// Box events reach the laptop too, relayed by the agent, so a laptop hook can
// follow any of them.
export function catalogFor(machine: "laptop" | string): CatalogEntry[] {
  return machine === "laptop" ? CATALOG.filter((e) => !e.gate) : CATALOG.filter((e) => e.where === "box");
}

export interface Described {
  label: string;
  gate: boolean;
  fields: string[];
}

// describe turns a hook's "on" into what the table shows: the catalog's
// label, or a readable form of a prefix like "worktree.*".
export function describe(on: string): Described {
  const hit = CATALOG.find((e) => e.on === on);
  if (hit) return { label: hit.label, gate: !!hit.gate, fields: hit.fields };
  const gate = on.startsWith("before:");
  const bare = gate ? on.slice("before:".length) : on;
  if (bare === "*") return { label: gate ? "Before anything" : "Every event", gate, fields: [] };
  if (bare.endsWith(".*")) {
    const area = bare.slice(0, -2);
    return { label: `${gate ? "Before any" : "Any"} ${area} event`, gate, fields: [] };
  }
  return { label: bare, gate, fields: [] };
}

// envName is how a data field reaches a hook's command.
export const envName = (field: string) => `BERTH_${field.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export const ALWAYS_ENV = ["BERTH_EVENT", "BERTH_EVENT_BOX", "BERTH_EVENT_ORIGIN"];

export interface Starter {
  id: string;
  title: string;
  description: string;
  // Where it belongs: this laptop, or the first online box.
  where: Where;
  hook: Hook;
}

export const STARTERS: Starter[] = [
  {
    id: "notify",
    title: "Notify when an agent waits",
    description: "A macOS notification, from any box.",
    where: "laptop",
    hook: { on: "agent.waiting", run: `osascript -e "display notification \\"$BERTH_PATH\\" with title \\"An agent on $BERTH_EVENT_BOX needs you\\""` },
  },
  {
    id: "deps",
    title: "Install deps on new worktrees",
    description: "pnpm install as soon as a worktree exists.",
    where: "box",
    hook: { on: "worktree.created", run: `cd "$BERTH_PATH" && pnpm install`, timeout: "10m" },
  },
  {
    id: "no-main",
    title: "Block worktrees on main",
    description: "Refuse a worktree whose branch is main.",
    where: "box",
    hook: { on: "before:worktree.create", run: `[ "\${BERTH_BRANCH:-$BERTH_NAME}" != "main" ] || { echo "work on a branch, not main"; exit 1; }` },
  },
];
