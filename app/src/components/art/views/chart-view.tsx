import { MotionConfig, MotionGlobalConfig } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Area } from "@/components/charts/area";
import { AreaChart } from "@/components/charts/area-chart";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { BarYAxis } from "@/components/charts/bar-y-axis";
import { FunnelChart } from "@/components/charts/funnel-chart";
import { Gauge } from "@/components/charts/gauge";
import { Grid } from "@/components/charts/grid";
import { Line } from "@/components/charts/line";
import { LineChart } from "@/components/charts/line-chart";
import { PieCenter } from "@/components/charts/pie-center";
import { PieChart } from "@/components/charts/pie-chart";
import { PieSlice } from "@/components/charts/pie-slice";
import { Ring } from "@/components/charts/ring";
import { RingCenter } from "@/components/charts/ring-center";
import { RingChart } from "@/components/charts/ring-chart";
import { SankeyChart, SankeyLink, SankeyNode, SankeyTooltip } from "@/components/charts/sankey";
import { ChartTooltip } from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import type { ViewProps } from "@/components/art/kinds";
import { Thumb } from "@/components/art/thumb";
import { useActiveTheme } from "@/hooks/use-theme";
import { type BerthChart, type ChartPlan, fmt, legend, parseChart, plan, series } from "@/lib/art/chart-spec";
import { chartVars } from "@/lib/art/theme";
import { cn } from "@/lib/utils";

// A berth.chart drawn with bklit UI's charts (components/charts), in the
// theme's colours: its tooltips render in a portal on <body>, so the
// --chart-* variables are set on the document as well as on the chart.
// Motion follows the person's reduced-motion setting.

// The size a thumbnail is drawn at before it is scaled down.
const THUMB_W = 560;

// It reads only the spec and the size it is drawn at, so a plugin's chart
// (plugins/ui.tsx's Chart) is drawn by the same code as an artifact's.
export default function ChartView({ body, size, height }: Pick<ViewProps, "body" | "size" | "height">) {
  const spec = useMemo(() => parseChart(body), [body]);
  const [box, width] = useWidth();
  useDocumentChartVars();
  if (!spec) return <Broken why="This chart's JSON doesn't parse." />;
  const p = plan(spec);
  if (size === "thumb") {
    const h = height ?? 120;
    // The funnel measures itself on screen, scaled or not: drawn at the
    // thumbnail's own size.
    if (p.type === "funnel")
      return (
        <div className="pointer-events-none" style={{ height: h }} aria-hidden>
          <MotionConfig reducedMotion="user">
            <Drawn spec={spec} p={p} thumb />
          </MotionConfig>
        </div>
      );
    return (
      <Thumb h={h} width={THUMB_W}>
        <div className="art-thumb-chart h-full">
          <MotionConfig reducedMotion="user">
            <Drawn spec={spec} p={p} thumb />
          </MotionConfig>
        </div>
      </Thumb>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3" data-chart-type={spec.type}>
      {(spec.subtitle || legend(spec).length > 0) && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {spec.subtitle && <p className="text-muted-foreground text-meta">{spec.subtitle}</p>}
          <Legend spec={spec} />
        </div>
      )}
      <div ref={box} className="relative max-h-[36rem] min-h-[14rem] flex-1">
        <div className="absolute inset-0">
          <MotionConfig reducedMotion="user">
            <Drawn spec={spec} p={narrowBars(p, width)} />
          </MotionConfig>
        </div>
      </div>
      <Changes spec={spec} />
      {spec.notes?.length ? (
        <ul className="list-disc ps-4 text-muted-foreground text-meta">
          {spec.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useWidth(): [React.RefCallback<HTMLDivElement>, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

// narrowBars lays a bar chart sideways when its categories' names wouldn't
// fit under the bars.
function narrowBars(p: ChartPlan, width: number): ChartPlan {
  if (p.type !== "bar" || p.horizontal || !width) return p;
  const longest = Math.max(...p.data.map((r) => String(r[p.x] ?? "").length));
  return longest * 7 + 16 > width / Math.max(1, p.data.length) ? { ...p, horizontal: true } : p;
}

// Reduce motion: bklit's charts are drawn at once. MotionConfig's
// reducedMotion keeps their fades and reveals (1.1s); this skips them.
if (typeof matchMedia !== "undefined") {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => {
    MotionGlobalConfig.skipAnimations = still.matches;
  };
  apply();
  still.addEventListener("change", apply);
}

// useDocumentChartVars puts the theme's chart variables on <html> while a
// chart is shown, for bklit's tooltips (portalled to <body>).
let users = 0;
function useDocumentChartVars() {
  const theme = useActiveTheme();
  useEffect(() => {
    const vars = chartVars(theme);
    const root = document.documentElement;
    users++;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      users--;
      if (users === 0) for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [theme]);
}

const fill = "h-full w-full";
const fillStyle = { aspectRatio: "auto", height: "100%" } as const;

function Drawn({ spec, p, thumb }: { spec: BerthChart; p: ChartPlan; thumb?: boolean }) {
  const units = spec.units;
  const margin = thumb ? { top: 12, right: 26, bottom: 28, left: 26 } : { top: 16, right: 16, bottom: 36, left: 16 };
  switch (p.type) {
    case "bar":
      return (
        <BarChart data={p.data} xDataKey={p.x} aspectRatio="auto" className={fill} stacked={p.stacked} orientation={p.horizontal ? "horizontal" : "vertical"} margin={p.horizontal ? { ...margin, right: 12, left: Math.round(Math.min(180, Math.max(60, Math.max(...p.data.map((r) => String(r[p.x] ?? "").length)) * (thumb ? 6.4 : 7.2) + 24))) } : margin} barGap={0.28}>
          <Grid horizontal={!p.horizontal} vertical={p.horizontal} />
          {p.series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} stroke={s.color} lineCap={4} animationType="grow" />
          ))}
          {p.horizontal ? <BarYAxis /> : <BarXAxis showAllLabels={p.data.length <= 8} />}
          {!thumb && <ChartTooltip />}
        </BarChart>
      );
    case "line":
      return (
        <LineChart data={p.data} aspectRatio="" className={fill} margin={margin}>
          <Grid horizontal />
          {p.series.map((s) => (
            <Line key={s.key} dataKey={s.key} stroke={s.color} strokeWidth={thumb ? 3 : 2.5} />
          ))}
          <XAxis numTicks={thumb ? 3 : 6} />
          {!thumb && <ChartTooltip />}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={p.data} aspectRatio="auto" className={fill} margin={margin}>
          <Grid horizontal />
          {p.series.map((s) => (
            <Area key={s.key} dataKey={s.key} fill={s.color} stroke={s.color} />
          ))}
          <XAxis numTicks={thumb ? 3 : 6} />
          {!thumb && <ChartTooltip />}
        </AreaChart>
      );
    case "funnel":
      return (
        <div className={cn(fill, "flex items-center justify-center")}>
          <FunnelChart data={p.stages} color={p.color} orientation="horizontal" showPercentage showValues showLabels={!thumb} formatValue={(v) => fmt(v, units)} style={{ ...fillStyle, maxHeight: "100%" }} className="max-h-full" />
        </div>
      );
    case "pie": {
      return (
        <div className={cn(fill, "flex items-center justify-center")}>
          <div className="aspect-square h-full max-h-full max-w-full">
            <PieChart data={p.slices} innerRadius={0} padAngle={0.01} cornerRadius={3} className={fill}>
              {p.slices.map((s, i) => (
                <PieSlice index={i} key={s.label} />
              ))}
              {!thumb && <PieCenter defaultLabel={units ? `Total, ${units}` : "Total"} />}
            </PieChart>
          </div>
        </div>
      );
    }
    case "ring":
      return (
        <div className={cn(fill, "flex items-center justify-center")}>
          <div className="aspect-square h-full max-h-full max-w-full">
            <RingChart data={p.rings} strokeWidth={thumb ? 16 : 22} ringGap={thumb ? 6 : 8} baseInnerRadius={thumb ? undefined : 96} className={fill}>
              {p.rings.map((r, i) => (
                <Ring index={i} key={r.label} />
              ))}
              {!thumb && <RingCenter defaultLabel={units ? `Total, ${units}` : "Total"} />}
            </RingChart>
          </div>
        </div>
      );
    case "sankey":
      return (
        <SankeyChart data={{ nodes: p.nodes.map((n) => ({ name: n.name })), links: p.links }} aspectRatio="auto" className={fill} margin={thumb ? { top: 8, right: 110, bottom: 8, left: 90 } : { top: 16, right: 150, bottom: 16, left: 120 }} nodeWidth={thumb ? 12 : 14} nodePadding={thumb ? 14 : 20}>
          <SankeyLink useGradient getNodeColor={(_, i) => p.nodes[i]?.color ?? "var(--chart-1)"} />
          <SankeyNode getNodeColor={(_, i) => p.nodes[i]?.color ?? "var(--chart-1)"} showValueLabels={false} />
          {!thumb && <SankeyTooltip />}
        </SankeyChart>
      );
    case "gauge":
      return (
        <div className={cn(fill, "flex items-center justify-center")}>
          <div className={cn("w-full", thumb ? "max-w-[19rem]" : "max-w-[34rem]")}>
            <Gauge value={p.percent} centerValue={p.value} defaultLabel={p.label} suffix={units === "%" ? "%" : units ? ` ${units}` : undefined} totalNotches={thumb ? 28 : 40} activeFill={p.color} minWidth={thumb ? 240 : 280} />
          </div>
        </div>
      );
    case "heatmap":
      return <Heatmap p={p} units={units} thumb={thumb} />;
  }
}

// Heatmap: a matrix of cells in bklit's scale colours, values printed.
function Heatmap({ p, units, thumb }: { p: Extract<ChartPlan, { type: "heatmap" }>; units?: string; thumb?: boolean }) {
  return (
    <div className={cn(fill, "overflow-auto")} data-heatmap>
      <table className={cn("art-heat w-full border-separate", thumb ? "border-spacing-[3px]" : "border-spacing-[3px]")}>
        <thead>
          <tr>
            <th aria-label="Row" />
            {p.cols.map((c) => (
              <th key={c} scope="col" className="art-tick px-0.5 pb-1 text-center font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r, ri) => (
            <tr key={r}>
              <th scope="row" className="art-tick whitespace-nowrap pe-2 text-end font-normal">
                {r}
              </th>
              {p.cols.map((c, ci) => {
                const v = p.cells[ri][ci];
                const lv = p.levels[ri][ci];
                return (
                  <td
                    key={c}
                    className="art-cell rounded-[4px] text-center tabular-nums"
                    data-level={lv}
                    aria-label={v === null ? `${r} at ${c}: no data` : `${r} at ${c}: ${fmt(v, units)}`}
                    style={{ background: lv < 0 ? "transparent" : `var(--chart-scale-0${lv + 1})`, color: `var(--chart-heat-ink-${lv + 1})`, animationDelay: `${Math.min(ri * 40 + ci * 12, 600)}ms` }}
                  >
                    {v === null ? "" : fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!thumb && (
        <div className="mt-2 flex items-center justify-end gap-1.5 text-tag text-muted-foreground">
          <span className="tabular-nums">{fmt(p.min, units)}</span>
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} className="h-2.5 w-5 rounded-[3px]" style={{ background: `var(--chart-scale-0${l})` }} />
          ))}
          <span className="tabular-nums">{fmt(p.max, units)}</span>
        </div>
      )}
    </div>
  );
}

function Legend({ spec }: { spec: BerthChart }) {
  const items = legend(spec);
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-meta" aria-label="Legend">
      {items.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// Changes: a two-series bar chart with a better direction lists each
// category's change, good or bad, under the chart.
function Changes({ spec }: { spec: BerthChart }) {
  if (spec.type !== "bar" || !spec.better) return null;
  const ss = series(spec);
  if (ss.length !== 2) return null;
  const [b, a] = ss;
  const x = spec.x ?? "x";
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Changes">
      {(spec.data ?? []).map((r) => {
        const from = Number(r[b.key]);
        const to = Number(r[a.key]);
        const d = from ? (to - from) / from : 0;
        const good = spec.better === "higher" ? d > 0 : d < 0;
        const flat = Math.abs(d) < 0.005;
        return (
          <li key={String(r[x])} className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-meta">
            <span className="text-muted-foreground">{String(r[x])}</span>
            <span className={cn("font-medium tabular-nums", flat ? "text-muted-foreground" : good ? "text-success-foreground" : "text-destructive-foreground")}>
              {flat ? "±0%" : `${d > 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}%`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Broken({ why }: { why: string }) {
  return <div className="flex h-full min-h-20 items-center justify-center rounded-md border border-dashed text-muted-foreground text-meta">{why}</div>;
}
