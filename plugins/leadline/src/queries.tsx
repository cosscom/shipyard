import type { WorktreePanelProps } from "@berth/plugin";
import { Badge, Chart, FilterChip, Tip, cn } from "@berth/plugin/ui";
import { useMemo, useState } from "react";

import type { QueryRow } from "./api";
import { queryProblem } from "./brief.ts";
import { ago, clock, count, ms, pct, per, span, tick } from "./format.ts";
import { jumpTo, useDebounced, useJump, useLive } from "./live";
import { SendButton } from "./send";
import { Command, DetailHeader, Head, Meter, More, None, Nothing, NPlusOne, type PanelContext, PanelShell, rowClass, Search, Section, SortHead, Split, StaleNote, Stat, Stats, Toolbar, Waiting } from "./ui";

// Queries: every database call of the worktree, grouped by shape (the
// statement with "?" where a value was), with how often and how long, and
// a flag on the ones a single request repeats: an N+1.

const PAGE = 200;
// The most the route gives in one answer; it is read whole each time, so more is asked for by raising the limit.
const MOST = 5000;
const keyOf = (q: { db_system: string; fingerprint: string }) => `${q.db_system}\n${q.fingerprint}`;
const unkey = (key: string) => ({ db_system: key.slice(0, key.indexOf("\n")), fingerprint: key.slice(key.indexOf("\n") + 1) });

type Sort = "total" | "calls" | "avg" | "p95";
const by: Record<Sort, (r: QueryRow) => number> = { total: (r) => r.total_ms, calls: (r) => r.calls, avg: (r) => r.avg_ms, p95: (r) => r.p95_ms };

export function QueriesPanel(props: WorktreePanelProps) {
  return (
    <PanelShell {...props} panel="queries">
      {(ctx) => <Queries ctx={ctx} />}
    </PanelShell>
  );
}

function Queries({ ctx }: { ctx: PanelContext }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  // BEGIN, COMMIT, SET and their like are kept out of the queries; this lists them instead.
  const [control, setControl] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [sort, setSort] = useState<{ key: Sort; dir: "asc" | "desc" }>({ key: "total", dir: "desc" });
  const [open, setOpen] = useState<string>();
  useJump("queries", ctx.box, ctx.source, setOpen);

  const live = useLive(() => ctx.api.queries(ctx.scope(), { q, control, limit }), [ctx.box, ctx.source, ctx.window.value, q, control, limit].join("\n"), { every: ctx.window.every, active: ctx.active, onFault: ctx.onFault });
  const rows = useMemo(() => {
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...(live.data ?? [])].sort((a, b) => sign * (by[sort.key](a) - by[sort.key](b)));
  }, [live.data, sort]);
  const maxTotal = Math.max(1e-9, ...rows.map((r) => r.total_ms));
  const onSort = (key: Sort) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const wide = !open;
  const head = { sort: sort.key, dir: sort.dir, onSort };

  return (
    <>
      <Toolbar ctx={ctx} note={live.data ? `${count(rows.length)}${rows.length >= limit ? "+" : ""} ${control ? "control statements" : rows.length === 1 ? "query shape" : "query shapes"}` : undefined}>
        <Search value={search} onChange={setSearch} placeholder="Filter by SQL text" />
        <Tip label="BEGIN, COMMIT, SET and their like: list them in place of the queries">
          <FilterChip pressed={control} onPressedChange={setControl}>
            Control
          </FilterChip>
        </Tip>
      </Toolbar>
      <StaleNote fault={live.data ? live.fault : undefined} />
      <Split
        list={
          !live.data ? (
            <Waiting fault={live.fault} onRetry={live.refresh} />
          ) : rows.length === 0 ? (
            control ? (
              <Nothing ctx={ctx} what="transaction or session control statements" filtered />
            ) : (
              <Nothing ctx={ctx} what="queries" filtered={!!q} />
            )
          ) : (
            <div className="min-h-0 flex-1 overflow-auto" data-testid="leadline-list">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-background vibrancy:bg-(--content-solid) [&_th]:border-b">
                  <tr>
                    <Head className="pl-3 text-left">Query</Head>
                    <SortHead id="calls" {...head} className="text-right">
                      Calls
                    </SortHead>
                    {wide && (
                      <>
                        <SortHead id="avg" {...head} className="hidden text-right @xl:table-cell">
                          Avg
                        </SortHead>
                        <SortHead id="p95" {...head} className="text-right">
                          p95
                        </SortHead>
                      </>
                    )}
                    <SortHead id="total" {...head} className="text-right">
                      Total time
                    </SortHead>
                    <Head className="w-9 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <QueryRowView key={keyOf(r)} ctx={ctx} r={r} wide={wide} on={open === keyOf(r)} maxTotal={maxTotal} onOpen={() => setOpen(open === keyOf(r) ? undefined : keyOf(r))} />
                  ))}
                </tbody>
              </table>
              {rows.length >= limit && limit < MOST && <More onClick={() => setLimit((n) => Math.min(MOST, n + PAGE))}>Show more query shapes</More>}
            </div>
          )
        }
        detail={open && <QueryDetailView key={open} ctx={ctx} query={unkey(open)} onClose={() => setOpen(undefined)} />}
      />
    </>
  );
}

function QueryRowView({ ctx, r, wide, on, maxTotal, onOpen }: { ctx: PanelContext; r: QueryRow; wide: boolean; on: boolean; maxTotal: number; onOpen(): void }) {
  const problem = queryProblem(r);
  const cell = "whitespace-nowrap border-b px-2 py-1.5 text-right align-top tabular-nums";
  return (
    <tr className={rowClass(on)} onClick={onOpen} data-testid="leadline-row" aria-selected={on}>
      <td className="w-full max-w-0 border-b py-1.5 pr-2 pl-3 align-top">
        <button type="button" className="block w-full truncate rounded-sm text-left font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => (e.stopPropagation(), onOpen())}>
          {r.fingerprint}
        </button>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground text-xs empty:hidden">
          {wide && <span>{r.db_system}</span>}
          {r.n_plus_one && <NPlusOne times={r.max_per_trace} />}
          {r.errors > 0 && <span className="font-medium text-destructive-foreground tabular-nums">{count(r.errors)} failed</span>}
          {problem === "slow" && (
            <Badge variant="outline" size="sm">
              Slow
            </Badge>
          )}
        </div>
      </td>
      <td className={cell}>{count(r.calls)}</td>
      {wide && (
        <>
          <td className={cn(cell, "hidden @xl:table-cell")}>{ms(r.avg_ms)}</td>
          <td className={cell}>{ms(r.p95_ms)}</td>
        </>
      )}
      <td className={cell}>
        <span className="flex items-center justify-end gap-2">
          {wide && <span className="hidden w-20 @2xl:flex"><Meter value={r.total_ms} max={maxTotal} /></span>}
          <span className="w-16 shrink-0">{ms(r.total_ms)}</span>
        </span>
      </td>
      <td className="border-b pr-2 align-top">{problem && <span className="flex h-8 items-center">{<SendButton ctx={ctx} ask={{ kind: "query", db_system: r.db_system, fingerprint: r.fingerprint }} what={problem === "n_plus_one" ? "this N+1" : problem === "failing" ? "this failing query" : "this slow query"} />}</span>}</td>
    </tr>
  );
}

function QueryDetailView({ ctx, query, onClose }: { ctx: PanelContext; query: { db_system: string; fingerprint: string }; onClose(): void }) {
  const live = useLive(() => ctx.api.query(ctx.scope(), query), [ctx.box, ctx.source, ctx.window.value].join("\n"), { every: ctx.window.every, active: ctx.active, onFault: ctx.onFault });
  const d = live.data;
  const s = d?.stats;
  // Seconds only when the whole window is a few minutes: a label has to fit under its point.
  const label = (at: number) => tick(at, ctx.window.ms > 5 * 60_000 ? 60_000 : (d?.series.bucket_ms ?? 0));
  const maxEndpoint = Math.max(1e-9, ...(d?.endpoints ?? []).map((e) => e.total_ms));
  const calls = useMemo(() => d && { type: "area" as const, x: "x", y: [{ key: "calls", label: "Calls", color: "1" }, { key: "failed", label: "Failed", color: "bad" }], data: d.series.t.map((at, i) => ({ x: label(at), calls: d.series.calls[i], failed: d.series.errors[i] })) }, [d, ctx.window.ms]);
  const latency = useMemo(
    () =>
      d && {
        // An area: its curve passes through the points without swinging past them.
        type: "area" as const,
        x: "x",
        units: "ms",
        y: [{ key: "p95", label: "p95", color: "2" }, { key: "avg", label: "Average", color: "1" }],
        // A bucket with no calls has no latency: it is left out, not drawn as zero.
        data: d.series.t.flatMap((at, i) => (d.series.avg_ms[i] == null ? [] : [{ x: label(at), avg: round(d.series.avg_ms[i]!), p95: round(d.series.p95_ms[i] ?? d.series.avg_ms[i]!) }])),
      },
    [d, ctx.window.ms],
  );
  const trace = (id: string) => jumpTo(ctx.berth, { panel: "traces", box: ctx.box, source: ctx.source, key: id });

  return (
    <>
      <DetailHeader label="Close the query" onClose={onClose} actions={<SendButton ctx={ctx} ask={{ kind: "query", ...query }} words what="this query" />}>
        <Badge variant="outline" size="sm" className="shrink-0">
          {query.db_system || "database"}
        </Badge>
        <span className="truncate font-medium">Query</span>
      </DetailHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4" data-testid="leadline-detail">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs">{query.fingerprint}</pre>
        {!d ? (
          <Waiting fault={live.fault} onRetry={live.refresh} />
        ) : !s ? (
          <None>This query didn't run in the last {span(ctx.window.ms)}.</None>
        ) : (
          <>
            <Stats>
              <Stat label="Calls" value={count(s.calls)} note={`in ${count(s.traces)} ${s.traces === 1 ? "trace" : "traces"}`} />
              <Stat label="Most in one request" value={`×${count(s.max_per_trace)}`} note={s.n_plus_one ? "N+1" : undefined} tone={s.n_plus_one ? "warn" : undefined} />
              <Stat label="Average" value={ms(s.avg_ms)} />
              <Stat label="p95" value={ms(s.p95_ms)} note={`max ${ms(s.max_ms)}`} />
              <Stat label="Failed" value={count(s.errors)} note={s.errors > 0 ? pct(s.errors / s.calls) : undefined} tone={s.errors > 0 ? "bad" : undefined} />
              <Stat label="Total time" value={ms(s.total_ms)} />
              <Stat label="Share of database time" value={pct(s.share)} />
              <Stat label="Last run" value={ago(Date.now() - s.last_ms)} />
            </Stats>
            <div className="grid gap-4 @2xl:grid-cols-2">
              <Section title="Calls" hint={`per ${span(d.series.bucket_ms)}`}>
                <Chart spec={calls!} className="h-60 px-6" />
              </Section>
              <Section title="Time per call" hint="average and p95, where it ran">
                {latency!.data.length > 1 ? <Chart spec={latency!} className="h-60 px-6" /> : <None>It ran in one stretch of the window, so there is no line to draw: {ms(s.avg_ms)} on average, p95 {ms(s.p95_ms)}.</None>}
              </Section>
            </div>
            {s.n_plus_one && (
              <Section title="Requests that show the N+1" hint="the ones that ran it five times or more, most first">
                <TraceList rows={d.n_plus_one.map((t) => ({ id: t.trace_id, at: t.start_ms, name: t.name, service: t.service, note: `${count(t.calls)} calls`, ms: t.total_ms, failed: t.errors > 0 }))} onOpen={trace} />
              </Section>
            )}
            <Section title="Requests that run it" hint="by time spent in this query">
              {d.endpoints.length === 0 ? (
                <None>No request that began in this window ran it: it runs outside any request Leadline saw.</None>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_th]:border-b">
                      <tr>
                        <Head className="pl-3 text-left">Endpoint</Head>
                        <Head className="text-right">Per request</Head>
                        <Head className="hidden text-right @lg:table-cell">Runs in</Head>
                        <Head className="pr-3 text-right">Total time</Head>
                      </tr>
                    </thead>
                    <tbody className="[&_tr:last-child_td]:border-b-0">
                      {d.endpoints.map((e) => (
                        <tr key={`${e.service}\n${e.name}`} className={rowClass()} onClick={() => jumpTo(ctx.berth, { panel: "endpoints", box: ctx.box, source: ctx.source, key: `${e.service}\n${e.name}` })}>
                          <td className="w-full max-w-0 border-b py-1.5 pr-2 pl-3">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <button type="button" className="truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {e.name}
                              </button>
                              <Command service={e.service} />
                              {e.n_plus_one && <NPlusOne times={e.max_per_request} />}
                            </span>
                          </td>
                          <td className={cn("border-b px-2 text-right tabular-nums", e.n_plus_one && "font-medium text-warning-foreground")}>×{per(e.per_request)}</td>
                          <td className="hidden border-b px-2 text-right tabular-nums @lg:table-cell">{pct(e.requests / Math.max(1, e.endpoint_requests))}</td>
                          <td className="border-b py-1.5 pr-3 pl-2">
                            <span className="flex items-center justify-end gap-2">
                              <span className="hidden w-16 @lg:flex"><Meter value={e.total_ms} max={maxEndpoint} /></span>
                              <span className="w-16 shrink-0 text-right tabular-nums">{ms(e.total_ms)}</span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            <Section title="Slowest traces" hint="by time spent in this query">
              <TraceList rows={d.traces.map((t) => ({ id: t.trace_id, at: t.start_ms, name: t.name, service: t.service, note: t.calls > 1 ? `${count(t.calls)} calls, slowest ${ms(t.slowest_ms)}` : undefined, ms: t.total_ms, failed: t.errors > 0 }))} onOpen={trace} />
            </Section>
          </>
        )}
      </div>
    </>
  );
}

const round = (n: number) => Number(n.toPrecision(4));

export interface TraceLine {
  id: string;
  at: number;
  name?: string;
  service?: string;
  note?: string;
  ms: number;
  failed?: boolean;
}

// TraceList is a short list of requests, each a click from its trace.
export function TraceList({ rows, onOpen, none = "None in this window." }: { rows: TraceLine[]; onOpen(id: string): void; none?: string }) {
  if (rows.length === 0) return <None>{none}</None>;
  return (
    <ul className="divide-y overflow-hidden rounded-lg border" data-testid="leadline-traces">
      {rows.map((t) => (
        <li key={t.id}>
          <button type="button" className="flex w-full items-center gap-3 px-3 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/60" onClick={() => onOpen(t.id)}>
            <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">{clock(t.at)}</span>
            <span role="img" aria-label={t.failed ? "Failed" : "Ok"} className={cn("size-1.5 shrink-0 rounded-full", t.failed ? "bg-destructive" : "bg-success")} />
            <span className="min-w-0 flex-1 truncate">{t.name || "A trace that began before this window"}</span>
            {t.service && <Command service={t.service} />}
            {t.note && <span className="hidden shrink-0 text-muted-foreground text-xs tabular-nums @md:block">{t.note}</span>}
            <span className="w-16 shrink-0 text-right tabular-nums">{ms(t.ms)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
