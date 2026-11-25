import { mockTerminalService, mockWorktreePath } from "@/lib/mock-services";
import type { BerthEvent } from "@/lib/api";
import type { Flow, FlowRun, LocationConfig, RepoConfig, ScopedFlow, ServiceStatus, Step, StepKind, StepRun } from "@/lib/flows";
import type { GuardStatus } from "@/components/guard-dialog";
import { maxRunsPerHour, rateWarning, triggerType } from "@/lib/flows";
import { mergeConfig } from "@/lib/kits";
import { kitOn } from "@/lib/mock-kits";

// Mock mode's flows, repository config and worktree services, behaving like
// internal/box/flows.go and repoconfig.go closely enough to build the UI on.

type Emit = (e: Omit<BerthEvent, "time">) => void;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const committed: Record<string, Record<string, RepoConfig>> = {
  devl: {
    shop: {
      setup: "pnpm install --frozen-lockfile && pnpm db:migrate",
      archive: "dropdb --if-exists $BERTH_WORKTREE_SLUG",
      ports: 3,
      env: {
        DATABASE_URL: "postgresql://postgres@localhost:5432/$BERTH_WORKTREE_SLUG",
        NEXT_PUBLIC_WEBAPP_URL: "http://$BERTH_WORKTREE_NAME.shop.$BERTH_BOX.localhost:1377",
        PORT: "$BERTH_PORT",
      },
      services: [
        { name: "web", run: "pnpm dev --port $BERTH_PORT", autostart: true },
        { name: "api", run: "pnpm --filter @shop/api dev --port $BERTH_PORT_1" },
      ],
      agents: [{ id: "claude", name: "Claude Code (Opus)", command: "claude --model opus" }],
      flows: [
        {
          id: "tests-after-turn",
          name: "Type-check after every Claude turn",
          enabled: true,
          trigger: { event: "agent.finished", where: { agent: "claude" } },
          steps: [
            { id: "types", kind: "run", command: "pnpm typecheck --filter=...[HEAD]", timeout: "15m" },
            { kind: "prompt", when: "failure", text: "Type-check failed:\n\n{{prev.output}}\n\nFix it, then stop." },
          ],
          max_runs_per_hour: 12,
        },
      ],
    },
  },
};

const local: Record<string, Record<string, RepoConfig>> = {
  devl: {
    shop: {
      env: { PAYMENTS_SECRET_KEY: "op://dev/payments/secret-key", NEXT_PUBLIC_IS_E2E: "1" },
      flows: [
        {
          id: "notify-when-waiting",
          name: "Notify me when an agent in shop needs me",
          enabled: true,
          trigger: { event: "agent.waiting" },
          steps: [{ kind: "notify", title: "{{worktree.name}} needs you", text: "An agent in {{location}} is waiting." }],
        },
      ],
    },
    notes: {},
  },
  gpu: { evals: {} },
};

const boxFlows: Record<string, Flow[]> = {
  devl: [
    {
      id: "slack-setup-failed",
      name: "Post to Slack when setup fails",
      enabled: true,
      trigger: { event: "worktree.setup.failed" },
      steps: [{ kind: "webhook", url: "https://hooks.slack.com/services/T000/B000/XXXX", text: '{"text": "Setup failed for {{worktree.name}} in {{location}}"}' }],
    },
    {
      id: "codex-review",
      name: "Codex reviews Claude's work",
      enabled: false,
      trigger: { event: "agent.finished", where: { agent: "claude", branch: "me/*" } },
      steps: [{ kind: "start_agent", agent: "codex", text: "Review the uncommitted changes in {{worktree.path}}. Don't edit; list bugs and risks." }],
    },
    {
      // Fires 60 times an hour with the default limit of 20: the limit
      // refuses the rest, and the list and editor say so.
      id: "every-minute",
      name: "Sweep stale previews every minute",
      enabled: true,
      trigger: { schedule: "* * * * *" },
      steps: [{ kind: "run", command: "./scripts/sweep-previews.sh" }],
    },
  ],
  gpu: [],
};

// What the box's limit refused in the last hour, by box/scope/flow, as
// GET flows says it.
const refused: Record<string, { n: number; last: string }> = { "devl/box/every-minute": { n: 7, last: minutesAgo(1) } };

// firesPerHour is a schedule's starts in its busiest hour, enough like the
// box's Cron.FiresPerHour for mock flows: the minute field's values.
function firesPerHour(schedule?: string): number | undefined {
  if (!schedule) return undefined;
  const minute = schedule.startsWith("@") ? "0" : schedule.trim().split(/\s+/)[0];
  const step = minute.match(/^\*\/(\d+)$/);
  return minute === "*" ? 60 : step ? Math.ceil(60 / Number(step[1])) : minute.split(",").length;
}

// withRate adds what the box says of a flow's limit.
function withRate(box: string, f: ScopedFlow): ScopedFlow {
  if (f.overridden) return f;
  const r = refused[`${box}/${f.scope}/${f.flow.id}`];
  const fires = firesPerHour(f.flow.trigger.schedule);
  const limit = maxRunsPerHour(f.flow);
  return { ...f, ...(r && { refused_last_hour: r.n, last_refused_at: r.last }), ...(fires && { fires_per_hour: fires, warning: rateWarning(fires, limit) }) };
}

const runs: Record<string, FlowRun[]> = {
  devl: [
    {
      id: "r3",
      flow: "tests-after-turn",
      scope: "repo:shop",
      started: minutesAgo(6),
      finished: minutesAgo(5),
      // The check failed and the on-failure prompt handled it, which the box
      // counts as the flow succeeding.
      status: "succeeded",
      event: { type: "agent.finished", time: minutesAgo(6), box: "devl", origin: "claude", data: { path: "/home/me/work/shop-checkout-fix", agent: "claude" } },
      steps: [
        { id: "types", kind: "run", status: "failed", started: minutesAgo(6), duration: "48.2s", exit_code: 2, output: "apps/web/lib/payments/webhook.ts:41:7 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n\nFound 1 error." },
        { id: "", kind: "prompt", status: "succeeded", started: minutesAgo(5), duration: "0.3s", exit_code: 0 },
      ],
    },
    {
      id: "r2",
      flow: "notify-when-waiting",
      scope: "repo:shop",
      started: minutesAgo(41),
      finished: minutesAgo(41),
      status: "succeeded",
      event: { type: "agent.waiting", time: minutesAgo(41), box: "devl", origin: "claude", data: { path: "/home/me/work/shop-checkout-fix" } },
      steps: [{ id: "", kind: "notify", status: "succeeded", duration: "2ms", exit_code: 0 }],
    },
    {
      id: "r1",
      flow: "tests-after-turn",
      scope: "repo:shop",
      started: minutesAgo(95),
      finished: minutesAgo(94),
      status: "succeeded",
      event: { type: "agent.finished", time: minutesAgo(95), box: "devl", origin: "claude", data: { path: "/home/me/work/shop-search-perf", agent: "claude" } },
      steps: [
        { id: "types", kind: "run", status: "succeeded", duration: "52.9s", exit_code: 0, output: "Tasks: 41 successful, 41 total" },
        { id: "", kind: "prompt", status: "skipped", exit_code: 0 },
      ],
    },
  ],
  gpu: [],
};

const services: Record<string, ServiceStatus[]> = {};

function merged(box: string, loc: string): RepoConfig {
  // The kit's layer sits between the committed config and this box's own.
  const repo = mergeConfig(committed[box]?.[loc], kitOn(box, loc)?.config);
  const own = local[box]?.[loc] ?? {};
  const by = <T,>(a: T[] = [], b: T[] = [], key: (x: T) => string) => [...a.filter((x) => !b.some((y) => key(y) === key(x))), ...b];
  return {
    ...repo,
    ...Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined && v !== "" && v !== 0)),
    env: { ...repo.env, ...own.env },
    services: by(repo.services, own.services, (s) => s.name),
    agents: by(repo.agents, own.agents, (a) => a.id),
    hooks: [...(repo.hooks ?? []), ...(own.hooks ?? [])],
    flows: by(repo.flows, own.flows, (f) => f.id),
  };
}

function listFlows(box: string): ScopedFlow[] {
  const out: ScopedFlow[] = (boxFlows[box] ?? []).map((flow) => ({ scope: "box", source: "box", editable: true, flow }));
  const locs = new Set([...Object.keys(committed[box] ?? {}), ...Object.keys(local[box] ?? {})]);
  for (const loc of locs) {
    const scope = `repo:${loc}`;
    const layers: [ScopedFlow["source"], Flow[] | undefined][] = [
      ["repo", committed[box]?.[loc]?.flows],
      ["kit", kitOn(box, loc)?.config.flows],
      ["local", local[box]?.[loc]?.flows],
    ];
    for (const [source, flows] of layers) for (const flow of flows ?? []) out.push({ scope, source, editable: source === "local", flow });
  }
  // Like the box: a more local layer's flow replaces one below it by id.
  return out.map((f) => (out.some((o, j) => j > out.indexOf(f) && o.scope === f.scope && o.flow.id === f.flow.id) ? { ...f, overridden: true } : f)).map((f) => withRate(box, f));
}

function validate(flows: Flow[]): string | undefined {
  const seen = new Set<string>();
  for (const f of flows) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(f.id)) return `flow id "${f.id}" must be lowercase letters, digits and dashes`;
    if (seen.has(f.id)) return `two flows are called ${f.id}`;
    seen.add(f.id);
    const starts = [f.trigger.event, f.trigger.schedule, f.trigger.github].filter(Boolean).length;
    if (starts !== 1) return `flow ${f.id}: a flow starts from exactly one of an event, a schedule, or GitHub`;
    if (f.trigger.schedule && f.trigger.schedule.trim().split(/\s+/).length !== 5 && !f.trigger.schedule.startsWith("@")) return `flow ${f.id}: "${f.trigger.schedule}" needs five fields (minute hour day month weekday) or a shortcut like @daily`;
    if (!f.steps.length) return `flow ${f.id} has no steps`;
    for (const [i, s] of f.steps.entries()) {
      const need = { run: s.command, prompt: s.text, start_agent: s.agent, notify: s.title, webhook: s.url, wait: "x" }[s.kind as StepKind];
      if (!need?.trim()) return `flow ${f.id}, step ${i + 1} (${s.kind}) is missing what to do`;
    }
  }
  return undefined;
}

// simulate runs a flow the way the box would, with made-up results: a
// command with "test" or "check" in it fails the first time.
function simulate(box: string, sf: ScopedFlow, data: Record<string, unknown>, emit: Emit, test = false): FlowRun {
  const started = new Date().toISOString();
  let prevFailed = false;
  // As the box decides: a failure that a later failure or always step
  // handles is not the flow failing.
  let failed = false;
  const steps: StepRun[] = sf.flow.steps.map((s: Step, i) => {
    const when = s.when ?? "success";
    const runs = when === "always" || (when === "failure" ? prevFailed : !prevFailed);
    if (!runs) return { id: s.id ?? "", kind: s.kind, status: "skipped", exit_code: 0 };
    const fail = s.kind === "run" && /test|check|lint/.test(s.command ?? "");
    if (s.kind === "notify") emit({ type: "notify", box, origin: `flow:${sf.flow.id}`, data: { title: (s.title ?? "").replace(/\{\{[^}]+\}\}/g, String(data.name ?? "checkout-fix")), body: s.text ?? "", flow: sf.flow.id, path: data.path } });
    prevFailed = fail;
    failed = fail && !sf.flow.steps.slice(i + 1).some((r) => r.when === "failure" || r.when === "always");
    return {
      id: s.id ?? "",
      kind: s.kind,
      status: fail ? "failed" : "succeeded",
      started,
      duration: s.kind === "run" ? `${(Math.random() * 40 + 3).toFixed(1)}s` : "4ms",
      exit_code: fail ? 1 : 0,
      output: s.kind === "run" ? (fail ? `$ ${s.command}\n✗ 2 failing\n  payments › webhook retries without an idempotency key\n  payments › creates one order per event` : `$ ${s.command}\n✓ done`) : undefined,
    };
  });
  const run: FlowRun = { id: `r${Date.now()}`, flow: sf.flow.id, scope: sf.scope, started, finished: new Date().toISOString(), status: failed ? "failed" : "succeeded", event: { type: triggerType(sf.flow.trigger), time: started, box, data }, steps, ...(test && { test }) };
  runs[box] = [run, ...(runs[box] ?? [])];
  emit({ type: "flow.started", box, origin: "app", data: { flow: sf.flow.id } });
  setTimeout(() => emit({ type: "flow.finished", box, data: { flow: sf.flow.id, status: run.status } }), 50);
  return run;
}

function serviceList(box: string, loc: string, wt: string): ServiceStatus[] {
  const key = `${box}/${loc}/${wt}`;
  if (!services[key]) {
    const base = 3100 + Object.keys(services).length * 10;
    services[key] = (merged(box, loc).services ?? []).map((s, i) => ({ ...s, state: s.autostart ? "running" : "stopped", unit: `berth-wt-${loc}-${wt}-${s.name}`, port: base + i }));
  }
  return services[key];
}

// The resource guard, per box: devl starts on and has acted once.
const guards: Record<string, GuardStatus["config"]> = { devl: { enabled: true, memory_percent: 90, sustain: "1m", session_memory_gb: 12 } };

function guardStatus(box: string): GuardStatus {
  const used = box === "devl" ? 0.92 : 0.41;
  const total = 32 * 2 ** 30;
  return {
    config: guards[box] ?? { enabled: false },
    memory: { total, used: Math.round(total * used) },
    memory_percent: used * 100,
    // gpu's older berthd has no session scopes.
    session_scopes: box !== "gpu",
    actions:
      box === "devl"
        ? [{ at: new Date(Date.now() - 18 * 60_000).toISOString(), action: "stop_services", location: "shop", worktree: "search-perf", services: ["web"], memory_percent: 93, reason: "no agent is working there" }]
        : [],
  };
}

// flowsCall answers the box API's flow, config and service routes, or
// returns undefined for anything else.
export function flowsCall(box: string, method: string, path: string, body: unknown, emit: Emit, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  const [route, query = ""] = path.split("?");
  const key = `${method} ${route}`;
  if (key === "GET flows") return delay(listFlows(box));
  if (key === "GET guard") return delay(guardStatus(box));
  if (key === "PUT guard") {
    guards[box] = (body as { config: GuardStatus["config"] }).config;
    return delay(guardStatus(box));
  }
  if (key === "PUT flows") {
    const flows = (body as { flows: Flow[] }).flows;
    const err = validate(flows);
    if (err) return Promise.reject(new Error(err));
    boxFlows[box] = flows;
    setTimeout(() => emit({ type: "flows.changed", box }), 20);
    return delay(listFlows(box));
  }
  if (key === "GET flows/runs") {
    const q = new URLSearchParams(query);
    return delay((runs[box] ?? []).filter((r) => !q.get("flow") || r.flow === q.get("flow")).slice(0, Number(q.get("limit") ?? 50)));
  }
  let m = route.match(/^flows\/([^/]+)\/test$/);
  if (method === "POST" && m) {
    const { scope, data } = body as { scope?: string; data: Record<string, unknown> };
    const sf = listFlows(box).find((f) => f.flow.id === decodeURIComponent(m![1]) && (!scope || f.scope === scope));
    if (!sf) return Promise.reject(new Error("no flow with that id"));
    return new Promise((r) => setTimeout(() => r(simulate(box, sf, data, emit, true)), 900));
  }
  m = route.match(/^locations\/([^/]+)\/config$/);
  if (m) {
    const loc = decodeURIComponent(m[1]);
    if (method === "PUT") {
      const next = (body as { local: RepoConfig }).local;
      const err = validate(next.flows ?? []);
      if (err) return Promise.reject(new Error(err));
      if (next.ports !== undefined && (next.ports < 0 || next.ports > 10)) return Promise.reject(new Error("ports must be between 0 and 10"));
      local[box] = { ...local[box], [loc]: next };
      setTimeout(() => emit({ type: "config.changed", box, data: { location: loc } }), 20);
    }
    const cfg: LocationConfig = { repo: committed[box]?.[loc] ?? null, repo_path: `/home/me/work/${loc}/.berth/config.json`, kit: kitOn(box, loc), local: local[box]?.[loc] ?? {}, effective: merged(box, loc) };
    return delay(cfg);
  }
  m = route.match(/^locations\/([^/]+)\/worktrees\/([^/]+)\/services(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (m) {
    const [loc, wt, svc, action] = [m[1], m[2], m[3], m[4]].map((x) => x && decodeURIComponent(x));
    const list = serviceList(box, loc!, wt!);
    // A service in a terminal is as its session is (lib/mock-services).
    const live = (s: ServiceStatus, run?: boolean) => {
      if (!s.terminal) return s;
      const t = mockTerminalService(box, loc!, wt!, s, run);
      return { ...s, session: t.session, state: t.running ? "running" : "stopped" };
    };
    if (!svc) return delay(list.map((s) => live(s)));
    const s = list.find((x) => x.name === svc);
    if (!s) return Promise.reject(new Error(`no service ${svc}`));
    if (action === "log") return delay(`$ ${s.run}\n  ▲ Next.js 15.3.0\n  - Local: http://localhost:${s.port}\n ✓ Ready in 2.1s\n`);
    s.state = action === "stop" ? "stopped" : "running";
    if (s.terminal) {
      const next = live(s, action !== "stop");
      setTimeout(() => emit({ type: action === "stop" ? "service.stopped" : "service.started", box, data: { location: loc, name: wt, path: mockWorktreePath(box, loc!, wt!), service: s.name, session: next.session } }), 30);
      return delay(next);
    }
    return delay(s);
  }
  return undefined;
}
