import type { BerthPluginContext, Location, Session } from "@berth/plugin";
import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Frame, FrameHeader, FramePanel, FrameTitle, Icon, PickOne, Skeleton, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tip, cn } from "@berth/plugin/ui";
import { useMemo, useState } from "react";

import type { Account, Agent, Limits, Window } from "./box";
import { DailyChart, OTHER_BOXES, SERIES, agentSeries, boxColor, boxSeries } from "./chart";
import { AGENT_NAME, ago, compact, days, firstDay, plan, summarize, total, usd, worktreeOf, type BoxSession, type Period, type Source } from "./data";

// What the screen knows about one box while reading it.
export interface BoxState {
  box: string;
  online: boolean;
  loading: boolean;
  error?: string;
}

export interface UsageProps {
  berth: BerthPluginContext;
  period: Period;
  // Boxes with a report, and every box the view covers.
  sources: Source[];
  states: BoxState[];
  accounts: Record<string, Account[] | undefined>;
  running: Record<string, Session[] | undefined>;
  // Every paired box, for stable colors.
  allBoxes: string[];
  // True when the view covers more than one box.
  multi: boolean;
}

type Tokens4 = [number, number, number, number];

export function UsageView({ berth, period, sources, states, accounts, running, allBoxes, multi }: UsageProps) {
  const sum = useMemo(() => summarize(sources, period), [sources, period]);
  const [stackBy, setStackBy] = useState<"agent" | "box">("agent");
  const counted = sources.map((s) => s.box);
  const showBox = multi && counted.length > 1;
  const busy = states.some((s) => s.loading);

  if (!sources.length) {
    if (busy) {
      return (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      );
    }
    return null;
  }
  const agents = (["claude", "codex"] as Agent[]).filter((a) => (sum.byAgent.get(a) ? total(sum.byAgent.get(a)!) > 0 : false) || dedupeLimits(a, sources, accounts, period).length > 0);
  const where = multi ? (counted.length === 1 ? counted[0] : `${counted.length} boxes`) : counted[0];
  if (!agents.length) {
    return (
      <Empty className="rounded-xl border py-16">
        <EmptyHeader>
          <Icon name="ChartColumn" className="mx-auto mb-2 size-5 text-muted-foreground" />
          <EmptyTitle>
            No agent usage on {where} {period === 1 ? "today" : `in the last ${period} days`}
          </EmptyTitle>
          <EmptyDescription>Claude Code and Codex record their token use as they work; it shows up here once an agent has run on a box.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const series = stackBy === "box" && showBox ? boxSeries(counted, allBoxes) : agentSeries();
  const byDay = stackBy === "box" && showBox ? foldBoxes(sum.byDayBox, series) : (sum.byDay as Map<string, Map<string, number>>);
  const subscription = agents.includes("claude") && claudeAccounts(sources, accounts).every((a) => plan(a)?.subscription);
  const files = sources.reduce((n, s) => n + s.report.files, 0);

  return (
    <div className="space-y-4">
      <div className={cn("grid gap-3", agents.length > 1 && "md:grid-cols-2")}>
        {agents.map((a) => (
          <AgentTile
            key={a}
            agent={a}
            tokens={sum.byAgent.get(a) ?? [0, 0, 0, 0]}
            sessions={sum.sessions.filter((s) => s.agent === a)}
            perBox={showBox ? sum.byAgentBox.get(a) : undefined}
            allBoxes={allBoxes}
            plans={usedAccounts(a, sources, accounts)}
            limits={dedupeLimits(a, sources, accounts, period)}
            period={period}
          />
        ))}
      </div>

      {period > 1 && (
        <Frame variant="card">
          <FrameHeader className="flex-row items-center gap-2 py-3">
            <FrameTitle>Tokens per day</FrameTitle>
            {showBox && (
              <PickOne
                label="Stack by"
                className="ml-auto"
                value={stackBy}
                onChange={(v: string) => setStackBy(v as "agent" | "box")}
                options={[
                  { value: "agent", label: "By agent" },
                  { value: "box", label: "By box" },
                ]}
              />
            )}
          </FrameHeader>
          <FramePanel className="p-4">
            <DailyChart days={days(sum.today, period)} byDay={byDay} series={series} />
          </FramePanel>
        </Frame>
      )}

      <div className={cn("grid gap-4", !showBox && "lg:grid-cols-2")}>
        <Frame variant="card">
          <FrameHeader className="py-3">
            <FrameTitle>By model</FrameTitle>
          </FrameHeader>
          <FramePanel className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  {showBox && <TableHead>Box</TableHead>}
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cache</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sum.byModel.slice(0, 12).map((m) => (
                  <TableRow key={m.agent + m.model + m.box}>
                    <TableCell className="max-w-56">
                      <span className="flex items-center gap-2">
                        <span className={cn("size-2 shrink-0 rounded-[2px]", SERIES[m.agent].dot)} />
                        <span className="truncate font-mono text-xs">{m.model}</span>
                      </span>
                    </TableCell>
                    {showBox && (
                      <TableCell>
                        <BoxChip box={m.box} allBoxes={allBoxes} />
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{compact(m.tokens[0])}</TableCell>
                    <TableCell className="text-right tabular-nums">{compact(m.tokens[1])}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{compact(m.tokens[2] + m.tokens[3])}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{compact(total(m.tokens))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
        <Frame variant="card">
          <FrameHeader className="py-3">
            <FrameTitle>By project</FrameTitle>
          </FrameHeader>
          <FramePanel className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worktree</TableHead>
                  {showBox && <TableHead>Box</TableHead>}
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sum.byWorktree.slice(0, 12).map((w) => (
                  <TableRow key={w.box + w.name.label}>
                    <TableCell className="max-w-56 truncate" title={w.name.path ?? w.name.label}>
                      {w.name.location ? w.name.label : <span className="font-mono text-muted-foreground text-xs">{w.name.label}</span>}
                    </TableCell>
                    {showBox && (
                      <TableCell>
                        <BoxChip box={w.box} allBoxes={allBoxes} />
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums text-muted-foreground">{w.sessions || ""}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{compact(total(w.tokens))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      </div>

      <Frame variant="card">
        <FrameHeader className="flex-row items-center gap-2 py-3">
          <FrameTitle>Sessions</FrameTitle>
          <span className="ml-auto text-muted-foreground text-xs">
            Cost is Claude Code's own estimate at API list prices{subscription ? "; your Claude subscription covers this use" : ""}.
          </span>
        </FrameHeader>
        <FramePanel className="p-0">
          <SessionList berth={berth} sessions={sum.sessions.slice(0, 30)} sources={sources} running={running} allBoxes={allBoxes} showBox={showBox} />
        </FramePanel>
      </Frame>

      <p className="text-muted-foreground text-xs">
        Read from {files} transcript{files === 1 ? "" : "s"}
        {sources.map((s, i) => (
          <span key={s.box}>
            {i === 0 ? " on " : i === sources.length - 1 ? " and " : ", "}
            {s.box} {ago(s.report.generated)}
            {s.report.tz ? ` (${s.report.tz})` : ""}
          </span>
        ))}
        ; days are each box's own.
        {sources.some((s) => s.report.partial) && ` ${sources.reduce((n, s) => n + s.report.pending, 0)} more are still being read; this updates when they are.`}
        {sources.some((s) => s.report.truncated) && " Older sessions are left out to keep the answer small."} Input excludes cached input, which is counted under cache.
      </p>
    </div>
  );
}

// The chart's box series: boxes past the named hues add up as one.
function foldBoxes(byDayBox: Map<string, Map<string, number>>, series: { key: string }[]) {
  const named = new Set(series.map((s) => s.key));
  const out = new Map<string, Map<string, number>>();
  for (const [day, m] of byDayBox) {
    const d = new Map<string, number>();
    for (const [box, n] of m) {
      const k = named.has(box) ? box : OTHER_BOXES;
      d.set(k, (d.get(k) ?? 0) + n);
    }
    out.set(day, d);
  }
  return out;
}

export function BoxChip({ box, allBoxes }: { box: string; allBoxes: string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px font-mono text-[11px] text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", boxColor(box, allBoxes).dot)} />
      {box}
    </span>
  );
}

// The same login on two boxes counts once: matched by the email the agent
// recorded, or else it is its own account on its own box.
const identity = (a: Account | undefined, box: string, id: string) => (a?.email ? `${a.agent}:${a.email}` : `${box}:${a?.agent}:${id}`);

// usedAccounts: the accounts an agent ran under in these reports, plus each
// box's default, one per login.
function usedAccounts(agent: Agent, sources: Source[], accounts: Record<string, Account[] | undefined>) {
  const out = new Map<string, { account: Account; boxes: string[] }>();
  for (const { box, report } of sources) {
    const ids = new Set(["default", ...report.daily.filter((d) => d[1] === agent).map((d) => d[2])]);
    for (const id of ids) {
      const a = accounts[box]?.find((x) => x.agent === agent && x.id === id);
      if (!a || !a.signed_in) continue;
      const k = identity(a, box, id);
      const seen = out.get(k);
      if (seen) seen.boxes.push(box);
      else out.set(k, { account: a, boxes: [box] });
    }
  }
  return [...out.values()];
}

function claudeAccounts(sources: Source[], accounts: Record<string, Account[] | undefined>) {
  return usedAccounts("claude", sources, accounts).map((u) => u.account);
}

export interface SharedLimits {
  label?: string;
  boxes: string[];
  limits: Limits;
}

// dedupeLimits keeps the newest limits each login reported.
// Limits read before the period are left out, as its tokens are.
function dedupeLimits(agent: Agent, sources: Source[], accounts: Record<string, Account[] | undefined>, period: Period): SharedLimits[] {
  const out = new Map<string, SharedLimits>();
  for (const { box, report } of sources) {
    const from = firstDay(report.today, period);
    for (const l of report.limits.filter((x) => x.agent === agent && x.at.slice(0, 10) >= from)) {
      const a = accounts[box]?.find((x) => x.agent === agent && x.id === l.account);
      const k = identity(a, box, l.account);
      const label = a?.email ?? (l.account === "default" ? box : `${box} · ${l.account}`);
      const seen = out.get(k);
      if (!seen) out.set(k, { label, boxes: [box], limits: l });
      else {
        seen.boxes.push(box);
        if (l.at > seen.limits.at) seen.limits = l;
      }
    }
  }
  const list = [...out.values()];
  // One login needs no name.
  if (list.length === 1) list[0].label = undefined;
  return list;
}

function AgentTile({
  agent,
  tokens,
  sessions: list,
  perBox,
  allBoxes,
  plans,
  limits,
  period,
}: {
  agent: Agent;
  tokens: Tokens4;
  sessions: BoxSession[];
  perBox?: Map<string, number>;
  allBoxes: string[];
  plans: { account: Account; boxes: string[] }[];
  limits: SharedLimits[];
  period: Period;
}) {
  const sessions = list.length;
  const costed = list.filter((s) => s.cost != null);
  const cost = costed.reduce((n, s) => n + (s.cost ?? 0), 0);
  const labels = plans.map((p) => ({ ...p, plan: plan(p.account) })).filter((p) => p.plan);
  const covered = labels.length > 0 && labels.every((p) => p.plan!.subscription);
  const boxes = perBox ? [...perBox.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];
  const sumBoxes = boxes.reduce((n, [, v]) => n + v, 0) || 1;
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row flex-wrap items-center gap-2 py-3">
        <span className={cn("size-2.5 rounded-[3px]", SERIES[agent].dot)} />
        <FrameTitle>{AGENT_NAME[agent]}</FrameTitle>
        <span className="ml-auto text-muted-foreground text-xs">{period === 1 ? "today" : `last ${period} days`}</span>
        {labels.length > 0 && <span className="basis-full" />}
        {labels.map((p) => (
          <Badge key={identity(p.account, p.boxes[0], p.account.id)} variant="outline" size="sm" title={[p.account.email, `on ${p.boxes.join(", ")}`].filter(Boolean).join(" · ")}>
            {p.plan!.label}
            {p.plan!.subscription ? " · subscription" : ""}
            {labels.length > 1 && p.account.email ? ` · ${p.account.email}` : ""}
          </Badge>
        ))}
      </FrameHeader>
      <FramePanel className="space-y-3 p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-2xl tabular-nums tracking-tight">{compact(total(tokens))}</span>
          <span className="text-muted-foreground text-sm">
            tokens in {sessions} session{sessions === 1 ? "" : "s"}
            {boxes.length > 1 ? ` on ${boxes.length} boxes` : ""}
          </span>
        </div>
        <dl className="grid grid-cols-4 gap-2 text-xs">
          {(["Input", "Output", "Cache read", "Cache write"] as const).map((l, i) => (
            <div key={l}>
              <dt className="text-muted-foreground">{l}</dt>
              <dd className="tabular-nums">{compact(tokens[i])}</dd>
            </div>
          ))}
        </dl>
        {boxes.length > 1 && (
          <div className="space-y-1.5">
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`By box: ${boxes.map(([b, n]) => `${b} ${compact(n)}`).join(", ")}`}>
              {boxes.map(([b, n]) => (
                <Tip key={b} label={`${b}: ${compact(n)} tokens`}>
                  <span className={cn("h-full first:rounded-l-full last:rounded-r-full", boxColor(b, allBoxes).dot)} style={{ width: `${(n / sumBoxes) * 100}%` }} />
                </Tip>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {boxes.map(([b, n]) => (
                <span key={b} className="flex items-center gap-1">
                  <span className={cn("size-1.5 rounded-full", boxColor(b, allBoxes).dot)} />
                  {b} <span className="text-foreground tabular-nums">{compact(n)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {costed.length > 0 && (
          <p className="border-t pt-3 text-muted-foreground text-xs">
            <span className="font-medium text-foreground tabular-nums">{usd(cost)}</span> is Claude Code's own estimate at API list prices for {costed.length === sessions ? "these sessions" : `${costed.length} of these sessions`}, whole sessions included.
            {covered ? ` ${labels.length === 1 ? labels[0].plan!.label : "Your subscriptions"} cover${labels.length === 1 ? "s" : ""} this use; it isn't billed per token.` : ""}
          </p>
        )}
        {limits.map((l) => (
          <LimitRows key={l.label ?? "one"} shared={l} />
        ))}
      </FramePanel>
    </Frame>
  );
}

function windowName(w: Window) {
  const h = w.window_minutes / 60;
  return h >= 24 * 6 ? "Weekly limit" : h >= 20 ? "Daily limit" : `${h}-hour limit`;
}

// LimitRows shows the plan windows the agent itself last reported, and says
// how old that report is: Codex's is what it saw on its last turn, Claude
// Code's what its `/usage` said when the box was last read.
function LimitRows({ shared }: { shared: SharedLimits }) {
  const l = shared.limits;
  const windows = [l.limits.primary, l.limits.secondary, ...(l.limits.extra ?? [])].filter(Boolean) as Window[];
  const next = l.agent === "codex" ? "Codex reports the new window on its next turn." : "The next read shows the new window.";
  return (
    <div className="space-y-2 border-t pt-3">
      {shared.label && <div className="truncate text-[11px] text-muted-foreground">{shared.label}</div>}
      {windows.map((w, i) => {
        const reset = w.resets_at ? new Date(w.resets_at * 1000) : null;
        const past = reset !== null && reset.getTime() < Date.now();
        const name = w.label ?? windowName(w);
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-medium">{name}</span>
              <span className="text-muted-foreground">as of {ago(l.at)}</span>
              <span className="ml-auto tabular-nums">{past ? "reset since" : `${Math.round(w.used_percent)}% used`}</span>
            </div>
            {!past && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={Math.round(w.used_percent)} aria-valuemin={0} aria-valuemax={100} aria-label={name}>
                <div className={cn("h-full rounded-full", w.used_percent >= 90 ? "bg-destructive" : w.used_percent >= 70 ? "bg-warning" : "bg-primary/70")} style={{ width: `${Math.min(100, w.used_percent)}%` }} />
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">{!reset ? "" : past ? `It reset ${reset.toLocaleDateString()}; ${next}` : `Resets ${reset.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}</div>
          </div>
        );
      })}
    </div>
  );
}

function SessionList({ berth, sessions, sources, running, allBoxes, showBox }: { berth: BerthPluginContext; sessions: BoxSession[]; sources: Source[]; running: Record<string, Session[] | undefined>; allBoxes: string[]; showBox: boolean }) {
  const [busy, setBusy] = useState<string>();
  if (!sessions.length) return <p className="px-4 py-6 text-center text-muted-foreground text-sm">No sessions in this period.</p>;
  const locationsOf = (box: string): Location[] => sources.find((s) => s.box === box)?.locations ?? [];

  const resume = async (s: BoxSession) => {
    const w = worktreeOf(s.cwd, locationsOf(s.box));
    if (!w.location) return;
    setBusy(s.box + s.id);
    try {
      const command = s.agent === "claude" ? `claude --resume ${s.id}` : `codex resume ${s.id}`;
      const created = await berth.api.request<{ name: string }>(s.box, "POST", "sessions", { location: w.main ? w.location : `${w.location}/${w.worktree}`, command });
      berth.openTerminal(s.box, created.name);
    } catch (err) {
      berth.notify("Couldn't resume that session", String((err as Error).message ?? err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ul className="divide-y">
      {sessions.map((s) => {
        const w = worktreeOf(s.cwd, locationsOf(s.box));
        const live = (running[s.box] ?? []).find((r) => !r.exited && r.agent === s.agent && r.dir === s.cwd);
        return (
          <li key={s.box + s.agent + s.id} className="group flex items-center gap-3 px-4 py-2 text-sm">
            <span className={cn("size-2 shrink-0 rounded-[2px]", SERIES[s.agent].dot)} aria-label={AGENT_NAME[s.agent]} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate">{s.title || <span className="text-muted-foreground">Untitled session</span>}</span>
                {showBox && <BoxChip box={s.box} allBoxes={allBoxes} />}
              </div>
              <div className="truncate text-muted-foreground text-xs">
                {w.label} · {s.models.join(", ")} · {ago(s.last)}
                {s.account !== "default" && ` · ${s.account}`}
              </div>
            </div>
            <span className="w-16 text-right tabular-nums">{compact(total(s.tokens))}</span>
            {s.cost != null ? (
              <Tip label="Claude Code's estimate at API list prices">
                <span className="w-16 text-right text-muted-foreground tabular-nums">{usd(s.cost)}</span>
              </Tip>
            ) : (
              <span className="w-16" />
            )}
            <span className="w-20 text-right">
              {live ? (
                <Button size="xs" variant="outline" onClick={() => berth.openTerminal(s.box, live.name)}>
                  Open
                </Button>
              ) : w.location ? (
                <Button size="xs" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" loading={busy === s.box + s.id} onClick={() => void resume(s)}>
                  Resume
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// BoxStatus: one chip per box the view covers, so a slow or failing box is
// visible without holding up the rest.
export function BoxStatus({ states, files, allBoxes }: { states: BoxState[]; files: Record<string, number | undefined>; allBoxes: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {states.map((s) => (
        <Tip key={s.box} label={s.error}>
          <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5", s.error && "border-destructive/40", !s.online && "border-dashed text-muted-foreground")}>
            <span className={cn("size-1.5 rounded-full", s.online ? boxColor(s.box, allBoxes).dot : "bg-muted-foreground/40")} />
            <span className="font-medium">{s.box}</span>
            {!s.online ? (
              <span>not counted (offline)</span>
            ) : s.loading ? (
              <>
                <Spinner className="size-3" />
                <span className="text-muted-foreground">reading…</span>
              </>
            ) : s.error ? (
              <span className="max-w-64 truncate text-destructive-foreground">couldn't read: {s.error}</span>
            ) : (
              <span className="text-muted-foreground tabular-nums">{files[s.box] ?? 0} transcripts</span>
            )}
          </span>
        </Tip>
      ))}
    </div>
  );
}
