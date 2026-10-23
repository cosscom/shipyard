import type { ToolDetail } from "@/lib/transcript";
import type { Marketplace, MarketPlugin } from "@/lib/marketplace";
import type { HelperRemoved, PluginHelpers } from "@/lib/plugin-helpers";
import { invoke } from "@tauri-apps/api/core";
import { readTimeout, reconnectDelay, STREAM_SILENCE_MS } from "@/lib/net";
import { IS_LINUX } from "@/lib/platform";
import type {
  BerthEvent,
  BoxInfo,
  BoxRoute,
  Conversation,
  ExecResult,
  QueuedPrompt,
  SendResult,
  Turn,
  TurnWait,
  Hook,
  HooksFile,
  WaitResult,
  WorktreeService,
  Location,
  PastSessions,
  PluginInfo,
  Service,
  Session,
  Stats,
  Status,
  TaskRequest,
  TaskResult,
  TaskTemplate,
  Theme,
  Worktree,
} from "@berth/plugin";

export type * from "@berth/plugin";

// The app is only a view: the laptop agent holds every box connection and
// serves this API on loopback (docs/reference/app-api.mdx). Closing or crashing the app
// never stops a session or a forward.

export interface Endpoint {
  url: string;
  token: string;
}

// OutdatedBox is GET /v1/boxes/outdated's answer for one online box:
// whether it runs an older berthd than this Shipyard ships. error is set when
// the check couldn't tell.
export interface OutdatedBox {
  box: string;
  current?: string;
  available?: string;
  outdated: boolean;
  error?: string;
}

export const isTauri = (): boolean => "__TAURI_INTERNALS__" in window;

// hasTrafficLights says whether the window's own buttons sit over its top
// left (the Tauri window's overlay title bar), so a strip there leaves them
// room. ?traffic=1 in the mock draws and counts them, for screenshots.
export const fakeTrafficLights = (): boolean => !isTauri() && new URLSearchParams(location.search).has("mock") && new URLSearchParams(location.search).has("traffic");
// The Linux app has its window manager's title bar instead.
export const hasTrafficLights = (): boolean => (isTauri() && !IS_LINUX) || fakeTrafficLights();

// endpoint finds the agent and its token: from the Tauri shell, which reads
// the token file, or in a plain browser from ?token= or the Vite env.
export async function endpoint(): Promise<Endpoint> {
  if (isTauri()) return invoke<Endpoint>("ui_endpoint");
  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? import.meta.env.VITE_BERTH_TOKEN;
  const url = params.get("agent") ?? import.meta.env.VITE_BERTH_URL ?? "http://127.0.0.1:1378";
  if (!token) throw new Error("No agent token. Open with ?token=… (berth ui-token prints it).");
  return { url, token };
}

// code, when the box or agent sent one, is what to branch on ("session_exited",
// "box_outdated", "not_found"…); lib/errors.ts turns it into words.
export class ApiError extends Error {
  // box is the box the request went to, when it went to one.
  box?: string;
  // The last few by message, so an error that reaches a toast only as text
  // still has its code (lib/errors.ts).
  static recent = new Map<string, ApiError>();
  // The whole answer, when it was JSON: a refused file write (412) carries
  // the file as it is now (lib/files.ts).
  detail?: Record<string, unknown>;
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    ApiError.recent.delete(message);
    ApiError.recent.set(message, this);
    if (ApiError.recent.size > 40) ApiError.recent.delete(ApiError.recent.keys().next().value!);
  }
}

// errorBody reads {error, code} from a failed response's text.
function errorBody(text: string, fallback: string): { message: string; code?: string; detail?: Record<string, unknown> } {
  try {
    const j = JSON.parse(text) as { error?: string; code?: string };
    return { message: j.error ?? (text.trim() || fallback), code: j.code, detail: j && typeof j === "object" ? (j as Record<string, unknown>) : undefined };
  } catch {
    // Not JSON: a plain-text error is already the message.
    return { message: text.trim() || fallback };
  }
}

// A live connection to a terminal session on a box.
export interface TerminalConnection {
  send(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  // How long output may wait to be sent, in ms: 0 while the terminal shows,
  // more while it is hidden, so a noisy program behind another tab comes in
  // a batch at a time (the agent's termpace.go). Kept across reconnects;
  // an older agent ignores it.
  pace?(ms: number): void;
  close(): void;
}

export interface TerminalHandlers {
  onOpen(): void;
  onData(data: Uint8Array | string): void;
  // Called once, however the connection ended. byUs is true after close().
  onClose(byUs: boolean): void;
}

// The guided install (berth add ssh in a terminal on this computer, shown
// full screen): its plan, the agents to choose from, and what the terminal's
// socket says besides the screen.
export interface InstallPlanStep {
  id: string;
  title: string;
  detail?: string;
  // Asks for the person's password with sudo; when, if set, says when.
  sudo?: boolean;
  when?: string;
  where: "laptop" | "box";
  commands: string[];
  // Why there is nothing to do, once the box is known.
  skip?: string;
}

export interface AgentChoice {
  id: string;
  name: string;
  command: string;
  install?: string;
  verified?: string;
  default?: boolean;
  // false: Shipyard leaves it to the person; why says why.
  offered: boolean;
  why?: string;
}

export interface InstallPlan {
  steps: InstallPlanStep[];
  agents: AgentChoice[];
  tmux: { bundled: boolean };
}

export interface GuidedInstallRequest {
  host: string;
  name?: string;
  network?: string;
  identity?: string;
  trust_host_key?: string;
  agents: string[];
  // Start from this step; the ones before it are kept.
  from?: string;
  // The whole plan and one terminal (Team setup's add a box); without it
  // the install is quiet and a terminal shows only while sudo asks.
  guided?: boolean;
}

// sudo: sudo is about to ask for the password in the terminal. ask: a
// yes-or-no question (the message), answered on the terminal's input.
export type InstallStepState = "start" | "done" | "fail" | "skip" | "open" | "cmd" | "sudo" | "ask";

export type InstallEvent =
  | { type: "step"; step: string; state: InstallStepState; message?: string }
  | { type: "failure"; ssh: SshFailure }
  | { type: "exit"; code: number; message?: string };

export interface InstallHandlers extends TerminalHandlers {
  onEvent(e: InstallEvent): void;
}

// Client is everything the app asks of the agent. The real one speaks HTTP;
// mock mode (?mock=1) swaps in fixtures with the same shape.
export interface Client {
  status(): Promise<Status>;
  themes(): Promise<Theme[]>;
  templates(): Promise<TaskTemplate[]>;
  plugins(): Promise<PluginInfo[]>;
  // Fetches a file from inside a plugin's folder, as bytes: its manifest or
  // main module, which the plugin host hashes before importing.
  pluginFile(plugin: PluginInfo, file: string): Promise<Uint8Array>;
  // signal, when given, abandons the request (it rejects with an AbortError).
  // headers carries a write's precondition (If-Match) to the box.
  box<T = unknown>(box: string, method: string, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T>;
  // A box API file as bytes, such as an agent browser's screenshot.
  boxBlob(box: string, path: string): Promise<Blob>;
  // POSTs a file to the box API as its raw bytes (an attachment), telling
  // onProgress how much has gone; the promise rejects with an AbortError
  // when signal aborts.
  upload<T = unknown>(box: string, path: string, body: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<T>;
  // Any laptop API call, such as "GET", "/v1/hooks"; signal aborts it.
  laptop<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  // A laptop API call that answers NDJSON, one value per line, as long
  // commands do (adding a box, upgrading, signing in to a tailnet).
  stream(method: string, path: string, body: unknown, onValue: (v: unknown) => void, signal?: AbortSignal): Promise<void>;
  addForward(box: string, local: number, remote: number): Promise<unknown>;
  // Follows events until signal aborts, reconnecting on its own; onConnect
  // runs on every (re)connect so callers can catch up on what they missed.
  events(onEvent: (e: BerthEvent) => void, onConnect: () => void, signal: AbortSignal): void;
  attach(box: string, session: string, cols: number, rows: number, handlers: TerminalHandlers): TerminalConnection;
  // The guided install's terminal: berth add ssh in a pseudo-terminal on
  // this computer. Its steps come as events beside the screen's bytes.
  installTerminal(req: GuidedInstallRequest, cols: number, rows: number, handlers: InstallHandlers): TerminalConnection;
  // The laptop proxy's URL for a port on a box.
  serviceUrl(box: string, port: number, proxyPort?: number): string;
}

// Typed helpers over Client.box for the box API.
export const boxApi = {
  // The agent CLIs on a box and how to add the others ("agents.install"
  // capability).
  agentCLIs: async (c: Client, box: string) => (await c.box<(AgentChoice & { installed: boolean; path?: string })[] | null>(box, "GET", "agents")) ?? [],
  // installAgents adds agent CLIs to a paired box, without sudo, streaming
  // what it prints and each agent's step.
  installAgents: async (c: Client, box: string, agents: string[], on: { line(l: string): void; step(e: { step: string; state: InstallStepState; message?: string }): void }, signal?: AbortSignal) => {
    let failure: string | undefined;
    let finished = false;
    await c.stream(
      "POST",
      `/v1/boxes/${encodeURIComponent(box)}/api/agents/install`,
      { agents },
      (v) => {
        const l = v as { line?: string; step?: { step: string; state: InstallStepState; message?: string }; done?: boolean; error?: string };
        if (l.line !== undefined) on.line(l.line);
        if (l.step) on.step(l.step);
        if (l.done) {
          finished = true;
          failure = l.error;
        }
      },
      signal,
    );
    if (failure) throw new Error(failure);
    if (!finished && !signal?.aborted) throw new Error("The box stopped answering before the agents were installed.");
  },
  locations: async (c: Client, box: string) => (await c.box<Location[] | null>(box, "GET", "locations")) ?? [],
  sessions: async (c: Client, box: string) => (await c.box<Session[] | null>(box, "GET", "sessions")) ?? [],
  stats: (c: Client, box: string) => c.box<Stats>(box, "GET", "stats"),
  services: async (c: Client, box: string) => (await c.box<Service[] | null>(box, "GET", "services")) ?? [],
  info: (c: Client, box: string) => c.box<BoxInfo>(box, "GET", "info"),
  // How the box starts agents that name no driver (lib/box-defaults.ts;
  // boxes with "agents.defaults").
  putAgentDefaults: (c: Client, box: string, d: { structured: boolean; mode?: string }) => c.box<{ structured: boolean; mode?: string }>(box, "PUT", "agents/defaults", d),
  addLocation: (c: Client, box: string, name: string, path: string) => c.box<Location>(box, "POST", "locations", { name, path }),
  addWorktree: (c: Client, box: string, location: string, req: { name: string; branch?: string; base?: string }) =>
    c.box<Worktree>(box, "POST", `locations/${encodeURIComponent(location)}/worktrees`, req),
  removeWorktree: (c: Client, box: string, location: string, worktree: string, force = false) =>
    c.box(box, "DELETE", `locations/${encodeURIComponent(location)}/worktrees/${encodeURIComponent(worktree)}${force ? "?force=1" : ""}`),
  // home: in the box user's home folder, tied to no worktree, in place of a
  // location (boxes with the "session.home" capability).
  startSession: (c: Client, box: string, req: ({ location: string } | { home: true }) & { name?: string; command?: string; agent?: string; prompt?: string; model?: string; effort?: string; title?: string; driver?: "terminal" | "claude" | "codex" | "acp"; mode?: string }) =>
    c.box<Session>(box, "POST", "sessions", req),
  stopSession: (c: Client, box: string, name: string) => c.box(box, "DELETE", `sessions/${encodeURIComponent(name)}`),
  // A structured agent's conversations, those that worked in path
  // ("conversations" capability).
  conversations: async (c: Client, box: string, path?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (limit) params.set("limit", String(limit));
    return (await c.box<Conversation[] | null>(box, "GET", `conversations${params.size ? `?${params}` : ""}`)) ?? [];
  },
  // Carries a conversation on: in its session, started again if it ended,
  // or in a new one when that is gone.
  resumeConversation: (c: Client, box: string, id: string) => c.box<Session>(box, "POST", `conversations/${encodeURIComponent(id)}/resume`),
  // Starts a structured session whose agent ended again, on its own record;
  // given one of its agent's past conversations (pastSessions), carries
  // that one on in the session instead.
  resumeSession: (c: Client, box: string, name: string, agentSessionId?: string) =>
    c.box<Session>(box, "POST", `sessions/${encodeURIComponent(name)}/resume`, agentSessionId ? { agent_session_id: agentSessionId } : undefined),
  // The agent's own past conversations in a structured session's folder.
  pastSessions: (c: Client, box: string, name: string) => c.box<PastSessions>(box, "GET", `sessions/${encodeURIComponent(name)}/past`),
  // Takes a structured session to Claude Code's own terminal, or back to its
  // chat (Session.switch).
  switchSession: (c: Client, box: string, name: string, to: "terminal" | "chat") =>
    c.box<Session>(box, "POST", `sessions/${encodeURIComponent(name)}/switch`, { to }),
  // Names a session's work; "" clears its title.
  // renameWorktree gives a worktree a display name ("" clears it), on boxes
  // that list "worktree.titles" (lib/worktree-names).
  renameWorktree: (c: Client, box: string, location: string, worktree: string, title: string) =>
    c.box<Worktree>(box, "PATCH", `locations/${encodeURIComponent(location)}/worktrees/${encodeURIComponent(worktree)}`, { title }),
  renameSession: (c: Client, box: string, name: string, title: string) => c.box<Session>(box, "PATCH", `sessions/${encodeURIComponent(name)}`, { title }),
  createTask: (c: Client, box: string, task: TaskRequest) => c.box<TaskResult>(box, "POST", "tasks", task),
  // A worktree's own services, from its repository's config.
  worktreeServices: async (c: Client, box: string, location: string, worktree: string) =>
    (await c.box<WorktreeService[] | null>(box, "GET", `locations/${encodeURIComponent(location)}/worktrees/${encodeURIComponent(worktree)}/services`)) ?? [],
  serviceAction: (c: Client, box: string, location: string, worktree: string, service: string, action: "start" | "stop" | "restart") =>
    c.box<WorktreeService>(box, "POST", `locations/${encodeURIComponent(location)}/worktrees/${encodeURIComponent(worktree)}/services/${encodeURIComponent(service)}/${action}`),
  serviceLog: (c: Client, box: string, location: string, worktree: string, service: string) =>
    c.box<string>(box, "GET", `locations/${encodeURIComponent(location)}/worktrees/${encodeURIComponent(worktree)}/services/${encodeURIComponent(service)}/log`),
  screen: (c: Client, box: string, name: string) => c.box<{ screen: string }>(box, "GET", `sessions/${encodeURIComponent(name)}/screen`),
  // send types text into a session. A person answering an agent passes
  // force: the box otherwise refuses to type into an agent at a question.
  // when "idle" holds it on the box until the agent is idle.
  send: (c: Client, box: string, name: string, text: string, enter = true, o: { when?: "now" | "idle"; force?: boolean; idem_key?: string } = {}) =>
    c.box<SendResult>(box, "POST", `sessions/${encodeURIComponent(name)}/send`, { text, enter, ...o }),
  // A session's latest turns, oldest first (boxes with the "turns" capability).
  turns: async (c: Client, box: string, name: string, limit = 20) =>
    (await c.box<Turn[] | null>(box, "GET", `sessions/${encodeURIComponent(name)}/turns?limit=${limit}`)) ?? [],
  turn: (c: Client, box: string, id: string) => c.box<Turn>(box, "GET", `turns/${encodeURIComponent(id)}`),
  // The prompts the box holds for a session until its agent is idle ("queue"
  // capability): cancel one, or type it now (force only at a question).
  queue: async (c: Client, box: string, name: string) => (await c.box<QueuedPrompt[] | null>(box, "GET", `sessions/${encodeURIComponent(name)}/queue`)) ?? [],
  unqueue: (c: Client, box: string, name: string, turn: string) => c.box(box, "DELETE", `sessions/${encodeURIComponent(name)}/queue/${encodeURIComponent(turn)}`),
  sendQueued: (c: Client, box: string, name: string, turn: string, force = false) =>
    c.box<SendResult>(box, "POST", `sessions/${encodeURIComponent(name)}/queue/${encodeURIComponent(turn)}/send`, { force }),
  // One file's diff in the session's worktree ("diff" capability).
  diff: (c: Client, box: string, name: string, file: string) => c.box<SessionDiff>(box, "GET", `sessions/${encodeURIComponent(name)}/diff?${new URLSearchParams({ file })}`),
  toolDetail: (c: Client, box: string, name: string, id: string) => c.box<ToolDetail>(box, "GET", `sessions/${encodeURIComponent(name)}/transcript/tool/${encodeURIComponent(id)}`),
  // waitTurn long-polls until the turn ends (or waits for someone, with
  // until "waiting"), or timeout seconds pass.
  waitTurn: (c: Client, box: string, id: string, timeout: number, until: "end" | "waiting" = "end") =>
    c.box<TurnWait>(box, "GET", `turns/${encodeURIComponent(id)}/wait?${new URLSearchParams({ until, timeout: String(timeout) })}`),
  // wait long-polls until the session's agent reports one of states after
  // the time given, or timeout seconds pass.
  wait: (c: Client, box: string, name: string, states: string[], timeout: number, after?: string) =>
    c.box<WaitResult>(box, "GET", `sessions/${encodeURIComponent(name)}/wait?${new URLSearchParams({ for: states.join(","), timeout: String(timeout), ...(after ? { after } : {}) })}`),
  exec: (c: Client, box: string, location: string, command: string, timeout = "10m") => c.box<ExecResult>(box, "POST", "exec", { location, command, timeout }),
  hooks: (c: Client, box: string) => c.box<HooksFile>(box, "GET", "hooks"),
  saveHooks: (c: Client, box: string, hooks: Hook[]) => c.box<HooksFile>(box, "PUT", "hooks", { hooks }),
  // testSecret asks the box to resolve a secret reference now. It reports
  // whether it could and the value's length, never the value.
  testSecret: (c: Client, box: string, ref: string) => c.box<SecretTest>(box, "POST", "secrets/test", { ref }),
};

export interface SessionDiff {
  file: string;
  diff: string;
  untracked?: boolean;
  // Only the first 64 KB is in diff.
  truncated?: boolean;
}

export interface SecretTest {
  ok: boolean;
  length?: number;
  error?: string;
}

// A value naming a secret rather than holding one: op://vault/item/field
// (1Password, resolved by the box's op CLI) or env://NAME (a variable from
// berthd's own environment).
export const SECRET_SCHEMES = ["op", "env"] as const;
export const isSecretRef = (v: string | undefined): boolean => !!v && SECRET_SCHEMES.some((s) => v.startsWith(`${s}://`));

// A machine on a tailnet that could be a box (berth discover).
export interface Machine {
  name: string;
  dns_name?: string;
  ip: string;
  os: string;
  online: boolean;
  // The paired box at this address, if it already is one.
  box?: string;
  // The machine runs Tailscale SSH: no keys needed to log in.
  ssh?: boolean;
  // SHA256 fingerprints of the SSH host keys the tailnet reports for it.
  host_keys?: string[];
}

export interface Discovery {
  // The SSH user to suggest: this computer's.
  user: string;
  machines: Machine[];
  // This computer's own Tailscale, when not listing a Shipyard network.
  tailscale?: "running" | "stopped" | "logged-out" | "missing";
  // Its tailnet's name, while running.
  tailnet?: string;
}

// A tailnet this laptop joined with its own embedded node.
export interface NetworkInfo {
  name: string;
  state: string;
  tailnet?: string;
  ips?: string[];
}

// One line of a long command's progress; the last has done set, and error
// when the command failed.
export interface StreamLine {
  line?: string;
  done?: boolean;
  error?: string;
  // A failed SSH login, explained (berth add ssh).
  ssh?: SshFailure;
}

// SshFailure is an SSH login that failed, in plain words, with what the next
// step needs: the install command when nothing answers, a key file when
// every key was refused, a fingerprint to trust for a new host.
export type SshFailure = {
  kind: "refused" | "timeout" | "unreachable" | "resolve" | "auth" | "password" | "host-key-unknown" | "host-key-changed" | "other";
  host: string;
  port?: string;
  // The one plain sentence to show.
  message: string;
  // The host key's, for host-key-unknown and host-key-changed.
  fingerprint?: string;
  // The agent and keys offered, for auth.
  tried?: string[];
  // ssh's own last line.
  detail?: string;
};

// SshPlan is how Shipyard will log in to a host, worked out before connecting
// from ~/.ssh/config (ssh -G) and the key agents that answer.
export type SshPlan = {
  host: string;
  user: string;
  hostname: string;
  port: string;
  agent?: { name: string; socket: string; source: "ssh-config" | "environment" | "launchd" | "discovered" };
  // Key files ssh will offer that exist.
  identity_files: string[];
  proxy_jump?: string;
  // One plain line: "Using 1Password's SSH agent".
  summary: string;
};

// CommandError is a streamed command's failure; ssh explains a failed SSH
// login when that is what went wrong.
export class CommandError extends Error {
  ssh?: SshFailure;
  constructor(message: string, ssh?: SshFailure) {
    super(message);
    this.name = "CommandError";
    this.ssh = ssh;
  }
}

// runCommand follows a streamed CLI command, passing each line of output on,
// and rejects with the command's own error when it fails.
async function runCommand(c: Client, method: string, path: string, body: unknown, onLine: (line: string) => void, signal?: AbortSignal) {
  let failure: string | undefined;
  let ssh: SshFailure | undefined;
  let finished = false;
  await c.stream(
    method,
    path,
    body,
    (v) => {
      const l = v as StreamLine;
      if (l.line !== undefined) onLine(l.line);
      if (l.done) {
        finished = true;
        failure = l.error;
        ssh = l.ssh;
      }
    },
    signal,
  );
  if (failure) throw new CommandError(failure, ssh);
  if (!finished && !signal?.aborted) throw new Error("The agent stopped answering before the command finished.");
}

// The laptop agent's own API, beside the boxes'.
export const laptopApi = {
  hooks: (c: Client) => c.laptop<HooksFile>("GET", "/v1/hooks"),
  saveHooks: (c: Client, hooks: Hook[]) => c.laptop<HooksFile>("PUT", "/v1/hooks", { hooks }),
  pair: (c: Client, link: string, name?: string, network?: string) =>
    c.laptop<{ name: string; address?: string; network?: string }>("POST", "/v1/boxes/pair", { link, name: name || undefined, network: network || undefined }),
  forget: (c: Client, box: string) => c.laptop("DELETE", `/v1/boxes/${encodeURIComponent(box)}`),
  // A box's routes (Settings › Boxes): add an SSH host or an address, turn
  // one on or off, remove one. Each answers with the box's routes now.
  addRoute: (c: Client, box: string, route: { kind: "ssh"; host: string } | { kind: "direct"; address: string }) =>
    c.laptop<BoxRoute[]>("POST", `/v1/boxes/${encodeURIComponent(box)}/routes`, route),
  setRoute: (c: Client, box: string, id: string, on: boolean) =>
    c.laptop<BoxRoute[]>("PATCH", `/v1/boxes/${encodeURIComponent(box)}/routes/${encodeURIComponent(id)}`, { off: !on }),
  removeRoute: (c: Client, box: string, id: string) => c.laptop<BoxRoute[]>("DELETE", `/v1/boxes/${encodeURIComponent(box)}/routes/${encodeURIComponent(id)}`),
  upgrade: (c: Client, box: string, onLine: (line: string) => void, signal?: AbortSignal) =>
    runCommand(c, "POST", `/v1/boxes/${encodeURIComponent(box)}/upgrade`, undefined, onLine, signal),
  // outdated says which online boxes run an older berthd than this Shipyard
  // ships (lib/outdated.ts).
  outdated: (c: Client, fresh?: boolean) => c.laptop<{ boxes: OutdatedBox[] }>("GET", `/v1/boxes/outdated${fresh ? "?fresh=1" : ""}`),
  // addSsh installs berthd on a host over SSH and pairs with it. It rejects
  // with a CommandError whose ssh explains a failed login. identity is a key
  // file to log in with; trust_host_key, a SHA256 fingerprint the person
  // approved for a host this computer hasn't connected to before.
  addSsh: (
    c: Client,
    req: { host: string; name?: string; network?: string; address?: string; identity?: string; trust_host_key?: string },
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ) => runCommand(c, "POST", "/v1/boxes/add-ssh", req, onLine, signal),
  // installPlan is the guided install's plan before connecting, and the
  // agent CLIs to choose from.
  installPlan: (c: Client, host: string, agents: string[]) =>
    c.laptop<InstallPlan>("GET", `/v1/ssh/install-plan?${new URLSearchParams({ host, agents: agents.join(",") || "none" })}`),
  // sshPlan says how Shipyard will log in to a host, without connecting.
  sshPlan: (c: Client, host: string, network?: string) =>
    c.laptop<SshPlan>("GET", `/v1/ssh/plan?host=${encodeURIComponent(host)}${network ? `&network=${encodeURIComponent(network)}` : ""}`),
  // sshHosts are the hosts ~/.ssh/config names, for completing a host field.
  sshHosts: async (c: Client) => (await c.laptop<string[] | null>("GET", "/v1/ssh/hosts")) ?? [],
  discover: (c: Client, network?: string) => c.laptop<Discovery>("GET", `/v1/discover${network ? `?network=${encodeURIComponent(network)}` : ""}`),
  networks: async (c: Client) => (await c.laptop<NetworkInfo[] | null>("GET", "/v1/networks")) ?? [],
  // networkLogin joins a tailnet: onUrl gets the sign-in page to open, and
  // the promise settles once the person has signed in.
  async networkLogin(c: Client, name: string, onUrl: (url: string) => void, signal?: AbortSignal): Promise<NetworkInfo> {
    let joined: NetworkInfo | undefined;
    let failure: string | undefined;
    await c.stream(
      "POST",
      `/v1/networks/${encodeURIComponent(name)}/login`,
      undefined,
      (v) => {
        const m = v as { auth_url?: string; network?: NetworkInfo; error?: string };
        if (m.auth_url) onUrl(m.auth_url);
        if (m.network) joined = m.network;
        if (m.error) failure = m.error;
      },
      signal,
    );
    if (failure) throw new Error(failure);
    if (!joined) throw new Error("The sign-in did not finish.");
    return joined;
  },
  // Turning a plugin on takes the hash of the files the user reviewed (see
  // plugins/consent.ts); the agent refuses it if they have changed since.
  allowPlugin: (c: Client, id: string, hash: string) => c.laptop<PluginInfo>("POST", `/v1/plugins/${encodeURIComponent(id)}/enable`, { hash }),
  // Turning one off stops its helper on the boxes, if it brings one:
  // helpers says what became of it on each (lib/plugin-helpers.ts).
  disablePlugin: (c: Client, id: string) => c.laptop<PluginInfo & { helpers?: HelperRemoved[] }>("POST", `/v1/plugins/${encodeURIComponent(id)}/disable`),
  // Where a plugin's helper is, to say before turning the plugin off.
  pluginHelpers: (c: Client, id: string) => c.laptop<PluginHelpers>("GET", `/v1/plugins/${encodeURIComponent(id)}/helpers`),
  // The plugin listing (lib/marketplace.ts). The agent reads it from the
  // web, since the app's own page may talk only to the agent; fresh reads
  // it again rather than the copy the agent keeps for a few minutes.
  marketplace: (c: Client, fresh = false) => c.laptop<Marketplace>("GET", `/v1/marketplace${fresh ? "?fresh=1" : ""}`),
  // Installing puts the plugin in ~/.berth/plugins and never turns it on.
  // version is the one shown, so a listing that moved on is refused (409
  // listing_changed); replace installs over a folder the listing didn't.
  installPlugin: (c: Client, id: string, version: string, replace = false) =>
    c.laptop<MarketPlugin>("POST", `/v1/marketplace/${encodeURIComponent(id)}/install`, replace ? { version, replace } : { version }),
  // Removing one removes its helper from the boxes too, and what it recorded.
  uninstallPlugin: (c: Client, id: string) => c.laptop<{ removed: string; helpers?: HelperRemoved[] }>("DELETE", `/v1/marketplace/${encodeURIComponent(id)}`),
};

export function httpClient(ep: Endpoint): Client {
  const headers = { Authorization: `Bearer ${ep.token}` };

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string>): Promise<T> {
    // A read gets a time limit (lib/net.ts), so a box that stops answering
    // mid-request fails with words rather than a spinner that never ends.
    const limit = readTimeout(method, path);
    const timer = limit ? AbortSignal.timeout(limit) : undefined;
    const sig = timer ? (signal ? AbortSignal.any([signal, timer]) : timer) : signal;
    let res: Response;
    let text: string;
    try {
      res = await fetch(ep.url + path, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: sig,
      });
      text = await res.text();
    } catch (err) {
      if (timer?.aborted && !signal?.aborted) {
        const box = /^\/v1\/boxes\/([^/]+)\//.exec(path)?.[1];
        throw new ApiError(`${box ? decodeURIComponent(box) : "Shipyard's agent"} didn't answer in ${Math.round(limit! / 1000)}s`, 504, "box_timeout");
      }
      throw err;
    }
    if (!res.ok) {
      const e = errorBody(text, res.statusText);
      const err = new ApiError(e.message, res.status, e.code);
      err.detail = e.detail;
      throw err;
    }
    // Logs come back as plain text; everything else is JSON.
    if (res.headers.get("Content-Type")?.startsWith("text/plain")) return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    status: () => request("GET", "/v1/status"),
    themes: () => request("GET", "/v1/themes"),
    templates: () => request("GET", "/v1/templates"),
    plugins: () => request("GET", "/v1/plugins"),
    async pluginFile(p, file) {
      const res = await fetch(`${ep.url}/v1/plugins/${encodeURIComponent(p.id)}/${file.split("/").map(encodeURIComponent).join("/")}`, { headers });
      if (!res.ok) throw new ApiError(`${p.id}: ${file}: ${res.status} ${res.statusText}`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },
    box: <T,>(box: string, method: string, path: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string>) =>
      request<T>(method, `/v1/boxes/${encodeURIComponent(box)}/api/${path}`, body, signal, extra).catch((err: unknown) => {
        if (err instanceof ApiError) err.box = box;
        throw err;
      }),
    async boxBlob(box, path) {
      const res = await fetch(`${ep.url}/v1/boxes/${encodeURIComponent(box)}/api/${path}`, { headers });
      if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
      return res.blob();
    },
    // XHR, not fetch: only it reports how much of the body has gone.
    upload: <T,>(box: string, path: string, body: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("The upload was cancelled", "AbortError"));
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${ep.url}/v1/boxes/${encodeURIComponent(box)}/api/${path}`);
        xhr.setRequestHeader("Authorization", headers.Authorization);
        xhr.setRequestHeader("Content-Type", body.type || "application/octet-stream");
        if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : body.size);
        const abort = () => xhr.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const done = () => signal?.removeEventListener("abort", abort);
        xhr.onload = () => {
          done();
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T);
            } catch {
              reject(new ApiError("The box answered with something that isn't JSON", xhr.status));
            }
            return;
          }
          const e = errorBody(xhr.responseText, xhr.statusText || `HTTP ${xhr.status}`);
          const err = new ApiError(e.message, xhr.status, e.code);
          err.box = box;
          reject(err);
        };
        xhr.onerror = () => {
          done();
          reject(new ApiError("The upload didn't reach the Shipyard agent", 0));
        };
        xhr.onabort = () => {
          done();
          reject(new DOMException("The upload was cancelled", "AbortError"));
        };
        xhr.send(body);
      }),
    laptop: (method, path, body, signal) => request(method, path, body, signal),
    async stream(method, path, body, onValue, signal) {
      const res = await fetch(ep.url + path, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) {
        const e = errorBody(await res.text(), res.statusText);
        throw new ApiError(e.message, res.status, e.code);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      const take = (line: string) => {
        if (!line.trim()) return;
        try {
          onValue(JSON.parse(line));
        } catch {
          // A line that is not JSON is skipped rather than ending the stream.
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          take(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      take(buf);
    },
    addForward: (box, local, remote) => request("POST", "/v1/forwards", { box, local, remote }),
    events: (onEvent, onConnect, signal) => followEvents(ep, onEvent, onConnect, signal),
    attach: (box, session, cols, rows, handlers) => {
      const url = new URL(`/v1/boxes/${encodeURIComponent(box)}/sessions/${encodeURIComponent(session)}/attach`, ep.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.search = new URLSearchParams({ cols: String(cols), rows: String(rows), token: ep.token }).toString();
      return attachSocket(url.toString(), handlers);
    },
    installTerminal: (req, cols, rows, handlers) => {
      const url = new URL("/v1/boxes/add-ssh/terminal", ep.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.search = installQuery(req, cols, rows, ep.token).toString();
      return attachSocket(url.toString(), handlers, handlers.onEvent);
    },
    serviceUrl: (box, port, proxyPort = 1377) => `http://${port}.${box}.localhost${proxyPort === 80 ? "" : `:${proxyPort}`}/`,
  };
}

// followEvents reads the agent's server-sent events with fetch, which unlike
// EventSource can send the token, and reconnects with backoff when the
// stream ends: after sleep, or while the agent restarts.
function followEvents(ep: Endpoint, onEvent: (e: BerthEvent) => void, onConnect: () => void, signal: AbortSignal) {
  let attempt = 0;
  const loop = async () => {
    while (!signal.aborted) {
      // A stream that goes silent past the agent's keepalive is dead though
      // not closed (the agent paused, the laptop slept): drop it and open
      // another, which refetches what was missed (onConnect).
      const mine = new AbortController();
      const stop = () => mine.abort();
      signal.addEventListener("abort", stop, { once: true });
      let silence = 0;
      const quiet = () => {
        window.clearTimeout(silence);
        silence = window.setTimeout(stop, STREAM_SILENCE_MS);
      };
      try {
        quiet();
        const res = await fetch(`${ep.url}/v1/events`, {
          headers: { Authorization: `Bearer ${ep.token}`, Accept: "text/event-stream" },
          signal: mine.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        attempt = 0;
        onConnect();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          quiet();
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let end: number;
          while ((end = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, end);
            buf = buf.slice(end + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as BerthEvent);
            } catch {
              // A malformed event is dropped, not fatal to the stream.
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      } finally {
        window.clearTimeout(silence);
        signal.removeEventListener("abort", stop);
      }
      // Backoff with jitter (lib/net.ts), so windows that lost the agent
      // together don't all come back in the same instant.
      await new Promise((r) => setTimeout(r, reconnectDelay(++attempt)));
    }
  };
  void loop();
}

// installQuery is the guided install's request as its socket's query.
export function installQuery(req: GuidedInstallRequest, cols: number, rows: number, token?: string): URLSearchParams {
  const q = new URLSearchParams({ host: req.host, agents: req.agents.join(",") || "none", cols: String(cols), rows: String(rows) });
  for (const k of ["name", "network", "identity", "trust_host_key", "from"] as const) if (req[k]) q.set(k, req[k]!);
  if (req.guided) q.set("guided", "1");
  if (token) q.set("token", token);
  return q;
}

// attachSocket relays a terminal over a WebSocket: binary messages carry
// bytes both ways, and text messages carry resizes to the box. With onText,
// text from the other end is JSON for it (the guided install's steps),
// not screen.
function attachSocket(url: string, h: TerminalHandlers, onText?: (e: InstallEvent) => void): TerminalConnection {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let closedByUs = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    h.onClose(closedByUs);
  };
  let paceMs = 0;
  const sendPace = () => ws.send(JSON.stringify({ type: "pace", ms: paceMs }));
  ws.onopen = () => {
    if (paceMs) sendPace();
    h.onOpen();
  };
  ws.onmessage = (m) => {
    if (typeof m.data === "string" && onText) {
      try {
        onText(JSON.parse(m.data) as InstallEvent);
      } catch {
        // Not an event: dropped rather than drawn.
      }
      return;
    }
    h.onData(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
  };
  ws.onclose = end;
  ws.onerror = end;
  const encoder = new TextEncoder();
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === "string" ? encoder.encode(data) : (data as Uint8Array<ArrayBuffer>));
    },
    resize(cols, rows) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    pace(ms) {
      if (ms === paceMs) return;
      paceMs = ms;
      if (ws.readyState === WebSocket.OPEN) sendPace();
    },
    close() {
      closedByUs = true;
      ws.close();
    },
  };
}
