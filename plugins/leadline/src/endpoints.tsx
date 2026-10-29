import type { WorktreePanelProps } from "@berth/plugin";
import { Chart, cn } from "@berth/plugin/ui";
import { useMemo, useState } from "react";

import type { EndpointRow, EndpointSort } from "./api";
import { endpointProblem } from "./brief.ts";
import { ago, count, ms, pct, per, plural, span, tick } from "./format.ts";
import { jumpTo, useDebounced, useJump, useLive } from "./live";
import { TraceList } from "./queries";
import { SendButton } from "./send";
import { Command, DetailHeader, Head, Meter, More, None, Nothing, NPlusOne, type PanelContext, PanelShell, rowClass, Search, Section, SortHead, Spark, Split, StaleNote, Stat, Stats, Toolbar, Waiting } from "./ui";

// Endpoints: the worktree's requests by route, with how many, how long, how
// many queries each one runs and how long it spends in databases.

const PAGE = 100;
// The most the route gives in one answer; it is read whole each time, so more is asked for by raising the limit.
const MOST = 1000;
const keyOf = (e: { service: string; name: string }) => `${e.service}\n${e.name}`;
const unkey = (key: string) => ({ service: key.slice(0, key.indexOf("\n")), name: key.slice(key.indexOf("\n") + 1) });

export function EndpointsPanel(props: WorktreePanelProps) {
  return (
    <PanelShell {...props} panel="endpoints">
      {(ctx) => <Endpoints ctx={ctx} />}
    </PanelShell>
  );
}

function Endpoints({ ctx }: { ctx: PanelContext }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [limit, setLimit] = useState(PAGE);
  const [sort, setSort] = useState<{ key: EndpointSort; dir: "asc" | "desc" }>({ key: "time", dir: "desc" });
  const [open, setOpen] = useState<string>();
  useJump("endpoints", ctx.box, ctx.source, setOpen);

  const live = useLive(() => ctx.api.endpoints(ctx.scope(), { q, sort: sort.key, dir: sort.dir, limit }), [ctx.box, ctx.source, ctx.window.value, q, sort.key, sort.dir, limit].join("\n"), { every: ctx.window.every, active: ctx.active, onFault: ctx.onFault });
  const rows = live.data?.rows ?? [];
  const total = live.data?.total ?? 0;
  const maxTotal = Math.max(1e-9, ...rows.map((r) => r.total_ms));
  // A name sorts A to Z first; a number, largest first.
  const onSort = (key: EndpointSort) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const wide = !open;
  const head = { sort: sort.key, dir: sort.dir, onSort };

  return (
    <>
      <Toolbar ctx={ctx} note={live.data ? `${count(total)} ${total === 1 ? "endpoint" : "endpoints"}` : undefined}>
        <Search value={search} onChange={setSearch} placeholder="Filter by name" />
      </Toolbar>
      <StaleNote fault={live.data ? live.fault : undefined} />
      <Split
        list={
          !live.data ? (
            <Waiting fault={live.fault} onRetry={live.refresh} />
          ) : rows.length === 0 ? (
            <Nothing ctx={ctx} what="requests" filtered={!!q} />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto" data-testid="leadline-list">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-background vibrancy:bg-(--content-solid) [&_th]:border-b">
                  <tr>
                    <SortHead id="name" {...head} className="pl-3 text-left">
                      Endpoint
                    </SortHead>
                    <SortHead id="requests" {...head} className="text-right">
                      Requests
                    </SortHead>
                    {wide && (
                      <SortHead id="errors" {...head} className="hidden text-right @md:table-cell">
                        Failed
                      </SortHead>
                    )}
                    <SortHead id="p95" {...head} className="text-right">
                      p95
                    </SortHead>
                    {wide && (
                      <>
                        <SortHead id="queries" {...head} className="hidden text-right @lg:table-cell">
                          Queries
                        </SortHead>
                        <SortHead id="db" {...head} className="hidden text-right @2xl:table-cell">
                          In databases
                        </SortHead>
                        <SortHead id="time" {...head} className="hidden text-right @xl:table-cell">
                          Total time
                        </SortHead>
                      </>
                    )}
                    <Head className="w-9 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <EndpointRowView key={keyOf(r)} ctx={ctx} r={r} wide={wide} on={open === keyOf(r)} maxTotal={maxTotal} onOpen={() => setOpen(open === keyOf(r) ? undefined : keyOf(r))} />
                  ))}
                </tbody>
              </table>
              {rows.length < total && limit < MOST && <More onClick={() => setLimit((n) => Math.min(MOST, n + PAGE))}>Show more endpoints</More>}
            </div>
          )
        }
        detail={open && <EndpointDetailView key={open} ctx={ctx} endpoint={unkey(open)} onClose={() => setOpen(undefined)} />}
      />
    </>
  );
}

function EndpointRowView({ ctx, r, wide, on, maxTotal, onOpen }: { ctx: PanelContext; r: EndpointRow; wide: boolean; on: boolean; maxTotal: number; onOpen(): void }) {
  const cell = "whitespace-nowrap border-b px-2 py-1.5 text-right tabular-nums";
  return (
    <tr className={rowClass(on)} onClick={onOpen} data-testid="leadline-row" aria-selected={on}>
      <td className="w-full max-w-0 border-b py-1.5 pr-2 pl-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <button type="button" className="truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => (e.stopPropagation(), onOpen())}>
            {r.name}
          </button>
          <Command service={r.service} />
          {!wide && r.errors > 0 && <span className="shrink-0 font-medium text-destructive-foreground text-xs tabular-nums">{count(r.errors)} failed</span>}
        </span>
      </td>
      <td className={cell}>
        <span className="flex items-center justify-end gap-2">
          {wide && r.spark && (
            <span className="hidden @xl:block">
              <Spark values={r.spark} label={`${plural(r.requests, "request")} over the window`} />
            </span>
          )}
          {count(r.requests)}
        </span>
      </td>
      {wide && <td className={cn(cell, "hidden @md:table-cell", r.errors > 0 && "font-medium text-destructive-foreground")}>{r.errors > 0 ? `${count(r.errors)} (${pct(r.errors / Math.max(1, r.requests))})` : "0"}</td>}
      <td className={cell}>{ms(r.p95_ms)}</td>
      {wide && (
        <>
          <td className={cn(cell, "hidden @lg:table-cell")}>{per(r.queries)}</td>
          <td className={cn(cell, "hidden @2xl:table-cell")}>{ms(r.db_ms)}</td>
          <td className={cn(cell, "hidden @xl:table-cell")}>
            <span className="flex items-center justify-end gap-2">
              <span className="hidden w-20 @3xl:flex"><Meter value={r.total_ms} max={maxTotal} /></span>
              <span className="w-16 shrink-0">{ms(r.total_ms)}</span>
            </span>
          </td>
        </>
      )}
      <td className="border-b pr-2">{r.errors > 0 && <SendButton ctx={ctx} ask={{ kind: "endpoint", service: r.service, name: r.name }} what="this failing endpoint" />}</td>
    </tr>
  );
}

const round = (n: number) => Number(n.toPrecision(4));

function EndpointDetailView({ ctx, endpoint, onClose }: { ctx: PanelContext; endpoint: { service: string; name: string }; onClose(): void }) {
  const live = useLive(() => ctx.api.endpoint(ctx.scope(), endpoint), [ctx.box, ctx.source, ctx.window.value].join("\n"), { every: ctx.window.every, active: ctx.active, onFault: ctx.onFault });
  const d = live.data;
  const s = d?.stats;
  // Seconds only when the whole window is a few minutes: a label has to fit under its point.
  const label = (at: number) => tick(at, ctx.window.ms > 5 * 60_000 ? 60_000 : (d?.series.bucket_ms ?? 0));
  const maxQuery = Math.max(1e-9, ...(d?.queries ?? []).map((x) => x.total_ms));
  const requests = useMemo(() => d && { type: "area" as const, x: "x", y: [{ key: "requests", label: "Requests", color: "1" }, { key: "failed", label: "Failed", color: "bad" }], data: d.series.t.map((at, i) => ({ x: label(at), requests: d.series.requests[i], failed: d.series.errors[i] })) }, [d, ctx.window.ms]);
  const latency = useMemo(
    () =>
      d && {
        // An area: its curve passes through the points without swinging past them.
        type: "area" as const,
        x: "x",
        units: "ms",
        y: [{ key: "p95", label: "p95", color: "2" }, { key: "p50", label: "p50", color: "1" }],
        // A bucket with no requests has no latency: it is left out, not drawn as zero.
        data: d.series.t.flatMap((at, i) => (d.series.p50_ms[i] == null ? [] : [{ x: label(at), p50: round(d.series.p50_ms[i]!), p95: round(d.series.p95_ms[i] ?? d.series.p50_ms[i]!) }])),
      },
    [d, ctx.window.ms],
  );
  const trace = (id: string) => jumpTo(ctx.berth, { panel: "traces", box: ctx.box, source: ctx.source, key: id });
  const problem = s ? endpointProblem(s, d?.queries) : "slow";
  const line = (r: { trace_id: string; start_ms: number; duration_ms: number; queries: number; db_ms: number; failed: boolean }) => ({ id: r.trace_id, at: r.start_ms, name: endpoint.name, note: `${plural(r.queries, "query", "queries")}, ${ms(r.db_ms)} in databases`, ms: r.duration_ms, failed: r.failed });

  return (
    <>
      <DetailHeader
        label="Close the endpoint"
        onClose={onClose}
        actions={<SendButton ctx={ctx} ask={{ kind: "endpoint", ...endpoint }} words what={problem === "failing" ? "this failing endpoint" : problem === "n_plus_one" ? "this N+1" : "this endpoint"} />}
      >
        <span className="truncate font-medium">{endpoint.name}</span>
        <Command service={endpoint.service} />
      </DetailHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4" data-testid="leadline-detail">
        {!d ? (
          <Waiting fault={live.fault} onRetry={live.refresh} />
        ) : !s ? (
          <None>No request reached it in the last {span(ctx.window.ms)}.</None>
        ) : (
          <>
            <Stats>
              <Stat label="Requests" value={count(s.requests)} note={`last ${ago(Date.now() - s.last_ms)}`} />
              <Stat label="Failed" value={count(s.errors)} note={s.errors > 0 ? pct(s.errors / Math.max(1, s.requests)) : undefined} tone={s.errors > 0 ? "bad" : undefined} />
              <Stat label="Average" value={ms(s.avg_ms)} />
              <Stat label="p95" value={ms(s.p95_ms)} note={`max ${ms(s.max_ms)}`} />
              <Stat label="Queries per request" value={per(s.queries)} tone={problem === "n_plus_one" ? "warn" : undefined} note={d.queries.some((x) => x.n_plus_one) ? "N+1" : undefined} />
              <Stat label="In databases" value={ms(s.db_ms)} note={s.avg_ms > 0 ? `${pct(s.db_ms / s.avg_ms)} of a request` : undefined} />
              <Stat label="Total time" value={ms(s.total_ms)} />
              <Stat label="Share of request time" value={pct(s.share)} />
            </Stats>
            <div className="grid gap-4 @2xl:grid-cols-2">
              <Section title="Requests" hint={`per ${span(d.series.bucket_ms)}`}>
                <Chart spec={requests!} className="h-60 px-6" />
              </Section>
              <Section title="Latency" hint="p50 and p95, where it had requests">
                {latency!.data.length > 1 ? <Chart spec={latency!} className="h-60 px-6" /> : <None>Its requests came in one stretch of the window, so there is no line to draw: p50 {ms(s.p50_ms)}, p95 {ms(s.p95_ms)}.</None>}
              </Section>
            </div>
            {d.failing.length > 0 && (
              <Section title="Failing requests" hint="newest first">
                <TraceList rows={d.failing.map(line)} onOpen={trace} />
              </Section>
            )}
            <Section title="Queries a request runs" hint="costliest first">
              {d.queries.length === 0 ? (
                <None>Its requests ran no database call in this window.</None>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_th]:border-b">
                      <tr>
                        <Head className="pl-3 text-left">Query</Head>
                        <Head className="text-right">Per request</Head>
                        <Head className="hidden text-right @lg:table-cell">Avg</Head>
                        <Head className="pr-3 text-right">Total time</Head>
                      </tr>
                    </thead>
                    <tbody className="[&_tr:last-child_td]:border-b-0">
                      {d.queries.map((x) => (
                        <tr key={`${x.db_system}\n${x.fingerprint}`} className={rowClass()} onClick={() => jumpTo(ctx.berth, { panel: "queries", box: ctx.box, source: ctx.source, key: `${x.db_system}\n${x.fingerprint}` })}>
                          <td className="w-full max-w-0 border-b py-1.5 pr-2 pl-3">
                            <button type="button" className="block w-full truncate rounded-sm text-left font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              {x.fingerprint}
                            </button>
                            {x.n_plus_one && (
                              <div className="mt-0.5">
                                <NPlusOne times={x.max_per_request} />
                              </div>
                            )}
                          </td>
                          <td className={cn("border-b px-2 text-right align-top tabular-nums leading-8", x.n_plus_one && "font-medium text-warning-foreground")}>×{per(x.per_request)}</td>
                          <td className="hidden border-b px-2 text-right align-top tabular-nums leading-8 @lg:table-cell">{ms(x.avg_ms)}</td>
                          <td className="border-b py-1.5 pr-3 pl-2 align-top">
                            <span className="flex h-5 items-center justify-end gap-2">
                              <span className="hidden w-16 @lg:flex"><Meter value={x.total_ms} max={maxQuery} /></span>
                              <span className="w-16 shrink-0 text-right tabular-nums">{ms(x.total_ms)}</span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            <Section title="Slowest requests">
              <TraceList rows={d.slowest.map(line)} onOpen={trace} />
            </Section>
          </>
        )}
      </div>
    </>
  );
}
