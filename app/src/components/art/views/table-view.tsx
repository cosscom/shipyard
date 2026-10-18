import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ViewProps } from "@/components/art/kinds";
import { Thumb } from "@/components/art/thumb";
import { parseTable, verdict } from "@/lib/art/table-data";
import { cn } from "@/lib/utils";

// A table artifact: CSV, TSV or JSON rows, as text. A status column
// colours its rows (failures stand out, skips go quiet) and can be
// filtered to failures; numbers align right; headers sort.

const isNum = (s: string) => s.trim() !== "" && !Number.isNaN(Number(s));

function cellText(col: string, v: string): string {
  if (isNum(v) && /_ms$/i.test(col)) {
    const n = Number(v);
    return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
  }
  return isNum(v) && Math.abs(Number(v)) >= 1000 ? Number(v).toLocaleString("en-US") : v;
}

const header = (c: string) => c.replace(/_ms$/i, "").replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase());
const rank = (v: string) => (verdict(v) === "fail" ? 0 : verdict(v) === "skip" ? 2 : 1);

export default function TableView({ art, body, size, height }: ViewProps) {
  const t = useMemo(() => parseTable(body, art.format), [body, art.format]);
  if (size === "thumb")
    return (
      <Thumb h={height ?? 120} width={620}>
        <Table t={t} thumb />
      </Thumb>
    );
  return <Table t={t} />;
}

function Table({ t, thumb }: { t: ReturnType<typeof parseTable>; thumb?: boolean }) {
  const { head, rows, status: si } = t;
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(si >= 0 ? { i: si, dir: 1 } : null);
  const [only, setOnly] = useState(false);
  const shown = useMemo(() => {
    let out = rows;
    if (only && si >= 0) out = out.filter((r) => verdict(r[si] ?? "") === "fail");
    if (sort) {
      const { i, dir } = sort;
      out = [...out].sort((a, b) => {
        const x = a[i] ?? "";
        const y = b[i] ?? "";
        if (i === si) return (rank(x) - rank(y)) * dir;
        if (isNum(x) && isNum(y)) return (Number(x) - Number(y)) * dir;
        return x.localeCompare(y) * dir;
      });
    }
    return out;
  }, [rows, only, si, sort]);
  const counts = si >= 0 ? { fail: rows.filter((r) => verdict(r[si] ?? "") === "fail").length, pass: rows.filter((r) => verdict(r[si] ?? "") === "pass").length, skip: rows.filter((r) => verdict(r[si] ?? "") === "skip").length } : undefined;
  const numeric = head.map((_, i) => rows.length > 0 && rows.every((r) => (r[i] ?? "") === "" || isNum(r[i] ?? "")));
  const limit = thumb ? 8 : 2000;
  if (!head.length) return <div className="flex h-full items-center justify-center text-muted-foreground text-meta">This table has no rows.</div>;
  return (
    <div className={cn("flex h-full min-h-0 flex-col", thumb && "pointer-events-none")} data-art-table>
      {counts && !thumb && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-meta">
          <span className="text-muted-foreground tabular-nums">{rows.length.toLocaleString("en-US")} rows</span>
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="size-2 rounded-full bg-[var(--chart-good)]" aria-hidden />
            {counts.pass} passed
          </span>
          <span className={cn("inline-flex items-center gap-1.5 tabular-nums", counts.fail > 0 && "font-medium text-destructive-foreground")}>
            <span className="size-2 rounded-full bg-[var(--chart-bad)]" aria-hidden />
            {counts.fail} failed
          </span>
          {counts.skip > 0 && <span className="text-muted-foreground tabular-nums">{counts.skip} skipped</span>}
          {counts.fail > 0 && (
            <button type="button" onClick={() => setOnly((o) => !o)} aria-pressed={only} className={cn("ml-auto rounded-md border px-2 py-0.5 text-meta", only ? "border-transparent bg-destructive/15 text-destructive-foreground" : "text-muted-foreground hover:bg-accent")}>
              Failures only
            </button>
          )}
        </div>
      )}
      <div className={cn("min-h-0 flex-1 rounded-md border", thumb ? "overflow-hidden" : "overflow-auto")}>
        <table className={cn("w-full border-collapse", thumb ? "text-tag leading-4" : "text-meta")}>
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
            <tr>
              {head.map((c, i) => (
                <th key={`${c}-${i}`} scope="col" aria-sort={sort?.i === i ? (sort.dir === 1 ? "ascending" : "descending") : undefined} className={cn("whitespace-nowrap border-b px-2 font-medium text-muted-foreground", thumb ? "py-1" : "py-1.5", numeric[i] ? "text-right" : "text-left")}>
                  {thumb ? (
                    header(c)
                  ) : (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ i, dir: s?.i === i ? (-s.dir as 1 | -1) : 1 }))}>
                      {header(c)}
                      {sort?.i === i && (sort.dir === 1 ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r, k) => {
              const st = si >= 0 ? verdict(r[si] ?? "") : undefined;
              return (
                <tr key={k} data-verdict={st} className={cn("border-b last:border-b-0", st === "fail" && "bg-[color-mix(in_oklab,var(--chart-bad)_11%,transparent)]", st === "skip" && "text-muted-foreground")}>
                  {head.map((col, i) => {
                    const v = r[i] ?? "";
                    return (
                      <td key={i} className={cn("px-2 align-top", thumb ? "py-1" : "py-1.5", numeric[i] && "text-right tabular-nums", i === si && "whitespace-nowrap", !thumb && i !== si && !numeric[i] && "max-w-[24rem]")}>
                        {i === si ? (
                          <span className={cn("inline-flex items-center gap-1 font-medium", st === "fail" ? "text-destructive-foreground" : st === "pass" ? "text-success-foreground" : "text-muted-foreground")}>
                            <span className={cn("size-1.5 rounded-full", st === "fail" ? "bg-[var(--chart-bad)]" : st === "pass" ? "bg-[var(--chart-good)]" : "bg-muted-foreground/50")} aria-hidden />
                            {v}
                          </span>
                        ) : (
                          <span className={cn(!thumb && "line-clamp-3 break-words", st === "fail" && /note|message|error|reason/i.test(col) && "text-destructive-foreground")}>{cellText(col, v)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length > limit && !thumb && <div className="pt-1.5 text-muted-foreground text-meta">and {(shown.length - limit).toLocaleString("en-US")} more rows; the source has them all</div>}
    </div>
  );
}
