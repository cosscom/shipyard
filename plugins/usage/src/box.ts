/// <reference path="./py.d.ts" />
// (So the app's tsc, which reaches this file through usage-summary.test.ts,
// knows usage.py is text too.)
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
  // Logins whose profile is on the box but whose login Claude Code lost:
  // they need signing in again (older boxes don't say).
  signed_out?: SignedOut[];
}

export interface SignedOut {
  agent: Agent;
  account: string;
  email: string | null;
  org: string | null;
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
  // Unix seconds; null when the agent printed a reset it couldn't be read from.
  resets_at: number | null;
  // The window's own name, for one scoped to a model ("Weekly limit (Fable)").
  label?: string;
}

export interface Limits {
  agent: Agent;
  account: string;
  // The login's email, when the agent recorded one.
  email?: string | null;
  // Its organisation's id: one email can sign in to two plans (a team seat
  // and a personal Max).
  org?: string | null;
  at: string;
  // Codex reports a 5-hour and a weekly window in its transcripts; Claude Code
  // reports its session, its week and a week per scoped model in `/usage`.
  limits: { plan_type?: string | null; primary?: Window | null; secondary?: Window | null; extra?: Window[] };
}

export interface Account {
  agent: Agent;
  id: string;
  dir: string;
  exists: boolean;
  signed_in: boolean;
  // Its profile is here but Claude Code lost the login: sign in again.
  signed_out?: boolean;
  email?: string | null;
  // Claude Code's organization type: claude_team, claude_enterprise,
  // claude_max, claude_pro (older boxes don't say).
  org_type?: string | null;
  name?: string | null;
  org?: string | null;
  // The organisation's id: one email can sign in to two plans.
  org_id?: string | null;
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

// A box with no projects has nowhere to run the script: not a failure, just
// nothing to read yet.
export class NoProjects extends Error {}

// where picks a location on the box to run in: the current worktree's, or
// any. The script itself works in the home folder, so a box with no
// projects runs it with none ("": exec runs in the home folder there).
export async function where(berth: BerthPluginContext, box: string, prefer?: string): Promise<string> {
  const locs: Location[] = await berth.api.locations(box);
  if (prefer && locs.some((l) => l.name === prefer.split("/")[0])) return prefer;
  return locs[0]?.name ?? "";
}

export async function runScript<T>(berth: BerthPluginContext, box: string, location: string, args: string[], timeout = "5m"): Promise<T> {
  const argv = JSON.stringify(["usage.py", ...args]).replace(/"/g, '\\"');
  const command = `python3 -c "import base64,json,sys;sys.argv=json.loads('${argv.replace(/'/g, "")}');exec(base64.b64decode('${encoded}'))"`;
  let r: Awaited<ReturnType<BerthPluginContext["orchestrate"]["exec"]>>;
  try {
    r = await berth.orchestrate.exec(box, location, command, timeout);
  } catch (err) {
    // A box whose berthd predates exec without a location: it needs a
    // project, as before.
    if (!location && /no location with that name/.test(String((err as Error)?.message ?? err))) {
      throw new NoProjects(`${box} has no projects yet; add one, or update Shipyard there, to read its usage`);
    }
    throw err;
  }
  if (r.exit_code === 127 || /python3: (command )?not found/.test(r.output)) throw new Error(`${box} has no python3, which reading usage needs`);
  if (r.exit_code !== 0) throw new Error(r.output.trim().split("\n").slice(-3).join("\n") || `exit ${r.exit_code}`);
  try {
    return JSON.parse(r.output.trim().split("\n").pop() ?? "") as T;
  } catch {
    throw new Error("the box answered something that isn't usage data");
  }
}
