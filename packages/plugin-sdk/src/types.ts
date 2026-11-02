// The JSON the laptop agent and boxes speak, as docs/reference/app-api.mdx describes it.
// Field names follow the Go structs exactly; the app and plugins share these.

export type BoxState = "connecting" | "online" | "offline" | "untrusted";

export interface BoxStatus {
  name: string;
  address: string;
  network?: string;
  fingerprint: string;
  state: BoxState;
  error?: string;
  latency_ms?: number;
  since: string;
  // A box on this computer itself (Use this Mac).
  local?: boolean;
  // When the agent next tries a box that isn't online, and how many tries
  // in a row have failed.
  retry_at?: string;
  attempts?: number;
  // How well the laptop reaches it: slow (requests still go through), the
  // latency's recent max and jitter, and whether Tailscale relays it.
  link?: BoxLink;
  // The route new requests take (a BoxRoute's id), and every way the
  // laptop knows to reach the box. A box on this computer has none.
  route?: string;
  routes?: BoxRoute[];
}

// One way the laptop reaches a box: the address it was paired at (kind
// "tailscale", or "direct" off a tailnet), SSH ("ssh", detail the host),
// or another address ("direct"). Every route carries the same pinned TLS.
export interface BoxRoute {
  id: string;
  kind: "tailscale" | "ssh" | "direct" | (string & {});
  label: string;
  detail?: string;
  // up; stalled (didn't answer once: new requests go elsewhere); down;
  // unknown (not tried yet); off (turned off, or only suggested).
  state: "up" | "stalled" | "down" | "unknown" | "off" | (string & {});
  latency_ms?: number;
  active?: boolean;
  error?: string;
  // Turned on because the box was added over SSH.
  auto?: boolean;
  // A host in ~/.ssh/config named like the box, offered but off.
  suggested?: boolean;
}

export interface BoxLink {
  slow?: boolean;
  // Why it's slow ("health check took 1.9s"), or why it went away.
  reason?: string;
  max_ms?: number;
  jitter_ms?: number;
  path?: BoxPath;
}

// How the box is reached over Tailscale, when that can be told.
export interface BoxPath {
  via: "direct" | "relay" | "peer-relay";
  // The relay (DERP) region: "nyc", and its city, "New York".
  relay?: string;
  relay_name?: string;
  // This computer's own nearest relay region's city.
  nearest?: string;
  endpoint?: string;
  // The agent network the box is reached on; absent for this computer's own Tailscale.
  tailnet?: string;
}

export interface Forward {
  id: string;
  box: string;
  local: number;
  remote: number;
  pin?: string;
}

export interface ForwardStatus extends Forward {
  state: "listening" | "failed" | string;
  error?: string;
}

export interface Route {
  pattern: string;
  box: string;
  port: number;
}

export interface Status {
  boxes: BoxStatus[];
  forwards: ForwardStatus[];
  routes: Route[];
  proxy: { port: number; url_port: number; error?: string };
  // Orgs of the person's projects that publish a team setup they haven't
  // accepted; older agents leave it out.
  team_suggestions?: TeamSuggestion[];
}

// A team setup the laptop noticed: <org>/.berth, which the person can
// read, from the org one or more of their projects come from.
export interface TeamSuggestion {
  org: string;
  // The setup's own name ("Acme").
  name: string;
  // "<org>/.berth".
  repo: string;
  projects: TeamSuggestProject[];
}

export interface TeamSuggestProject {
  box: string;
  location: string;
  repo: string;
  // team.json names the repository.
  listed: boolean;
  // What its setup brings, in a few words: "per-worktree databases",
  // "services", "Log in as…", "review links".
  sets_up: string[];
  // team.json gives the repo a kit, which can be taken on its own ("Just
  // the kit"); kit_applied: the project follows it already.
  kit?: boolean;
  kit_applied?: boolean;
}

export interface Worktree {
  name: string;
  path: string;
  branch?: string;
  head?: string;
  main?: boolean;
  setting_up?: boolean;
  // The first of the worktree's own ports ($BERTH_PORT).
  port?: number;
  // A display name a person gave it, shown in its place; its branch and
  // folder keep name. Boxes that list "worktree.titles" carry it.
  title?: string;
  // The path of the worktree whose agent handed this one off, to nest it
  // under; another worktree of the same location.
  parent?: string;
  // A worktree the repo had before Team setup adopted it: its setup runs
  // the first time a terminal or an agent starts there.
  setup_on_open?: boolean;
}

export interface Scripts {
  setup?: string;
  archive?: string;
  from?: "berth" | "repo";
}

export interface Location {
  name: string;
  path: string;
  repo: boolean;
  worktrees?: Worktree[];
  scripts: Scripts;
  // Agents the repository's .berth/config.json defines.
  agents?: AgentPreset[];
  // The origin remote's URL, its owner/name on a forge ("acme/shop"), and
  // the branch new worktrees start from by default.
  remote?: string;
  slug?: string;
  default_branch?: string;
  // Whether the box runs the repository's .berth/config.json: "none"
  // without one, "trusted", or "untrusted" / "changed" while it waits for
  // someone to trust it (only its port count applies until then).
  repo_trust?: "none" | "trusted" | "untrusted" | "changed";
  // How to tell the work here is right: the repo config's "check", else one
  // found in the repository (package.json, go.mod, Cargo.toml, a Makefile).
  check?: string;
  check_from?: "config" | "detected";
}

// What an agent's hooks said last: "idle" is an agent that is open but has
// not been given anything yet.
export type AgentState = "idle" | "running" | "waiting" | "finished";

export interface Session {
  name: string;
  location?: string;
  dir: string;
  command?: string;
  created: string;
  attached: number;
  exited: boolean;
  agent?: string;
  agent_state?: AgentState;
  // When agent_state last changed.
  state_since?: string;
  // The agent preset the session was started with, when berth started it
  // with one (kept even when the command wraps the agent).
  preset?: string;
  // The agent's current (or last) turn ("shop-feat-a-claude#3"), the
  // journal seq of its state, and how well berth knows it: "hooks" (the
  // agent said), "partial" (its turn starts when berth sends) or "screen".
  turn?: string;
  state_seq?: number;
  fidelity?: "hooks" | "partial" | "screen" | string;
  // How many prompts the box holds for the agent until it is idle (boxes
  // with the "queue" capability list them: GET sessions/{name}/queue).
  queued?: number;
  // What the agent waits on, from its own hooks ("ask" capability), while
  // agent_state is "waiting".
  ask?: Ask;
  // Set on a finished agent that turn check read as still at work without
  // it: a delegated task, a build, a deploy or a watcher still running, to
  // pick up by itself. The app shows it as working.
  unfinished?: boolean;
  // Set on a finished agent that turn check read as parked: nothing runs
  // and nothing is asked of you while it waits on someone else's reply or
  // a later time ("check again in 24 hours"). The app shows it as idle.
  parked?: boolean;
  // Set on a waiting agent that turn check read as asking in its last
  // message: the reply box answers it, and its screen shows only its
  // prompt, with no question there to read options from.
  soft_wait?: boolean;
  // What the work is called: the first line of the prompt it started with
  // (or the first it was sent), about 48 characters, or what someone renamed
  // it to. Absent until there is one; api.renameSession names it.
  title?: string;
  // Set on a worktree service's own terminal (a service with "terminal":
  // true, from boxes with the "service.terminal" capability): the service's
  // name. It never runs an agent, and closing its tab never stops it.
  service?: string;
  // How the box reaches the agent ("driver" capability): "terminal", its
  // own screen in tmux, or "claude", Claude Code driven through its stream
  // ("driver.claude" capability).
  driver?: "terminal" | "claude" | "codex" | "acp" | string;
  // Where a structured session can switch ("driver.switch" capability):
  // "terminal", to Claude Code's own screen, or "chat", back from it. POST
  // sessions/{name}/switch with { to } switches it.
  switch?: "terminal" | "chat";
  // The systemd scope its processes run in, on boxes where sessions get
  // one (Linux with systemd), and what they use: memory (bytes, page cache
  // included), its ceiling if the box sets one (Settings → Boxes), processor
  // seconds, and near_limit from 90% of the ceiling. Near it, the box slows
  // the session down; nothing is stopped.
  scope?: string;
  usage?: { memory: number; memory_high?: number; cpu_s: number; cpu_percent?: number; processes?: number; near_limit?: boolean; throttled?: number; scoped?: boolean };
  // Set on a structured session that ended because its agent, started
  // again, exited as it started.
  failed?: LaunchFailure;
}

// An agent started again that exited as it started: when, its exit code,
// and the end of what it wrote to its stderr.
export interface LaunchFailure {
  at: string;
  code: number;
  error?: string;
}

// A waiting agent's request, from its hooks rather than its screen: the
// tool, a short summary of its input (the command, or the file's path;
// never what it would write), its reason, and the message it showed. Each
// is at most 300 characters.
// A structured agent's conversation, kept on the box past its session
// ("conversations" capability): GET conversations lists them, newest first.
export interface Conversation {
  id: string;
  agent: string;
  location?: string;
  dir: string;
  // The session it last ran in, and whether that one is running.
  session?: string;
  live?: boolean;
  agent_session_id?: string;
  mode?: string;
  // Its first prompt's first line.
  title?: string;
  created: string;
  updated?: string;
  // Set when its agent, started again, exited as it started; the next start
  // that comes up clears it.
  failed?: LaunchFailure;
}

// One of a structured agent's own conversations in a session's folder,
// which its chat's /resume can carry on (GET sessions/{name}/past,
// "sessions.past" capability): Claude Code's, including those had in its
// terminal, or what an ACP agent lists.
export interface PastSession {
  id: string;
  title?: string;
  updated?: string;
  // The one the session runs now; or another live session that runs it.
  current?: boolean;
  session?: string;
}

export interface PastSessions {
  agent: string;
  sessions: PastSession[];
  // Why the list is empty, when the agent can't give one.
  note?: string;
}

export interface Ask {
  tool?: string;
  input?: string;
  why?: string;
  message?: string;
  // The answers a structured session offers, by the key that picks one
  // (POST sessions/{name}/send with that key); a terminal's are on its
  // screen instead.
  choices?: { key: string; label: string }[];
}

// A prompt the box holds for an agent until it is idle: the start of its
// text (preview) and its full length.
export interface QueuedPrompt {
  turn: string;
  preview: string;
  length: number;
  origin?: string;
  at: string;
}

// A turn is one prompt to the end of the agent's reply. Boxes whose info
// lists the "turns" capability keep them.
export interface Turn {
  // "<session>#<n>"; URL-encode it in paths (# is %23).
  id: string;
  session: string;
  agent?: string;
  n: number;
  // Who prompted: laptop:<name>, flow:<id>, phone, terminal.
  origin?: string;
  sent_seq?: number;
  end_seq?: number;
  // queued (held until the agent is idle), pending (sent, not started yet),
  // running, waiting, finished, exited or lost (status says why: "cancelled"
  // for a held prompt someone cancelled).
  state: "queued" | "pending" | "running" | "waiting" | "finished" | "exited" | "lost" | string;
  queued?: string;
  started?: string;
  ended?: string;
  // Times it waited for someone (a permission or a question).
  waits?: { start: string; end?: string; reason?: string; ask?: Ask }[];
  fidelity?: "hooks" | "partial" | "screen" | string;
  idem_key?: string;
  // "error" when the agent ended the turn on a failure.
  status?: string;
}

// What sending a prompt did. turn and seq come from boxes that keep turns;
// at is always the box's own clock, which a following wait counts from.
export interface SendResult {
  sent: boolean;
  // Held in the box's inbox until the agent is idle (when: "idle").
  queued?: boolean;
  // A retry with an idem_key already used: nothing was typed again.
  duplicate?: boolean;
  turn?: string;
  seq?: number;
  at: string;
}

// What a turn wait returns.
export interface TurnWait {
  turn: Turn;
  state: Turn["state"];
  timed_out: boolean;
}

// What an agent adapter can report: a box's info lists them.
export interface AdapterCaps {
  ready: boolean;
  started: boolean;
  waiting: boolean;
  finished: boolean;
  final_message: boolean;
  via: "hooks" | "notify" | "plugin" | "screen" | string;
}

export interface Usage {
  total: number;
  used: number;
}

export interface BoxAgent {
  tool: string;
  pid: number;
  path?: string;
  location?: string;
  worktree?: string;
  state: AgentState;
  since?: string;
}

export interface Stats {
  hostname: string;
  uptime_s?: number;
  cpus: number;
  load?: number[];
  memory: Usage;
  swap: Usage;
  disks: (Usage & { mount: string })[];
  agents: BoxAgent[];
  hooks: boolean;
}

export interface Service {
  location: string;
  worktree: string;
  path: string;
  port: number;
  process?: string;
  main?: boolean;
}

export interface Port {
  port: number;
  address: string;
  pid?: number;
  process?: string;
  command?: string;
  dir?: string;
}

export interface Share {
  id: string;
  port: number;
  url: string;
  started: string;
  state: string;
  error?: string;
}

// An agent a box can start: claude, codex, or one a template defines.
export interface AgentPreset {
  id: string;
  name: string;
  command: string;
  // How the agent takes a starting prompt, when it needs a flag for it.
  prompt_flag?: string;
  // How it takes a model and an effort, when berth knows. A preset without
  // one offers no choice of it.
  model_flag?: string;
  effort_flag?: string;
  // The models and efforts to offer, by the CLI's own names (aliases where
  // it has them). Leaving one out means the CLI's default.
  models?: string[];
  efforts?: string[];
  // What starts its Agent Client Protocol server ("acp", "--acp"): with it,
  // the agent can run structured on boxes listing "driver.acp".
  acp?: string;
}

// AgentPath is where a box found an agent CLI: through the person's shell
// ("shell"), on berthd's PATH ("path") or in a folder installers use
// ("dir"), and how it was installed when the path says (npm, Homebrew, bun,
// volta, pnpm).
export interface AgentPath {
  id: string;
  name: string;
  command: string;
  path: string;
  version?: string;
  install?: string;
  via?: string;
}

export interface BoxInfo {
  name?: string;
  version?: string;
  os?: string;
  arch?: string;
  build?: string;
  tools?: string[];
  agents?: AgentPreset[];
  // The box user's home folder.
  home?: string;
  // Where each built-in agent's CLI was found (boxes with "agents.paths").
  agent_paths?: AgentPath[];
  // Optional API features: "turns" (send returns a turn; turn waits),
  // "journal" (events carry a seq; GET events?since=SEQ replays).
  capabilities?: string[];
  adapters?: Record<string, AdapterCaps>;
}

export interface Check {
  area: string;
  name: string;
  status: "ok" | "warn" | "fail" | "info" | string;
  detail?: string;
  fix?: string;
}

export interface BerthEvent {
  // The box journal's number for the event, in order (boxes with "journal").
  seq?: number;
  type: string;
  time: string;
  box?: string;
  origin?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface TaskRequest {
  location: string;
  // The session this task continues, for a handoff.
  from_session?: string;
  // A pull request number: the worktree checks out its head.
  pr?: number;
  // The ref to fetch for it, such as pull/9035/head or merge-requests/42/head.
  ref?: string;
  name: string;
  branch?: string;
  base?: string;
  agent?: string;
  command?: string;
  prompt?: string;
  // The agent's model and effort, by the CLI's own names (an agent's
  // `models` and `efforts`); unset is the CLI's default. Only with `agent`.
  model?: string;
  effort?: string;
  // What to call the work; without it, the prompt's first line.
  title?: string;
  // Asks the app to show the new agent: as a tab of its worktree when the
  // person is looking at it, otherwise as a toast that opens it.
  open?: "split" | "tab";
  // How berthd runs the agent: "terminal" (the default) or "claude", Claude
  // Code structured ("driver.claude" capability); mode is a structured
  // agent's permission mode to start in ("bypassPermissions": berthd allows
  // what it asks, questions and plans aside).
  driver?: "terminal" | "claude" | "codex" | "acp";
  mode?: string;
}

export interface TaskResult {
  worktree: Worktree;
  session: Session;
}

// An input a template asks for; {{id}} in its prompt or branch is replaced
// with what was typed.
export interface TemplateVariable {
  id: string;
  label?: string;
  multiline?: boolean;
  default?: string;
}

// A reusable recipe for new tasks, from ~/.berth/templates/*.json. {{name}}
// is the task's name; other {{var}}s become inputs in the New Task dialog.
export interface TaskTemplate {
  id: string;
  name: string;
  description?: string;
  box?: string;
  location?: string;
  agent?: string;
  command?: string;
  prompt?: string;
  branch?: string;
  base?: string;
  variables?: TemplateVariable[];
}

export interface PluginHook {
  on: string;
  run: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  main: string;
  description?: string;
  // Ships inside the app (plugins/ in the repository) rather than
  // ~/.berth/plugins; a user plugin with the same id replaces it.
  builtin?: boolean;
  // false for a built-in that stays off until turned on in Settings.
  defaultEnabled?: boolean;
  // Where the app imports main from, relative to the agent's URL.
  entry?: string;
  // For a plugin in ~/.berth/plugins: on only once the user has allowed it.
  enabled?: boolean;
  // The hash of the manifest and main module the user allowed. The app
  // imports a plugin only when what it fetched hashes to this.
  allowed?: string;
  // Allowed once, but changed since: off until it is reviewed again.
  changed?: boolean;
  // "marketplace" for a plugin installed from the listing in Settings →
  // Plugins, which the app can update and remove.
  source?: "marketplace";
  hooks?: PluginHook[];
  // The titles of the Home widgets it adds, from berth-plugin.json's
  // "homeWidgets", so Home's picker can offer them while it is off.
  homeWidgets?: string[];
  error?: string;
}

export interface ThemeColors {
  background: string;
  foreground: string;
  sidebar: string;
  sidebarForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  accent: string;
  accentForeground: string;
  primary: string;
  primaryForeground: string;
  card: string;
  popover: string;
  ring: string;
  success: string;
  warning: string;
  destructive: string;
  // Optional; without them the app uses its own.
  // info: what is running (a spinner), and notices.
  info?: string;
  // Each state's colour as text: a badge's or a banner's words, on a 16%
  // wash of the state's colour.
  successForeground?: string;
  warningForeground?: string;
  destructiveForeground?: string;
  infoForeground?: string;
  // Links in an agent's reply (otherwise the text colour, underlined).
  link?: string;
  // Selected text outside the terminal.
  selection?: string;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  // Selected text, where the text's own colour would not read on the
  // selection.
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  appearance: "dark" | "light";
  colors: ThemeColors;
  terminal: TerminalColors;
  // The Shiki theme that colours code in diffs and edits, by its name in
  // shiki.style/themes ("dracula", "github-light-default", …). It loads
  // when a diff first shows. Without it, Pierre's own light or dark.
  syntax?: string;
}

// A hook from ~/.berth/hooks.json, or one a plugin adds (source
// "plugin:<id>", read-only).
export interface Hook {
  on: string;
  run: string;
  tool?: string;
  timeout?: string;
  source?: string;
}

export interface HooksFile {
  path: string;
  hooks: Hook[];
}

export interface WaitResult {
  state: AgentState | string;
  timed_out: boolean;
  // The turn the state belongs to, from boxes that keep turns.
  turn?: string;
}

export interface ExecResult {
  exit_code: number;
  // The end of the command's output, at most 64 KB.
  output: string;
  // True when the start of the output was dropped.
  truncated?: boolean;
}

// A service a repository declares for its worktrees (.berth/config.json),
// as it runs in one worktree.
export interface WorktreeService {
  name: string;
  run: string;
  autostart?: boolean;
  // "running", "stopped", "failed", …
  state: string;
  unit: string;
  port?: number;
  // A service in a terminal of its own runs in session, shown as a tab
  // named title.
  terminal?: boolean;
  title?: string;
  session?: string;
}

// Runs: orchestrations the box executes and journals (loops, reviews,
// hand-offs, broadcasts, attempts, flows), from boxes whose info lists the
// "runs" capability. They keep going while the laptop sleeps and survive a
// restart of berthd.
export type RunStatus = "queued" | "running" | "waiting_gate" | "paused" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface RunUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  usd?: number;
}

// A gate a run waits at: someone approves or rejects it (a pick gate also
// names the winning attempt).
export interface RunGate {
  path: string;
  title: string;
  text?: string;
  deadline?: string;
  pick?: boolean;
  // The candidate a pick approves without naming one (0-based).
  default?: number;
  // The two ways on when they aren't approve and reject: "Retry
  // publishing" and "Finish without a pull request" at a pull request
  // that didn't open.
  approve_label?: string;
  reject_label?: string;
}

export interface RunStep {
  id: string;
  kind: string;
  // Where it is in the run: "2" is the third step, "2.r1.0" the first step
  // of a loop's first round, "0.i3.1" the second step of a map's fourth item.
  path: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "waiting" | "unknown" | "cancelled" | string;
  attempt?: number;
  started?: string;
  ended?: string;
  duration?: string;
  output?: string;
  exit_code: number;
  error?: string;
  turn?: string;
  session?: string;
  usage?: RunUsage;
  children?: RunStep[];
}

// One attempt of an attempts run.
export interface RunCandidate {
  index: number;
  agent?: string;
  location?: string;
  worktree?: string;
  path?: string;
  branch?: string;
  session?: string;
  verify: { passed: boolean; rounds?: number; exit_code: number; tail?: string };
  diff: { files: number; added: number; removed: number; commits: number };
  summary?: string;
  turns?: number;
  tokens?: RunUsage;
  judge: { rank?: number; reason?: string };
  picked?: boolean;
}

export interface RunSummary {
  id: string;
  template: string;
  title?: string;
  flow_id?: string;
  scope?: string;
  status: RunStatus;
  key?: string;
  // What deduplicates its trigger: github:<flow>:<pr>:<item>, webhook:...,
  // or the Idempotency-Key it was started with.
  idem_key?: string;
  group?: string;
  origin?: string;
  path?: string;
  session?: string;
  cursor?: string;
  test?: boolean;
  created: string;
  updated: string;
  finished?: string;
  error?: string;
  usage?: RunUsage;
  gate?: RunGate;
  steps?: number;
  candidates?: number;
}

export interface Run extends Omit<RunSummary, "steps" | "candidates"> {
  params?: Record<string, unknown>;
  vars?: Record<string, string>;
  steps: RunStep[];
  candidates?: RunCandidate[];
  budget?: { max_rounds?: number; max_agents?: number; max_wall?: string; max_usd?: number; max_tokens?: number };
}

export interface RunRequest {
  template?: string;
  params?: Record<string, unknown>;
  title?: string;
  // Ad-hoc steps instead of a template.
  flow?: unknown[];
  // Runs one of the box's flows now.
  flow_id?: string;
  scope?: string;
  data?: Record<string, unknown>;
  session?: string;
  path?: string;
  group?: string;
  budget?: Run["budget"];
}
