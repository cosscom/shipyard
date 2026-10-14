import { defaultRangeExtractor, type Range, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// ChatList draws a conversation's rows in its pane's scroller, only those
// near the view (a long chat holds thousands), each measured as it draws.
// It keeps to the foot while new work arrives, unless the person has
// scrolled up to read; rows added above (older turns) leave what they read
// where it was, as does a row above the view that grows or shrinks (a fold
// opened, a code block coloured). A row seen before draws without its
// entrance motion.
//
// Words selected in it stay selectable as it scrolls: while a selection is
// in the chat, every row from where it starts to where it ends stays drawn
// (up to HOLD_MAX rows), so dragging or Shift-clicking past the screen
// selects, and copies, all of them. Rows beyond that are not drawn, so ⌘A
// takes the rows drawn; each reply's own Copy takes all of its words.
//
// For assistive technology it is a list: each row a list item that says
// where it is in the whole conversation, drawn or not.

export interface ChatListApi {
  // Bring a row to the middle of the view.
  scrollToRow(index: number): void;
  scroller: HTMLElement | null;
  // The rows drawn now, by index.
  drawn(): { index: number; el: HTMLElement }[];
  virtualizer: Virtualizer<HTMLElement, Element>;
}

export interface ChatListProps<T> {
  rows: T[];
  rowKey(row: T): string;
  // A first guess at a row's height, until it is drawn.
  estimate(row: T): number;
  render(row: T, index: number): ReactNode;
  // Above the rows (older turns loading) and after them (queued prompts).
  header?: ReactNode;
  tail?: ReactNode;
  // Changes when the last row grows (streamed words), to keep to the foot.
  grew?: unknown;
  // Changes when the person sends something: back to the foot.
  repin?: unknown;
  // The person scrolled near the top.
  onNearTop?(): void;
  // Parts that need the list (search).
  children?(api: ChatListApi): ReactNode;
  className?: string;
}

const GAP = 16;
// The most rows a selection keeps drawn, from its start to its end.
const HOLD_MAX = 1000;

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
// Far enough up to read before older turns are fetched.
const NEAR_TOP = 900;

export function ChatList<T>({ rows, rowKey, estimate, render, header, tail, grew, repin, onNearTop, children, className }: ChatListProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => setScroller(root.current?.closest<HTMLElement>(".overflow-y-auto") ?? null), []);

  // Where the rows start in the scroller: below its padding and the header.
  useLayoutEffect(() => {
    const sc = scroller;
    const el = top.current;
    if (!sc || !el) return;
    const measure = () => {
      // DOM scroll offsets use layout pixels; rects use screen pixels and
      // include a canvas node's zoom transform. Keep both in the same units.
      const rect = sc.getBoundingClientRect();
      const scale = sc.offsetHeight ? rect.height / sc.offsetHeight : 1;
      setMargin(Math.round((el.getBoundingClientRect().bottom - rect.top) / scale + sc.scrollTop));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);

  // The virtualizer works out every row's place again whenever its key
  // function changes: that is a new one only when the rows' keys changed,
  // not each time a row's content does (a draft's words, every 600ms).
  const keys = useMemo(() => rows.map(rowKey), [rows, rowKey]);
  const keyOf = useRef<{ keys: string[]; fn(i: number): string }>(null);
  if (!keyOf.current || !sameKeys(keyOf.current.keys, keys)) keyOf.current = { keys, fn: (i) => keys[i] };
  const latest = useRef(rows);
  latest.current = rows;
  const guess = useRef(estimate);
  guess.current = estimate;
  const estimateSize = useCallback((i: number) => guess.current(latest.current[i]), []);

  // The rows a selection starts and ends in, by key, while there is one.
  const [held, setHeld] = useState<{ from: string; to: string }>();
  useEffect(() => {
    const rowOf = (n: Node | null) => {
      const el = n instanceof Element ? n : n?.parentElement;
      const row = el?.closest<HTMLElement>("[data-chat-row]");
      return row && root.current?.contains(row) ? row.dataset.chatRow : undefined;
    };
    const on = () => {
      const sel = document.getSelection();
      const from = sel && !sel.isCollapsed ? rowOf(sel.anchorNode) : undefined;
      const to = sel && !sel.isCollapsed ? rowOf(sel.focusNode) : undefined;
      // A selection whose end is outside the rows (dragged onto the header
      // or the reply box) holds from its start.
      setHeld((h) => (!from ? undefined : h?.from === from && h.to === (to ?? from) ? h : { from, to: to ?? from }));
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  const heldAt = useMemo(() => {
    if (!held) return undefined;
    const a = keys.indexOf(held.from);
    const b = keys.indexOf(held.to);
    return a < 0 ? undefined : [a, b < 0 ? a : b] as const;
  }, [held, keys]);
  const rangeExtractor = useCallback(
    (r: Range) => {
      const drawn = defaultRangeExtractor(r);
      if (!heldAt) return drawn;
      const lo = Math.min(heldAt[0], heldAt[1], r.startIndex);
      const hi = Math.max(heldAt[0], heldAt[1], r.endIndex);
      if (hi - lo <= HOLD_MAX) return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      return [...new Set([...drawn, heldAt[0], heldAt[1]])].sort((x, y) => x - y);
    },
    [heldAt],
  );

  const v = useVirtualizer<HTMLElement, Element>({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize,
    getItemKey: keyOf.current.fn,
    rangeExtractor,
    overscan: 6,
    gap: GAP,
    scrollMargin: margin,
    // Rows added above keep the row being read in place.
    anchorTo: "end",
  });

  // Following the foot: true until the person scrolls up to read.
  const pinned = useRef(true);
  const userAt = useRef(0);
  // A canvas node can change width without a window resize. The old row
  // measurements then describe a different line wrap, so the virtualizer can
  // draw rows far above the visible part of a long conversation.
  useEffect(() => {
    const sc = scroller;
    if (!sc) return;
    let width = sc.clientWidth;
    const ro = new ResizeObserver(() => {
      if (sc.clientWidth === width) return;
      width = sc.clientWidth;
      v.measure();
      if (pinned.current) requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
    });
    ro.observe(sc);
    return () => ro.disconnect();
  }, [scroller, v]);
  const nearTop = useRef(onNearTop);
  nearTop.current = onNearTop;
  useEffect(() => {
    const sc = scroller;
    if (!sc) return;
    const user = () => {
      userAt.current = Date.now();
    };
    const onScroll = () => {
      const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      if (near) pinned.current = true;
      else if (Date.now() - userAt.current < 1000) pinned.current = false;
      if (!pinned.current && sc.scrollTop < NEAR_TOP) nearTop.current?.();
    };
    const opts = { passive: true };
    sc.addEventListener("scroll", onScroll, opts);
    for (const e of ["wheel", "touchmove", "pointerdown", "keydown"]) sc.addEventListener(e, user, opts);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      for (const e of ["wheel", "touchmove", "pointerdown", "keydown"]) sc.removeEventListener(e, user);
    };
  }, [scroller]);

  // Whatever changes the height (a row measured, words streamed, a queued
  // prompt) keeps a pinned view at the foot; a fold the person just opened
  // doesn't pull the view away from it.
  useEffect(() => {
    const sc = scroller;
    const el = root.current;
    if (!sc || !el) return;
    const stick = () => {
      if (pinned.current && Date.now() - userAt.current > 600) sc.scrollTop = sc.scrollHeight;
    };
    stick();
    const ro = new ResizeObserver(stick);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);
  useLayoutEffect(() => {
    if (pinned.current && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [scroller, rows.length, grew]);
  useLayoutEffect(() => {
    if (repin === undefined || !scroller) return;
    pinned.current = true;
    scroller.scrollTop = scroller.scrollHeight;
  }, [repin, scroller]);

  // Rows already seen draw still; only rows new since the list opened move in.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(rows.map(rowKey));
  const items = v.getVirtualItems();
  useEffect(() => {
    for (const vi of items) seen.current!.add(String(vi.key));
  });

  const api: ChatListApi = {
    scrollToRow: (i) => {
      pinned.current = false;
      userAt.current = Date.now();
      v.scrollToIndex(i, { align: "center" });
    },
    scroller,
    drawn: () => {
      const out: { index: number; el: HTMLElement }[] = [];
      root.current?.querySelectorAll<HTMLElement>("[data-chat-row]").forEach((el) => out.push({ index: Number(el.dataset.index), el }));
      return out;
    },
    virtualizer: v,
  };

  return (
    <div ref={root} className={cn("flex flex-col", className)}>
      <div ref={top}>{header}</div>
      <div role="list" aria-label="Conversation" className="relative w-full" style={{ height: v.getTotalSize() }}>
        {items.map((vi) => {
          const key = String(vi.key);
          return (
            <div
              key={key}
              role="listitem"
              aria-posinset={vi.index + 1}
              aria-setsize={rows.length}
              data-chat-row={key}
              data-index={vi.index}
              ref={v.measureElement}
              className={cn("absolute top-0 left-0 flex w-full flex-col gap-4", seen.current!.has(key) && "cv-still")}
              style={{ transform: `translateY(${vi.start - margin}px)` }}
            >
              <Row row={rows[vi.index]} index={vi.index} render={render as (r: unknown, i: number) => ReactNode} />
            </div>
          );
        })}
      </div>
      {tail && <div className="mt-4 flex flex-col gap-4">{tail}</div>}
      {children?.(api)}
    </div>
  );
}

// Row draws one row, again only when it or how rows draw changes: scrolling
// moves rows without drawing them anew.
const Row = memo(function Row({ row, index, render }: { row: unknown; index: number; render(row: unknown, index: number): ReactNode }) {
  return render(row, index);
});
