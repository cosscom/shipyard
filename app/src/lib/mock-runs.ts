import { ApiError, type BerthEvent, type Run, type RunCandidate, type RunStep, type RunSummary, type Session } from "@/lib/api";
import { agentOf } from "@/lib/derive";

// Runs in the demo: the shop world on devl has a loop going, an attempts run
// of three agents waiting for you to pick one in Review's Compare, one whose
// pick's pull request didn't open (retry, or finish without one), one on a
// Gitea repository that finished with its branch pushed and no pull
// request, a flow's run, a review and a finished broadcast. Deciding, cancelling and starting
// runs work, so the loops panel, Automations → Runs, Compare and the phone
// all have something to show. A bulk Stop's stop run plays out against the
// demo's own sessions and worktrees (playStop).

type Emit = (e: Omit<BerthEvent, "time">) => void;

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const step = (path: string, kind: string, status: string, startMin: number, endMin: number | undefined, more: Partial<RunStep> = {}): RunStep => ({
  id: more.id ?? path.split(".").pop()!,
  kind,
  path,
  status,
  started: at(startMin),
  ended: endMin === undefined ? undefined : at(endMin),
  duration: endMin === undefined ? undefined : `${Math.round((startMin - endMin) * 60)}s`,
  exit_code: 0,
  ...more,
});

function candidate(index: number, agent: string, passed: boolean, added: number, removed: number, rank: number, reason: string, summary: string): RunCandidate {
  return {
    index,
    agent,
    location: "shop",
    worktree: `refunds-a${index + 1}`,
    path: `/home/me/work/shop-refunds-a${index + 1}`,
    branch: `refunds-a${index + 1}`,
    session: `refunds-a${index + 1}-${agent}-x7k2-0i${index}0`,
    verify: { passed, rounds: passed ? 1 : 2, exit_code: passed ? 0 : 1, tail: passed ? undefined : "FAIL test/refunds.test.ts > partial refund\n  expected 50 to equal 0" },
    diff: { files: 4 + index, added, removed, commits: index === 1 ? 2 : 1 },
    summary,
    turns: passed ? 1 : 2,
    tokens: { input: 21000 + index * 4000, output: 3400 + index * 500, cache_read: 160000 + index * 20000, usd: 0.41 + index * 0.07 },
    judge: { rank, reason },
  };
}

const attemptsRun = (): Run => ({
  id: "r_mshp7x7k2",
  template: "attempts",
  group: "g_refunds",
  title: "refunds: 3 attempts",
  status: "waiting_gate",
  origin: "laptop:mac",
  cursor: "2.t.0",
  created: at(42),
  updated: at(6),
  usage: { input: 75000, output: 11500, cache_read: 540000, usd: 1.44 },
  params: { location: "shop", name: "refunds", prompt: "Implement partial refunds (see issue 412)." },
  gate: { path: "2.t.0", title: "Pick the best attempt at refunds", text: "Winner: attempt 3. Smallest diff that passes, with a test for the partial case.", pick: true, default: 2 },
  candidates: [
    candidate(0, "claude", false, 182, 31, 3, "its check fails: the partial refund is never recorded", "feat: partial refunds; test: refunds"),
    candidate(1, "codex", true, 141, 22, 2, "passes, but reworks the ledger more than it needs to", "refactor: ledger entries; feat: partial refunds"),
    candidate(2, "claude", true, 74, 9, 1, "passes with the smallest diff and a test for the partial case", "feat: partial refunds with a ledger entry"),
  ],
  steps: [
    step("0", "map", "succeeded", 42, 9, {
      id: "attempts",
      output: "1. attempt 1 (claude): check failed\n2. attempt 2 (codex): check passed\n3. attempt 3 (claude): check passed",
      children: [0, 1, 2].map((i) =>
        step(`0.i${i}`, "item", "", 42, 9 + i, {
          id: `i${i}`,
          children: [
            step(`0.i${i}.0`, "start_agent", "succeeded", 42, 41.8, { id: "start", output: `started refunds-a${i + 1}` }),
            step(`0.i${i}.1`, "wait", "succeeded", 41.8, 20 - i * 3, { id: "work", output: "finished", usage: { input: 18000, output: 3000, cache_read: 150000 } }),
            step(`0.i${i}.2`, "loop", i === 0 ? "failed" : "succeeded", 20 - i * 3, 10 + i, { id: "verify", output: i === 0 ? "" : "done in round 1 of 2", error: i === 0 ? "still not done after 2 rounds" : undefined }),
            step(`0.i${i}.3`, "collect", "succeeded", 10 + i, 9 + i, { id: "collect" }),
          ],
        }),
      ),
    }),
    step("1", "judge", "succeeded", 9, 7, {
      id: "judge",
      output: "Winner: attempt 3. passes with the smallest diff and a test for the partial case",
      children: [step("1.ask", "headless", "succeeded", 9, 7, { id: "judge", output: '{"winner": 3, "ranking": [3, 2, 1]}', usage: { input: 2100, output: 120, usd: 0.02 } })],
    }),
    step("2", "if", "running", 7, undefined, { id: "choose", children: [step("2.t", "then", "", 7, undefined, { children: [step("2.t.0", "gate", "waiting", 7, undefined, { id: "pick", output: "Pick the best attempt at refunds" })] })] }),
  ],
});

const loopRun = (round: number): Run => ({
  id: "r_mshp7l00p",
  template: "loop",
  title: "Loop until pnpm test passes",
  status: "running",
  session: "checkout-fix-claude",
  origin: "laptop:mac",
  cursor: `1.r${round}.1.t.1`,
  created: at(12),
  updated: at(1),
  params: { session: "checkout-fix-claude", check: "pnpm test", max: 5 },
  vars: { session: "checkout-fix-claude" },
  usage: { input: 32000, output: 5100, cache_read: 210000 },
  steps: [
    step("0", "if", "succeeded", 12, 8, { id: "ask", children: [step("0.t", "then", "", 12, 8, { children: [step("0.t.0", "prompt", "succeeded", 12, 12, { id: "first", output: "sent to checkout-fix-claude" }), step("0.t.1", "wait", "succeeded", 12, 8, { id: "first_turn", output: "finished" })] })] }),
    step("1", "loop", "running", 8, undefined, {
      id: "rounds",
      children: [
        step("1.r1", "round", "", 8, 4, {
          id: "r1",
          children: [
            step("1.r1.0", "check", "failed", 8, 7.5, { id: "check", exit_code: 1, output: "FAIL src/cart.test.ts > applies the discount once\n  expected 90 to be 81", error: "exited with 1" }),
            step("1.r1.1", "if", "succeeded", 7.5, 4, { id: "fix" }),
          ],
        }),
        step(`1.r${round}`, "round", "", 4, undefined, { id: `r${round}`, children: [step(`1.r${round}.0`, "check", "failed", 4, 3.6, { id: "check", exit_code: 1, output: "FAIL src/cart.test.ts > rounds totals", error: "exited with 1" })] }),
      ],
    }),
  ],
});

const flowRun = (): Run => ({
  id: "r_mshp7f10w",
  template: "flow",
  flow_id: "check-after-turn",
  scope: "repo:shop",
  title: "Check after each turn",
  status: "succeeded",
  origin: "flow:check-after-turn",
  path: "/home/me/work/shop-qa-deck",
  created: at(25),
  updated: at(24),
  finished: at(24),
  steps: [step("0", "run", "succeeded", 25, 24.5, { id: "test", output: "Tests 48 passed (48)" }), step("1", "prompt", "skipped", 24.5, 24.5, { id: "2" })],
});

const reviewRun = (): Run => ({
  id: "r_mshp7rv1e",
  template: "review",
  title: "Review of qa-deck-codex's work",
  status: "succeeded",
  origin: "laptop:mac",
  created: at(70),
  updated: at(66),
  finished: at(66),
  usage: { input: 9000, output: 400, cache_read: 30000, usd: 0.06 },
  steps: [step("0", "if", "succeeded", 70, 66, { children: [step("0.t", "then", "", 70, 66, { children: [step("0.t.0", "headless", "succeeded", 70, 66, { id: "review", output: "Verdict: fix first.\nsrc/deck.ts:42 - the empty deck throws", usage: { input: 9000, output: 400, cache_read: 30000, usd: 0.06 } })] })] })],
});

// The same task tried on gpu too: a group, compared as one in Review.
const gpuAttempts = (): Run => ({
  id: "r_mgpu4a9z1",
  template: "attempts",
  group: "g_refunds",
  title: "refunds: 1 attempt",
  status: "waiting_gate",
  created: at(41),
  updated: at(8),
  gate: { path: "2.t.0", title: "Pick the best attempt at refunds", pick: true, default: 0 },
  candidates: [{ ...candidate(0, "codex", true, 88, 12, 1, "passes; adds a migration it doesn't need", "feat: partial refunds (with a migration)"), location: "shop", path: "/home/me/shop-refunds-a1" }],
  steps: [step("1", "judge", "succeeded", 10, 8, { id: "judge", output: "Winner: attempt 1. passes; adds a migration it doesn't need" })],
});

// An attempts run's candidate in another task's worktrees.
const renamed = (c: RunCandidate, name: string, picked?: boolean): RunCandidate => {
  const wt = `${name}-a${c.index + 1}`;
  return { ...c, worktree: wt, path: `/home/me/work/shop-${wt}`, branch: wt, session: `${wt}-${c.agent}-x7k2-0i${c.index}0`, picked };
};

// The steps of an attempts run of two that got as far as its pull request.
const pickedSteps = (name: string, start: number, pr: RunStep, tidy?: RunStep): RunStep[] => [
  step("0", "map", "succeeded", start, start - 30, { id: "attempts", output: "1. attempt 1 (claude): check passed\n2. attempt 2 (codex): check passed" }),
  step("1", "judge", "succeeded", start - 30, start - 31, { id: "judge", output: "Winner: attempt 1. passes with the smaller diff" }),
  step("2", "if", "succeeded", start - 31, start - 33, { id: "choose", children: [step("2.t", "then", "", start - 31, start - 33, { children: [step("2.t.0", "gate", "succeeded", start - 31, start - 33, { id: "pick", output: `Pick the best attempt at ${name}` })] })] }),
  step("3", "if", pr.status === "failed" ? "running" : "succeeded", start - 33, pr.status === "failed" ? undefined : start - 34, { id: "pr", children: [step("3.t", "then", "", start - 33, undefined, { children: [pr] })] }),
  ...(tidy ? [tidy] : []),
];

// Picked, but its pull request didn't open (GitHub said no): publishing
// failed, not the agents' work, and it waits to retry or finish without one.
const publishRun = (): Run => ({
  id: "r_mshp9pb4x",
  template: "attempts",
  title: "search: 2 attempts",
  status: "waiting_gate",
  origin: "laptop:mac",
  cursor: "3.t.0",
  created: at(60),
  updated: at(4),
  params: { location: "shop", name: "search", prompt: "Make catalog search fast for 100k products.", then: { pr: { draft: true } } },
  gate: {
    path: "3.t.0.publish1",
    title: "The pull request didn't open",
    text: "The agents' work is done and your pick is kept; only publishing failed: gh pr create failed.\n\nHTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n\nRetry once it's fixed, or finish without a pull request: the run goes on and archives the other attempts.",
    approve_label: "Retry publishing",
    reject_label: "Finish without a pull request",
  },
  candidates: [
    renamed(candidate(0, "claude", true, 64, 12, 1, "passes with the smaller diff", "perf: index the catalog for search"), "search", true),
    renamed(candidate(1, "codex", true, 118, 40, 2, "passes, but caches more than it needs to", "perf: cache search results"), "search"),
  ],
  steps: pickedSteps("search", 60, step("3.t.0", "pr", "failed", 26, 25.9, { id: "open", attempt: 1, exit_code: 1, error: "gh pr create failed", output: "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login" })),
});

// Picked on a repository hosted on Gitea: gh can't open a pull request
// there, so the branch is pushed, the step says so, and the run finished.
const giteaRun = (): Run => ({
  id: "r_mshp9gt3a",
  template: "attempts",
  title: "invoices: 2 attempts",
  status: "succeeded",
  origin: "laptop:mac",
  created: at(150),
  updated: at(110),
  finished: at(110),
  params: { location: "shop", name: "invoices", prompt: "Add PDF invoices.", then: { pr: { draft: true } } },
  candidates: [
    renamed(candidate(0, "claude", true, 88, 6, 1, "passes with a test for the PDF", "feat: PDF invoices"), "invoices", true),
    renamed(candidate(1, "codex", false, 140, 20, 2, "its check fails on the totals", "feat: invoices as PDF"), "invoices"),
  ],
  steps: pickedSteps(
    "invoices",
    150,
    step("3.t.0", "pr", "skipped", 116, 115.9, {
      id: "open",
      output:
        "This repository is on git.acme.dev, not GitHub, so Shipyard didn't open a pull request. The branch invoices-a1 is pushed to origin; open one there: https://git.acme.dev/acme/shop/compare/main...invoices-a1. (If git.acme.dev is GitHub Enterprise, run \"gh auth login --hostname git.acme.dev\" on this box.)",
    }),
    step("4", "if", "succeeded", 115.9, 110, { id: "tidy", children: [step("4.t", "then", "", 115.9, 110, { children: [step("4.t.0", "cleanup", "succeeded", 115.9, 110, { id: "archive", output: "archived invoices-a2" })] })] }),
  ),
});

let gpuRuns: Run[] | undefined;
let runs: Run[] | undefined;
let round = 2;

function world(): Run[] {
  if (!runs) runs = [attemptsRun(), publishRun(), loopRun(round), flowRun(), reviewRun(), giteaRun()];
  return runs;
}

const summary = (r: Run): RunSummary => ({ ...r, steps: r.steps.length, candidates: r.candidates?.length });

// Act calls the mock box's own routes, as a run's steps do on a real one.
type Act = (method: string, path: string) => Promise<unknown>;

// Each box archives one worktree at a time across its stop runs, as a box
// does (archiveTurn in internal/box/api.go): archiveTurn answers with the
// release once it's this one's turn.
const archiveLines = new Map<string, Promise<void>>();
function archiveTurn(box: string): Promise<() => void> {
  const before = archiveLines.get(box) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((done) => (release = done));
  archiveLines.set(
    box,
    before.then(() => mine),
  );
  return before.then(() => release);
}

// playStop plays a stop run out as the box does (internal/box/runstop.go):
// the sessions stopped three at a time, then each worktree archived where
// it's safe, one at a time and in the box's line, through the mock's own
// routes. Cancelled, it finishes the step in flight and starts no more.
async function playStop(r: Run, box: string, act: Act, emit: Emit) {
  const p = r.params as { sessions: string[]; worktrees: { location: string; name: string; path: string; sessions: string[] }[] };
  const stops: RunStep[] = [];
  const archives: RunStep[] = [];
  const show = () =>
    Object.assign(r, {
      updated: new Date().toISOString(),
      steps: [{ id: "stop", path: "0", kind: "map", status: "running", exit_code: 0, children: stops }, ...(archives.length ? [{ id: "archive", path: "1", kind: "map", status: "running", exit_code: 0, children: archives }] : [])],
    });
  const put = (list: RunStep[], k: number, path: string, kind: string, status: string, more: Partial<RunStep> = {}) => {
    const leaf: RunStep = { id: kind === "stop_session" ? "session" : "worktree", path, kind, status, exit_code: 0, ...more };
    list[k] = { id: `i${k}`, path: path.slice(0, -2), kind: "item", status, exit_code: 0, children: [leaf] };
    show();
  };
  const over = () => stopping.has(r.id);
  const queue = p.sessions.map((s, k) => [s, k] as const);
  const worker = async () => {
    for (let next = queue.shift(); next && !over(); next = queue.shift()) {
      const [s, k] = next;
      put(stops, k, `0.i${k}.0`, "stop_session", "running");
      try {
        await act("DELETE", `sessions/${encodeURIComponent(s)}`);
        put(stops, k, `0.i${k}.0`, "stop_session", "succeeded", { output: "stopped" });
      } catch (err) {
        put(stops, k, `0.i${k}.0`, "stop_session", "failed", { error: (err as Error).message, exit_code: 1 });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const [j, w] of p.worktrees.entries()) {
    if (over()) break;
    const at = `1.i${j}.0`;
    put(archives, j, at, "archive_worktree", "running");
    const release = await archiveTurn(box);
    try {
      if (over()) {
        put(archives, j, at, "archive_worktree", "cancelled");
        break;
      }
      await archiveOne(j, at, w);
    } finally {
      release();
    }
  }
  async function archiveOne(j: number, at: string, w: (typeof p.worktrees)[number]) {
    let live: Session[];
    try {
      live = ((await act("GET", "sessions")) as Session[]).filter((s) => !s.exited && agentOf(s) && (s.dir === w.path || s.dir.startsWith(`${w.path}/`)));
    } catch (err) {
      put(archives, j, at, "archive_worktree", "failed", { error: (err as Error).message, exit_code: 1 });
      return;
    }
    if (live.length) {
      put(archives, j, at, "archive_worktree", "skipped", { output: live.some((s) => p.sessions.includes(s.name)) ? "Kept: an agent there didn't stop" : "Kept: another agent is still running there" });
      return;
    }
    try {
      const res = (await act("DELETE", `locations/${encodeURIComponent(w.location)}/worktrees/${encodeURIComponent(w.name)}`)) as { archive?: string };
      // The box waits for the archive script, then says it's gone.
      if (res?.archive) await new Promise((ok) => setTimeout(ok, 1600));
      put(archives, j, at, "archive_worktree", "succeeded", { output: "Archived; its branch is kept" });
    } catch (err) {
      const msg = (err as Error).message;
      if (/modified or untracked/.test(msg)) put(archives, j, at, "archive_worktree", "skipped", { output: "Kept: uncommitted changes" });
      else if (/no worktree/.test(msg)) put(archives, j, at, "archive_worktree", "succeeded", { output: "already gone" });
      else put(archives, j, at, "archive_worktree", "failed", { error: msg, exit_code: 1 });
    }
  }
  const failed = stops.some((s) => s.status === "failed") || archives.some((s) => s.status === "failed");
  const status = over() ? "cancelled" : failed ? "failed" : "succeeded";
  // Its maps end too, as the box's do, so the run's timeline shows none
  // still running.
  const mapStatus = (items: RunStep[]) => (over() ? "cancelled" : items.some((c) => c.status === "failed") ? "failed" : "succeeded");
  Object.assign(r, {
    status,
    error: status === "succeeded" ? undefined : status === "cancelled" ? "cancelled" : "a step failed",
    finished: new Date().toISOString(),
    updated: new Date().toISOString(),
    steps: r.steps.map((s) => ({ ...s, status: mapStatus(s.path === "0" ? stops : archives) })),
  });
  emit({ type: "run.finished", box, data: { run: r.id, status } });
}

// The stop runs asked to stop: they end once the step in flight has.
const stopping = new Set<string>();
// The Idempotency-Key each run was started under, by run.
const idemKeys = new Map<string, string>();

export function runsCall(box: string, method: string, path: string, body: unknown, emit: Emit, delay: <T>(v: T) => Promise<T>, act?: Act): Promise<unknown> | undefined {
  if (box !== "devl" && box !== "gpu") {
    if (method === "GET" && path.startsWith("runs")) return delay(path.startsWith("runs?") ? [] : undefined);
    if (method === "GET" && path === "autofix") return delay([]);
    return undefined;
  }
  if (box === "gpu" && !gpuRuns) gpuRuns = [gpuAttempts()];
  const all = box === "gpu" ? gpuRuns! : world();
  if (method === "GET" && path.startsWith("runs?")) {
    const q = new URLSearchParams(path.split("?")[1]);
    const t = q.get("template");
    const g = q.get("group");
    return delay(all.filter((r) => (!t || r.template === t) && (!g || r.group === g)).map(summary));
  }
  if (method === "GET" && path === "runs/templates") return delay([]);
  let m = /^runs\/([^/?]+)$/.exec(path);
  if (method === "GET" && m) {
    const r = all.find((x) => x.id === decodeURIComponent(m![1]));
    if (r?.template === "loop" && r.status === "running") {
      // The loop moves on in the demo, a round a minute.
      round = Math.min(4, 2 + Math.floor((Date.now() / 60_000) % 3));
      Object.assign(r, loopRun(round));
    }
    return r ? delay(r) : Promise.reject(new ApiError("no run with that id", 404));
  }
  m = /^runs\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && m) {
    const r = all.find((x) => x.id === m![1]);
    if (r?.template === "stop" && r.status === "running") {
      stopping.add(r.id);
      return delay({ cancelled: m[1] });
    }
    if (r) Object.assign(r, { status: "cancelled", finished: new Date().toISOString(), error: "cancelled", gate: undefined });
    emit({ type: "run.finished", box, data: { run: m[1], status: "cancelled" } });
    return delay({ cancelled: m[1] });
  }
  m = /^runs\/([^/]+)\/gates\/([^/]+)\/decide$/.exec(path);
  if (method === "POST" && m) {
    const r = all.find((x) => x.id === m![1]);
    const d = body as { approve: boolean; pick?: number };
    if (!r?.gate) return Promise.reject(new ApiError("that run is not waiting at a gate", 409));
    if (r.gate.approve_label) {
      // The publish gate: a retry opens it this time; finishing without
      // one is a skip. Either way the run archives the rest and is done.
      const pr = r.steps.find((s) => s.kind === "if" && s.id === "pr")?.children?.[0]?.children?.[0];
      if (pr)
        Object.assign(
          pr,
          d.approve
            ? { status: "succeeded", attempt: 2, error: undefined, output: "https://github.com/acme/shop/pull/318", ended: new Date().toISOString() }
            : { status: "skipped", error: undefined, output: "Finished without a pull request (gh pr create failed).", ended: new Date().toISOString() },
        );
      const loser = r.candidates?.find((c) => !c.picked)?.worktree;
      r.steps.push(step("4", "if", "succeeded", 0, 0, { id: "tidy", children: [step("4.t", "then", "", 0, 0, { children: [step("4.t.0", "cleanup", "succeeded", 0, 0, { id: "archive", output: `archived ${loser}` })] })] }));
      Object.assign(r, { status: "succeeded", finished: new Date().toISOString(), updated: new Date().toISOString(), gate: undefined });
      emit({ type: "run.finished", box, data: { run: r.id, status: r.status } });
      return delay({ decided: r.id, approve: d.approve });
    }
    const pick = d.pick ?? r.gate.default ?? 0;
    for (const c of r.candidates ?? []) c.picked = d.approve && c.index === pick;
    Object.assign(r, { status: d.approve ? "succeeded" : "failed", finished: new Date().toISOString(), gate: undefined, error: d.approve ? undefined : "rejected" });
    emit({ type: "run.finished", box, data: { run: r.id, status: r.status } });
    return delay({ decided: r.id, approve: d.approve });
  }
  if (method === "POST" && path === "runs") {
    const req = body as { template?: string; title?: string; group?: string; params?: Record<string, unknown>; idem_key?: string };
    // Asked again under the same key, the box answers with the run it has.
    const had = req.idem_key ? all.find((x) => idemKeys.get(x.id) === req.idem_key) : undefined;
    if (had) return delay(summary(had));
    const r: Run = { id: `r_mdemo${Math.random().toString(36).slice(2, 7)}`, template: req.template ?? "flow", title: req.title ?? `${req.template} run`, status: "running", created: new Date().toISOString(), updated: new Date().toISOString(), group: req.group, params: req.params, steps: [] };
    if (req.idem_key) idemKeys.set(r.id, req.idem_key);
    all.unshift(r);
    emit({ type: "run.created", box, data: { run: r.id, template: r.template, status: "running" } });
    // A broadcast plays out: each prompt typed in, then, if asked, each
    // turn ending, so the composer's results show it going.
    if (r.template === "broadcast") {
      const sessions = (req.params?.sessions as { session: string }[] | undefined) ?? [];
      const wait = !!req.params?.wait;
      const step = (id: string, kind: string, status: string, output?: string): RunStep => ({ id, kind, path: id, status, output, exit_code: 0 });
      const steps = (sent: boolean, done: boolean): RunStep[] => [
        {
          ...step("0", "map", done ? "succeeded" : "running"),
          children: sessions.map((_, k) => ({
            ...step(`0.i${k}`, "item", done ? "succeeded" : "running"),
            children: [step(`0.i${k}.0`, "prompt", sent ? "succeeded" : "running"), ...(wait ? [step(`0.i${k}.1`, "wait", done ? "succeeded" : "running", done ? "finished" : undefined)] : [])],
          })),
        },
      ];
      r.steps = steps(false, false);
      setTimeout(() => Object.assign(r, { steps: steps(true, false), updated: new Date().toISOString() }), 900);
      setTimeout(
        () => {
          Object.assign(r, { steps: steps(true, true), status: "succeeded", updated: new Date().toISOString(), finished: new Date().toISOString() });
          emit({ type: "run.finished", box, data: { run: r.id, status: r.status } });
        },
        wait ? 4200 : 1400,
      );
    }
    if (r.template === "stop" && act) void playStop(r, box, act, emit);
    return delay(summary(r));
  }
  if (method === "GET" && path.startsWith("review?run=")) {
    const r = all.find((x) => x.id === decodeURIComponent(path.slice("review?run=".length)));
    if (!r) return Promise.reject(new ApiError("no run with that id", 404));
    const files = (c: RunCandidate) => [
      { path: "src/refunds/partial.ts", code: "A", added: Math.round(c.diff.added * 0.55), removed: 0 },
      { path: "src/ledger/entry.ts", code: "M", added: Math.round(c.diff.added * 0.2), removed: Math.round(c.diff.removed * 0.6) },
      { path: "test/refunds.test.ts", code: "M", added: Math.round(c.diff.added * 0.25), removed: Math.round(c.diff.removed * 0.4) },
    ];
    const pr = r.steps.find((s) => s.kind === "if" && s.id === "pr")?.children?.[0]?.children?.[0];
    return delay({ run: summary(r), gate: r.gate, judge: r.steps.find((s) => s.kind === "judge")?.output, pr, candidates: (r.candidates ?? []).map((c) => ({ ...c, review: { files: files(c) } })) });
  }
  if (method === "GET" && path === "autofix") return delay([{ path: "/home/me/work/shop-checkout-fix", ci: true, review: false, max: 3 }]);
  if (method === "PUT" && path === "autofix") return delay([body]);
  return undefined;
}
