import { type HomeWidgetProps, useBoxes, useWidgetData } from "@berth/plugin";
import { Tip, WidgetEmpty, WidgetSkeleton, cn } from "@berth/plugin/ui";

import { type Agent, type Report, runScript, where, type Window } from "./box";
import { AGENT_NAME, compact, days, usd } from "./data";

// The Usage widget on Home: tokens your agents used today and each day of
// the week, what Claude Code estimates they cost, and how much of a plan's
// window Codex last saw used. usage.py reads the agents' own records on
// each box, every 5 minutes while the widget is on screen.

export interface UsageSummary {
  today: number;
  // Tokens a day, the last 7 days, oldest first.
  week: { day: string; tokens: number }[];
  // Claude Code's own estimate at API prices, for sessions active this week.
  cost: number;
  byAgent: { agent: Agent; tokens: number }[];
  limits: { label: string; used: number; resets: number }[];
  failed: string[];
}

const windowName = (w: Window) => {
  const h = w.window_minutes / 60;
  return h >= 24 * 6 ? "week" : h >= 20 ? "day" : `${h}h`;
};

// summarizeUsage adds up the boxes' reports for the widget.
export function summarizeUsage(reports: { box: string; report: Report }[], failed: string[] = []): UsageSummary {
  const today = reports.reduce((t, r) => (r.report.today > t ? r.report.today : t), "");
  const week = today ? days(today, 7).map((day) => ({ day, tokens: 0 })) : [];
  const at = new Map(week.map((d) => [d.day, d]));
  const agents = new Map<Agent, number>();
  let cost = 0;
  const limits: UsageSummary["limits"] = [];
  for (const { report } of reports) {
    for (const [day, agent, , , , ...t] of report.daily) {
      const n = t[0] + t[1] + t[2] + t[3];
      const d = at.get(day);
      if (!d) continue;
      d.tokens += n;
      agents.set(agent, (agents.get(agent) ?? 0) + n);
    }
    const from = week[0]?.day ?? "";
    for (const s of report.sessions) if ((s.last ?? "") >= from && s.cost) cost += s.cost;
    // The newest limits each login reported this week.
    const newest = new Map<string, (typeof report.limits)[number]>();
    for (const l of report.limits) {
      if (l.at.slice(0, 10) < from) continue;
      const k = `${l.agent}/${l.account}`;
      if (!newest.has(k) || newest.get(k)!.at < l.at) newest.set(k, l);
    }
    for (const l of newest.values())
      for (const w of [l.limits.primary, l.limits.secondary, ...(l.limits.extra ?? [])]) if (w?.resets_at) limits.push({ label: `${AGENT_NAME[l.agent]} · ${w.label ?? windowName(w)}`, used: w.used_percent / 100, resets: w.resets_at * 1000 });
  }
  return {
    today: at.get(today)?.tokens ?? 0,
    week,
    cost,
    byAgent: [...agents.entries()].map(([agent, tokens]) => ({ agent, tokens })).sort((a, b) => b.tokens - a.tokens),
    limits: limits.filter((l) => l.resets > Date.now()).sort((a, b) => b.used - a.used),
    failed,
  };
}

export function UsageWidget({ berth, size }: HomeWidgetProps) {
  const online = useBoxes()
    .filter((b) => b.state === "online")
    .map((b) => b.name);
  const { data, error, loading } = useWidgetData<UsageSummary>(
    `usage:${online.join(",")}`,
    async () => {
      const failed: string[] = [];
      const got = await Promise.all(
        online.map(async (box) => {
          try {
            return { box, report: await runScript<Report>(berth, box, await where(berth, box), ["report", "7"], "2m") };
          } catch {
            failed.push(box);
            return undefined;
          }
        }),
      );
      const reports = got.filter((r): r is { box: string; report: Report } => !!r);
      if (!reports.length && failed.length) throw new Error(`Couldn't read usage on ${failed.join(", ")}`);
      return summarizeUsage(reports, failed);
    },
    { every: 5 * 60_000 },
  );
  const big = size === "l" || size === "t";
  if (!online.length) return <WidgetEmpty scene="offline" title="No box is online" hint="Usage is read from the agents' records on each box." />;
  if (!data && loading) return <WidgetSkeleton rows={3} />;
  if (!data) return <WidgetEmpty scene="storm" title="Couldn't read usage" hint={error} compact />;
  const max = Math.max(1, ...data.week.map((d) => d.tokens));
  const total = data.week.reduce((n, d) => n + d.tokens, 0);
  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-1">
      <div className="flex items-baseline gap-2">
        <span className="font-heading font-semibold text-2xl tabular-nums tracking-tight">{compact(data.today)}</span>
        <span className="min-w-0 truncate text-muted-foreground text-xs">tokens today</span>
        {data.cost > 0 && (
          <Tip label="Claude Code's own estimate at API prices, for sessions active this week. A subscription isn't billed this way.">
            <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">≈ {usd(data.cost)} this week</span>
          </Tip>
        )}
      </div>
      <div className={cn("flex items-end gap-[2px]", big ? "h-16" : "h-8")} role="list" aria-label={`Tokens a day this week, ${compact(total)} in all`}>
        {data.week.map((d, i) => (
          <Tip key={d.day} label={`${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${compact(d.tokens)} tokens`}>
            <span role="listitem" aria-label={`${d.day}: ${d.tokens} tokens`} className="flex h-full flex-1 items-end">
              <span className={cn("block w-full rounded-t-[4px] rounded-b-[1px]", d.tokens ? (i === data.week.length - 1 ? "bg-info" : "bg-info/60") : "bg-muted")} style={{ height: d.tokens ? `${Math.max(8, (d.tokens / max) * 100)}%` : 2 }} />
            </span>
          </Tip>
        ))}
      </div>
      {data.limits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {data.limits.slice(0, big ? 4 : 1).map((l) => (
            <div key={l.label} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate">{l.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(l.used * 100)}%</span>
              </span>
              <span className="block h-1 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={Math.round(l.used * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={l.label}>
                <span className={cn("block h-full rounded-full", l.used >= 0.9 ? "bg-destructive" : l.used >= 0.7 ? "bg-warning" : "bg-foreground/45")} style={{ width: `${Math.min(100, l.used * 100)}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {size !== "s" && (
        <p className="truncate text-[11px] text-muted-foreground">
          This week: {data.byAgent.map((a) => `${AGENT_NAME[a.agent]} ${compact(a.tokens)}`).join(" · ") || "no tokens yet"}
        </p>
      )}
      {data.failed.length > 0 && <p className="truncate text-[11px] text-muted-foreground">Couldn't read {data.failed.join(", ")}</p>}
    </div>
  );
}
