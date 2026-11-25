import type { AgentPreset, BerthEvent, Client, Hook } from "@/lib/api";
import type { InstalledKit } from "@/lib/kits";

// Flows are a box's automations: a trigger event, then steps run in order,
// each on the previous step's success, failure, or always. They live on a
// box (its own, or a repository's: committed, its kit's, or this box's) and
// the box runs them; the app only edits and watches them. See
// internal/box/flows.go.

export type StepKind = "run" | "prompt" | "wait" | "start_agent" | "notify" | "webhook";
export type StepWhen = "success" | "failure" | "always";

export interface Step {
  id?: string;
  // A run step kind (loop, gate, pr, …) the editor shows but does not edit
  // is any other string.
  kind: StepKind | (string & {});
  when?: StepWhen;
  command?: string;
  text?: string;
  title?: string;
  session?: string;
  for?: string[];
  agent?: string;
  new_worktree?: boolean;
  name?: string;
  url?: string;
  timeout?: string;
}

export type GitHubOn = "review_comment" | "pr_review" | "check_failed" | "pr_merged";

// Trigger is what starts a flow: exactly one of an event, a schedule (cron
// or @daily-style, the box's local time), or something on a worktree's PR.
export interface Trigger {
  event?: string;
  schedule?: string;
  // A scheduled flow runs once per matching worktree, not once at the repo.
  each_worktree?: boolean;
  github?: { on: GitHubOn; poll?: string };
  // author limits GitHub comment and review triggers to these logins, or
  // "collaborators", or "*" (anyone); empty means collaborators.
  where?: { location?: string; agent?: string; branch?: string; author?: string[] };
}

export type TriggerKind = "event" | "schedule" | "github";

export function triggerKind(t: Trigger): TriggerKind {
  return t.schedule ? "schedule" : t.github ? "github" : "event";
}

// triggerType is the event type a flow's runs carry, as the box sets it.
export function triggerType(t: Trigger): string {
  return t.schedule ? "schedule.fired" : t.github ? `github.${t.github.on}` : (t.event ?? "");
}

export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  // Empty means DEFAULT_MAX_RUNS_PER_HOUR.
  max_runs_per_hour?: number;
}

// DEFAULT_MAX_RUNS_PER_HOUR is how often a flow may start in an hour when it
// doesn't say: the box's DefaultMaxRunsPerHour (internal/box/flows.go).
export const DEFAULT_MAX_RUNS_PER_HOUR = 20;

// Where a flow lives: "box", or "repo:<location>".
export type Scope = string;

// "box": the box's own. A repository's flows come in layers, merged in this
// order: "repo" (committed in .berth/config.json), "kit" (the project's kit),
// "local" (this box's config for the repository). Repo and kit flows are
// read-only here; a local flow with the same id overrides them.
export type FlowSource = "box" | "repo" | "kit" | "local";

export interface ScopedFlow {
  scope: Scope;
  source: FlowSource;
  editable: boolean;
  // A more local layer has a flow with this id, and only that one runs.
  overridden?: boolean;
  flow: Flow;
  // Starts the runs-per-hour limit refused in the last hour (its own
  // window), and the latest one. The box keeps them in memory: a restart
  // clears them.
  refused_last_hour?: number;
  last_refused_at?: string;
  // A scheduled flow's starts in its busiest hour (times its worktrees for
  // each_worktree, which share the limit), and the box's warning when that
  // is over the limit. Older boxes send neither.
  fires_per_hour?: number;
  warning?: string;
}

// maxRunsPerHour is a flow's limit, its own or the default.
export const maxRunsPerHour = (f: Flow) => (f.max_runs_per_hour && f.max_runs_per_hour > 0 ? f.max_runs_per_hour : DEFAULT_MAX_RUNS_PER_HOUR);

// refusedLabel is the badge a flow shows while its limit refuses starts.
export const refusedLabel = (n: number) => `Limit reached · ${n} refused in the last hour`;

// rateWarning says how many starts an hour a schedule's limit will refuse,
// in the box's words (rateCheck.warning in internal/box/flowrate.go), or
// nothing when it fits.
export function rateWarning(fires: number, limit: number, eachWorktree?: boolean): string | undefined {
  if (fires <= limit) return undefined;
  const share = eachWorktree ? " across its worktrees, which share the limit" : "";
  return `This schedule fires up to ${fires} times an hour${share}; the limit is ${limit}, so about ${fires - limit} starts an hour will be refused.`;
}

const layer: Record<FlowSource, number> = { box: 0, repo: 0, kit: 1, local: 2 };
const sameFlow = (a: ScopedFlow, b: ScopedFlow) => a.scope === b.scope && a.flow.id === b.flow.id;

// isOverridden says whether a more local layer replaces f, so the box never
// runs it and lists show the replacement instead.
export const isOverridden = (f: ScopedFlow, all: ScopedFlow[]) => all.some((o) => sameFlow(o, f) && layer[o.source] > layer[f.source]);

// overrides says whether f replaces a flow from a layer under it.
export const overrides = (f: ScopedFlow, all: ScopedFlow[]) => all.some((o) => sameFlow(o, f) && layer[o.source] < layer[f.source]);

export interface StepRun {
  id: string;
  // A run step kind (loop, gate, pr, …) the editor shows but does not edit
  // is any other string.
  kind: StepKind | (string & {});
  status: "succeeded" | "failed" | "skipped";
  started?: string;
  duration?: string;
  output?: string;
  exit_code: number;
  error?: string;
}

export interface FlowRun {
  id: string;
  flow: string;
  scope: Scope;
  started: string;
  finished?: string;
  // interrupted: berthd restarted during the run, before runs resumed.
  // Boxes with runs also say queued, waiting_gate and cancelled.
  status: "running" | "succeeded" | "failed" | "interrupted" | "queued" | "waiting_gate" | "cancelled";
  event: BerthEvent;
  steps: StepRun[];
  error?: string;
  // Started from the editor's Test run, not by the trigger.
  test?: boolean;
}

export interface WorktreeService {
  name: string;
  run: string;
  autostart?: boolean;
  // Runs in a terminal of its own, a tab named title (boxes with the
  // "service.terminal" capability).
  terminal?: boolean;
  title?: string;
}

// RepoConfig is a repository's .berth/config.json, or a box's own layer of
// it for one location.
export interface RepoConfig {
  setup?: string;
  archive?: string;
  agents?: AgentPreset[];
  ports?: number;
  env?: Record<string, string>;
  services?: WorktreeService[];
  hooks?: Hook[];
  flows?: Flow[];
  // Who a worktree's pages can be logged in as, and the script that does it
  // (lib/login-url.ts). Only from trusted layers: the kit, the box's own
  // config, or the committed config once trusted.
  login?: LoginConfig;
  // A "Review in Shipyard" button on each PR opened from the project's
  // worktrees (box/reviewbutton.go). Off unless a layer or team.json says.
  review_button?: boolean;
  // Keep the default branch current: a new branch from it fetches it first
  // and fast-forwards the local one (box/freshbase.go). On unless a layer
  // says false.
  keep_main?: boolean;
}

// LoginUser is a seeded user a worktree can be logged in as. The box always
// answers with objects; a config file may list plain emails.
export interface LoginUser {
  email: string;
  label?: string;
}

export interface LoginConfig {
  // Relative to the kit's folder ($BERTH_KIT_DIR) or the config's.
  script: string;
  users?: LoginUser[];
  // Any valid email may be asked for, not only the listed users.
  any?: boolean;
}

// RepoTrust says whether a box runs a repository's committed config. Until
// someone trusts it (and again whenever the file changes) only its port
// count applies; wants is everything else it asks to run.
export interface RepoTrust {
  state: "none" | "trusted" | "untrusted" | "changed";
  // The sha256 of the file as it is now: trusting sends it back, so a file
  // changed since it was shown is refused.
  hash?: string;
  wants?: RepoConfig;
}

export const trustPending = (t?: { state: string } | string) => {
  const s = typeof t === "string" ? t : t?.state;
  return s === "untrusted" || s === "changed";
};

export interface LocationConfig {
  // Committed in the repository, as this box applies it (its ports alone
  // until trusted); null without a .berth/config.json.
  repo: RepoConfig | null;
  repo_path: string;
  repo_trust?: RepoTrust;
  // This box's own layer, which the app edits.
  local: RepoConfig;
  // What applies: local laid over repo.
  effective: RepoConfig;
  // The project's kit, a layer between repo and local.
  kit?: InstalledKit;
  // Whether PRs from the project's worktrees get the review button, and
  // where that comes from; inherited is the value without this box's own
  // setting. The team's team.json counts here, unlike in effective.
  review_button?: ReviewButtonState;
}

export interface ReviewButtonState {
  on: boolean;
  from?: "box" | "repo" | "kit" | "team";
  inherited: boolean;
  inherited_from?: "repo" | "kit" | "team";
}

export interface ServiceStatus extends WorktreeService {
  state: string;
  unit: string;
  port?: number;
  session?: string;
}

const enc = encodeURIComponent;

export const flowsApi = {
  list: async (c: Client, box: string) => (await c.box<ScopedFlow[] | null>(box, "GET", "flows")) ?? [],
  saveBox: (c: Client, box: string, flows: Flow[]) => c.box<ScopedFlow[]>(box, "PUT", "flows", { flows }),
  runs: async (c: Client, box: string, flow?: string, limit = 50) =>
    (await c.box<FlowRun[] | null>(box, "GET", `flows/runs?${new URLSearchParams({ ...(flow ? { flow } : {}), limit: String(limit) })}`)) ?? [],
  test: (c: Client, box: string, id: string, scope: Scope, data: Record<string, unknown>) => c.box<FlowRun>(box, "POST", `flows/${enc(id)}/test`, { scope, data }),
  config: (c: Client, box: string, location: string) => c.box<LocationConfig>(box, "GET", `locations/${enc(location)}/config`),
  saveConfig: (c: Client, box: string, location: string, local: RepoConfig) => c.box<LocationConfig>(box, "PUT", `locations/${enc(location)}/config`, { local }),
  trustRepo: (c: Client, box: string, location: string, hash: string) => c.box<LocationConfig>(box, "POST", `locations/${enc(location)}/config/trust`, { hash }),
  untrustRepo: (c: Client, box: string, location: string) => c.box<LocationConfig>(box, "DELETE", `locations/${enc(location)}/config/trust`),
  services: async (c: Client, box: string, location: string, worktree: string) =>
    (await c.box<ServiceStatus[] | null>(box, "GET", `locations/${enc(location)}/worktrees/${enc(worktree)}/services`)) ?? [],
  serviceAction: (c: Client, box: string, location: string, worktree: string, service: string, action: "start" | "stop" | "restart") =>
    c.box(box, "POST", `locations/${enc(location)}/worktrees/${enc(worktree)}/services/${enc(service)}/${action}`),
};

export const scopeLocation = (scope: Scope) => (scope.startsWith("repo:") ? scope.slice("repo:".length) : undefined);

// scopeLabel names where a flow lives, for headings.
export function scopeLabel(scope: Scope, box: string): string {
  const loc = scopeLocation(scope);
  return loc ? `${loc} on ${box}` : `This box: ${box}`;
}

// slug turns a flow's name into an id the box accepts.
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "flow"
  );
}
