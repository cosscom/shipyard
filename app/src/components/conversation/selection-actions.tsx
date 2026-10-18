import { ArrowUpIcon, TextQuoteIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChatListApi } from "@/components/conversation/chat-list";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { canQuote, quoted, quoteInto } from "@/lib/chat-quote";

// SelectionActions is what words selected in a chat offer: a small bar by
// the selection to ask the agent about them (typed there, sent with the
// words quoted) or to quote them in the reply box and say more there.
// It shows for what the chat lets be selected (a reply, a tool's output, a
// question), once the pointer lets go or the keyboard has extended the
// selection, and goes when the selection does, on Escape, or after it sends.
//
// After Beautiful UI's Selection Actions (beautifului.dev), as an idea only.

// The words the selection stays marked with while the bar's field has the
// focus (and the page's own selection has moved into it).
const HL = "chat-quote";
type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): Highlights | undefined => (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

// Room kept between the bar and the selection, and the pane's edges.
const GAP = 8;
const EDGE = 12;

interface Picked {
  text: string;
  range: Range;
}

export function SelectionActions({ api, chat, who }: { api: ChatListApi; chat: string; who: string }) {
  const [picked, setPicked] = useState<Picked>();
  const [question, setQuestion] = useState("");
  const [at, setAt] = useState<{ top: number; left: number; below: boolean }>();
  const bar = useRef<HTMLDivElement>(null);
  const pane = api.scroller?.parentElement ?? null;
  const scroller = api.scroller;

  const close = useCallback(() => {
    setPicked(undefined);
    setQuestion("");
    setAt(undefined);
    highlights()?.delete(HL);
  }, []);

  // What is selected now, if the chat lets it be quoted.
  const read = useCallback((): Picked | undefined => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !scroller) return;
    const range = sel.getRangeAt(0);
    const inside = (n: Node | null) => {
      const el = n instanceof Element ? n : n?.parentElement;
      return !!el && scroller.contains(el) && !!el.closest("[data-selectable]");
    };
    if (!inside(sel.anchorNode) || !inside(sel.focusNode)) return;
    const text = sel.toString();
    if (text.trim().length < 2) return;
    return { text, range: range.cloneRange() };
  }, [scroller]);

  // Shown once a selection is made: the pointer let go, or Shift and an
  // arrow (or ⌘A) extended it from the keyboard.
  useEffect(() => {
    if (!scroller) return;
    const settle = () =>
      window.setTimeout(() => {
        const p = read();
        if (p) {
          setPicked(p);
          setQuestion("");
        }
      }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || ((e.metaKey || e.ctrlKey) && e.key === "a")) settle();
    };
    scroller.addEventListener("pointerup", settle);
    scroller.addEventListener("keyup", onKey);
    return () => {
      scroller.removeEventListener("pointerup", settle);
      scroller.removeEventListener("keyup", onKey);
    };
  }, [scroller, read]);

  // Gone when the selection is: unless the bar's own field took the focus.
  useEffect(() => {
    if (!picked) return;
    const onChange = () => {
      if (bar.current?.contains(document.activeElement)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picked, close]);

  // Placed above the selection's first line, or below its last when the
  // top of the view has no room; it follows the chat as it scrolls.
  const place = useCallback(() => {
    if (!picked || !pane || !bar.current) return;
    // Its lines' boxes, without the empty ones a selection starting at a
    // line's end or a list's marker has.
    const rects = [...picked.range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return close();
    const first = rects[0];
    const last = rects[rects.length - 1];
    const box = pane.getBoundingClientRect();
    const view = scroller?.getBoundingClientRect() ?? box;
    const { width, height } = bar.current.getBoundingClientRect();
    const below = first.top - height - GAP < view.top;
    const top = below ? last.bottom + GAP : first.top - height - GAP;
    // Out of view altogether: hidden until it is back.
    if (last.bottom < view.top || first.top > view.bottom) return setAt(undefined);
    // Centred on the line it sits by (a line is several boxes where its
    // words change style).
    const line = rects.filter((r) => Math.abs(r.top - (below ? last.top : first.top)) < 2);
    const from = Math.min(...line.map((r) => r.left));
    const anchor = (from + Math.max(...line.map((r) => r.right))) / 2;
    const left = Math.min(Math.max(anchor - width / 2, box.left + EDGE), box.right - width - EDGE);
    setAt({ top: top - box.top, left: left - box.left, below });
  }, [picked, pane, scroller, close]);

  useLayoutEffect(() => {
    place();
  }, [place]);
  useEffect(() => {
    if (!picked || !scroller) return;
    scroller.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      scroller.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [picked, scroller, place]);

  // The words stay marked while the field is typed in.
  const mark = () => {
    if (picked && Highlight) highlights()?.set(HL, new Highlight(picked.range));
  };
  useEffect(() => () => highlights()?.delete(HL), []);

  if (!picked || !pane || !canQuote(chat)) return null;
  const done = (send: boolean) => {
    const q = question.trim();
    if (send && !q) return;
    const text = send ? `${quoted(picked.text)}\n\n${q}` : `${quoted(picked.text)}\n\n`;
    if (!quoteInto(chat, { text, send })) return;
    window.getSelection()?.removeAllRanges();
    close();
  };
  // Buttons take no focus from the selection on press.
  const keep = (e: { preventDefault(): void }) => e.preventDefault();

  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label="Selected words"
      data-testid="selection-actions"
      className="cv-pop absolute z-30 flex h-9 items-center gap-1 rounded-lg border bg-popover p-1 pl-2.5 text-popover-foreground shadow-lg/5"
      style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
      data-below={at?.below ? "" : undefined}
      onBlur={(e) => {
        // Focus gone elsewhere with nothing selected any more: done.
        if (bar.current?.contains(e.relatedTarget as Node | null)) return;
        if (window.getSelection()?.isCollapsed !== false) close();
      }}
    >
      <input
        aria-label={`Ask ${who} about this`}
        placeholder={`Ask ${who} about this…`}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onFocus={mark}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            done(true);
          }
        }}
        className="h-full w-[min(15rem,40vw)] min-w-0 bg-transparent text-desc outline-none placeholder:text-muted-foreground"
      />
      {question.trim() ? (
        <Tip label={`Send to ${who}, with the words quoted`}>
          <Button size="icon-xs" className="rounded-md" aria-label={`Send to ${who}`} onPointerDown={keep} onClick={() => done(true)}>
            <ArrowUpIcon />
          </Button>
        </Tip>
      ) : null}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground" onPointerDown={keep} onMouseDown={keep} onClick={() => done(false)}>
        <TextQuoteIcon />
        Quote in reply
      </Button>
    </div>,
    pane,
  );
}
