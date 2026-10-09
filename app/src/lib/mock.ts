import { mockFileBlob, mockFilesCall } from "@/lib/mock-files";
import { LINEAR_USAGE, processesCall } from "./mock-processes";
import type { BerthEvent, Client, Hook, HooksFile, Location, Service, Session, SshFailure, Stats, Status, TerminalHandlers, Turn } from "@/lib/api";
import { flowsCall } from "@/lib/mock-flows";
import { runsCall } from "@/lib/mock-runs";
import { mockRequirements } from "@/lib/mock-requirements";
import { browserCall, mockScreencast, mockShotSvg } from "@/lib/mock-browser";
import { mockDevtoolsCall } from "@/lib/mock-devtools";
import { phoneCall } from "@/lib/mock-phone";
import { turnCheckCall } from "@/lib/mock-turncheck";
import { worktreesCall } from "@/lib/mock-worktrees";
import { kitsCall, kitsStream } from "@/lib/mock-kits";
import { initTeamMock, isTeamSession, teamAttach, teamBoxCall, teamLaptopCall } from "@/lib/mock-team";
import { initPrReviewMock, prReviewLaptopCall } from "@/lib/mock-pr-review";
import { reviewCall, reviewExec } from "@/lib/mock-review";
import { editorsCall } from "@/lib/mock-editors";
import { imageGenCall } from "@/lib/mock-imagegen";
import { mockShell } from "@/lib/mock-shell";
import { mockServiceAttach, wireMockServices } from "@/lib/mock-services";
import { mockIssueTitle } from "@/lib/mock-issues";
import { usageCall, usageExec } from "@/lib/mock-usage";
import { initMockQueue, queueCall } from "@/lib/mock-queue";
import { computersBoxCall, computersCall, initMockComputers } from "@/lib/mock-computers";
import { initMockLocalBox, localBoxCall, localBoxFolders, localBoxStream } from "@/lib/mock-local-box";
import { initMockInstall, mockBoxAgents, mockInstallAgents, mockInstallPlan, mockInstallTerminal } from "@/lib/mock-install";
import { mockBoxDoctor, mockDiagnosticsCall } from "@/lib/mock-diagnostics";
import { ApiError } from "@/lib/api";
import { titleOf } from "@/lib/derive";
import { demoAttach, demoScreen } from "@/demo/terminal";
import { mockHistoryCall } from "@/lib/mock-history";
import { BENCH, benchFleet, benchTerm, noisyTerm, seedBenchChats } from "@/lib/mock-bench";
import { mockAnswer, mockToolDetailSync, WEBHOOK_TEST } from "@/lib/mock-conversation";
import { crowd } from "@/lib/mock-crowd";

// Mock mode (?mock=1) runs the whole UI on fixtures, so it can be worked on
// without an agent or a box. State is mutable: new tasks and sessions appear,
// and an agent changes state now and then so notifications can be seen.

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const GB = 1024 ** 3;

const status: Status = {
  boxes: [
    {
      name: "devl",
      address: "100.64.0.4:7444",
      fingerprint: "sha256:9f2c…",
      state: "online",
      latency_ms: 24,
      since: ago(140),
      // Added over SSH: SSH is the faster route, Tailscale relays.
      link: { path: { via: "relay", relay: "nyc", relay_name: "New York", nearest: "London" } },
      route: "ssh",
      routes: [
        { id: "ssh", kind: "ssh", label: "SSH", detail: "alex@devl", state: "up", latency_ms: 24, active: true, auto: true },
        { id: "paired", kind: "tailscale", label: "Tailscale relayed", detail: "100.64.0.4:7444", state: "up", latency_ms: 140 },
      ],
    },
    {
      name: "gpu",
      address: "100.64.0.19:7444",
      network: "personal",
      fingerprint: "sha256:41ab…",
      state: "online",
      latency_ms: 112,
      since: ago(30),
      route: "paired",
      routes: [
        { id: "paired", kind: "tailscale", label: "Tailscale (personal)", detail: "100.64.0.19:7444", state: "up", latency_ms: 112, active: true },
        { id: "ssh", kind: "ssh", label: "SSH", detail: "gpu", state: "off", suggested: true },
      ],
    },
    {
      name: "old-vps",
      address: "203.0.113.7:7444",
      fingerprint: "sha256:c0de…",
      state: "offline",
      error: "dial tcp: i/o timeout",
      since: ago(600),
      route: "paired",
      routes: [{ id: "paired", kind: "direct", label: "Direct", detail: "203.0.113.7:7444", state: "down", active: true, error: "dial tcp: i/o timeout" }],
    },
  ],
  forwards: [{ id: "f1", box: "devl", local: 5432, remote: 5432, state: "listening" }],
  routes: [],
  proxy: { port: 1377, url_port: 1377 },
};

// The berthd build each box runs, and the one this Shipyard ships: gpu is
// behind until it is updated (GET /v1/boxes/outdated).
const SHIPPED_BUILD = "b9758a308077";
const mockBuilds: Record<string, string> = { devl: SHIPPED_BUILD, gpu: "304337b99a15" };

// ?mock=1&fresh=1 is a new account: no boxes yet, so onboarding shows.
const fresh = new URLSearchParams(location.search).has("fresh");
if (fresh) {
  status.boxes = [];
  status.forwards = [];
}

const locations: Record<string, Location[]> = {
  devl: [
    {
      name: "shop",
      path: "/home/me/work/shop",
      repo: true,
      scripts: { setup: "pnpm install && pnpm db:migrate", archive: "pnpm db:drop", from: "repo" },
      check: "pnpm test",
      check_from: "detected",
      remote: "git@github.com:acme/shop.git",
      slug: "acme/shop",
      default_branch: "main",
      worktrees: [
        { name: "shop", path: "/home/me/work/shop", branch: "main", main: true },
        { name: "checkout-fix", path: "/home/me/work/shop-checkout-fix", branch: "me/checkout-fix" },
        { name: "qa-deck", path: "/home/me/work/shop-qa-deck", branch: "me/qa-deck" },
        { name: "search-perf", path: "/home/me/work/shop-search-perf", branch: "me/search-perf" },
        // Handed off from checkout-fix's agent, and on from there: nested.
        { name: "order-export", path: "/home/me/work/shop-order-export", branch: "me/order-export", parent: "/home/me/work/shop-checkout-fix" },
        // Named after a pasted link, as a worktree made from one is.
        { name: "https-linear-app-acme", path: "/home/me/work/shop-https-linear-app-acme", branch: "https-linear-app-acme", parent: "/home/me/work/shop-order-export" },
      ],
    },
    {
      name: "notes",
      path: "/home/me/work/notes",
      repo: true,
      remote: "git@github.com:me/notes.git",
      slug: "me/notes",
      default_branch: "main",
      scripts: {},
      worktrees: [{ name: "notes", path: "/home/me/work/notes", branch: "main", main: true }],
    },
  ],
  gpu: [
    {
      name: "shop",
      path: "/home/me/shop",
      repo: true,
      remote: "git@github.com:acme/shop.git",
      slug: "acme/shop",
      default_branch: "main",
      scripts: {},
      worktrees: [
        { name: "shop", path: "/home/me/shop", branch: "main", main: true },
        { name: "ci-flake", path: "/home/me/shop-ci-flake", branch: "me/ci-flake" },
      ],
    },
    {
      name: "evals",
      path: "/home/me/evals",
      repo: true,
      scripts: {},
      worktrees: [
        { name: "evals", path: "/home/me/evals", branch: "main", main: true },
        { name: "judge-v2", path: "/home/me/evals-judge-v2", branch: "judge-v2" },
      ],
    },
  ],
};

// Sessions that have had a first prompt, which may have named them.
const mockPrompted = new Set<string>();

const sessions: Record<string, Session[]> = {
  devl: [
    { name: "checkout-fix-claude", title: "Fix checkout webhook retries", location: "shop/checkout-fix", dir: "/home/me/work/shop-checkout-fix", command: "claude", created: ago(52), attached: 0, exited: false, agent: "claude", agent_state: "waiting", state_since: ago(4), ask: { tool: "Bash", input: "pnpm prisma migrate dev --name idempotency_key", why: "The fix needs a column for idempotency keys" } },
    // The worktree's dev server, a service in a terminal of its own.
    { name: "svc-shop-checkout-fix-web", title: "Next.js", location: "shop/checkout-fix", dir: "/home/me/work/shop-checkout-fix", command: "pnpm dev --port $BERTH_PORT", created: ago(50), attached: 0, exited: false, service: "web" },
    { name: "qa-deck-codex", title: "Build the QA deck for the release", location: "shop/qa-deck", dir: "/home/me/work/shop-qa-deck", command: "codex", created: ago(18), attached: 1, exited: false, agent: "codex", agent_state: "running", state_since: ago(2) },
    { name: "shop-shell", location: "shop", dir: "/home/me/work/shop", command: "", created: ago(300), attached: 0, exited: false },
    { name: "search-perf-claude", title: "Speed up product search", location: "shop/search-perf", dir: "/home/me/work/shop-search-perf", command: "claude", created: ago(95), attached: 0, exited: false, agent: "claude", agent_state: "finished", state_since: ago(23) },
    // Three agents in one worktree, so the board has to tell them apart.
    { name: "order-export-claude", title: "Export orders as CSV from the admin", location: "shop/order-export", dir: "/home/me/work/shop-order-export", command: "claude 'Export orders as CSV from the admin'", created: ago(1700), attached: 0, exited: false, agent: "claude", agent_state: "finished", state_since: ago(1560) },
    { name: "order-export-claude-2", location: "shop/order-export", dir: "/home/me/work/shop-order-export", command: "claude", created: ago(320), attached: 0, exited: false, agent: "claude", agent_state: "idle", state_since: ago(290) },
    { name: "order-export-claude-3", title: "Add tests for the export job", location: "shop/order-export", dir: "/home/me/work/shop-order-export", command: "claude 'Add tests for the export job'", created: ago(140), attached: 0, exited: false, agent: "claude", agent_state: "finished", state_since: ago(75) },
    // Its repository's Playwright tests run near its 12 GB memory limit
    // (mock-processes).
    { name: "https-linear-app-acme-claude", title: "Fix the cart badge after a refund", location: "shop/https-linear-app-acme", dir: "/home/me/work/shop-https-linear-app-acme", command: "claude", created: ago(44), attached: 0, exited: false, agent: "claude", agent_state: "idle", state_since: ago(40), scope: "berth-https-linear-app-acme-claude-tq1.scope", usage: LINEAR_USAGE },
    { name: "notes-claude", location: "notes", dir: "/home/me/work/notes", command: "claude", created: ago(700), attached: 0, exited: true, agent: "claude" },
  ],
  gpu: [
    { name: "ci-flake-claude", title: "Move acme billing to the new ledger", location: "shop/ci-flake", dir: "/home/me/shop-ci-flake", command: "claude", created: ago(30), attached: 0, exited: false, agent: "claude", agent_state: "finished", state_since: ago(6) },
    { name: "judge-v2-claude", title: "Tune the judge prompt", location: "evals/judge-v2", dir: "/home/me/evals-judge-v2", command: "claude", created: ago(9), attached: 0, exited: false, agent: "claude", agent_state: "running", state_since: ago(1) },
    { name: "evals-codex", location: "evals", dir: "/home/me/evals", command: "codex", created: ago(3), attached: 0, exited: false, agent: "codex", agent_state: "idle", state_since: ago(3) },
    // Asks a form of questions (AskUserQuestion) after a reply with code.
    { name: "shop-claude", title: "Plan the checkout release", location: "shop", dir: "/home/me/shop", command: "claude", created: ago(12), attached: 0, exited: false, agent: "claude", agent_state: "waiting", state_since: ago(2), ask: { tool: "AskUserQuestion", message: "Three questions about the release window" } },
  ],
};

const stats: Record<string, Stats> = {
  devl: {
    hostname: "dev-box",
    cpus: 8,
    load: [1.2, 0.9, 0.8],
    memory: { total: 16 * GB, used: 9.4 * GB },
    swap: { total: 2 * GB, used: 0.1 * GB },
    disks: [{ mount: "/", total: 160 * GB, used: 71 * GB }],
    agents: [],
    hooks: true,
  },
  gpu: {
    hostname: "gpu",
    cpus: 32,
    load: [4.1, 3.8, 3.5],
    memory: { total: 128 * GB, used: 41 * GB },
    swap: { total: 0, used: 0 },
    disks: [{ mount: "/", total: 2000 * GB, used: 840 * GB }],
    agents: [],
    hooks: true,
  },
};

// ?mock=1&crowd=1: many more agents, on more boxes (lib/mock-crowd.ts).
if (new URLSearchParams(location.search).has("crowd")) crowd({ status, locations, sessions, stats });
// ?mock=1&bench=…: far more than the fixtures, for measuring (lib/mock-bench.ts).
if (BENCH === "fleet") benchFleet({ status, locations, sessions, stats });
if (BENCH === "chat") seedBenchChats();

const services: Record<string, Service[]> = {
  devl: [
    { location: "shop", worktree: "shop", path: "/home/me/work/shop", port: 3000, process: "node", main: true },
    { location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix", port: 3001, process: "node /home/me/work/shop-checkout-fix/node_modules/.bin/next dev -p 3001" },
    { location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix", port: 5555, process: "node /home/me/work/shop-checkout-fix/node_modules/.bin/prisma studio --port 5555 --browser none" },
    { location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix", port: 6379, process: "redis-server *:6379" },
    // An agent's headless browser: listening in the worktree, but nothing to open.
    { location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix", port: 39815, process: "/home/me/.agent-browser/browsers/chrome-150.0.7290.0/chrome --remote-debugging-port=0 --no-first-run --no-default-browser-check --headless=new --user-data-dir=/tmp/ab-profile-91" },
    { location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix", port: 41733, process: "/home/me/.npm/_npx/9f3c1a2b4d5e6f70/node_modules/agent-browser/bin/agent-browser-linux-x64 daemon" },
    { location: "shop", worktree: "qa-deck", path: "/home/me/work/shop-qa-deck", port: 4789, process: "vite" },
    { location: "shop", worktree: "order-export", path: "/home/me/work/shop-order-export", port: 3002, process: "node /home/me/work/shop-order-export/node_modules/.bin/vite --port 3002" },
    { location: "shop", worktree: "order-export", path: "/home/me/work/shop-order-export", port: 6006, process: "node /home/me/work/shop-order-export/node_modules/.bin/storybook dev -p 6006 --no-open" },
  ],
  gpu: [{ location: "evals", worktree: "judge-v2", path: "/home/me/evals-judge-v2", port: 8888, process: "jupyter" }],
};

// ?mock=1&firstrun=1: one box paired and nothing else yet (no projects,
// agents or services), for Home's first run.
if (new URLSearchParams(location.search).has("firstrun")) {
  status.boxes = status.boxes.filter((b) => b.name === "devl");
  status.forwards = [];
  for (const k of Object.keys(locations)) locations[k] = [];
  for (const k of Object.keys(sessions)) sessions[k] = [];
  for (const k of Object.keys(services)) services[k] = [];
}

// Hooks per machine, editable the way the agent and boxes allow.
const hooksFiles: Record<string, HooksFile> = {
  laptop: {
    path: "/Users/me/.berth/hooks.json",
    hooks: [
      { on: "agent.waiting", run: `osascript -e "display notification \\"$BERTH_PATH\\" with title \\"An agent on $BERTH_EVENT_BOX needs you\\""` },
      { on: "agent.finished", run: "afplay /System/Library/Sounds/Glass.aiff", source: "plugin:hello-ports" },
    ],
  },
  devl: {
    path: "/home/me/.berth/hooks.json",
    hooks: [
      { on: "worktree.created", run: 'cd "$BERTH_PATH" && pnpm install --frozen-lockfile', timeout: "10m" },
      { on: "before:worktree.create", run: '[ "${BERTH_BRANCH:-$BERTH_NAME}" != "main" ] || { echo "work on a branch, not main"; exit 1; }' },
      { on: "agent.finished", run: 'curl -fsS -X POST "$SLACK_HOOK" -d "{\\"text\\":\\"$BERTH_PATH done\\"}"', tool: "slack", timeout: "20s" },
    ],
  },
  gpu: { path: "/home/me/.berth/hooks.json", hooks: [] },
};

const VALID_ON = /^(before:)?(\*|[a-z][a-z0-9-]*\.(\*|[a-z][a-z0-9.-]*))$/;

// saveHooks validates like the Go side (internal/hooks.Validate) and keeps
// plugins' hooks, which the editor never sends back.
function saveHooks(machine: string, hooks: Hook[]): Promise<HooksFile> {
  for (const [i, h] of hooks.entries()) {
    if (!VALID_ON.test(h.on)) return Promise.reject(new Error(`hook ${i + 1}: "${h.on}" is not an event, a prefix like worktree.*, *, or before: one of those`));
    if (!h.run.trim()) return Promise.reject(new Error(`hook ${i + 1} (${h.on}): nothing to run`));
  }
  const file = hooksFiles[machine];
  file.hooks = [...hooks.filter((h) => !h.source), ...file.hooks.filter((h) => h.source)];
  setTimeout(() => emit({ type: "hooks.changed", box: machine === "laptop" ? undefined : machine }), 30);
  return delay(file);
}

// /v1/app documents, as the laptop agent keeps them. Projects start with a
// Work section so sections show.
const appDocs: Record<string, unknown> = fresh ? {} : { projects: { projects: [{ id: "acme/shop", section: "Work", default_box: "devl" }, { id: "me/notes", section: "Work" }], sections: ["Work", "Personal"] } };

const listeners = new Set<(e: BerthEvent) => void>();
const emit = (e: Omit<BerthEvent, "time">) => listeners.forEach((l) => l({ ...e, time: new Date().toISOString() }));
// The artifacts' fixtures, wired to the event stream when first loaded;
// window.__art.bump() plays a live update (a rewritten file's new version).
const artifactsMock = () =>
  import("@/lib/art/mock-artifacts").then((m) => {
    m.wireArtifactsMock(emit);
    return m;
  });
if (typeof window !== "undefined") (window as unknown as { __art: unknown }).__art = { bump: () => artifactsMock().then((m) => m.bumpArtifacts()), vdiff: () => artifactsMock().then((m) => m.bumpVdiff()) };
wireMockServices({
  sessions: (box) => (sessions[box] ??= []),
  path: (box, loc, wt) => locations[box]?.find((l) => l.name === loc)?.worktrees?.find((w) => w.name === wt)?.path ?? `/home/me/work/${loc}-${wt}`,
  port: (box, path) => services[box]?.find((s) => s.path === path && /next/.test(s.process ?? ""))?.port ?? 3100,
  emit,
});

// mockDemo is what the live demo's script (src/demo/script.ts) moves agents
// with. Keys are "box/session".
export const mockDemo = {
  // The last thing sent to each session (an answer, a prompt).
  lastSent: {} as Record<string, string>,
  // setAgent puts an agent in a state and says so, as its hooks would.
  setAgent(box: string, name: string, state: "running" | "waiting" | "finished") {
    const s = sessions[box]?.find((x) => x.name === name);
    if (!s) return;
    s.agent_state = state;
    s.state_since = new Date().toISOString();
    emit({ type: state === "running" ? "agent.started" : `agent.${state}`, box, origin: s.agent, data: { path: s.dir, session: s.name, agent: s.agent } });
  },
};

// An agent finishes its turn, then starts again, so the board moves. A new
// account has no agents, so nothing moves there. The live demo moves its
// agents on its own script instead (src/demo/script.ts).
// ?still keeps it at rest, for measuring the app while nothing changes
// (perf/soak.mjs).
if (!fresh && !__BERTH_DEMO__ && !new URLSearchParams(location.search).has("still")) setInterval(() => {
  const s = sessions.devl.find((x) => x.name === "qa-deck-codex");
  if (!s) return;
  s.agent_state = s.agent_state === "running" ? "waiting" : "running";
  s.state_since = new Date().toISOString();
  emit({ type: s.agent_state === "waiting" ? "agent.waiting" : "agent.started", box: "devl", origin: s.agent, data: { path: s.dir } });
}, 25_000);

const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 120));

// mockOrchestration answers send, wait and exec: a prompted agent works for
// a moment and finishes, and a worktree's check fails once, then passes, so
// a loop takes two rounds.
const checksRun: Record<string, number> = {};
// mockProjects is a box's folders, branches and the resolver: enough to
// browse, clone, create, and make worktrees from names, branches, PRs and
// issues.
const mockFolders: Record<string, { git?: boolean; slug?: string }> = {
  "/home/me": {},
  "/home/me/work": {},
  "/home/me/work/shop": { git: true, slug: "acme/shop" },
  "/home/me/work/notes": { git: true, slug: "me/notes" },
  "/home/me/work/ondine": { git: true, slug: "me/ondine" },
  "/home/me/work/drafts": {},
  "/home/me/work/scratch": {},
  "/home/me/learn": { git: true },
  "/home/me/go": {},
  "/home/me/orca": {},
  "/home/me/orca/projects": {},
  "/home/me/orca/projects/bean-app": { git: true, slug: "me/bean-app" },
};
const mockBranches = ["main", "me/checkout-fix", "me/qa-deck", "me/search-perf", "feat/qa-app", "feat/pr-previews", "fix/cart-badge"];
const HOME = "/home/me";
const expand = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? `${HOME}${p.slice(1)}` : p.replace(/\/+$/, "") || "/");

function mockProjects(box: string, method: string, path: string, body?: unknown): Promise<unknown> | undefined {
  const [route, query = ""] = path.split("?");
  if (method === "GET" && route === "fs") {
    const dir = expand(new URLSearchParams(query).get("path") ?? "~");
    if (!(dir in mockFolders)) return Promise.reject(new Error(`${dir}: no such folder`));
    const entries = Object.keys(mockFolders)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
      .sort()
      .map((p) => ({ name: p.split("/").pop()!, path: p, ...mockFolders[p] }));
    return delay({ path: dir, parent: dir === "/" ? undefined : dir.split("/").slice(0, -1).join("/") || "/", home: HOME, entries });
  }
  if (method === "POST" && route === "locations/new") {
    // sample: the box writes its sample project (examples/hello) in.
    const r = body as { name?: string; parent?: string; sample?: string };
    if (r.sample && r.sample !== "hello") return Promise.reject(new ApiError(`there is no sample named "${r.sample}"`, 400));
    r.name ||= r.sample ?? "";
    const dir = `${expand(r.parent ?? "~/work")}/${r.name}`;
    if (locations[box]?.some((l) => l.name === r.name)) return Promise.reject(new Error(`a location named ${r.name} already exists`));
    mockFolders[dir] = { git: true };
    const loc: Location = { name: r.name, path: dir, repo: true, scripts: {}, default_branch: "main", worktrees: [{ name: r.name, path: dir, branch: "main", main: true }] };
    locations[box] = [...(locations[box] ?? []), loc];
    setTimeout(() => emit({ type: "location.added", box, data: { location: r.name, path: dir } }), 30);
    return delay(loc);
  }
  const m = /^locations\/([^/]+)\/(resolve|branches|worktrees)$/.exec(route);
  if (!m) return undefined;
  const loc = locations[box]?.find((l) => l.name === decodeURIComponent(m[1]));
  if (!loc) return Promise.reject(new Error("no location with that name"));
  if (m[2] === "branches" && method === "GET") {
    return delay({ default: "main", branches: [...mockBranches.map((name) => ({ name, current: name === "main" })), { name: "release/v2.8", remote: true }] });
  }
  if (m[2] === "resolve" && method === "POST") {
    const { input, kind } = body as { input: string; kind?: string };
    const text = input.trim();
    const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const pr = /(?:^#|\/pull\/|^!|merge_requests\/)(\d+)/.exec(text);
    const issue = /\/issues\/(\d+)/.exec(text);
    let r: Record<string, unknown>;
    if (issue && kind !== "branch" && kind !== "name") {
      const title = mockIssueTitle(Number(issue[1])) ?? "Login loops after password reset";
      const name = `issue-${issue[1]}-${slugOf(title).slice(0, 40).replace(/-$/, "")}`;
      r = { kind: "issue", name, branch: name, base: "main", title, url: text };
    } else if (pr && kind !== "branch" && kind !== "name") {
      const n = Number(pr[1]);
      r = n === 404
        ? { kind: "pr", name: `pr-${n}`, branch: `pr-${n}`, pr: n, ref: `pull/${n}/head`, note: "gh is not installed on this box; using pull/404/head" }
        : { kind: "pr", name: "fix-payment-retries", branch: "me/fix-payment-retries", pr: n, ref: `pull/${n}/head`, title: "Fix payment retries without an idempotency key", url: `https://github.com/acme/shop/pull/${n}` };
    } else if (kind !== "name" && mockBranches.includes(text)) {
      r = { kind: "branch", name: slugOf(text.split("/").pop()!), branch: text, exists: true };
    } else if (kind !== "name" && text === "release/v2.8") {
      r = { kind: "remote-branch", name: "v2-8", branch: text, exists: true };
    } else {
      r = { kind: kind === "branch" ? "branch" : "name", name: slugOf(text), branch: slugOf(text), base: "main", exists: false };
    }
    return new Promise((res) => setTimeout(() => res(r), 220));
  }
  if (m[2] === "worktrees" && method === "POST") {
    const r = body as { name: string; branch?: string; pr?: number };
    if (loc.worktrees?.some((w) => w.name === r.name)) return Promise.reject(new Error(`git worktree add: '${loc.path}-${r.name}' already exists`));
    const wt = { name: r.name, path: `${loc.path}-${r.name}`, branch: r.branch || r.name };
    loc.worktrees = [...(loc.worktrees ?? []), wt];
    setTimeout(() => emit({ type: "worktree.created", box, data: { location: loc.name, name: r.name, path: wt.path } }), 50);
    return delay(wt);
  }
  return undefined;
}

// mockTurns is each session's turns, as a box with the "turns" capability
// keeps them: the last 50 per session.
const mockTurns: Record<string, Turn[]> = {};
// Prompts held until their agent is idle (send with when "idle").
const mockInbox: Record<string, { turn: Turn; text: string }[]> = {};
let mockSeq = 1000;

function mockStartTurn(box: string, s: Session, tr: Turn, text: string) {
  const at = new Date().toISOString();
  mockDemo.lastSent[`${box}/${s.name}`] = text;
  Object.assign(tr, { state: "running", started: at, sent_seq: ++mockSeq, fidelity: s.agent === "claude" ? "hooks" : "partial" });
  s.agent_state = "running";
  s.state_since = at;
  s.turn = tr.id;
  emit({ seq: ++mockSeq, type: "agent.started", box, origin: s.agent, data: { path: s.dir, session: s.name, turn: tr.id } });
  setTimeout(() => {
    const end = new Date().toISOString();
    Object.assign(tr, { state: "finished", ended: end, end_seq: ++mockSeq });
    s.agent_state = "finished";
    s.state_since = end;
    emit({ seq: mockSeq, type: "agent.finished", box, origin: s.agent, data: { path: s.dir, session: s.name } });
    const next = mockInbox[`${box}/${s.name}`]?.shift();
    s.queued = mockInbox[`${box}/${s.name}`]?.length || undefined;
    if (next) setTimeout(() => mockStartTurn(box, s, next.turn, next.text), 300);
    // The demo's agents work a little longer, so you see them at it.
  }, __BERTH_DEMO__ ? 4500 : 1500);
}

// A file's diff, as GET sessions/{name}/diff answers: the demo's edits
// (mock-conversation's), or a small change for any other file.
function mockDiff(file: string): { diff: string; untracked?: boolean } {
  const head = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
  const hunks = mockToolDetailSync(file);
  if (hunks?.hunks?.length)
    return { diff: head + hunks.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("") };
  if (file.endsWith("webhook.test.ts")) {
    const lines = WEBHOOK_TEST.replace(/\n$/, "").split("\n");
    return { untracked: true, diff: `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n` };
  }
  return {
    diff: `${head}@@ -1,4 +1,5 @@
 import { describe, it } from "vitest";
+import { retry } from "./retry";
 
 describe("checkout", () => {
-  it.todo("charges once");
+  it("charges once", () => retry(2));
`,
  };
}

function mockOrchestration(box: string, method: string, path: string, body?: unknown): Promise<unknown> | undefined {
  const qm = /^sessions\/([^/?]+)\/(queue|diff)(?:\/([^/?]+)(\/send)?)?/.exec(path);
  const qs = qm ? sessions[box]?.find((x) => x.name === decodeURIComponent(qm[1])) : undefined;
  if (qm && !qs) return Promise.reject(new ApiError("no session with that name", 404));
  if (qs && qm?.[2] === "diff") {
    const file = new URLSearchParams(path.split("?")[1]).get("file") ?? "";
    return delay({ file, ...mockDiff(file) });
  }
  if (qs && qm?.[2] === "queue") {
    const key = `${box}/${qs.name}`;
    const inbox = (mockInbox[key] ??= []);
    if (!qm[3]) return delay(inbox.map((i) => ({ turn: i.turn.id, preview: i.text.length > 280 ? `${i.text.slice(0, 280)}…` : i.text, length: i.text.length, origin: i.turn.origin, at: i.turn.queued })));
    const id = decodeURIComponent(qm[3]);
    const at = inbox.findIndex((i) => i.turn.id === id);
    if (at < 0) return Promise.reject(new ApiError("that prompt is no longer queued: it was sent or cancelled", 404));
    if (method === "POST" && qm[4] && qs.agent_state === "waiting" && !(body as { force?: boolean } | undefined)?.force)
      return Promise.reject(new ApiError(`${qs.name} is waiting for someone to answer it (a permission or a question); answer it at the terminal, or send with force to type anyway`, 409));
    const [item] = inbox.splice(at, 1);
    qs.queued = inbox.length || undefined;
    if (method === "DELETE") {
      Object.assign(item.turn, { state: "lost", status: "cancelled", ended: new Date().toISOString() });
      emit({ seq: ++mockSeq, type: "session.unqueued", box, data: { name: qs.name, turn: id } });
      return delay({ cancelled: id });
    }
    Object.assign(item.turn, { state: "pending", sent_seq: ++mockSeq });
    emit({ seq: mockSeq, type: "session.sent", box, data: { name: qs.name, turn: id, when: "now" } });
    return delay({ sent: true, turn: id, seq: mockSeq, at: new Date().toISOString() });
  }
  const tw = /^turns\/([^/?]+)(\/wait)?/.exec(path);
  if (tw) {
    const id = decodeURIComponent(tw[1]);
    const name = id.split("#")[0];
    const tr = mockTurns[`${box}/${name}`]?.find((t) => t.id === id);
    if (!tr) return Promise.reject(new ApiError("no turn with that ID", 404));
    if (!tw[2]) return delay(tr);
    const q = new URLSearchParams(path.split("?")[1]);
    const untilWaiting = q.get("until") === "waiting";
    const until = Date.now() + Math.min(parseInt(q.get("timeout") ?? "60") || 60, 60) * 1000;
    return new Promise((resolve) => {
      const tick = () => {
        const ended = ["finished", "exited", "lost"].includes(tr.state) || (untilWaiting && tr.state === "waiting");
        if (ended || Date.now() >= until) return resolve(structuredClone({ turn: tr, state: tr.state, timed_out: !ended }));
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  const m = /^sessions\/([^/?]+)\/(send|wait|turns)/.exec(path);
  const s = m ? sessions[box]?.find((x) => x.name === decodeURIComponent(m[1])) : undefined;
  if (m && !s) return Promise.reject(new ApiError("no session with that name", 404, "not_found"));
  if (s && m?.[2] === "turns") {
    const limit = parseInt(new URLSearchParams(path.split("?")[1]).get("limit") ?? "20") || 20;
    return delay((mockTurns[`${box}/${s.name}`] ?? []).slice(-limit));
  }
  if (s && m?.[2] === "send") {
    const req = (body ?? {}) as { text?: string; when?: string; force?: boolean; idem_key?: string; enter?: boolean };
    const key = `${box}/${s.name}`;
    const list = (mockTurns[key] ??= []);
    const dup = req.idem_key ? list.find((t) => t.idem_key === req.idem_key) : undefined;
    if (dup) return delay({ sent: dup.state !== "queued", queued: dup.state === "queued", duplicate: true, turn: dup.id, seq: dup.sent_seq, at: new Date().toISOString() });
    if (s.exited) return Promise.reject(new ApiError("the session's program has ended, so it can't take input; start it again", 409, "session_exited"));
    if (req.when === "now" && !req.force && s.agent_state === "waiting")
      return Promise.reject(new ApiError(`${s.name} is waiting for someone to answer it (a permission or a question); answer it at the terminal, or send with force to type anyway`, 409, "agent_waiting"));
    const tr: Turn = { id: `${s.name}#${list.length + 1}`, session: s.name, agent: s.agent, n: list.length + 1, origin: "laptop:demo", state: "pending", idem_key: req.idem_key };
    list.push(tr);
    if (list.length > 50) list.shift();
    const at = new Date().toISOString();
    if (req.when === "idle" && (s.agent_state === "running" || s.agent_state === "waiting")) {
      Object.assign(tr, { state: "queued", queued: at });
      (mockInbox[key] ??= []).push({ turn: tr, text: req.text ?? "" });
      s.queued = mockInbox[key].length;
      emit({ seq: ++mockSeq, type: "session.queued", box, data: { name: s.name, turn: tr.id } });
      return delay({ sent: false, queued: true, turn: tr.id, seq: mockSeq, at });
    }
    mockStartTurn(box, s, tr, req.text ?? "");
    // The first prompt an untitled session gets names it, as on a box.
    if (!mockPrompted.has(key) && req.enter !== false) {
      mockPrompted.add(key);
      if (!s.title) s.title = titleOf(req.text ?? "") || undefined;
    }
    return delay({ sent: true, turn: tr.id, seq: tr.sent_seq, at });
  }
  if (s && m?.[2] === "wait") {
    const q = new URLSearchParams(path.split("?")[1]);
    const want = (q.get("for") || "finished,waiting").split(",");
    const after = Date.parse(q.get("after") ?? "") || 0;
    const until = Date.now() + Math.min(parseInt(q.get("timeout") ?? "60") || 60, 60) * 1000;
    return new Promise((resolve) => {
      const tick = () => {
        if (s.exited) return resolve({ state: "exited", timed_out: false });
        if (s.agent_state && want.includes(s.agent_state) && Date.parse(s.state_since ?? "") > after) return resolve({ state: s.agent_state, timed_out: false, turn: s.turn });
        // The last state seen, never an empty one.
        if (Date.now() >= until) return resolve({ state: s.agent_state ?? "running", timed_out: true, turn: s.turn });
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  // An attachment "lands" in the worktree's .berth/attachments, as on a box.
  const am = method === "POST" ? /^(?:sessions\/([^/]+)|locations\/[^/]+\/worktrees\/([^/]+))\/attachments$/.exec(path) : null;
  if (am) {
    // JSON with base64 data (attach-local below), or a raw upload's name
    // and size (upload).
    const { name, data, size } = body as { name: string; data?: string; size?: number };
    const dir = am[1] ? (sessions[box]?.find((x) => x.name === decodeURIComponent(am[1]))?.dir ?? "/home/demo") : `/home/demo/${decodeURIComponent(am[2])}`;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const type = /\.(png|jpe?g|gif|webp)$/i.test(name) ? `image/${name.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")}` : /\.pdf$/i.test(name) ? "application/pdf" : "text/plain";
    return delay({ path: `${dir}/.berth/attachments/${stamp}-${name}`, name: `${stamp}-${name}`, type, size: size ?? Math.floor(((data ?? "").length * 3) / 4) });
  }
  // secrets/test resolves a reference the way the box would, answering only
  // whether it could and the value's length.
  if (method === "POST" && path === "secrets/test") {
    const { ref } = body as { ref: string };
    if (!/^(op|env):\/\/[^/\s]+/.test(ref)) return delay({ ok: false, error: "not a secret reference: use op://vault/item/field or env://NAME" });
    // op://vault/item/field: the item is the third part.
    if (/missing|nope/.test(ref)) return delay({ ok: false, error: `op: [ERROR] 2026/10/03 09:14:02 "${ref.replace(/^op:\/\//, "").split("/")[1] ?? ref}" isn't an item in the "${ref.replace(/^op:\/\//, "").split("/")[0]}" vault` });
    return delay({ ok: true, length: 32 });
  }
  if (method === "POST" && path === "exec") {
    const r = body as { location: string; command: string };
    const reviewed = reviewExec(box, r.location, r.command, emit);
    if (reviewed) return new Promise((resolve) => setTimeout(() => resolve(reviewed), 400));
    const usage = usageExec(box, r.command);
    if (usage) return new Promise((resolve) => setTimeout(() => resolve(usage), 600));
    const shell = mockShell(box, r.location, r.command);
    if (shell) return new Promise((resolve) => setTimeout(() => resolve(shell), 250));
    const n = (checksRun[`${box}:${r.location}`] = (checksRun[`${box}:${r.location}`] ?? 0) + 1);
    const output = n === 1 ? `$ ${r.command}\n FAIL  src/checkout.test.ts > rejects a double charge\n   Expected: 409\n   Received: 200\n\nTests: 1 failed, 213 passed\n` : `$ ${r.command}\nTests: 214 passed\n`;
    return new Promise((resolve) => setTimeout(() => resolve({ exit_code: n === 1 ? 1 : 0, output }), 700));
  }
  return undefined;
}

// Each worktree's "web" service, by worktree path: it starts and stops for
// real here, so the Run button can be seen doing both.
const webRunning = new Map<string, boolean>();

function worktreeServicesFixture(box: string, loc: string, wt: string) {
  const path = locations[box]?.find((l) => l.name === loc)?.worktrees?.find((w) => w.name === wt)?.path ?? `${box}:${loc}/${wt}`;
  const running = webRunning.get(path) ?? false;
  return [
    { name: "web", run: "pnpm dev --port $BERTH_PORT", autostart: true, state: running ? "running" : "stopped", unit: `berth-${loc}-${wt}-web`, port: 3100 },
    { name: "worker", run: "pnpm worker", state: "stopped", unit: `berth-${loc}-${wt}-worker` },
  ];
}

// How many times each box was asked for its requirements: the first is the
// card's own, the rest Check again.
const reqAsks: Record<string, number> = {};

function boxCall(box: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const online = status.boxes.find((b) => b.name === box)?.state === "online";
  // 503, as the agent answers when a request never reached the box.
  if (!online) return Promise.reject(new ApiError(`${box} is offline`, 503));
  const doc = mockBoxDoctor(box, !!status.boxes.find((b) => b.name === box)?.local, method, path);
  if (doc) return doc;
  // In-app artifacts (lib/art/mock-artifacts.ts, loaded when first asked).
  if (/^locations\/[^/]+\/worktrees\/[^/]+\/artifacts/.test(path)) return artifactsMock().then((m) => delay(m.artifactsMockCall(box, method, path) ?? null));
  // Visual diffs' baselines and Accept as baseline (internal/box/shots.go).
  if (/^worktrees\/[^/]+\/[^/]+\/shots\//.test(path))
    return artifactsMock().then((m) => {
      const r = m.shotsMockCall(method, path, body);
      return r === undefined ? Promise.reject(new ApiError("no visual diffs here", 404)) : delay(r);
    });
  const team = teamBoxCall(box, method, path, body, delay);
  if (team) return team;
  const flows = flowsCall(box, method, path, body, emit, delay);
  if (flows) return flows;
  const runs = runsCall(box, method, path, body, emit, delay);
  if (runs) return runs;
  const browser = browserCall(box, method, path);
  if (browser) return delay(browser);
  try {
    const procs = processesCall(box, method, path, emit);
    if (procs !== undefined) return delay(procs);
  } catch (err) {
    return Promise.reject(new ApiError((err as Error).message, /didn't start/.test((err as Error).message) ? 403 : 404));
  }
  const computers = computersBoxCall(box, method, path);
  if (computers) return computers;
  const thisMac = localBoxFolders(box, method, path);
  if (thisMac) return thisMac;
  const phone = phoneCall(box, method, path, body, delay);
  if (phone) return phone;
  const turnCheck = turnCheckCall(box, method, path, body, delay);
  if (turnCheck) return turnCheck;
  const usage = usageCall(box, method, path, body, delay);
  if (usage) return usage;
  const wts = worktreesCall(box, method, path, body, { locations, sessions }, emit, delay);
  if (wts) return wts;
  const hist = mockHistoryCall(box, method, path, body, { sessions, emit });
  if (hist) return hist;
  // The live demo's agents say their own lines (src/demo/terminal.ts).
  if (__BERTH_DEMO__ && method === "GET" && /^sessions\/[^/]+\/screen/.test(path)) {
    const s = sessions[box]?.find((x) => x.name === decodeURIComponent(path.split("/")[1]));
    const screen = s && demoScreen(s);
    if (screen) return delay({ screen });
  }
  const review = reviewCall(box, method, path, sessions[box]);
  if (review) return review;
  if (method === "GET" && path === "agents") return delay(mockBoxAgents(box));
  // Look again: the same two, found afresh.
  if (method === "POST" && path === "agents/refresh") return delay({ agents: [], agent_paths: [], shell: "/bin/bash", shell_ok: true });
  if (method === "GET" && path === "requirements") {
    reqAsks[box] = (reqAsks[box] ?? 0) + 1;
    return delay(mockRequirements(box, !!status.boxes.find((b) => b.name === box)?.local, reqAsks[box] - 1));
  }
  const key = `${method} ${path}`;
  if (key === "GET locations") return delay(locations[box] ?? []);
  if (key === "GET sessions") return delay(sessions[box] ?? []);
  if (key === "GET stats") return delay(stats[box]);
  if (key === "GET services") return delay(services[box] ?? []);
  const svc = /^locations\/([^/]+)\/worktrees\/([^/]+)\/services(?:\/([^/]+)(?:\/(start|stop|restart|log))?)?$/.exec(path);
  if (svc) {
    const [, loc, wt, name, action] = svc.map((x) => x && decodeURIComponent(x));
    // The demo repository has none, to show the empty state.
    if (loc === "notes") return delay([]);
    const list = worktreeServicesFixture(box, loc, wt);
    if (!name) return delay(list);
    const one = list.find((x) => x.name === name);
    if (!one) return Promise.reject(new Error("no service with that name in this repository's config"));
    if (action === "log") return delay(`$ ${one.run}\n  ▲ Next.js 15.2.0\n  - Local:   http://localhost:3100\n ✓ Ready in 1.4s\n GET / 200 in 84ms\n`);
    if (name === "web") {
      const p = locations[box]?.find((l) => l.name === loc)?.worktrees?.find((w) => w.name === wt)?.path ?? `${box}:${loc}/${wt}`;
      webRunning.set(p, action !== "stop");
      setTimeout(() => emit({ type: action === "stop" ? "service.stopped" : "service.started", box, data: { location: loc, name: wt, path: p, service: name, port: 3100 } }), 50);
    }
    return delay(worktreeServicesFixture(box, loc, wt).find((x) => x.name === name));
  }
  const skills = mockSkills(box, method, path, body);
  if (skills) return skills;
  const integrations = mockIntegrations(box, method, path, body);
  if (integrations) return integrations;
  if (key === "GET hooks") return hooksFiles[box] ? delay(hooksFiles[box]) : Promise.reject(new Error("this box has no hooks file"));
  if (key === "PUT hooks") return saveHooks(box, (body as { hooks: Hook[] }).hooks);
  // The box fills in an agent's form of questions (mock-conversation).
  const answer = method === "POST" ? /^sessions\/([^/]+)\/answer$/.exec(path) : null;
  if (answer) {
    const name = decodeURIComponent(answer[1]);
    try {
      const r = mockAnswer(box, name, body as Parameters<typeof mockAnswer>[2]);
      mockDemo.setAgent(box, name, "finished");
      return delay(r);
    } catch (err) {
      return Promise.reject(new ApiError(String((err as Error).message), 409));
    }
  }
  const orchestration = mockOrchestration(box, method, path, body);
  if (orchestration) return orchestration;
  const projects = mockProjects(box, method, path, body);
  if (projects) return projects;
  if (key === "GET info")
    return delay({
      name: box,
      version: "0.1.0",
      build: mockBuilds[box] ?? SHIPPED_BUILD,
      tools: ["claude", "codex"],
      home: HOME,
      // gpu runs an older berthd (mockBuilds): it can't keep worktree names.
      capabilities: ["diff", "turns", "queue", "ask", "answer", "journal", "runs", "exec.detach", "browser", "browser.devtools", "titles", "sample", "service.terminal", "session.home", "agents.install", "artifacts", "processes", ...(box === "gpu" ? [] : ["worktree.titles", "agents.paths"])],
      // Claude Code from npm under nvm, as the person's shell finds it;
      // Codex from Shipyard's own installer.
      agent_paths: [
        { id: "claude", name: "Claude Code", command: "claude", path: `${HOME}/.nvm/versions/node/v22.9.0/bin/claude`, version: "2.1.3 (Claude Code)", install: "npm", via: "shell" },
        { id: "codex", name: "Codex", command: "codex", path: `${HOME}/.local/bin/codex`, version: "codex-cli 0.46.0", via: "shell" },
      ],
      adapters: {
        claude: { ready: true, started: true, waiting: true, finished: true, final_message: true, via: "hooks" },
        codex: { ready: true, started: true, waiting: true, finished: true, final_message: true, via: "hooks" },
        screen: { ready: true, started: true, waiting: true, finished: true, final_message: false, via: "screen" },
      },
      agents: [
        { id: "claude", name: "Claude Code", command: "claude", model_flag: "--model", effort_flag: "--effort", models: ["opus", "sonnet", "haiku"], efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "codex", name: "Codex", command: "codex", model_flag: "--model", effort_flag: "-c model_reasoning_effort=", models: ["gpt-5-codex", "gpt-5"], efforts: ["minimal", "low", "medium", "high"] },
        { id: "gemini", name: "Gemini CLI", command: "gemini", prompt_flag: "-i" },
        { id: "shell", name: "Shell", command: "" },
      ],
    });
  if (method === "GET" && /^sessions\/[^/]+\/screen/.test(path)) {
    const name = decodeURIComponent(path.split("/")[1]);
    const s = sessions[box]?.find((x) => x.name === name);
    const screen =
      s?.agent_state === "waiting"
        ? "● The fix needs a migration for the new idempotency_key column.\n\n  Do you want me to create it?\n  ❯ 1. Yes\n    2. No, and tell Claude what to do differently"
        : s?.agent_state === "finished"
          ? "● Search results render 38% faster on the slow-network profile.\n  All 214 tests pass.\n\n✻ Baked for 6m 41s · done"
          : s?.agent_state === "idle"
          ? " ▐▛███▜▌   Codex\n  ~/evals\n\n────────────────────────────────\n❯ Try \"refactor the judge\"\n────────────────────────────────\n  ? for shortcuts"
          : "● Running pnpm test --filter checkout…\n  ⎿  PASS  createOrder.test.ts (41 tests)\n  ⎿  RUNS  payments/webhook.test.ts\n\n✻ Testing… (2m 13s · esc to interrupt)\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)";
    return delay({ screen });
  }
  if (key === "POST tasks") {
    const t = body as { location: string; name: string; branch?: string; agent?: string; command?: string; open?: string; prompt?: string; title?: string };
    const loc = locations[box].find((l) => l.name === t.location)!;
    if (loc.worktrees?.some((w) => w.name === t.name)) return Promise.reject(new Error(`a worktree named ${t.name} already exists`));
    const wt = { name: t.name, path: `${loc.path}-${t.name}`, branch: t.branch || `me/${t.name}` };
    loc.worktrees = [...(loc.worktrees ?? []), wt];
    const agent = t.agent || "claude";
    const title = titleOf(t.title || t.prompt || "", t.title ? 80 : undefined) || undefined;
    const session: Session = { name: `${t.name}-${agent}`, location: `${t.location}/${t.name}`, dir: wt.path, command: t.command ?? agent, created: new Date().toISOString(), attached: 0, exited: false, agent, agent_state: "running", title };
    sessions[box].push(session);
    setTimeout(() => emit({ type: "worktree.created", box, data: { location: t.location, name: t.name, path: wt.path } }), 50);
    setTimeout(() => emit({ type: "task.created", box, data: { location: t.location, name: t.name, path: wt.path, branch: wt.branch, session: session.name, agent } }), 60);
    if (t.open) setTimeout(() => emit({ type: "session.open", box, data: { name: session.name, location: session.location, path: wt.path, open: t.open, agent } }), 120);
    return delay({ worktree: wt, session });
  }
  if (key === "POST sessions" && (body as { home?: boolean }).home) {
    // A terminal in the box's home, tied to no worktree.
    const r = body as { name?: string; command?: string };
    const command = r.command ?? "";
    const session: Session = { name: r.name ?? `home-${command.split(" ")[0] || "shell"}-${sessions[box].length}`, dir: HOME, command, created: new Date().toISOString(), attached: 0, exited: false };
    sessions[box].push(session);
    return delay(session);
  }
  if (key === "POST sessions") {
    const r = body as { location: string; name?: string; command?: string; agent?: string; prompt?: string; title?: string };
    const [locName, wtName] = r.location.split("/");
    const loc = locations[box].find((l) => l.name === locName)!;
    const wt = loc.worktrees?.find((w) => w.name === (wtName ?? locName)) ?? loc.worktrees![0];
    const command = r.command ?? r.agent ?? "";
    const agent = ["claude", "codex", "gemini"].includes(command) ? command : undefined;
    const title = titleOf(r.title || r.prompt || "", r.title ? 80 : undefined) || undefined;
    const session: Session = { name: r.name ?? `${wt.name}-${command || "shell"}-${sessions[box].length}`, location: r.location, dir: wt.path, command, created: new Date().toISOString(), attached: 0, exited: false, agent, agent_state: agent ? "running" : undefined, title };
    sessions[box].push(session);
    return delay(session);
  }
  // Removing a worktree or a project. A worktree with uncommitted work
  // (checkout-fix, in the fixtures) refuses without force, as git does.
  const rmWt = /^locations\/([^/]+)\/worktrees\/([^/?]+)(\?.*)?$/.exec(path);
  if (method === "DELETE" && rmWt) {
    const [, loc, wt, q = ""] = rmWt.map((x) => x && decodeURIComponent(x));
    const l = locations[box]?.find((x) => x.name === loc);
    const w = l?.worktrees?.find((x) => x.name === wt);
    if (!l || !w) return Promise.reject(new Error("no worktree with that name"));
    if (wt === "checkout-fix" && !q.includes("force=1")) return Promise.reject(new Error(`git worktree remove: '${w.path}' contains modified or untracked files, use --force to delete it`));
    const gone = () => {
      l.worktrees = l.worktrees!.filter((x) => x !== w);
      sessions[box] = (sessions[box] ?? []).filter((x) => x.dir !== w.path);
      emit({ type: "worktree.removed", box, data: { location: loc, name: wt, path: w.path } });
    };
    // With an archive script the box runs it first, in the background.
    if (l.scripts?.archive) {
      setTimeout(() => emit({ type: "worktree.archive.started", box, data: { location: loc, name: wt, path: w.path, script: l.scripts!.archive } }), 20);
      setTimeout(() => {
        gone();
        emit({ type: "worktree.archive.finished", box, data: { location: loc, name: wt, path: w.path } });
      }, 1500);
      return delay({ removing: wt, archive: l.scripts.archive });
    }
    setTimeout(gone, 50);
    return delay({ removed: wt });
  }
  const rmLoc = /^locations\/([^/]+)$/.exec(path);
  if (method === "DELETE" && rmLoc) {
    const loc = decodeURIComponent(rmLoc[1]);
    locations[box] = (locations[box] ?? []).filter((x) => x.name !== loc);
    setTimeout(() => emit({ type: "location.removed", box, data: { location: loc } }), 50);
    return delay({ removed: loc });
  }
  // Naming a worktree: its title, or "" to clear it. gpu's berthd is too
  // old, and answers as one does: DELETE is there, PATCH is not.
  const nameWt = /^locations\/([^/]+)\/worktrees\/([^/?]+)$/.exec(path);
  if (method === "PATCH" && nameWt) {
    if (box === "gpu") return Promise.reject(new ApiError("Method Not Allowed", 405));
    const [, loc, wt] = nameWt.map((x) => x && decodeURIComponent(x));
    const w = locations[box]?.find((x) => x.name === loc)?.worktrees?.find((x) => x.name === wt);
    if (!w) return Promise.reject(new ApiError("no worktree with that name in the location", 404));
    const title = titleOf((body as { title?: string }).title ?? "", 80);
    w.title = title && title !== w.name ? title : undefined;
    setTimeout(() => emit({ type: "worktree.renamed", box, data: { location: loc, name: wt, path: w.path } }), 30);
    return delay({ ...w });
  }
  // Renaming a session: its title, or "" to clear it.
  if (method === "PATCH" && /^sessions\/[^/]+$/.test(path)) {
    const s = sessions[box]?.find((x) => x.name === decodeURIComponent(path.slice("sessions/".length)));
    if (!s) return Promise.reject(new ApiError("no session with that name", 404));
    s.title = titleOf((body as { title?: string }).title ?? "", 80) || undefined;
    mockPrompted.add(`${box}/${s.name}`);
    setTimeout(() => emit({ type: "session.renamed", box, data: { name: s.name } }), 30);
    return delay({ ...s });
  }
  if (method === "DELETE" && path.startsWith("sessions/")) {
    const name = decodeURIComponent(path.slice("sessions/".length));
    sessions[box] = sessions[box].filter((s) => s.name !== name);
    setTimeout(() => emit({ type: "session.stopped", box, data: { name } }), 50);
    return delay({ removed: name });
  }
  if (key === "POST locations") {
    const r = body as { name: string; path: string };
    const slug = mockFolders[r.path]?.slug;
    const loc: Location = { name: r.name, path: r.path, repo: true, scripts: {}, ...(slug ? { slug, remote: `git@github.com:${slug}.git` } : {}), worktrees: [{ name: r.name, path: r.path, branch: "main", main: true }] };
    locations[box].push(loc);
    return delay(loc);
  }
  return Promise.reject(new Error(`mock: no fixture for ${key}`));
}

// A fake terminal: a short Claude-like transcript, then an echoing prompt.
// The live demo's terminals follow their agent instead, and answer.
// ?echoDelay=300 holds every echo of typing back that many ms, like a slow
// link to the box, for predictive echo (lib/predict) to show.
const ECHO_DELAY = Number(new URLSearchParams(location.search).get("echoDelay")) || 0;

function mockAttach(box: string, session: string, h: TerminalHandlers) {
  // A service's own terminal (lib/mock-services).
  if (sessions[box]?.some((x) => x.name === session && x.service)) return mockServiceAttach(box, session, h);
  // A team setup's runner (lib/mock-team).
  if (isTeamSession(box, session)) return teamAttach(box, session, h);
  if (__BERTH_DEMO__) {
    return demoAttach(box, session, h, {
      session: () => sessions[box]?.find((x) => x.name === session),
      answered: () => mockDemo.lastSent[`${box}/${session}`],
      send: (text) => boxCall(box, "POST", `sessions/${encodeURIComponent(session)}/send`, { text, enter: false }),
      listen: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    });
  }
  if (BENCH === "term") return benchTerm(h);
  if (BENCH === "noisy") return noisyTerm(h);
  const timers: number[] = [];
  let open = true;
  const s = sessions[box]?.find((x) => x.name === session);
  // A box's home terminal is a plain shell at ~.
  const home = s && !s.location && !s.command;
  const lines = home ? ["\x1b[2J\x1b[H", `Last login: Mon Oct  5 09:12:44 on ${box}\r\n`, `\x1b[32mme@${box}\x1b[0m:\x1b[34m~\x1b[0m$ `] : [
    "\x1b[2J\x1b[H",
    `\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1m${s?.agent ?? "shell"}\x1b[0m on \x1b[36m${box}\x1b[0m  \x1b[2m${s?.dir ?? ""}\x1b[0m\r\n\r\n`,
    "\x1b[33m●\x1b[0m Read \x1b[1mapps/web/lib/checkout/createOrder.ts\x1b[0m\r\n",
    "\x1b[2m  ⎿  Read 412 lines\x1b[0m\r\n\r\n",
    "\x1b[37m●\x1b[0m The payment webhook retries without an idempotency key,\r\n  so a slow response can create two orders.\r\n  I will add the key and a test.\r\n\r\n",
    "\x1b[32m●\x1b[0m Update(\x1b[1mapps/web/lib/payments/webhook.ts\x1b[0m)\r\n",
    "\x1b[2m  ⎿  Updated with \x1b[0m\x1b[32m12 additions\x1b[0m\x1b[2m and \x1b[0m\x1b[31m3 removals\x1b[0m\r\n\r\n",
    "\x1b[2m✻ Baked for 1m 12s · done\x1b[0m\r\n\r\n",
    "\x1b[1m❯\x1b[0m ",
  ];
  let i = 0;
  timers.push(window.setTimeout(() => h.onOpen(), 150));
  const next = () => {
    if (!open || i >= lines.length) return;
    h.onData(lines[i++]);
    timers.push(window.setTimeout(next, 90));
  };
  timers.push(window.setTimeout(next, 200));
  return {
    send(data: Uint8Array | string) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      const echo = text.replace(/\r/g, "\r\n\x1b[2m(mock: nothing runs here)\x1b[0m\r\n\x1b[1m❯\x1b[0m ").replace(/\x7f/g, "\b \b");
      if (!ECHO_DELAY) h.onData(echo);
      else timers.push(window.setTimeout(() => open && h.onData(echo), ECHO_DELAY));
    },
    resize() {},
    close() {
      open = false;
      timers.forEach(clearTimeout);
      h.onClose(true);
    },
  };
}

// Boxes: discovering, adding over SSH, pairing, upgrading and forgetting
// them, and tailnet sign-ins. Added boxes come online empty.

// This Mac's tailnet. ?tailnet=none is a Mac without Tailscale, =off one
// signed out of it, =stopped one with it turned off.
type MockMachine = { name: string; dns_name: string; ip: string; os: string; online: boolean; box?: string; ssh?: boolean; host_keys?: string[] };
const tailnetMode = new URLSearchParams(location.search).get("tailnet");
// An invented fingerprint: the host key build-01 presents, as the tailnet reports it.
const BUILD_KEY = "SHA256:bW9jay1idWlsZC0wMS1ob3N0LWtleS1ub3QtcmVhbA";
const discovery = {
  user: "me",
  tailscale: tailnetMode === "none" ? "missing" : tailnetMode === "off" ? "logged-out" : tailnetMode === "stopped" ? "stopped" : "running",
  tailnet: "example.com",
  machines: [
    { name: "dev-box", dns_name: "dev-box.example-tailnet.ts.net", ip: "100.64.0.12", os: "linux", online: true },
    { name: "build-01", dns_name: "build-01.example-tailnet.ts.net", ip: "100.64.0.14", os: "linux", online: true, ssh: true, host_keys: [BUILD_KEY] },
    { name: "hetzner-ax41", dns_name: "hetzner-ax41.example-tailnet.ts.net", ip: "100.64.0.11", os: "linux", online: true },
    { name: "gpu-runner", dns_name: "gpu-runner.example-tailnet.ts.net", ip: "100.64.0.19", os: "linux", online: false },
    { name: "studio-mac", dns_name: "studio-mac.example-tailnet.ts.net", ip: "100.64.0.67", os: "macOS", online: true },
  ] as MockMachine[],
};
if (!fresh) discovery.machines[2].box = "devl";
if (discovery.tailscale !== "running") {
  discovery.machines = [];
  delete (discovery as { tailnet?: string }).tailnet;
}

// The machines on tailnets Shipyard signed in to itself, by network.
const networkMachines: MockMachine[] = [
  { name: "homelab", dns_name: "homelab.example-home.ts.net", ip: "100.80.0.2", os: "linux", online: true },
  { name: "nas", dns_name: "nas.example-home.ts.net", ip: "100.80.0.3", os: "linux", online: true, ssh: true },
  { name: "pi", dns_name: "pi.example-home.ts.net", ip: "100.80.0.4", os: "linux", online: false },
];
const discoverNetwork = (_network: string) => ({ user: "me", machines: networkMachines });

const mockNetworks = fresh ? [] : [{ name: "personal", state: "Running", tailnet: "example.ts.net", ips: ["100.64.0.73"] }];

// The live demo lists none: a plugin from ~/.berth/plugins would load from
// the dev server, which the demo doesn't have.
const mockPlugins = [{ id: "hello-ports", name: "Hello ports", version: "0.1.0", main: "dist/index.js", description: "Every dev server on every box, one click from your browser.", entry: "/__dev-plugins/hello-ports/dist/index.js", enabled: false, defaultEnabled: false, allowed: undefined as string | undefined }].filter(() => !__BERTH_DEMO__);


function addMockBox(name: string, address: string, network?: string) {
  if (!status.boxes.some((b) => b.name === name)) {
    status.boxes.push({ name, address, network, fingerprint: "sha256:5eed…", state: "online", latency_ms: 42, since: new Date().toISOString() });
  }
  locations[name] ??= [];
  sessions[name] ??= [];
  services[name] ??= [];
  stats[name] ??= { hostname: name, cpus: 8, load: [0.2, 0.1, 0.1], memory: { total: 32 * GB, used: 3 * GB }, swap: { total: 0, used: 0 }, disks: [{ mount: "/", total: 240 * GB, used: 40 * GB }], agents: [], hooks: true };
  const m = [...discovery.machines, ...networkMachines].find((x) => address.startsWith(x.ip) || address.startsWith(x.dns_name));
  if (m) m.box = name;
  emit({ type: "box.connected", box: name });
}

// mockSshPlan is how Shipyard would log in: 1Password's agent for most hosts,
// keys on disk for one with "nokey" in its name. Invented paths only.
function mockSshPlan(host: string) {
  const at = host.lastIndexOf("@");
  const hostname = host.slice(at + 1);
  const user = at > 0 ? host.slice(0, at) : "me";
  if (/nokey/.test(host)) return { host, user, hostname, port: "22", identity_files: ["~/.ssh/id_ed25519"], summary: "Using keys from ~/.ssh (id_ed25519)" };
  return {
    host,
    user,
    hostname,
    port: "22",
    agent: { name: "1Password", socket: "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock", source: "discovered" },
    identity_files: [],
    summary: "Using 1Password's SSH agent",
  };
}

// mockSshFailure fails an add-ssh by a word in the host, the way berth add
// ssh explains each kind. A new host key succeeds once trusted.
function mockSshFailure(host: string, trusted?: string) {
  const where = host.split("@").pop() ?? host;
  const fp = "SHA256:Zm9yLWRlbW8tb25seS1ub3QtYS1yZWFsLWtleQ";
  if (/refused|fail|nope/.test(host))
    return { kind: "refused", host: where, port: "22", message: `Nothing is accepting SSH on ${where} (port 22): the machine answered, but refused the connection. Run the install command on the box instead, or check the address.` };
  if (/denied/.test(host))
    return {
      kind: "auth",
      host: where,
      port: "22",
      tried: ["the keys in 1Password's SSH agent", "~/.ssh/id_ed25519"],
      message: `${where} refused the login. Shipyard offered the keys in 1Password's SSH agent, ~/.ssh/id_ed25519. Make the right key available: unlock your key manager's SSH agent, name it with IdentityAgent for this host in ~/.ssh/config, or choose the key file. Or add this computer's public key to ~/.ssh/authorized_keys on the box.`,
    };
  if (/build-01/.test(host) && trusted !== BUILD_KEY)
    return { kind: "host-key-unknown", host: where, port: "22", fingerprint: BUILD_KEY, message: `This computer hasn't connected to ${where} before. Check its host key fingerprint, then trust it to continue.` };
  if (/newkey/.test(host) && trusted !== fp)
    return { kind: "host-key-unknown", host: where, port: "22", fingerprint: fp, message: `This computer hasn't connected to ${where} before. Check its host key fingerprint, then trust it to continue.` };
  if (/changed/.test(host))
    return {
      kind: "host-key-changed",
      host: where,
      port: "22",
      fingerprint: fp,
      message: `${where}'s host key has changed since this computer last connected, so Shipyard did not log in. If the box was rebuilt, remove the old key with \`ssh-keygen -R ${where}\` and try again; if not, someone may be in the way, so don't connect.`,
    };
  if (/nohost/.test(host)) return { kind: "resolve", host: where, port: "22", message: `Could not resolve ${where}: no machine by that name is reachable from this computer. Check the spelling, or use its IP or tailnet address.` };
  return undefined;
}

// mockRoutes changes a box's routes the way the agent does (boxroutes.go):
// an added route is measured at once, and a box keeps one route on.
function mockRoutes(method: string, path: string, body: unknown): Promise<unknown> | undefined {
  const m = /^\/v1\/boxes\/([^/]+)\/routes(?:\/([^/]+))?$/.exec(path);
  const box = m && status.boxes.find((b) => b.name === decodeURIComponent(m[1]));
  if (!m || !box) return undefined;
  const routes = (box.routes ??= []);
  const id = m[2] && decodeURIComponent(m[2]);
  const settle = () => {
    if (!routes.some((r) => r.active && r.state !== "off")) {
      for (const r of routes) r.active = false;
      const next = routes.filter((r) => r.state === "up").sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0];
      if (next) next.active = true;
    }
    box.route = routes.find((r) => r.active)?.id;
    emit({ type: "box.route", box: box.name });
    return delay(routes);
  };
  if (method === "POST" && !id) {
    const r = body as { kind: string; host?: string; address?: string };
    if (r.kind === "ssh") {
      if (!r.host || r.host.startsWith("-")) return Promise.reject(new ApiError(`"${r.host ?? ""}" is not an SSH host`, 400));
      box.routes = routes.filter((x) => x.kind !== "ssh");
      box.routes.push({ id: "ssh", kind: "ssh", label: "SSH", detail: r.host, state: "up", latency_ms: 31 });
      return settle();
    }
    if (!r.address || !/:\d+$/.test(r.address)) return Promise.reject(new ApiError(`"${r.address ?? ""}" is not a host:port`, 400));
    box.routes = routes.filter((x) => x.id !== `direct:${r.address}`);
    box.routes.push({ id: `direct:${r.address}`, kind: "direct", label: "Direct", detail: r.address, state: "up", latency_ms: 9 });
    return settle();
  }
  const route = routes.find((r) => r.id === id);
  if (!route) return Promise.reject(new ApiError("the box has no route with that id", 404));
  if (method === "PATCH") {
    const off = (body as { off: boolean }).off;
    if (off && !routes.some((r) => r.id !== id && r.state !== "off")) return Promise.reject(new ApiError("a box needs one route on: turn another on first", 400));
    route.state = off ? "off" : "up";
    route.latency_ms = off ? undefined : (route.latency_ms ?? 30);
    if (off) route.active = false;
    return settle();
  }
  if (method === "DELETE") {
    if (id === "paired") return Promise.reject(new ApiError("the address the box was paired at can be turned off, not removed", 400));
    box.routes = routes.filter((r) => r.id !== id);
    return settle();
  }
  return undefined;
}

function laptopBoxes(method: string, path: string, body: unknown): Promise<unknown> | undefined {
  const routed = path.includes("/routes") ? mockRoutes(method, path, body) : undefined;
  if (routed) return routed;
  if (method === "GET" && path.startsWith("/v1/discover")) {
    const network = new URLSearchParams(path.split("?")[1] ?? "").get("network");
    return delay(network ? discoverNetwork(network) : discovery);
  }
  if (method === "GET" && path === "/v1/networks") return delay(mockNetworks);
  if (method === "GET" && path.startsWith("/v1/boxes/outdated"))
    return delay({
      boxes: status.boxes
        .filter((b) => b.state === "online")
        .map((b) => {
          const current = mockBuilds[b.name] ?? SHIPPED_BUILD;
          return { box: b.name, current, available: SHIPPED_BUILD, outdated: current !== SHIPPED_BUILD };
        }),
    });
  if (method === "GET" && path === "/v1/ssh/hosts") return delay(["dev-box", "hetzner", "pi"]);
  if (method === "GET" && path.startsWith("/v1/ssh/install-plan")) {
    const q = new URLSearchParams(path.split("?")[1] ?? "");
    const agents = (q.get("agents") ?? "").split(",").filter((a) => a && a !== "none");
    return delay(mockInstallPlan(q.get("host") || "me@box", agents));
  }
  if (method === "GET" && path.startsWith("/v1/ssh/plan")) return delay(mockSshPlan(new URLSearchParams(path.split("?")[1]).get("host") ?? ""));
  if (method === "POST" && path === "/v1/boxes/pair") {
    const r = body as { link: string; name?: string; network?: string };
    const address = /^berth:\/\/([^?]+)/.exec(r.link)?.[1] ?? "100.64.0.9:7444";
    const name = r.name || "box";
    addMockBox(name, address, r.network);
    return delay({ name, address, network: r.network });
  }
  const forget = /^\/v1\/boxes\/([^/]+)$/.exec(path);
  if (method === "DELETE" && forget) {
    const name = decodeURIComponent(forget[1]);
    status.boxes = status.boxes.filter((b) => b.name !== name);
    for (const m of [...discovery.machines, ...networkMachines]) if (m.box === name) delete m.box;
    return delay({ removed: name });
  }
  const toggle = /^\/v1\/plugins\/([^/]+)\/(enable|disable)$/.exec(path);
  if (method === "POST" && toggle) {
    const p = mockPlugins.find((x) => x.id === decodeURIComponent(toggle[1]));
    if (!p) return Promise.reject(new Error("no such plugin"));
    const hash = (body as { hash?: string } | undefined)?.hash;
    if (toggle[2] === "enable" && !hash) return Promise.reject(new Error("review the plugin in the app to turn it on"));
    p.enabled = toggle[2] === "enable";
    p.allowed = p.enabled ? hash : undefined;
    return delay(p);
  }
  return undefined;
}

// mockStream plays a long command's output a line at a time, as the agent
// streams the CLI's.
async function mockStream(method: string, path: string, body: unknown, onValue: (v: unknown) => void, signal?: AbortSignal) {
  if (method === "POST" && (await kitsStream(path, body, onValue, emit, signal))) return;
  if (method === "GET" && path.endsWith("/browser/screencast")) return mockScreencast(onValue, signal);
  if (await localBoxStream(method, path, body, onValue, signal)) return;
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))));
    });
  const say = async (line: string, ms = 450) => {
    await wait(ms);
    onValue({ line });
  };
  if (method === "POST" && path === "/v1/boxes/add-ssh") {
    const r = body as { host: string; name?: string; network?: string; trust_host_key?: string };
    const where = r.host.split("@").pop() ?? r.host;
    await say(mockSshPlan(r.host).summary, 200);
    const failure = mockSshFailure(r.host, r.trust_host_key);
    if (failure) {
      await wait(900);
      onValue({ done: true, error: failure.message, ssh: failure });
      return;
    }
    if (r.trust_host_key) await say(`Trusted ${where}'s host key (${r.trust_host_key}).`, 200);
    await say(`Checking ${r.host}…`, 300);
    await say("Installing berthd-linux-amd64 (8 MB)…", 900);
    const ip = [...discovery.machines, ...networkMachines].find((m) => m.dns_name === where || m.ip === where)?.ip ?? "100.64.0.11";
    await say(`  Installed /home/me/.config/systemd/user/berthd.service; berthd is serving on ${ip}:7444.`, 1400);
    const name = r.name || where.split(".")[0];
    await wait(700);
    addMockBox(name, `${ip}:7444`, r.network);
    onValue({ line: `Paired with ${name} at ${ip}:7444. SSH is no longer needed for this box.` });
    onValue({ done: true });
    return;
  }
  const addAgents = /^\/v1\/boxes\/([^/]+)\/api\/agents\/install$/.exec(path);
  if (method === "POST" && addAgents) {
    await mockInstallAgents(decodeURIComponent(addAgents[1]), (body as { agents: string[] }).agents, onValue, wait);
    return;
  }
  const upgrade = /^\/v1\/boxes\/([^/]+)\/upgrade$/.exec(path);
  if (method === "POST" && upgrade) {
    const name = decodeURIComponent(upgrade[1]);
    const from = mockBuilds[name] ?? SHIPPED_BUILD;
    if (from === SHIPPED_BUILD) {
      await say(`${name} already runs this build (${SHIPPED_BUILD}).`, 300);
      onValue({ done: true });
      return;
    }
    await say(`Uploading berthd-linux-amd64 to ${name}…`, 300);
    await say(`${name} upgraded: ${from} → ${SHIPPED_BUILD}. Sessions kept running.`, 1600);
    mockBuilds[name] = SHIPPED_BUILD;
    onValue({ done: true });
    return;
  }
  const login = /^\/v1\/networks\/([^/]+)\/login$/.exec(path);
  if (method === "POST" && login) {
    const name = decodeURIComponent(login[1]);
    await wait(500);
    onValue({ auth_url: "https://login.tailscale.com/a/mock-sign-in" });
    await wait(2500);
    const info = { name, state: "Running", tailnet: "example.ts.net", ips: ["100.64.0.73"] };
    mockNetworks.push(info);
    onValue({ network: info });
    return;
  }
  const clone = /^\/v1\/boxes\/([^/]+)\/api\/locations\/clone$/.exec(path);
  if (method === "POST" && clone) {
    const box = decodeURIComponent(clone[1]);
    const r = body as { url: string; parent?: string; name?: string };
    const name = r.name || r.url.replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "");
    await say(`Cloning into '${name}'...`, 300);
    if (/nope|missing/.test(r.url)) {
      await wait(600);
      onValue({ line: "remote: Repository not found." });
      onValue({ done: true, error: `fatal: repository '${r.url}' not found` });
      return;
    }
    for (const pct of [12, 47, 83, 100]) await say(`Receiving objects: ${pct}% (${pct * 41}/4100), ${(pct * 0.31).toFixed(1)} MiB | 18.2 MiB/s`, 350);
    await say("Resolving deltas: 100% (2210/2210), done.", 400);
    const dir = `${expand(r.parent ?? "~/work")}/${name}`;
    mockFolders[dir] = { git: true };
    const loc: Location = { name, path: dir, repo: true, scripts: {}, default_branch: "main", slug: r.url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1"), worktrees: [{ name, path: dir, branch: "main", main: true }] };
    locations[box] = [...(locations[box] ?? []), loc];
    onValue({ done: true, location: loc });
    return;
  }
  throw new Error(`mock: no stream for ${method} ${path}`);
}

// Join links and each box's computers (lib/mock-computers).
initMockComputers({ status, networks: mockNetworks, addBox: addMockBox, emit, delay });
// Use this Mac (lib/mock-local-box).
initMockLocalBox({ status, addBox: addMockBox, delay });
// The guided install's terminal (lib/mock-install).
initMockInstall({
  addBox: addMockBox,
  sshFailure: (host, trusted) => mockSshFailure(host, trusted) as SshFailure | undefined,
  boxIP: (where) => [...discovery.machines, ...networkMachines].find((m) => m.dns_name === where || m.ip === where)?.ip ?? "100.64.0.11",
});

// The offline prompt queue and its box-offline simulator (lib/mock-queue).
initMockQueue({ status, sessions, emit, delay, send: (box, session, text, enter) => boxCall(box, "POST", `sessions/${encodeURIComponent(session)}/send`, { text, enter, when: "now" }) }, fresh);

let teamWired = false;

export function mockClient(): Client {
  if (!teamWired) {
    teamWired = true;
    initTeamMock({ status, locations, sessions, emit, delay, addBox: (name, address) => addMockBox(name, address) });
    initPrReviewMock({ status, locations, services, emit, delay });
  }
  return counted(mockAgent());
}

// counted tallies what the app asks the mock agent for, as requests to a
// real one would be, on window.__berthCalls ("GET box/sessions/x/transcript"
// → count): the soak test (perf/soak.mjs) reads how often the app asks
// while nothing changes.
function counted(c: Client): Client {
  const calls: Record<string, number> = {};
  (window as unknown as { __berthCalls: Record<string, number> }).__berthCalls = calls;
  // A test that sets window.__berthCallStacks = {} also gets who asked.
  const stacks = () => (window as unknown as { __berthCallStacks?: Record<string, Record<string, number>> }).__berthCallStacks;
  const tally = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
    const s = stacks();
    if (!s) return;
    const at = (new Error().stack ?? "").split("\n").slice(3, 8).join(" < ");
    (s[k] ??= {})[at] = (s[k][at] ?? 0) + 1;
  };
  const bare = (p: string) => p.split("?")[0];
  return new Proxy(c, {
    get(target, name, recv) {
      const v = Reflect.get(target, name, recv);
      if (typeof v !== "function" || typeof name !== "string") return v;
      return (...a: unknown[]) => {
        if (name === "box") tally(`${a[1]} ${a[0]}/${bare(String(a[2]))}`);
        else if (name === "laptop") tally(`${a[0]} ${bare(String(a[1]))}`);
        else if (name === "stream") tally(`${a[0]} ${bare(String(a[1]))}`);
        else tally(name);
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  });
}

function mockAgent(): Client {
  return {
    status: () => delay(status),
    themes: () => delay([]),
    templates: () =>
      delay([
        {
          id: "bugfix",
          name: "Fix a bug",
          description: "Claude on a fresh branch from main, test first.",
          location: "shop",
          agent: "claude",
          branch: "fix/{{name}}",
          base: "main",
          prompt: "Fix {{issue}}. Write a failing test first.",
          variables: [{ id: "issue", label: "Issue or description", multiline: true }],
        },
        { id: "review", name: "Review a branch", description: "Codex reviews the changes against main.", agent: "codex", prompt: "Review {{branch_name}} against main and list risks." },
      ]),
    plugins: () => delay(mockPlugins),
    async pluginFile(p, file) {
      const res = await fetch(`/__dev-plugins/${encodeURIComponent(p.id)}/${file}`);
      if (!res.ok) throw new Error(`${p.id}: ${res.status} (run pnpm build in plugins/${p.id})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    box: <T,>(box: string, method: string, path: string, body?: unknown, _signal?: AbortSignal, headers?: Record<string, string>) =>
      ((mockFilesCall(box, method, path, body, headers) ?? boxCall(box, method, path, body)) as Promise<T>).catch((err: unknown) => {
        if (err instanceof ApiError) err.box = box;
        throw err;
      }),
    boxBlob: async (_box, path) =>
      /\/artifacts\/[0-9a-f]{10}\/img\/[0-9a-f]{16}\.png$/.test(path) ? ((await (await artifactsMock()).artifactImage(path)) ?? Promise.reject(new ApiError("no such image", 404))) : (/\/artifacts\/[0-9a-f]{10}\/v\/\d+$/.test(path) ? ((await artifactsMock()).artifactBlob(path) ?? Promise.reject(new ApiError("no such artifact", 404))) : (mockFileBlob(path) ?? new Blob([mockShotSvg()], { type: "image/svg+xml" }))),
    // An upload creeps along at about 1 MB/s, so the chip's progress shows.
    upload: <T,>(box: string, path: string, body: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        const [route, query = ""] = path.split("?");
        const name = new URLSearchParams(query).get("name") ?? "file";
        let sent = 0;
        const tick = window.setInterval(() => {
          sent = Math.min(body.size, sent + 100_000);
          onProgress?.(sent, body.size);
          if (sent < body.size) return;
          window.clearInterval(tick);
          (boxCall(box, "POST", route, { name, size: body.size }) as Promise<T>).then(resolve, reject);
        }, 100);
        signal?.addEventListener("abort", () => {
          window.clearInterval(tick);
          reject(new DOMException("The upload was cancelled", "AbortError"));
        });
      }),
    laptop: <T,>(method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === "/v1/hooks") return delay(hooksFiles.laptop) as Promise<T>;
      if (method === "PUT" && path === "/v1/hooks") return saveHooks("laptop", (body as { hooks: Hook[] }).hooks) as Promise<T>;
      // The app's own documents (/v1/app/<key>), such as project groups.
      const app = /^\/v1\/app\/([a-z0-9-]+)$/.exec(path);
      if (app && method === "GET") return delay(appDocs[app[1]] ?? null) as Promise<T>;
      if (app && method === "PUT") {
        appDocs[app[1]] = structuredClone(body);
        return delay(body) as Promise<T>;
      }
      // A file on "this Mac" goes up as an attachment, as the agent does.
      const local = method === "POST" ? /^\/v1\/boxes\/([^/]+)\/attach-local$/.exec(path) : null;
      if (local) {
        const r = body as { path: string; session?: string; location?: string; worktree?: string };
        const name = r.path.split("/").pop() ?? "file";
        const route = r.session ? `sessions/${encodeURIComponent(r.session)}/attachments` : `locations/${r.location}/worktrees/${r.worktree}/attachments`;
        return boxCall(decodeURIComponent(local[1]), "POST", route, { name, data: "AAAA".repeat(30000) }) as Promise<T>;
      }
      const diag = mockDiagnosticsCall(method, path);
      if (diag) return diag as Promise<T>;
      const requests = mockDevtoolsCall(method, path);
      if (requests) return delay(requests) as Promise<T>;
      const thisMac = localBoxCall(method, path);
      if (thisMac) return thisMac as Promise<T>;
      const boxes = laptopBoxes(method, path, body);
      if (boxes) return boxes as Promise<T>;
      const computers = computersCall(method, path, body);
      if (computers) return computers as Promise<T>;
      const queued = queueCall(method, path, body);
      if (queued) return queued as Promise<T>;
      const kits = kitsCall(method, path, body, emit, delay);
      if (kits) return kits as Promise<T>;
      const team = teamLaptopCall(method, path, body, delay);
      if (team) return team as Promise<T>;
      const prReview = prReviewLaptopCall(method, path, body, delay);
      if (prReview) return prReview as Promise<T>;
      const eds = editorsCall(method, path, body, delay);
      if (eds) return eds as Promise<T>;
      const gen = imageGenCall(method, path, delay);
      if (gen) return gen as Promise<T>;
      return Promise.reject(new Error(`mock: no fixture for ${method} ${path}`));
    },
    stream: mockStream,
    addForward: () => delay({}),
    events(onEvent, onConnect, signal) {
      listeners.add(onEvent);
      setTimeout(onConnect, 0);
      signal.addEventListener("abort", () => listeners.delete(onEvent));
    },
    installTerminal: (req, cols, rows, handlers) => mockInstallTerminal(req, cols, rows, handlers),
    attach: (box, session, _cols, _rows, h) => mockAttach(box, session, h),
    serviceUrl: (box, port) => `http://${port}.${box}.localhost:1377/`,
  };
}

// Skills on each box: some installed, one outdated, the rest missing, so
// every state shows. Project copies start missing and are kept out of git.
const skillCatalog = [
  { name: "berth", description: "Use berth to work across development boxes — repos, worktrees, tasks, sessions, ports and the repo's config.", version: "eb32be71b151" },
  { name: "berth-artifacts", description: "Show the user data as a chart, table, diagram, notes or a small page in their Shipyard app instead of a wall of text.", version: "3b7e9c41d2a0" },
  { name: "berth-browser", description: "Use the worktree's own page in a headless browser on the box: snapshot, click, fill, screenshot, console errors and the page's size.", version: "a84f0d27c6e3" },
  { name: "berth-hooks", description: "Automate berth with hooks and gates at the right scope.", version: "f20829fe718c" },
  { name: "berth-orchestrate", description: "Drive other coding agents: prompt, wait, check, loop, hand off, review.", version: "66660a4b14c8" },
  { name: "berth-preview", description: "Run the worktree's dev server on its port and show it in the Shipyard app.", version: "e1454dda1a21" },
  { name: "berth-visual-diff", description: "Screenshot the worktree's pages and main's, diff them, and show what moved.", version: "5d0c1a9e7f42" },
];
type MockSkillState = "installed" | "outdated" | "missing";
const skillStates: Record<string, Record<string, MockSkillState>> = {};
const skillCommitted: Record<string, boolean> = {};

function skillState(scope: string, skill: string, agent: string): MockSkillState {
  const k = `${scope}|${skill}|${agent}`;
  if (!skillStates[scope]) skillStates[scope] = {};
  if (!(k in skillStates[scope])) {
    const seeded = !scope.includes("/") && agent === "claude" ? (skill === "berth" ? "installed" : skill === "berth-orchestrate" ? "outdated" : "missing") : "missing";
    skillStates[scope][k] = seeded;
  }
  return skillStates[scope][k];
}

function skillsReport(box: string, location?: string) {
  const agents = ["claude", "codex"];
  const home = box === "mac-test" ? "/Users/me" : "/home/me";
  const repo = location ? (locations[box]?.find((l) => l.name === location)?.path ?? `${home}/work/${location}`) : undefined;
  return {
    agents,
    user_dirs: { claude: `${home}/.claude/skills`, codex: `${home}/.agents/skills` },
    project_dirs: repo ? { claude: `${repo}/.claude/skills`, codex: `${repo}/.agents/skills` } : undefined,
    location,
    skills: skillCatalog.map((s) => ({
      ...s,
      user: Object.fromEntries(agents.map((a) => [a, skillState(box, s.name, a)])),
      project: location ? Object.fromEntries(agents.map((a) => [a, skillState(`${box}/${location}`, s.name, a)])) : undefined,
      excluded: location ? Object.fromEntries(agents.map((a) => [a, !skillCommitted[`${box}/${location}|${s.name}|${a}`]])) : undefined,
    })),
  };
}

function mockSkills(box: string, method: string, path: string, body?: unknown): Promise<unknown> | undefined {
  if (method === "GET" && (path === "skills" || path.startsWith("skills?"))) {
    const location = new URLSearchParams(path.split("?")[1] ?? "").get("location") ?? undefined;
    return delay(skillsReport(box, location));
  }
  const m = /^skills\/(install|uninstall)$/.exec(path);
  if (method !== "POST" || !m) return undefined;
  const req = body as { skills: string[] | "all"; agent: string; target: string; location?: string; commit?: boolean };
  if (req.target === "project" && !req.location) return Promise.reject(new Error("a project install needs a location"));
  const names = req.skills === "all" || (req.skills.length === 1 && req.skills[0] === "all") ? skillCatalog.map((s) => s.name) : req.skills;
  const agents = req.agent === "all" ? ["claude", "codex"] : [req.agent];
  const scope = req.target === "project" ? `${box}/${req.location}` : box;
  for (const n of names) {
    for (const a of agents) {
      skillState(scope, n, a);
      skillStates[scope][`${scope}|${n}|${a}`] = m[1] === "install" ? "installed" : "missing";
      if (req.target === "project") skillCommitted[`${scope}|${n}|${a}`] = m[1] === "install" && !!req.commit;
    }
  }
  setTimeout(() => emit({ type: m[1] === "install" ? "skills.installed" : "skills.removed", box, data: { skills: names, agents, target: req.target, location: req.location } }), 50);
  return new Promise((resolve) => setTimeout(() => resolve(skillsReport(box, req.location)), 450));
}

// Agent hooks: the first box has Claude Code without them, so starting it
// there shows the offer to install them.
const mockHooked: Record<string, boolean> = {};
function mockIntegrations(box: string, method: string, path: string, body?: unknown): Promise<unknown> | undefined {
  const first = status.boxes[0]?.name;
  const report = () => ({
    tools: [
      { id: "claude", name: "Claude Code", command: "claude", present: true, hooked: mockHooked[`${box}:claude`] ?? box !== first },
      { id: "codex", name: "Codex", command: "codex", present: true, hooked: mockHooked[`${box}:codex`] ?? true },
      { id: "cursor", name: "Cursor Agent", command: "cursor-agent", present: false, hooked: false },
    ],
  });
  if (method === "GET" && path === "integrations") return delay(report());
  if (method !== "POST" || path !== "integrations/install") return undefined;
  const { tool, account } = body as { tool: string; account?: string };
  // One account folder (the Usage plugin's "Add account…") leaves the default as it was.
  if (!account) mockHooked[`${box}:${tool}`] = true;
  setTimeout(() => emit({ type: "integrations.installed", box, data: account ? { tool, account } : { tool } }), 50);
  const where = account ?? "~/.claude";
  return new Promise((resolve) => setTimeout(() => resolve({ ...report(), output: `Claude Code: hooks and 7 skills in ${where}\n  hooks added in ${where}/settings.json` }), 450));
}

// mockAgentOpens plays an agent on a box running
// `berthd session new LOC/WT --agent claude --prompt … --open split|tab`:
// a new session, then session.open asking the app to show it.
let mockOpened = 0;
export function mockAgentOpens(box: string, location: string, dir: string, open: "split" | "tab") {
  const name = `${location.replace(/\//g, "-")}-claude-${(++mockOpened).toString(36)}`;
  const now = new Date().toISOString();
  (sessions[box] ??= []).push({ name, location, dir, command: "claude 'Review the diff'", created: now, attached: 0, exited: false, agent: "claude", agent_state: "running", state_since: now });
  emit({ type: "session.started", box, data: { name, location, path: dir, command: "claude" } });
  setTimeout(() => emit({ type: "session.open", box, data: { name, location, path: dir, open, agent: "claude" } }), 80);
}

// mockNotifications plays one of every event the notification centre turns
// into a notification, a moment apart, so each kind shows: a waiting agent,
// one that finished three times (one collapsed row), failures, the guard, a
// kit with warnings, a flow's message, and an agent opening things.
export function mockNotifications() {
  const devl = "devl";
  const plays: [number, Omit<BerthEvent, "time">][] = [
    [0, { type: "agent.waiting", box: devl, origin: "claude", data: { path: "/home/me/work/shop-checkout-fix" } }],
    [150, { type: "agent.finished", box: devl, origin: "claude", data: { path: "/home/me/work/shop-search-perf" } }],
    [300, { type: "agent.finished", box: devl, origin: "claude", data: { path: "/home/me/work/shop-search-perf" } }],
    [450, { type: "agent.finished", box: devl, origin: "claude", data: { path: "/home/me/work/shop-search-perf" } }],
    [600, { type: "flow.finished", box: devl, origin: "flow:tests-after-turn", data: { flow: "tests-after-turn", scope: "repo:shop", run: "r3", status: "failed", path: "/home/me/work/shop-checkout-fix" } }],
    [750, { type: "worktree.setup.failed", box: devl, data: { location: "shop", name: "qa-deck", path: "/home/me/work/shop-qa-deck" }, error: "pnpm install exited with status 1: ERR_PNPM_FETCH_404" }],
    [900, { type: "service.failed", box: devl, data: { location: "shop", name: "qa-deck", service: "storybook", error: "port 6006 is already in use" } }],
    [1050, { type: "guard.acted", box: "gpu", origin: "guard", data: { action: "stop_services", location: "evals", name: "judge-v2", path: "/home/me/evals-judge-v2", services: ["web", "worker"], memory_percent: 93.4, reason: "Memory at 93% for 2 minutes" } }],
    [1200, { type: "kit.installed", box: devl, data: { location: "shop", kit: "shop-dev", version: "3", source: "https://example.com/kits/shop-dev.json", warnings: ["The .env.example has keys this kit does not set: PAYMENTS_WEBHOOK_SECRET", "pnpm is older than the repository asks for (9.1 < 9.4)"] } }],
    [1350, { type: "notify", box: devl, origin: "flow:nightly-e2e", data: { title: "Nightly e2e passed", body: "412 tests in 9m 12s", flow: "nightly-e2e", location: "shop" } }],
    // One of three Claude Codes in one worktree: named by its session, it
    // reads as "Claude Code 3", not just "Claude Code".
    [1420, { type: "agent.finished", box: devl, origin: "claude", data: { path: "/home/me/work/shop-order-export", session: "order-export-claude-3", agent: "claude" } }],
    [1500, { type: "preview.open", box: devl, data: { location: "shop", name: "qa-deck", path: "/home/me/work/shop-qa-deck", port: 4789, url_path: "/deck" } }],
  ];
  for (const [ms, e] of plays) setTimeout(() => emit(e), ms);
  setTimeout(() => mockAgentOpens(devl, "shop/qa-deck", "/home/me/work/shop-qa-deck", "split"), 1650);
  // A plugin's notify, and a review-ready item, come from the app itself.
  setTimeout(() => {
    void import("@/lib/notify").then((m) => m.notify("Usage at 82% of the weekly limit", "Claude Code on your work account", "warning"));
    void import("@/lib/notifications").then((m) =>
      m.route({
        category: "review",
        title: "Claude Code left changes to review",
        detail: "4 files · +128 −31 · me/search-perf",
        tone: "success",
        box: devl,
        path: "/home/me/work/shop-search-perf",
        action: { kind: "review", box: devl, path: "/home/me/work/shop-search-perf" },
        key: `review|${devl}|/home/me/work/shop-search-perf`,
      }),
    );
  }, 1800);
}

// ?notify=1 plays them on start.
if (!fresh && new URLSearchParams(location.search).has("notify")) setTimeout(mockNotifications, 2500);
