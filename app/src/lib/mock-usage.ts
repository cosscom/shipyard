import type { ExecResult } from "@/lib/api";

// The Usage & accounts plugin's box side in ?mock=1: the box env
// (GET/PUT env) and usage.py's report, accounts and mkaccount, answered
// with made-up numbers so the screens can be explored.

const env: Record<string, Record<string, string>> = { devl: {} };
const HOME = "/home/me";

interface MockAccount {
  agent: "claude" | "codex";
  id: string;
  dir: string;
  exists: boolean;
  signed_in: boolean;
  [k: string]: unknown;
}

const accounts: Record<string, MockAccount[]> = {};
// devl has a second login per agent; other boxes sign in with the same
// default logins, so the screen counts those once.
const accountsOf = (box: string) =>
  (accounts[box] ??= (
    [
    { agent: "claude", id: "default", dir: `${HOME}/.claude`, exists: true, signed_in: true, email: "you@example.com", name: "You", org: null, billing: "stripe_subscription", tier: "default_claude_max_20x" },
    { agent: "claude", id: "work", dir: `${HOME}/.berth/accounts/claude/work`, exists: true, signed_in: true, email: "you@work.example", name: "You", org: "Work", billing: "stripe_subscription", tier: "default_claude_max_5x" },
    { agent: "codex", id: "default", dir: `${HOME}/.codex`, exists: true, signed_in: true, method: "chatgpt", email: "you@example.com", plan: "pro" },
    { agent: "codex", id: "api", dir: `${HOME}/.berth/accounts/codex/api`, exists: true, signed_in: true, method: "api key", email: null, plan: null },
    ] as MockAccount[]
  ).filter((a) => box === "devl" || a.id === "default"));

export function usageCall(box: string, method: string, path: string, body: unknown, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  if (path !== "env") return undefined;
  if (method === "PUT") env[box] = { ...((body as { env?: Record<string, string> })?.env ?? {}) };
  return delay({ path: `${HOME}/.berth/env.json`, env: env[box] ?? {} });
}

// usageExec answers `python3 -c "…usage.py…"` from the plugin's runScript.
export function usageExec(box: string, command: string): ExecResult | undefined {
  const argv = /sys\.argv=json\.loads\('([^']*)'\)/.exec(command)?.[1];
  if (!argv || !command.includes("usage.py")) return undefined;
  const args = JSON.parse(argv.replace(/\\"/g, '"')) as string[];
  const out = (v: unknown) => ({ exit_code: 0, output: JSON.stringify(v) + "\n" });
  if (args[1] === "accounts") {
    return out({
      accounts: accountsOf(box),
      home: HOME,
      sessions: {
        "checkout-fix-claude": { CLAUDE_CONFIG_DIR: `${HOME}/.berth/accounts/claude/work` },
        "qa-deck-codex": {},
        "search-perf-claude": {},
        "judge-v2-claude": {},
        "evals-codex": { CODEX_HOME: `${HOME}/.berth/accounts/codex/api` },
      },
    });
  }
  if (args[1] === "mkaccount") {
    const [agent, name] = [args[2] as "claude" | "codex", args[3]];
    const dir = `${HOME}/.berth/accounts/${agent}/${name}`;
    if (!accountsOf(box).some((a) => a.agent === agent && a.id === name)) accountsOf(box).push({ agent, id: name, dir, exists: true, signed_in: false });
    return out({ agent, id: name, dir });
  }
  if (args[1] === "report") return out(report(box));
  return { exit_code: 2, output: "usage: report|accounts|mkaccount\n" };
}

// A small seeded generator, so the mock reads the same on every load.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function report(box: string) {
  const r = rng(box.length * 7919);
  const now = new Date();
  const gpu = box !== "devl";
  const WT = gpu ? [`${HOME}/evals-judge-v2`, `${HOME}/evals`, `${HOME}/scratch`] : [`${HOME}/work/shop-checkout-fix`, `${HOME}/work/shop-qa-deck`, `${HOME}/work/shop-search-perf`, `${HOME}/work/shop`, `${HOME}/work/notes`, `${HOME}/scratch`];
  const daily: unknown[][] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = iso(d);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const busy = (weekend ? 0.25 : 0.6 + r()) * (gpu ? 0.35 : 1);
    const rows: [string, string, string, number][] = [
      ["claude", "default", "claude-opus-5-5", 1],
      ["claude", gpu ? "default" : "work", "claude-sonnet-5-5", 0.5],
      ["claude", "default", "claude-haiku-4-5-20251001", 0.08],
      ["codex", "default", "gpt-5.5-codex", 0.45],
    ];
    for (const [agent, account, model, weight] of rows) {
      if (r() > 0.85) continue;
      const cwd = WT[Math.floor(r() * WT.length)];
      const scale = busy * weight;
      const cacheRead = Math.round(scale * (18e6 + r() * 30e6));
      daily.push([day, agent, account, model, cwd, Math.round(scale * (20e3 + r() * 90e3)), Math.round(scale * (90e3 + r() * 260e3)), agent === "codex" ? Math.round(cacheRead * 0.4) : cacheRead, agent === "codex" ? 0 : Math.round(scale * (0.6e6 + r() * 1.8e6))]);
    }
  }
  const at = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
  const s = (agent: string, account: string, cwd: string, title: string | null, h: number, len: number, tokens: number[], cost: number | null, models: string[]) => ({
    agent,
    account,
    id: `${agent === "claude" ? "6f1c" : "0199"}${Math.floor(r() * 1e8).toString(16)}-${(title ?? "").length.toString(16).padStart(4, "0")}-4a2b-9c1d-${Math.floor(r() * 1e12).toString(16).padStart(12, "0")}`,
    cwd,
    title,
    first: at(h + len),
    last: at(h),
    tokens,
    cost,
    models,
  });
  return {
    generated: now.toISOString(),
    days: 30,
    since: iso(new Date(now.getTime() - 29 * 86400e3)),
    today: iso(now),
    tz: "Europe/London",
    partial: false,
    pending: 0,
    files: gpu ? 23 : 84,
    daily,
    sessions: gpu
      ? [
          s("claude", "default", WT[0], "Judge v2 rubric and eval harness", 0.02, 0.3, [12_007, 58_400, 4_112_904, 380_220], 6.11, ["claude-opus-5-5"]),
          s("codex", "default", WT[1], "Sweep the eval seeds", 3, 0.6, [41_200, 22_310, 610_400, 0], null, ["gpt-5.5-codex"]),
          s("claude", "default", WT[2], "Plot judge agreement", 49, 0.4, [8_120, 30_444, 2_204_100, 190_330], 3.02, ["claude-sonnet-5-5"]),
        ]
      : [
      s("claude", "work", WT[0], "Cap payment retries with exponential backoff", 0.1, 1.2, [61_204, 284_113, 21_402_118, 1_204_660], 18.42, ["claude-sonnet-5-5"]),
      s("codex", "default", WT[1], "Build the QA slide deck from the test plan", 0.05, 0.4, [148_220, 92_118, 1_310_720, 0], null, ["gpt-5.5-codex"]),
      s("claude", "default", WT[2], "Profile the search page's first render", 0.6, 2.4, [88_410, 402_877, 38_119_402, 2_008_114], 41.07, ["claude-opus-5-5", "claude-haiku-4-5-20251001"]),
      s("claude", "default", WT[4], "Tidy the internal deploy script", 26, 0.8, [20_118, 77_040, 6_200_400, 512_331], 9.36, ["claude-opus-5-5"]),
      s("codex", "default", WT[3], "Review the webhook handler", 30, 0.5, [64_002, 31_877, 820_224, 0], null, ["gpt-5.5-codex"]),
      s("claude", "work", WT[5], null, 52, 0.2, [3_400, 9_120, 410_022, 88_120], 0.94, ["claude-sonnet-5-5"]),
      s("claude", "default", WT[0], "Reproduce the double-charge bug", 75, 1.6, [40_210, 190_442, 15_002_871, 902_114], 22.6, ["claude-opus-5-5"]),
    ],
    limits: [
      {
        agent: "claude",
        account: "default",
        at: at(0.02),
        limits: {
          primary: { used_percent: 31, window_minutes: 300, resets_at: Math.round(now.getTime() / 1000 + 2 * 3600) },
          secondary: { used_percent: 64, window_minutes: 10080, resets_at: Math.round(now.getTime() / 1000 + 3 * 86400) },
          extra: [{ used_percent: 32, window_minutes: 10080, resets_at: Math.round(now.getTime() / 1000 + 3 * 86400), label: "Weekly limit (Fable)" }],
        },
      },
      {
        agent: "codex",
        account: "default",
        at: at(gpu ? 5 : 0.05),
        limits: {
          plan_type: "pro",
          primary: { used_percent: 34, window_minutes: 300, resets_at: Math.round(now.getTime() / 1000 + 3 * 3600 + 1200) },
          secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.round(now.getTime() / 1000 + 4 * 86400) },
        },
      },
    ],
  };
}
