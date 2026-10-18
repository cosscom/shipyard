import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChatListApi } from "@/components/conversation/chat-list";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import "@/components/conversation/history.css";

// ChatSearch is ⌘F inside a conversation: it finds words across prompts,
// replies and the steps' targets (folded ones too, which open to the
// match), counts them, steps through them with Enter and ⇧Enter, and marks
// them where they are drawn. It starts at the latest match, nearest the
// foot, where the person usually is. It takes ⌘F only while its chat has the focus
// (or was last clicked), so a terminal pane keeps its own.

// SearchEntry is one item's searchable words, in the row that draws it;
// open names the folds that hide it.
export interface SearchEntry {
  row: number;
  item: string;
  text: string;
  open?: string[];
}

interface Hit {
  row: number;
  item: string;
  // Which match in its item.
  nth: number;
  open?: string[];
}

const HL = "chat-find";
const HL_NOW = "chat-find-now";
const MAX_HITS = 5000;

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): Highlights | undefined => (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

// entries gives what to look through: asked for only while search is open
// with words to find, so a closed search costs a long chat nothing.
export function ChatSearch({ api, entries, onReveal }: { api: ChatListApi; entries(): SearchEntry[]; onReveal(ids: string[]): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const pane = api.scroller?.parentElement ?? null;

  // ⌘F (Ctrl+F) when this chat has the focus or was the last thing clicked.
  const inside = useRef(false);
  useEffect(() => {
    if (!pane) return;
    const down = (e: PointerEvent) => {
      inside.current = pane.contains(e.target as Node);
    };
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.key.toLowerCase() !== "f" || e.shiftKey) return;
      const active = document.activeElement;
      const here = (active && active !== document.body ? pane.contains(active) : inside.current) && pane.isConnected && pane.offsetParent !== null;
      if (!here) return;
      e.preventDefault();
      e.stopPropagation();
      if (!open) back.current = active as HTMLElement | null;
      setOpen(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [pane, open]);

  const q = query.trim().toLowerCase();
  const hits = useMemo<Hit[]>(() => {
    if (!open || q.length < 1) return [];
    const out: Hit[] = [];
    for (const e of entries()) {
      const t = e.text.toLowerCase();
      let i = t.indexOf(q);
      let n = 0;
      while (i >= 0 && out.length < MAX_HITS) {
        out.push({ row: e.row, item: e.item, nth: n++, open: e.open });
        i = t.indexOf(q, i + q.length);
      }
      if (out.length >= MAX_HITS) break;
    }
    return out;
  }, [open, q, entries]);

  // A new search starts at the match nearest the foot: the latest.
  useEffect(() => {
    setAt(hits.length ? hits.length - 1 : 0);
    // Only when the words change, not as the chat grows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  const cur = hits[Math.min(at, hits.length - 1)];

  // Open what hides the match, bring its row into view, then mark it.
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useEffect(() => {
    if (!cur) {
      reveal.current([]);
      return;
    }
    reveal.current(cur.open ?? []);
    api.scrollToRow(cur.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.row, cur?.item, cur?.nth, open]);

  const paint = useCallback(() => {
    const hl = highlights();
    if (!hl || !Highlight) return;
    if (!open || !q) {
      hl.delete(HL);
      hl.delete(HL_NOW);
      return;
    }
    const all: Range[] = [];
    let now: Range | undefined;
    for (const { el } of api.drawn()) {
      for (const item of el.querySelectorAll<HTMLElement>("[data-item-id]")) {
        const ranges = rangesIn(item, q);
        all.push(...ranges);
        if (cur && item.dataset.itemId === cur.item && el.dataset.index === String(cur.row) && ranges.length) now = ranges[Math.min(cur.nth, ranges.length - 1)];
      }
    }
    hl.set(HL, new Highlight(...all));
    if (now) hl.set(HL_NOW, new Highlight(now));
    else hl.delete(HL_NOW);
    return now;
  }, [api, open, q, cur]);

  // Marks follow what is drawn: on every scroll and once the match's row
  // has drawn (and its fold opened), the current match centred.
  useLayoutEffect(() => {
    if (!open) return;
    let frames = 0;
    let raf = 0;
    const settle = () => {
      const now = paint();
      if (now && api.scroller) {
        const r = now.getBoundingClientRect();
        const box = api.scroller.getBoundingClientRect();
        if (r.top < box.top + 48 || r.bottom > box.bottom - 48) api.scroller.scrollTop += r.top - box.top - box.height / 2;
        return;
      }
      if (++frames < 30) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
  }, [open, paint, api]);
  useEffect(() => {
    const sc = api.scroller;
    if (!open || !sc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void paint());
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [open, paint, api.scroller]);
  useEffect(
    () => () => {
      highlights()?.delete(HL);
      highlights()?.delete(HL_NOW);
    },
    [],
  );

  const step = (d: number) => hits.length && setAt((a) => (Math.min(a, hits.length - 1) + d + hits.length) % hits.length);
  const close = () => {
    setOpen(false);
    reveal.current([]);
    highlights()?.delete(HL);
    highlights()?.delete(HL_NOW);
    const b = back.current;
    back.current = null;
    if (b?.isConnected) b.focus();
  };

  if (!open || !pane) return null;
  return createPortal(
    <div role="search" aria-label="Find in this chat" className="hs-find absolute top-3 right-6 z-20 flex h-9 w-[min(340px,calc(100%-48px))] items-center gap-1 rounded-lg border bg-popover pr-1 pl-2.5 text-popover-foreground shadow-lg/5">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" || (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey))) {
            // As in a terminal's find: from the foot, Enter goes up to older
            // matches and ⇧Enter comes back down.
            e.preventDefault();
            step(e.shiftKey ? 1 : -1);
          }
        }}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
      />
      <span aria-live="polite" className={cn("shrink-0 px-1 text-meta tabular-nums", q && !hits.length ? "text-destructive-foreground" : "text-muted-foreground")}>
        {q ? (hits.length ? `${Math.min(at, hits.length - 1) + 1} of ${hits.length >= MAX_HITS ? `${MAX_HITS}+` : hits.length}` : "No matches") : ""}
      </span>
      <Tip label={<span className="flex items-center gap-1.5">Older match <Kbd>↵</Kbd></span>}>
        <Button size="icon-xs" variant="ghost" aria-label="Older match" disabled={!hits.length} onClick={() => step(-1)}>
          <ChevronUpIcon />
        </Button>
      </Tip>
      <Tip label={<span className="flex items-center gap-1.5">Newer match <Kbd>⇧↵</Kbd></span>}>
        <Button size="icon-xs" variant="ghost" aria-label="Newer match" disabled={!hits.length} onClick={() => step(1)}>
          <ChevronDownIcon />
        </Button>
      </Tip>
      <Tip label={<span className="flex items-center gap-1.5">Close <Kbd>esc</Kbd></span>}>
        <Button size="icon-xs" variant="ghost" aria-label="Close search" onClick={close}>
          <XIcon />
        </Button>
      </Tip>
    </div>,
    pane,
  );
}

// rangesIn finds every match of q (lower case) in an element's text.
function rangesIn(root: HTMLElement, q: string): Range[] {
  const out: Range[] = [];
  // Not the controls drawn over the words (a code block's Copy).
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest("[data-copy-code],[aria-hidden=true]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.nodeValue ?? "").toLowerCase();
    let i = t.indexOf(q);
    while (i >= 0) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      out.push(r);
      i = t.indexOf(q, i + q.length);
    }
  }
  return out;
}

// searchText is an item's words as drawn: Markdown without its marks.
export function plainMarkdown(md: string): string {
  return md
    .replace(/```[^\n]*\n/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/^\|?[\s:|-]+\|?$/gm, "")
    .replace(/\|/g, " ");
}
