import { Icon, Tip, cn } from "@berth/plugin/ui";
import { memo, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Cell, ForeignKey, Order } from "./api";
import { editText, type Family, isLong, parseInput, show } from "./engines/families.ts";

// The grid a table's rows and a statement's results are drawn in.
//
// A page is up to 500 rows of 40 columns or more: 20,000 cells, which no
// browser lays out or scrolls well. So, as the app's own long list does (the
// chat, on @tanstack/react-virtual), only the rows near the view are in the
// page. Here every row is one height and every column one width, worked out
// from its type before anything is drawn, so which rows are in view is
// arithmetic on the scroll position: no measuring, nothing that jumps as
// rows arrive, and the table never lays out again as it scrolls. The header
// stays put (position: sticky) and the rows above and below the view are
// one empty row each, as tall as the rows they stand for.

export interface GridColumn {
  name: string;
  type: string;
  family: Family;
  // Part of the primary key.
  key?: boolean;
  // The foreign key it is part of: its cells jump to the row they point at.
  fk?: ForeignKey;
  nullable?: boolean;
  // The database always fills it in (an identity, a computed column): it
  // takes no value from an edit.
  generated?: boolean;
}

export interface GridRow {
  // What the row is called: its key, or a new row's name.
  id: string;
  // Its cells as they are shown, staged changes and all.
  cells: Cell[];
  // Its place in what was read, for a row that was.
  ref?: number;
  state?: "new" | "deleted" | "gone";
  // The columns with a staged change, by index.
  changed?: ReadonlySet<number>;
  // A new row's columns nothing was typed in: they take their default.
  unset?: ReadonlySet<number>;
  // The cells that arrived cut short.
  cut?: ReadonlySet<number>;
}

export interface GridProps {
  label: string;
  columns: GridColumn[];
  rows: GridRow[];
  // The number of the first row, for the margin.
  offset?: number;
  order?: Order[];
  onSort?(column: string): void;
  onFilter?(column: string): void;
  // Whether a cell takes an edit; without it nothing does.
  canEdit?(row: GridRow, col: number): boolean;
  onEdit?(row: GridRow, col: number, value: Cell): void;
  // Shows a cell's whole value.
  onView(row: GridRow, col: number): void;
  onJump?(row: GridRow, col: number): void;
  // Rows that can be picked, and the ones that are.
  picked?: ReadonlySet<string>;
  canPick?(row: GridRow): boolean;
  onPick?(ids: string[], on: boolean): void;
}

const ROW = 30;
const HEAD = 44;
const MARGIN = 52;
// Rows kept ready either side of the view.
const SPARE = 10;

const WIDTH: Record<Family, number> = { integer: 96, decimal: 116, boolean: 88, uuid: 292, time: 232, json: 280, text: 232, binary: 208, array: 208, other: 168 };

const widthOf = (c: GridColumn) => Math.round(Math.min(380, Math.max(WIDTH[c.family], c.name.length * 7.8 + 64, c.type.length * 6.4 + 28)));

interface Sel {
  row: number;
  col: number;
}

export function Grid({ label, columns, rows, offset = 0, order, onSort, onFilter, canEdit, onEdit, onView, onJump, picked, canPick, onPick }: GridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [sel, setSel] = useState<Sel>();
  const [editing, setEditing] = useState(false);
  // The next selection takes the keyboard's focus with it.
  const follow = useRef(false);
  const widths = useMemo(() => columns.map(widthOf), [columns]);
  const total = MARGIN + widths.reduce((a, b) => a + b, 0);
  const pickable = !!onPick;

  // What every row is handed, without changing between draws.
  const latest = useRef({ rows, columns, canEdit, onEdit, onView, onJump, onPick });
  latest.current = { rows, columns, canEdit, onEdit, onView, onJump, onPick };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Other rows: the selection is about the ones that were there.
  const shape = `${rows.length}:${columns.length}:${rows[0]?.id ?? ""}`;
  // They start from their top: another page, another order.
  useEffect(() => {
    setSel(undefined);
    setEditing(false);
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [shape]);

  const first = Math.max(0, Math.floor(view.top / ROW) - SPARE);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + SPARE);

  const reveal = useCallback(
    (s: Sel) => {
      const el = scroller.current;
      if (!el) return;
      const top = s.row * ROW;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW > el.scrollTop + el.clientHeight - HEAD) el.scrollTop = top + ROW - el.clientHeight + HEAD;
      const left = widths.slice(0, s.col).reduce((a, b) => a + b, MARGIN);
      if (left - MARGIN < el.scrollLeft) el.scrollLeft = left - MARGIN;
      else if (left + widths[s.col] > el.scrollLeft + el.clientWidth) el.scrollLeft = left + widths[s.col] - el.clientWidth;
    },
    [widths],
  );

  useEffect(() => {
    if (!sel || editing || !follow.current) return;
    follow.current = false;
    scroller.current?.querySelector<HTMLElement>(`[data-cell="${sel.row}:${sel.col}"]`)?.focus({ preventScroll: true });
  }, [sel, editing, first, last]);

  const move = (to: Sel) => {
    const next = { row: Math.max(0, Math.min(rows.length - 1, to.row)), col: Math.max(0, Math.min(columns.length - 1, to.col)) };
    follow.current = true;
    reveal(next);
    setSel(next);
  };

  // Enter on a cell: edit it where that is allowed, otherwise show it whole.
  const act = useCallback((s: Sel) => {
    const l = latest.current;
    const row = l.rows[s.row];
    if (!row) return;
    if (l.onEdit && l.canEdit?.(row, s.col)) setEditing(true);
    else l.onView(row, s.col);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (editing || !sel || !(e.target as HTMLElement).matches("[data-cell]")) return;
    const page = Math.max(1, Math.floor((view.height - HEAD) / ROW) - 1);
    const steps: Record<string, Sel> = {
      ArrowUp: { row: sel.row - 1, col: sel.col },
      ArrowDown: { row: sel.row + 1, col: sel.col },
      ArrowLeft: { row: sel.row, col: sel.col - 1 },
      ArrowRight: { row: sel.row, col: sel.col + 1 },
      PageUp: { row: sel.row - page, col: sel.col },
      PageDown: { row: sel.row + page, col: sel.col },
      Home: { row: e.metaKey || e.ctrlKey ? 0 : sel.row, col: 0 },
      End: { row: e.metaKey || e.ctrlKey ? rows.length - 1 : sel.row, col: columns.length - 1 },
    };
    if (steps[e.key]) {
      e.preventDefault();
      move(steps[e.key]);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      act(sel);
    } else if (e.key === " ") {
      e.preventDefault();
      const row = rows[sel.row];
      if (row) onView(row, sel.col);
    }
  };

  const select = useCallback((row: number, col: number) => {
    setEditing(false);
    setSel({ row, col });
  }, []);
  const open = useCallback(
    (row: number, col: number) => {
      setSel({ row, col });
      act({ row, col });
    },
    [act],
  );
  const commit = useCallback((row: number, col: number, value: Cell) => {
    const l = latest.current;
    if (l.rows[row]) l.onEdit?.(l.rows[row], col, value);
    follow.current = true;
    setEditing(false);
  }, []);
  const cancel = useCallback(() => {
    follow.current = true;
    setEditing(false);
  }, []);
  const view1 = useCallback((row: number, col: number) => latest.current.rows[row] && latest.current.onView(latest.current.rows[row], col), []);
  const jump = useCallback((row: number, col: number) => latest.current.rows[row] && latest.current.onJump?.(latest.current.rows[row], col), []);
  const pick = useCallback((row: number, on: boolean) => latest.current.rows[row] && latest.current.onPick?.([latest.current.rows[row].id], on), []);

  const pickables = useMemo(() => (pickable ? rows.filter((r) => canPick?.(r) ?? true).map((r) => r.id) : []), [rows, pickable, canPick]);
  const allPicked = pickables.length > 0 && pickables.every((id) => picked?.has(id));

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto overscroll-contain bg-pane" data-testid="database-grid" onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <table role="grid" aria-label={label} aria-readonly={!onEdit} aria-rowcount={rows.length + 1} aria-colcount={columns.length + 1} className="border-separate border-spacing-0 text-sm" style={{ tableLayout: "fixed", width: total }}>
        <colgroup>
          <col style={{ width: MARGIN }} />
          {widths.map((w, i) => (
            <col key={columns[i].name + i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr aria-rowindex={1} style={{ height: HEAD }}>
            <th scope="col" className="sticky top-0 left-0 z-30 border-r border-b bg-background vibrancy:bg-(--content-solid) px-2 text-center font-normal text-muted-foreground text-xs">
              {pickable && pickables.length > 0 ? (
                <input type="checkbox" className="size-3.5 cursor-pointer align-middle accent-primary" aria-label={allPicked ? "Pick no rows" : "Pick every row on this page"} checked={allPicked} onChange={(e) => onPick?.(pickables, e.target.checked)} />
              ) : (
                <span aria-hidden>#</span>
              )}
              {!pickable && <span className="sr-only">Row</span>}
            </th>
            {columns.map((c, i) => {
              const by = order?.find((o) => o.column === c.name);
              return (
                <th key={c.name + i} scope="col" aria-colindex={i + 2} aria-sort={by ? (by.desc ? "descending" : "ascending") : onSort ? "none" : undefined} className="group/head sticky top-0 z-20 border-r border-b bg-background vibrancy:bg-(--content-solid) px-2 text-left align-middle font-normal">
                  <div className="flex items-center gap-1">
                    {onSort ? (
                      <button type="button" onClick={() => onSort(c.name)} className={cn("flex min-w-0 items-center gap-1 rounded-sm font-medium text-[13px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", by ? "text-foreground" : "text-foreground/90")}>
                        {c.key && <Icon name="KeyRound" className="size-3 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{c.name}</span>
                        {by && <Icon name={by.desc ? "ArrowDown" : "ArrowUp"} className="size-3 shrink-0" />}
                      </button>
                    ) : (
                      <span className="truncate font-medium text-[13px]">{c.name}</span>
                    )}
                    {onFilter && (
                      <Tip label={`Filter by ${c.name}`}>
                        <button type="button" aria-label={`Filter by ${c.name}`} onClick={() => onFilter(c.name)} className="-mr-1 ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/head:opacity-100">
                          <Icon name="ListFilter" className="size-3" />
                        </button>
                      </Tip>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground leading-4">
                    {c.type}
                    {c.fk && <span> → {c.fk.ref_table}</span>}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {first > 0 && (
            <tr aria-hidden style={{ height: first * ROW }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
          {rows.slice(first, last).map((r, i) => {
            const at = first + i;
            const on = sel?.row === at;
            return (
              <RowView
                key={r.id}
                at={at}
                number={r.state === "new" ? 0 : offset + (r.ref ?? at) + 1}
                row={r}
                columns={columns}
                sel={on ? sel.col : -1}
                // The first cell takes Tab when nothing is selected.
                tab={!sel && at === first ? 0 : -1}
                editing={on && editing}
                picked={pickable && (canPick?.(r) ?? true) ? !!picked?.has(r.id) : undefined}
                select={select}
                open={open}
                view={view1}
                jump={onJump ? jump : undefined}
                pick={pick}
                commit={commit}
                cancel={cancel}
              />
            );
          })}
          {last < rows.length && (
            <tr aria-hidden style={{ height: (rows.length - last) * ROW }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  at: number;
  number: number;
  row: GridRow;
  columns: GridColumn[];
  sel: number;
  tab: number;
  editing: boolean;
  // undefined: this row can't be picked.
  picked?: boolean;
  select(row: number, col: number): void;
  open(row: number, col: number): void;
  view(row: number, col: number): void;
  jump?(row: number, col: number): void;
  pick(row: number, on: boolean): void;
  commit(row: number, col: number, value: Cell): void;
  cancel(): void;
}

const RowView = memo(function RowView({ at, number, row, columns, sel, tab, editing, picked, select, open, view, jump, pick, commit, cancel }: RowProps) {
  const gone = row.state === "deleted" || row.state === "gone";
  return (
    <tr aria-rowindex={at + 2} data-testid="database-row" data-row={row.id} data-state={row.state} style={{ height: ROW }} className={cn(row.state === "new" && "bg-success/8", gone && "bg-destructive/8")}>
      {/* Opaque, as rows scroll under it: the row's tint, mixed with the page. */}
      <td
        role="rowheader"
        className={cn(
          "sticky left-0 z-10 border-r border-b bg-background vibrancy:bg-(--content-solid) px-2 text-center text-muted-foreground text-xs tabular-nums",
          row.state === "new" && "bg-[color-mix(in_oklab,var(--success)_8%,var(--background))]",
          // A row that is gone, by this edit or by something else's, looks the same: it is not there.
          gone && "bg-[color-mix(in_oklab,var(--destructive)_8%,var(--background))]",
        )}
      >
        {picked !== undefined ? (
          <input type="checkbox" className="size-3.5 cursor-pointer align-middle accent-primary" aria-label={row.state === "new" ? "Pick the new row" : `Pick row ${number}`} checked={picked} onChange={(e) => pick(at, e.target.checked)} />
        ) : row.state === "new" ? (
          <span className="font-medium text-success-foreground">new</span>
        ) : (
          number
        )}
      </td>
      {columns.map((c, col) => {
        const on = sel === col;
        const cell = row.cells[col] ?? null;
        const unset = row.unset?.has(col);
        const cut = row.cut?.has(col);
        const shown = show(cell, c.family);
        const changed = row.changed?.has(col);
        const more = cut || isLong(cell);
        const points = !!jump && !!c.fk && cell !== null && row.state !== "new";
        return (
          <td
            key={c.name + col}
            role="gridcell"
            aria-colindex={col + 2}
            aria-selected={on}
            data-cell={`${at}:${col}`}
            data-col={c.name}
            data-changed={changed || undefined}
            // While it is typed in, the box inside it is what takes the keyboard.
            tabIndex={on ? (editing ? undefined : 0) : col === 0 ? tab : -1}
            onClick={() => select(at, col)}
            onFocus={() => !on && select(at, col)}
            onDoubleClick={() => open(at, col)}
            className={cn(
              "relative border-r border-b px-2 font-mono text-xs outline-none",
              // Changed, as the File tab marks a changed line: the whole cell, tinted.
              changed && "bg-info/14",
              on && "z-[5] shadow-[inset_0_0_0_2px_var(--ring)]",
              shown.right && "text-right tabular-nums",
              gone && "text-muted-foreground line-through",
            )}
          >
            {on && editing ? (
              <CellEditor initial={unset ? "" : editText(cell)} column={c} onCommit={(v) => commit(at, col, v)} onCancel={cancel} />
            ) : (
              <span className="flex items-center gap-1">
                <span className={cn("min-w-0 flex-1 truncate", (shown.kind !== "value" || unset) && "font-sans text-[11px] text-muted-foreground italic")}>{unset ? (c.generated ? "generated" : "default") : shown.text}</span>
                {more && (
                  <Tip label={cut ? "Cut at 4,000 characters: show what was read" : "Show the whole value"}>
                    <button type="button" tabIndex={on ? 0 : -1} aria-label={`Show the whole value of ${c.name}`} onClick={(e) => (e.stopPropagation(), view(at, col))} className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      <Icon name={cut ? "Scissors" : "maximize-2"} className="size-3" />
                    </button>
                  </Tip>
                )}
                {points && (
                  <Tip label={`Open the row in ${c.fk!.ref_table}`}>
                    <button type="button" tabIndex={on ? 0 : -1} aria-label={`Open the row in ${c.fk!.ref_table} that ${c.name} points at`} onClick={(e) => (e.stopPropagation(), jump!(at, col))} className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      <Icon name="ArrowUpRight" className="size-3" />
                    </button>
                  </Tip>
                )}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
});

// CellEditor is a cell while it is typed in. Enter keeps what was typed,
// Escape leaves the cell as it was, and NULL is its own button: an empty box
// is the empty string in a text column and not a value in any other.
function CellEditor({ initial, column, onCommit, onCancel }: { initial: string; column: GridColumn; onCommit(value: Cell): void; onCancel(): void }) {
  const [text, setText] = useState(initial);
  const [why, setWhy] = useState<string>();
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const keep = (leaving: boolean) => {
    if (done.current) return;
    const parsed = parseInput(text, column.family);
    if (parsed.ok) {
      done.current = true;
      onCommit(parsed.value);
    } else if (leaving) {
      done.current = true;
      onCancel();
    } else setWhy(parsed.why);
  };
  return (
    <span className="-mx-1 flex items-center gap-1">
      <input
        ref={input}
        value={text}
        aria-label={`${column.name}, ${column.type}`}
        aria-invalid={!!why}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => (setText(e.target.value), setWhy(undefined))}
        onBlur={() => keep(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") keep(false);
          else if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 font-mono text-xs outline-none focus:border-ring aria-invalid:border-destructive"
      />
      {column.nullable && (
        <button
          type="button"
          // Before the input's blur, which would keep what was typed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            done.current = true;
            onCommit(null);
          }}
          className="h-6 shrink-0 rounded-sm border border-input bg-background px-1.5 font-sans text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Set NULL
        </button>
      )}
      {why && (
        <span role="alert" className="absolute top-full left-0 z-20 mt-px whitespace-nowrap rounded-md border bg-popover px-2 py-1 font-sans text-destructive-foreground text-xs shadow-md">
          {why}
        </span>
      )}
    </span>
  );
}
