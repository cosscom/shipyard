import type { Location } from "@berth/plugin";

import type { Account, Agent, Limits, Report, Tokens, UsageSession } from "./box";

export type Period = 1 | 7 | 30;

export const AGENT_NAME: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };

export const total = (t: Tokens) => t[0] + t[1] + t[2] + t[3];

const add = (a: Tokens, b: readonly number[]): Tokens => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const zero = (): Tokens => [0, 0, 0, 0];

// firstDay is the earliest box-local day in a period ending today.
export function firstDay(today: string, period: Period): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (period - 1));
  return d.toISOString().slice(0, 10);
}

// days lists every box-local day of a period, oldest first.
export function days(today: string, period: Period): string[] {
  const out: string[] = [];
  const start = new Date(firstDay(today, period) + "T00:00:00Z");
  for (let i = 0; i < period; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface WorktreeName {
  label: string;
  location?: string;
  worktree?: string;
  path?: string;
  main?: boolean;
}

// worktreeOf names the deepest worktree containing dir, or the folder.
export function worktreeOf(dir: string | null, locations: Location[]): WorktreeName {
  if (!dir) return { label: "Unknown folder" };
  let best: WorktreeName | undefined;
  let depth = -1;
  for (const l of locations) {
    for (const w of l.worktrees ?? []) {
      if ((dir === w.path || dir.startsWith(w.path + "/")) && w.path.length > depth) {
        depth = w.path.length;
        best = { label: w.main ? l.name : `${l.name}/${w.name}`, location: l.name, worktree: w.name, path: w.path, main: w.main };
      }
    }
  }
  return best ?? { label: dir.replace(/^\/(home|Users)\/[^/]+/, "~") };
}

// A box's answer, with what the summary needs to name its folders.
export interface Source {
  box: string;
  report: Report;
  locations: Location[];
}

export interface BoxSession extends UsageSession {
  box: string;
}

export interface Summary {
  byAgent: Map<Agent, Tokens>;
  // Each agent's tokens on each box.
  byAgentBox: Map<Agent, Map<string, number>>;
  byModel: { agent: Agent; model: string; box: string; tokens: Tokens }[];
  byWorktree: { box: string; name: WorktreeName; tokens: Tokens; sessions: number }[];
  // Tokens per day, by agent and by box.
  byDay: Map<string, Map<Agent, number>>;
  byDayBox: Map<string, Map<string, number>>;
  sessions: BoxSession[];
  // The latest box-local day among the boxes: the chart ends there.
  today: string;
}

// summarize adds up the boxes' reports over a period. Each box's period
// ends on its own today, in its own time zone.
export function summarize(sources: Source[], period: Period): Summary {
  const byAgent = new Map<Agent, Tokens>();
  const byAgentBox = new Map<Agent, Map<string, number>>();
  const byModel = new Map<string, { agent: Agent; model: string; box: string; tokens: Tokens }>();
  const byWorktree = new Map<string, { box: string; name: WorktreeName; tokens: Tokens; sessions: number }>();
  const byDay = new Map<string, Map<Agent, number>>();
  const byDayBox = new Map<string, Map<string, number>>();
  const sessions: BoxSession[] = [];
  let today = "";
  const bump = <K>(m: Map<string, Map<K, number>>, day: string, k: K, n: number) => {
    const d = m.get(day) ?? new Map<K, number>();
    d.set(k, (d.get(k) ?? 0) + n);
    m.set(day, d);
  };
  for (const { box, report: r, locations } of sources) {
    if (r.today > today) today = r.today;
    const from = firstDay(r.today, period);
    for (const [day, agent, , model, cwd, ...t] of r.daily) {
      if (day < from) continue;
      const n = t[0] + t[1] + t[2] + t[3];
      byAgent.set(agent, add(byAgent.get(agent) ?? zero(), t));
      const ab = byAgentBox.get(agent) ?? new Map<string, number>();
      ab.set(box, (ab.get(box) ?? 0) + n);
      byAgentBox.set(agent, ab);
      const mk = `${agent}\u0000${model}\u0000${box}`;
      const m = byModel.get(mk) ?? { agent, model, box, tokens: zero() };
      m.tokens = add(m.tokens, t);
      byModel.set(mk, m);
      const name = worktreeOf(cwd, locations);
      const wk = `${box}\u0000${name.label}`;
      const w = byWorktree.get(wk) ?? { box, name, tokens: zero(), sessions: 0 };
      w.tokens = add(w.tokens, t);
      byWorktree.set(wk, w);
      bump(byDay, day, agent, n);
      bump(byDayBox, day, box, n);
    }
    for (const s of r.sessions) {
      if ((s.last ?? "") < from) continue;
      sessions.push({ ...s, box });
      const w = byWorktree.get(`${box}\u0000${worktreeOf(s.cwd, locations).label}`);
      if (w) w.sessions++;
    }
  }
  return {
    byAgent,
    byAgentBox,
    byModel: [...byModel.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
    byWorktree: [...byWorktree.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
    byDay,
    byDayBox,
    sessions: sessions.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")),
    today,
  };
}

// compact writes a token count the way people read them: 2.2B, 14.3M, 980K.
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

export const usd = (n: number) => (n < 0.01 ? "<$0.01" : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// plan describes an account's plan in words, from what the agent recorded.
export function plan(a: Account | undefined): { label: string; subscription: boolean } | undefined {
  if (!a) return undefined;
  if (a.agent === "claude") {
    // A team or enterprise seat records a Max-like tier of its own
    // (default_claude_max_5x): its organization says what the plan is.
    if (a.org_type === "claude_team" || a.org_type === "claude_enterprise") {
      return { label: a.org_type === "claude_team" ? "Claude Team" : "Claude Enterprise", subscription: true };
    }
    const t = (a.tier ?? "").toLowerCase();
    const max = /max_(\d+)x/.exec(t);
    const label = max ? `Claude Max ${max[1]}x` : t.includes("pro") ? "Claude Pro" : a.billing === "stripe_subscription" ? "Claude subscription" : a.billing ? a.billing.replace(/_/g, " ") : "Claude";
    return { label, subscription: a.billing === "stripe_subscription" || Boolean(max) };
  }
  if (a.method === "api key") return { label: "OpenAI API key", subscription: false };
  return a.plan ? { label: `ChatGPT ${a.plan.charAt(0).toUpperCase()}${a.plan.slice(1)}`, subscription: true } : undefined;
}

// login is one login across boxes: its email and organisation (one email
// can sign in to a team seat and a personal plan), or the account on its box
// when it has no email.
const login = (agent: Agent | undefined, email: string | null | undefined, org: string | null | undefined, box: string, id: string) =>
  email ? `${agent}:${email}${org ? `#${org}` : ""}` : `${box}:${agent}:${id}`;

// identity is login for an account a box listed.
export const identity = (a: Account | undefined, box: string, id: string) => login(a?.agent, a?.email, a?.org_id, box, id);

export interface SharedLimits {
  // Which login it is, unique among them.
  key: string;
  label?: string;
  boxes: string[];
  limits: Limits;
}

// dedupeLimits keeps the newest limits each login reported.
// Limits read before the period are left out, as its tokens are.
export function dedupeLimits(agent: Agent, sources: Source[], accounts: Record<string, Account[] | undefined>, period: Period): SharedLimits[] {
  const out = new Map<string, SharedLimits>();
  for (const { box, report } of sources) {
    const from = firstDay(report.today, period);
    for (const l of report.limits.filter((x) => x.agent === agent && x.at.slice(0, 10) >= from)) {
      const a = accounts[box]?.find((x) => x.agent === agent && x.id === l.account);
      // Who it is: the box's account, or what the report says when the box
      // listed no accounts.
      const email = a?.email ?? l.email;
      const k = login(agent, email, a?.org_id ?? l.org, box, l.account);
      const label = email ?? (l.account === "default" ? box : `${box} · ${l.account}`);
      const seen = out.get(k);
      if (!seen) out.set(k, { key: k, label, boxes: [box], limits: l });
      else {
        seen.boxes.push(box);
        if (l.at > seen.limits.at) seen.limits = l;
      }
    }
  }
  const list = [...out.values()];
  // Two plans of one email are named by their account too, and by their
  // boxes when that is the same as well (each box's "default").
  const twins = () => list.filter((s) => list.some((o) => o !== s && o.label === s.label));
  for (const s of twins()) s.label = `${s.label} · ${s.limits.account}`;
  for (const s of twins()) s.label = `${s.label} (${s.boxes.join(", ")})`;
  // One login needs no name.
  if (list.length === 1) list[0].label = undefined;
  return list;
}
