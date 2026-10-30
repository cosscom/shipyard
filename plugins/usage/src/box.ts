import type { BerthPluginContext, Location } from "@berth/plugin";

import script from "../box/usage.py";

// The box side: usage.py, sent with each request through exec, so a box
// needs nothing installed but python3. It answers JSON.

export type Tokens = [input: number, output: number, cacheRead: number, cacheWrite: number];

export interface Report {
  generated: string;
  days: number;
  since: string;
  today: string;
  tz: string;
  partial: boolean;
  pending: number;
  files: number;
  truncated?: boolean;
  // [day, agent, account, model, cwd, input, output, cache read, cache write]
  daily: [string, Agent, string, string, string, number, number, number, number][];
  sessions: UsageSession[];
  limits: Limits[];
}

export type Agent = "claude" | "codex";

export interface UsageSession {
  agent: Agent;
  account: string;
  id: string;
  cwd: string | null;
  title: string | null;
  first: string | null;
  last: string | null;
  tokens: Tokens;
  // Claude Code's own estimate at API list prices, when it recorded one.
  cost: number | null;
  models: string[];
}

export interface Window {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

export interface Limits {
  agent: Agent;
  account: string;
  at: string;
  // The box's own day at `at`, as the days of its tokens are.
  day: string;
  limits: { plan_type?: string | null; primary?: Window | null; secondary?: Window | null };
}

export interface Account {
  agent: Agent;
  id: string;
  dir: string;
  exists: boolean;
  signed_in: boolean;
  email?: string | null;
  name?: string | null;
  org?: string | null;
  billing?: string | null;
  tier?: string | null;
  method?: string | null;
  plan?: string | null;
}

export interface Accounts {
  accounts: Account[];
  // tmux session name → the account variables it was started with.
  sessions: Record<string, { CLAUDE_CONFIG_DIR?: string; CODEX_HOME?: string }>;
  home: string;
}

// The env variable that picks each agent's login.
export const ACCOUNT_VAR: Record<Agent, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

const encoded = (() => {
  const bytes = new TextEncoder().encode(script);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
})();

// where picks a location on the box to run in: the current worktree's, or
// any. exec needs one; the script itself works in the home folder.
export async function where(berth: BerthPluginContext, box: string, prefer?: string): Promise<string> {
  const locs: Location[] = await berth.api.locations(box);
  if (prefer && locs.some((l) => l.name === prefer.split("/")[0])) return prefer;
  if (!locs.length) throw new Error(`${box} has no projects yet; add one to read its usage`);
  return locs[0].name;
}

export async function runScript<T>(berth: BerthPluginContext, box: string, location: string, args: string[], timeout = "5m"): Promise<T> {
  const argv = JSON.stringify(["usage.py", ...args]).replace(/"/g, '\\"');
  const command = `python3 -c "import base64,json,sys;sys.argv=json.loads('${argv.replace(/'/g, "")}');exec(base64.b64decode('${encoded}'))"`;
  const r = await berth.orchestrate.exec(box, location, command, timeout);
  if (r.exit_code === 127 || /python3: (command )?not found/.test(r.output)) throw new Error(`${box} has no python3, which reading usage needs`);
  if (r.exit_code !== 0) throw new Error(r.output.trim().split("\n").slice(-3).join("\n") || `exit ${r.exit_code}`);
  try {
    return JSON.parse(r.output.trim().split("\n").pop() ?? "") as T;
  } catch {
    throw new Error("the box answered something that isn't usage data");
  }
}
