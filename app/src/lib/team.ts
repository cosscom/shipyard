import { create } from "zustand";

import type { BerthEvent, Client } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { scheduleRefresh, useStore } from "@/lib/store";

// Team setup: an org on GitHub publishes how its engineers' boxes are set
// up, in a repo of its own, <org>/.berth (team.json, schema berth.team/v1:
// box steps run by a script of its own, the repos and where each one's
// setup comes from, and the keys they need). The laptop agent reads it with
// this computer's own GitHub CLI (gh), checks which repos the person can
// read, and hands the reviewed commit to a box, which runs the steps in a
// terminal the person can see (sudo asks them there), signs in to GitHub
// on its own (gh auth login, a credential the box keeps), clones the repos
// and sets each one up. Under the hood it is a "workspace kit".
// docs/guides/team-setup.mdx.

export interface GitHubState {
  state: "missing" | "signed-out" | "ready";
  login?: string;
  name?: string;
  avatar_url?: string;
  install?: { os: "darwin" | "linux" | "windows"; command: string; url: string };
  error?: string;
}

export interface TeamStep {
  id: string;
  title: string;
  detail?: string;
  sudo?: boolean;
}

export interface TeamProjectSpec {
  id: string;
  repo: string;
  path?: string;
  required?: boolean;
  kit?: string;
  init?: string;
  init_detail?: string;
  first_task?: string;
}

export interface TeamKeys {
  from?: string;
  shared?: Record<string, string>;
  ask?: string[];
}

// TeamSetup is team.json as the org wrote it.
export interface TeamSetup {
  schema: string;
  id: string;
  name: string;
  org: string;
  description?: string;
  contact?: string;
  docs?: string;
  // settings reach the box script as BERTH_SETTING_<NAME>.
  box?: { os?: string[]; script?: string; steps?: TeamStep[]; settings?: Record<string, string> };
  // The agent CLIs Shipyard installs on the box, as a step of its own.
  agents?: string[];
  projects?: TeamProjectSpec[];
  keys?: Record<string, TeamKeys>;
  // "optional" (the default): engineers may skip 1Password and type the
  // shared keys instead; "required": the box signs op in.
  onepassword?: "optional" | "required";
  updates?: { notify?: boolean };
}

export interface TeamFile {
  path: string;
  size: number;
  text?: string;
}

// A box step as the plan shows it, with Shipyard's own steps among them:
// "github" (the box's own gh auth login) and, when the keys are 1Password
// references, "1password" (op signed in on the box).
export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  sudo: boolean;
  berth?: boolean;
  commands: string[];
}

export type ProjectSource = "repo" | "kit" | "none";

// A clone of a project's repo already on the box: a Shipyard project, or
// one the box found in the usual folders (~/code, ~/work, …), matched by
// its origin. The page offers to use it instead of cloning a second copy.
export interface ExistingClone {
  path: string;
  // The path with ~ for the box's home folder.
  display: string;
  branch?: string;
  // HEAD when it is detached.
  head?: string;
  // Files with uncommitted changes.
  dirty: number;
  // Commits its upstream has that it lacks, as of its last fetch.
  behind?: number;
  // Its Shipyard project's name, when it is one already.
  location?: string;
  last_commit?: string;
  used?: string;
  // At the path team.json gives the project.
  at_path?: boolean;
  // Its git worktrees besides the main checkout.
  worktrees?: number;
}

export interface ProjectView {
  id: string;
  repo: string;
  path: string;
  required: boolean;
  access: boolean;
  private: boolean;
  size_kb?: number;
  description?: string;
  default_branch?: string;
  source: ProjectSource;
  config_hash?: string;
  kit?: { ref: string; commit?: string; id: string; name: string; hash: string };
  services: string[];
  init?: string;
  init_detail?: string;
  first_task?: string;
  commands: string[];
  // Clones of it already on the box, the preferred first.
  existing?: ExistingClone[];
  existing_note?: string;
}

export interface TeamChange {
  kind: "add" | "remove" | "change";
  area: "step" | "setting" | "project" | "key" | "file" | "setup";
  id: string;
  text: string;
  detail?: string;
  sudo?: boolean;
}

export interface TeamUpdate {
  from: string;
  to: string;
  author: string;
  date: string;
  commits: number;
  changes: TeamChange[];
  sudo: string[];
}

export interface TeamOrg {
  login: string;
  name: string;
  avatar_url: string;
  verified: boolean;
  type: "Organization" | "User";
  html_url: string;
}

export interface OrgRepo {
  full_name: string;
  private: boolean;
  description: string;
  pushed_at: string;
  has_berth: boolean;
  existing?: ExistingClone[];
}

// Where a setup was read: the org's <org>/.berth, or a link to any repo,
// branch or folder (to try one before <org>/.berth exists). key is what
// the routes take for it: the org name, or the link.
export interface TeamSource {
  kind: "org" | "link";
  repo: string;
  ref?: string;
  ref_kind?: "branch" | "tag" | "commit";
  path?: string;
  html_url: string;
  label: string;
  key: string;
}

export interface TeamAsk {
  project: string;
  key: string;
  set?: boolean;
}

export interface TeamView {
  // For a link, the owner of the repo read, not the team the setup is for
  // (that is setup.org).
  org: TeamOrg;
  source?: TeamSource;
  state: "found" | "none" | "unreadable" | "no-org";
  repo?: { full_name: string; private: boolean; default_branch: string; html_url: string };
  commit?: { sha: string; short: string; author: string; author_avatar?: string; date: string; message: string };
  setup?: TeamSetup;
  files?: TeamFile[];
  steps?: PlanStep[];
  projects: ProjectView[];
  access: { readable: number; total: number; missing: string[] };
  keys: {
    shared: number;
    ask: TeamAsk[];
    // The shared keys that are 1Password references: typed once instead
    // when 1Password is skipped.
    onepassword?: TeamAsk[];
    onepassword_required?: boolean;
  };
  repos?: OrgRepo[];
  accepted?: { commit: string; box: string; at: string };
  update?: TeamUpdate | null;
  warnings: string[];
  // Where the box looked for clones it already has.
  scanned?: { looked: string[]; truncated?: boolean };
}

export type StepState = "todo" | "running" | "waiting" | "done" | "skipped" | "failed";
export type RepoState = "queued" | "cloning" | "setting-up" | "ready" | "failed" | "skipped";

export interface TeamStatus {
  id: string;
  name: string;
  org: string;
  commit: string;
  box: string;
  phase: "steps" | "projects" | "done" | "failed";
  session?: string;
  steps: { id: string; title: string; sudo: boolean; state: StepState; secs?: number; error?: string; code?: string; url?: string }[];
  projects: {
    id: string;
    repo: string;
    state: RepoState;
    location?: string;
    error?: string;
    trust?: string;
    warnings?: string[];
    line?: string;
    // The terminal its first-time setup (init) runs in, and whether that
    // terminal waits for an answer there (a [Y/n], a password).
    session?: string;
    waiting?: boolean;
    // The keys the team lists for it; those its config on the box has no
    // value for yet; and those 1Password would give it, while skipped.
    keys?: string[];
    missing?: string[];
    deferred?: string[];
    // It uses a clone that was already on the box, at path, as it was;
    // note says which and why when there was a choice. first_open counts
    // its git worktrees set up the first time each is opened.
    adopted?: boolean;
    path?: string;
    note?: string;
    first_open?: number;
  }[];
  keys_set: string[];
  // 1Password was skipped for the shared keys; Use 1Password undoes it.
  onepassword_skipped?: boolean;
  started: string;
  updated: string;
  error?: string;
}

export interface Accepted {
  org: string;
  // What the routes take for it again, and where it was read.
  key?: string;
  source?: TeamSource;
  id: string;
  name: string;
  commit: string;
  box: string;
  at: string;
}

export interface SetupRequest {
  box: string;
  commit?: string;
  projects?: string[];
  keys?: Record<string, Record<string, string>>;
  repos?: string[];
  // Skip 1Password: op is never signed in or called for the shared keys,
  // which come typed in keys instead (blank ones are missing).
  skip_onepassword?: boolean;
  // Which clone on the box each project uses, by project id (or repo for
  // repos): a folder there, or "" for a fresh clone.
  use?: Record<string, string>;
}

// TeamKitPlan is "Just the kit" before it runs (internal/agent/teamkit.go):
// a project's kit from the team setup, for a project already on the box,
// without the setup's box steps, sudo, clone or 1Password.
export interface TeamKitPlan {
  org: TeamOrg;
  name: string;
  commit: string;
  short: string;
  box: string;
  location: string;
  project: string;
  repo: string;
  kit: { ref: string; id: string; name: string; description?: string; hash: string };
  sets_up: string[];
  // The kit's tools, checked on the box (found is absent when it didn't say).
  requires: { tool: string; hint?: string; found?: boolean }[];
  // The project's shared keys and its init: each off unless chosen.
  keys: { name: string; onepassword: boolean; used_by: string[] }[];
  init?: { script: string; detail?: string };
  replaces?: string;
  applied?: boolean;
  worktrees: number;
  warnings: string[];
}

export interface TeamKitResult {
  kit: { id: string; name: string };
  warnings: string[];
  first_open: number;
  session?: string;
}

const enc = encodeURIComponent;

export const teamApi = {
  github: (c: Client) => c.laptop<GitHubState>("GET", "/v1/github"),
  githubLogin: (c: Client) => c.laptop<{ opened: boolean; command: string; error?: string }>("POST", "/v1/github/login"),
  view: (c: Client, org: string, o: { box?: string; from?: string } = {}) => {
    const q = new URLSearchParams();
    if (o.box) q.set("box", o.box);
    if (o.from) q.set("from", o.from);
    const qs = q.toString();
    return c.laptop<TeamView>("GET", `/v1/team/${enc(org)}${qs ? `?${qs}` : ""}`);
  },
  setup: (c: Client, org: string, req: SetupRequest) => c.laptop<TeamStatus>("POST", `/v1/team/${enc(org)}/setup`, req),
  // Fast-forwards a found clone that is behind: a button of its own, never
  // part of using it.
  pull: (c: Client, org: string, box: string, repo: string, path: string) => c.laptop<ExistingClone>("POST", `/v1/team/${enc(org)}/pull`, { box, repo, path }),
  kitPlan: (c: Client, org: string, box: string, location: string) => c.laptop<TeamKitPlan>("GET", `/v1/team/${enc(org)}/kit?box=${enc(box)}&location=${enc(location)}`),
  applyKit: (c: Client, org: string, req: { box: string; location: string; commit: string; hash: string; keys?: boolean; init?: boolean }) => c.laptop<TeamKitResult>("POST", `/v1/team/${enc(org)}/kit`, req),
  retry: (c: Client, org: string, box: string, from: string) => c.laptop<TeamStatus>("POST", `/v1/team/${enc(org)}/retry`, { box, from }),
  update: (c: Client, org: string) => c.laptop<TeamUpdate | { update: null }>("GET", `/v1/team/${enc(org)}/update`),
  accepted: async (c: Client) => (await c.laptop<Accepted[] | null>("GET", "/v1/team")) ?? [],
  // The box's own record of the setups it ran.
  onBox: async (c: Client, box: string) => (await c.box<TeamStatus[] | null>(box, "GET", "team")) ?? [],
  status: (c: Client, box: string, id: string) => c.box<TeamStatus>(box, "GET", `team/${enc(id)}`),
  // Use 1Password after skipping it: the references go back into each
  // project's config, and op signs in in the team's terminal.
  useOnePassword: (c: Client, box: string, id: string) => c.box<TeamStatus>(box, "POST", `team/${enc(id)}/onepassword`, {}),
};

// defaultUse is which clone each project uses before anyone chooses: a
// Shipyard project of the same repo (the box's preferred one), else the
// only clone found when it is clean; otherwise a fresh clone (""). Nothing
// the box merely found is used unless it is that one clean clone.
export function defaultUse(existing: ExistingClone[] | undefined): string {
  const all = existing ?? [];
  const loc = all.find((c) => c.location);
  if (loc) return loc.path;
  if (all.length === 1 && all[0].dirty === 0) return all[0].path;
  return "";
}

// missingKeys is what a run left without a value, by project: keys left
// blank when asked (or skipped with 1Password), to add in Project settings.
export function missingKeys(run?: Pick<TeamStatus, "projects">): { project: string; location?: string; keys: string[] }[] {
  return (run?.projects ?? []).filter((p) => p.missing?.length).map((p) => ({ project: p.id, location: p.location, keys: p.missing! }));
}

export { isLink, teamRef, validOrg } from "@/lib/team-ref";

// ——— live state ———

// Where the page was opened from, which it says (a link names the org).
export type TeamFrom = "onboarding" | "addbox" | "link" | "sidebar" | "palette" | "suggestion";

interface TeamState {
  github?: GitHubState;
  // What the boxes report, by "box/id".
  runs: Record<string, TeamStatus>;
  accepted: Accepted[];
  // Newer commits of accepted setups, by key (the org, or the link).
  updates: Record<string, TeamUpdate>;
  // Repos announced ready, so each says so once.
  announced: Record<string, true>;
}

export const useTeam = create<TeamState>()(() => ({ runs: {}, accepted: [], updates: {}, announced: {} }));

export const runKey = (box: string, id: string) => `${box}/${id}`;

export function putRun(s: TeamStatus) {
  useTeam.setState((t) => ({ runs: { ...t.runs, [runKey(s.box, s.id)]: s } }));
}

// The run for a team on a box, or the latest for the org on any box.
export function runFor(t: Pick<TeamState, "runs">, org: string, box?: string): TeamStatus | undefined {
  const all = Object.values(t.runs).filter((r) => r.org.toLowerCase() === org.toLowerCase() && (!box || r.box === box));
  return all.sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
}

// keyOf is what opens a run's page again: the link it was set up from, or
// its org.
export function keyOf(t: Pick<TeamState, "accepted">, run: Pick<TeamStatus, "id" | "org" | "box">): string {
  const a = t.accepted.find((x) => x.id === run.id && x.box === run.box) ?? t.accepted.find((x) => x.id === run.id);
  return a?.key ?? run.org;
}

// The run in progress anywhere, for the sidebar and the status bar.
export function activeRun(t: Pick<TeamState, "runs">): TeamStatus | undefined {
  const all = Object.values(t.runs).filter((r) => r.phase === "steps" || r.phase === "projects" || r.phase === "failed");
  return all.sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
}

// A run that finished a moment ago keeps its repos marked new in the
// sidebar until someone opens one or a while passes.
export function recentlyDone(t: Pick<TeamState, "runs">, within = 30 * 60_000): TeamStatus | undefined {
  return Object.values(t.runs).find((r) => r.phase === "done" && Date.now() - new Date(r.updated).getTime() < within);
}

let loading: Promise<void> | undefined;

// loadTeams asks the laptop which setups it accepted, and each online box
// for its runs; quiet when the agent or a box doesn't know about teams yet.
export function loadTeams(): Promise<void> {
  const client = useStore.getState().client;
  if (!client) return Promise.resolve();
  loading ??= (async () => {
    const accepted = await teamApi.accepted(client).catch(() => [] as Accepted[]);
    useTeam.setState({ accepted });
    const boxes = useStore.getState().status?.boxes.filter((b) => b.state === "online") ?? [];
    await Promise.all(
      boxes.map(async (b) => {
        const runs = await teamApi.onBox(client, b.name).catch(() => [] as TeamStatus[]);
        runs.forEach(putRun);
      }),
    );
    // Updates of accepted setups, shown in the sidebar until reviewed.
    await Promise.all(
      accepted.map(async (a) => {
        const key = a.key ?? a.org;
        const u = await teamApi.update(client, key).catch(() => null);
        if (u && "changes" in u) useTeam.setState((t) => ({ updates: { ...t.updates, [key]: u } }));
      }),
    );
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}

export async function refreshGitHub(): Promise<GitHubState | undefined> {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    const github = await teamApi.github(client);
    useTeam.setState({ github });
    return github;
  } catch (err) {
    const github: GitHubState = { state: "missing", error: errorMessage(err) };
    useTeam.setState({ github });
    return github;
  }
}

const pendingRuns = new Map<string, number>();

// refreshRun reads one run again, debounced: events come in bursts.
export function refreshRun(box: string, id: string) {
  const k = runKey(box, id);
  window.clearTimeout(pendingRuns.get(k));
  pendingRuns.set(
    k,
    window.setTimeout(async () => {
      pendingRuns.delete(k);
      const client = useStore.getState().client;
      if (!client) return;
      try {
        const s = await teamApi.status(client, box, id);
        const before = useTeam.getState().runs[k];
        putRun(s);
        announce(before, s);
      } catch {
        // The box answers the next one.
      }
    }, 60),
  );
}

// Listeners the page and the toasts register for repos turning ready.
type ReadyListener = (run: TeamStatus, project: TeamStatus["projects"][number]) => void;
const readyListeners = new Set<ReadyListener>();
export function onRepoReady(fn: ReadyListener) {
  readyListeners.add(fn);
  return () => void readyListeners.delete(fn);
}

function announce(before: TeamStatus | undefined, now: TeamStatus) {
  for (const p of now.projects) {
    if (p.state !== "ready") continue;
    const k = `${runKey(now.box, now.id)}/${p.id}`;
    if (useTeam.getState().announced[k]) continue;
    const was = before?.projects.find((x) => x.id === p.id)?.state;
    useTeam.setState((t) => ({ announced: { ...t.announced, [k]: true } }));
    if (was && was !== "ready") readyListeners.forEach((fn) => fn(now, p));
  }
}

// refreshRunsOn reads every run on box again: after it was away, what the
// page shows may be behind.
export function refreshRunsOn(box: string) {
  for (const r of Object.values(useTeam.getState().runs)) if (r.box === box && r.phase !== "done") refreshRun(box, r.id);
}

// handleTeamEvent keeps runs current from the box's team.* events.
export function handleTeamEvent(e: BerthEvent) {
  const d = (e.data ?? {}) as { team?: string; org?: string; project?: string; state?: string; location?: string };
  if (e.type === "team.update" && d.org) {
    void loadTeams();
    return;
  }
  // The laptop noticed (or stopped suggesting) an org's team setup
  // (lib/team-suggest.ts): its status says which.
  if (e.type === "team.suggestions") {
    void useStore.getState().refreshStatus();
    return;
  }
  if (e.type === "box.connected") {
    const box = (e.data as { box?: string } | undefined)?.box ?? e.box;
    if (box) refreshRunsOn(box);
    return;
  }
  if (!e.box || !d.team) return;
  if (e.type === "team.project" && (d.state === "ready" || d.state === "cloning")) scheduleRefresh(e.box, ["locations"]);
  refreshRun(e.box, d.team);
}

// ——— words ———

export const SOURCE_LABEL: Record<ProjectSource, string> = {
  repo: "repo's .berth/config.json",
  kit: "team kit",
  none: "no setup",
};

// keysLine is the keys step in one line: "5 from 1Password · 1 to enter".
export function keysLine(v: Pick<TeamView, "keys">, entered = 0, skipOP = false): string {
  const ops = skipOP ? (v.keys.onepassword ?? []).filter((k) => !k.set).length : 0;
  const ask = v.keys.ask.filter((k) => !k.set).length + ops - entered;
  const parts: string[] = [];
  const fromOP = skipOP ? v.keys.shared - (v.keys.onepassword?.length ?? 0) : v.keys.shared;
  if (fromOP) parts.push(`${fromOP} ${skipOP ? "shared" : "from 1Password"}`);
  if (ask > 0) parts.push(`${ask} to enter`);
  return parts.join(" · ");
}

export const sudoCount = (v: Pick<TeamView, "steps">) => (v.steps ?? []).filter((s) => s.sudo).length;

export function durationOf(secs?: number): string {
  if (secs === undefined) return "";
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

// ——— adding a box from Team setup ———

// TeamAfterInstall is Team setup's part when a box is added from its page:
// the guided install's plan shows the team's steps after its own, and once
// the box is ready the same screen starts the team's setup on it and shows
// its terminal. Two phases of one screen: the install runs over SSH before
// berthd is there, and the team's steps then run in berthd's own terminal
// on the box (which keeps going if this window closes), so sudo may ask
// once in each.
export interface TeamAfterInstall {
  // What runFor takes for its runs.
  org: string;
  name: string;
  steps: PlanStep[];
  repos: number;
  // Starts the setup on the new box, with what the page has chosen (repos,
  // keys, 1Password or not).
  start(box: string): Promise<TeamStatus>;
  retry(box: string, from: string): Promise<TeamStatus>;
}

// The Team setup page registers itself here while it is open.
export const useTeamAddBox = create<{ ctx?: TeamAfterInstall }>()(() => ({}));
