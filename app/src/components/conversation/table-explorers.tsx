import { ArrowDownIcon, ArrowUpIcon, BarChart3Icon, ListFilterIcon, Table2Icon } from "lucide-react";
import { lazy, type RefObject, Suspense, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Spinner } from "@/components/ui/spinner";
import { verdict } from "@/lib/art/table-data";
import { type ChatTableData, planChatTable, shownRows } from "@/lib/chat-table";
import { cn } from "@/lib/utils";
import "@/components/conversation/table-explorers.css";

const ChartView = lazy(() => import("@/components/art/views/chart-view"));

// A GFM table is kept whole: its links, formatting and Copy are still the
// Markdown's. A small toolbar adds an explored text table, with sorting and
// failure filtering, or a chart when its columns safely read as numbers.
interface TableBlock {
  key: number;
  frame: HTMLElement;
  host: HTMLElement;
  data: ChatTableData;
}

function readTable(table: HTMLTableElement): ChatTableData | undefined {
  const head = [...(table.tHead?.rows[0]?.cells ?? [])].map((c) => c.textContent?.trim() ?? "");
  const rows = [...(table.tBodies[0]?.rows ?? [])].map((r) => [...r.cells].map((c) => c.textContent?.trim() ?? ""));
  if (!head.length || rows.length < 2 || rows.length > 200) return undefined;
  return { head, rows };
}

export function TableExplorers({ body, html, draft }: { body: RefObject<HTMLElement | null>; html: string; draft: boolean }) {
  const [blocks, setBlocks] = useState<TableBlock[]>([]);
  useLayoutEffect(() => {
    const found: TableBlock[] = [];
    if (!draft) body.current?.querySelectorAll<HTMLElement>(".cv-table").forEach((frame, key) => {
      const table = frame.querySelector<HTMLTableElement>(":scope > table");
      const data = table && readTable(table);
      if (!data) return;
      const host = document.createElement("div");
      host.className = "cv-table-explorer";
      frame.prepend(host);
      found.push({ key, frame, host, data });
    });
    setBlocks((was) => (was.length || found.length ? found : was));
    return () => {
      for (const b of found) {
        b.host.remove();
        delete b.frame.dataset.tableMode;
      }
    };
  }, [body, html, draft]);
  return blocks.map((block) => <Explorer key={`${block.key}:${block.data.head.join("|")}:${block.data.rows.length}`} block={block} />);
}

type Mode = "original" | "table" | "chart";

function Explorer({ block }: { block: TableBlock }) {
  const [mode, setMode] = useState<Mode>("original");
  const [sort, setSort] = useState<{ index: number; descending: boolean }>();
  const [only, setOnly] = useState(false);
  const plan = useMemo(() => planChatTable(block.data), [block.data]);
  const rows = useMemo(() => shownRows(block.data, plan, sort, only), [block.data, plan, sort, only]);
  useLayoutEffect(() => {
    block.frame.dataset.tableMode = mode;
  }, [block, mode]);
  const chartBody = plan.chart && JSON.stringify(plan.chart);
  return createPortal(
    <>
      <div className="cv-table-toolbar">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground"><Table2Icon size={13} aria-hidden />{block.data.rows.length} rows</span>
        <span className="ml-auto inline-flex items-center gap-1">
          {mode !== "original" && <button type="button" onClick={() => setMode("original")} className="cv-table-action">Original</button>}
          {mode !== "table" && <button type="button" onClick={() => setMode("table")} className="cv-table-action"><ListFilterIcon size={12} aria-hidden /> Explore</button>}
          {chartBody && mode !== "chart" && <button type="button" onClick={() => setMode("chart")} className="cv-table-action"><BarChart3Icon size={12} aria-hidden /> Chart</button>}
          {mode === "table" && plan.failures > 0 && <button type="button" onClick={() => setOnly((v) => !v)} aria-pressed={only} className={cn("cv-table-action", only && "cv-table-action-on")}>Failures only</button>}
        </span>
      </div>
      {mode === "table" && (
        <div className="cv-table-explored" data-testid="chat-explored-table">
          <table>
            <thead><tr>{block.data.head.map((h, i) => <th key={`${h}-${i}`} scope="col" aria-sort={sort?.index === i ? sort.descending ? "descending" : "ascending" : undefined} className={plan.numeric[i] ? "text-right" : "text-left"}><button type="button" onClick={() => setSort((was) => ({ index: i, descending: was?.index === i ? !was.descending : false }))}>{h}{sort?.index === i && (sort.descending ? <ArrowDownIcon size={12} aria-hidden /> : <ArrowUpIcon size={12} aria-hidden />)}</button></th>)}</tr></thead>
            <tbody>{rows.map((row, ri) => <tr key={`${row.join("|")}-${ri}`} data-status={plan.status >= 0 ? verdict(row[plan.status] ?? "") : undefined}>{row.map((cell, ci) => <td key={ci} className={plan.numeric[ci] ? "text-right tabular-nums" : undefined}>{cell}</td>)}</tr>)}</tbody>
          </table>
          {only && !rows.length && <p className="p-3 text-center text-meta text-muted-foreground">No failed rows.</p>}
        </div>
      )}
      {mode === "chart" && chartBody && (
        <div className="cv-table-chart" data-testid="chat-table-chart">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-4" /></div>}>
            <ChartView body={chartBody} size="full" />
          </Suspense>
        </div>
      )}
    </>,
    block.host,
  );
}
