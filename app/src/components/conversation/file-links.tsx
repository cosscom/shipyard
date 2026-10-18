import { ArrowUpRightIcon } from "lucide-react";
import { createContext, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDark, useDiffs } from "@/components/diff/load";
import { FileGlyph } from "@/components/files/file-bits";
import { PreviewCard, PreviewCardPopup } from "@/components/ui/preview-card";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { dirName, fileName } from "@/lib/file-match";
import { isFile, knownFile, readFile } from "@/lib/file-links";
import { excerpt, type FileRef, lineLabel, lineSpan, parseRef } from "@/lib/file-refs";
import { type How, openFile, type WorktreeFile } from "@/lib/files";
import { PaneContext } from "@/lib/pane-context";
import { cn } from "@/lib/utils";
import { focusPane, type WorktreeRef } from "@/lib/workspaces";

// A file an agent names in its reply, in inline code (`src/app.ts:14`),
// links to it: hovering shows its lines, as the chat draws an edit, and a
// click opens it there. Only a file the box says is in the session's own
// worktree links (lib/file-links.ts); anything else stays the code it was.
//
// A reply is HTML drawn once and kept (markdown.tsx), so the links are made
// in the page after it draws: its inline code is marked where it names a
// file, and one card per chat follows whichever is hovered or focused.

const ROW = 20;
const ROWS = 16;
// The lines above the one named, to show where it is.
const BEFORE = 3;
// Past this many lines, the card shows plain lines around the ones named:
// a whole file drawn and coloured would cost more than a glance is worth.
const HUGE = 2000;
const OPEN_DELAY = 350;
const CLOSE_DELAY = 180;

interface Scope {
  worktree: WorktreeRef;
  show(el: HTMLElement, delay?: number): void;
  hide(): void;
  dismiss(): void;
  open(el: HTMLElement, how: How): void;
}

const Links = createContext<Scope | undefined>(undefined);

export function useFileWorktree(): WorktreeRef | undefined {
  return useContext(Links)?.worktree;
}

// The ref a marked code element carries (mark).
function refOf(el: HTMLElement): FileRef {
  const line = Number(el.dataset.line) || undefined;
  const end = Number(el.dataset.end) || undefined;
  return { path: el.dataset.fileRef ?? "", ...(line ? { line } : {}), ...(end ? { end } : {}) };
}

// FileLinks makes the paths named in its chat's replies links to the files
// of worktree; with none (a session outside any worktree), they stay code.
export function FileLinks({ worktree, children }: { worktree?: WorktreeRef; children: ReactNode }) {
  return worktree ? <LinkHost worktree={worktree}>{children}</LinkHost> : children;
}

function LinkHost({ worktree, children }: { worktree: WorktreeRef; children: ReactNode }) {
  const pane = useContext(PaneContext);
  const [card, setCard] = useState<{ el: HTMLElement; ref: FileRef; width: number }>();
  const [open, setOpen] = useState(false);
  const timers = useRef({ open: 0, close: 0 });
  const live = useRef({ card, open });
  live.current = { card, open };

  const scope = useMemo<Scope>(() => {
    const clear = () => {
      window.clearTimeout(timers.current.open);
      window.clearTimeout(timers.current.close);
    };
    const shown = (el: HTMLElement) => live.current.open && live.current.card?.el === el;
    return {
      worktree,
      show(el, delay = OPEN_DELAY) {
        clear();
        if (shown(el)) return;
        // From one link to the next, the card follows at once.
        const go = () => {
          const column = el.closest<HTMLElement>(".cv-md")?.getBoundingClientRect().width ?? 560;
          setCard({ el, ref: refOf(el), width: Math.max(360, Math.round(column)) });
          setOpen(true);
        };
        if (live.current.open || delay === 0) go();
        else timers.current.open = window.setTimeout(go, delay);
      },
      hide() {
        clear();
        timers.current.close = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
      },
      dismiss() {
        clear();
        setOpen(false);
      },
      open(el, how) {
        clear();
        setOpen(false);
        const r = refOf(el);
        // The chat's own pane acts, as a click in it would: its worktree is
        // the one the file is opened in.
        if (pane) focusPane(pane.wsKey, pane.tab, pane.pane);
        openFile(r.path, how, r.line, r.end);
      },
    };
  }, [worktree, pane]);
  useEffect(() => {
    const t = timers.current;
    return () => {
      window.clearTimeout(t.open);
      window.clearTimeout(t.close);
    };
  }, []);

  // Under the line it names, as wide as the reply's column.
  const anchor = useMemo(() => {
    if (!card) return undefined;
    return {
      contextElement: card.el,
      getBoundingClientRect() {
        const r = card.el.getBoundingClientRect();
        const col = card.el.closest(".cv-md")?.getBoundingClientRect();
        return col ? new DOMRect(col.left, r.top, col.width, r.height) : r;
      },
    };
  }, [card]);

  return (
    <Links value={scope}>
      {children}
      <PreviewCard open={open && !!card?.el.isConnected} onOpenChange={(o) => !o && scope.dismiss()}>
        {card && (
          <PreviewCardPopup
            anchor={anchor}
            sideOffset={6}
            // Clear of the status bar: without the room below, it opens above.
            collisionPadding={{ top: 8, right: 8, bottom: 36, left: 8 }}
            className="w-auto max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 text-wrap"
            style={{ width: card.width }}
            data-testid="file-card"
            data-path={card.ref.path}
            onPointerEnter={() => window.clearTimeout(timers.current.close)}
            onPointerLeave={() => scope.hide()}
          >
            <Card worktree={worktree} at={card.ref} onOpen={(how) => scope.open(card.el, how)} />
          </PreviewCardPopup>
        )}
      </PreviewCard>
    </Links>
  );
}

// ---- The card ----

type Read = { state: "loading" } | { state: "ready"; file: WorktreeFile } | { state: "error"; message: string };

function Card({ worktree, at, onOpen }: { worktree: WorktreeRef; at: FileRef; onOpen(how: How): void }) {
  const [read, setRead] = useState<Read>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setRead({ state: "loading" });
    readFile(worktree, at.path).then(
      (file) => live && setRead({ state: "ready", file }),
      (err) => live && setRead({ state: "error", message: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [worktree, at.path]);
  const lines = useMemo(() => (read.state === "ready" && read.file.content !== undefined ? read.file.content.replace(/\n$/, "").split("\n").length : 0), [read]);
  const span = lines ? lineSpan(at, lines) : undefined;
  const said = lineLabel(at);
  const dir = dirName(at.path);

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/30 pr-1 pl-3 text-meta">
        <FileGlyph path={at.path} className="size-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-tag text-muted-foreground">
          {dir && <span>{dir}/</span>}
          <span className="text-foreground">{fileName(at.path)}</span>
          {said && <span className="font-sans"> · {said}</span>}
        </span>
        <button type="button" onClick={(e) => onOpen(how(e))} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Open
          <ArrowUpRightIcon className="size-3.5" />
        </button>
      </div>
      {read.state === "loading" && (
        <div className="flex items-center justify-center text-muted-foreground" style={{ height: 4 * ROW }}>
          <Spinner className="size-4" />
        </div>
      )}
      {read.state === "error" && <p className="px-3 py-3 text-muted-foreground text-meta">Couldn't read it: {read.message}</p>}
      {read.state === "ready" && read.file.content === undefined && <p className="px-3 py-3 text-muted-foreground text-meta">{read.file.reason ?? (read.file.image ? "A picture: open it to see it." : "Not a text file.")}</p>}
      {read.state === "ready" && read.file.content !== undefined && <Lines path={at.path} text={read.file.content} lines={lines} span={span} />}
    </>
  );
}

// Lines is the file, scrolled to the lines named with a few above them,
// drawn by the diff renderer; plain while it loads, for a huge file, or
// when it can't load.
function Lines({ path, text, lines, span }: { path: string; text: string; lines: number; span?: { from: number; to: number } }) {
  const huge = lines > HUGE;
  const lib = useDiffs(!huge);
  const dark = useDark();
  const box = useRef<HTMLDivElement>(null);
  const mod = lib && "mod" in lib ? lib.mod : undefined;
  const top = span ? Math.max(0, span.from - 1 - BEFORE) * ROW : 0;
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = top;
  }, [top, mod]);
  if (!mod || huge) return <PlainLines text={text} span={span} />;
  const style = { "--berth-diff-bg": "var(--popover)" } as CSSProperties;
  return (
    <div ref={box} data-selectable className="overflow-auto overscroll-contain font-mono text-mono leading-5 [font-variant-ligatures:none]" style={{ maxHeight: ROWS * ROW }} data-testid="file-card-lines">
      {/* As tall as the file before it draws, so it opens scrolled to the line. */}
      <div style={{ minHeight: lines * ROW }}>
        <mod.FileLines name={path} text={text} from={span?.from} to={span?.to} dark={dark} style={style} />
      </div>
    </div>
  );
}

// PlainLines is the stand-in: the lines around the ones named, numbered as
// the file numbers them.
function PlainLines({ text, span }: { text: string; span?: { from: number; to: number } }) {
  const { start, lines } = useMemo(() => excerpt(text, span, BEFORE, ROWS), [text, span]);
  return (
    <div data-selectable className="overflow-auto overscroll-contain py-0 font-mono text-mono leading-5 [font-variant-ligatures:none]" style={{ maxHeight: ROWS * ROW }} data-testid="file-card-lines">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => {
            const n = start + i;
            const picked = !!span && n >= span.from && n <= span.to;
            return (
              <tr key={n} data-line={n} data-picked={picked || undefined} className={cn(picked && "bg-ring/15")}>
                <td className="w-10 select-none pr-2 pl-2 text-right align-top text-muted-foreground/70 tabular-nums">{n}</td>
                <td className="whitespace-pre pr-3">{l || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- In a reply ----

// mark makes inline code a link to its file: focusable, and read as a link.
function mark(el: HTMLElement, r: FileRef) {
  el.dataset.fileRef = r.path;
  if (r.line) el.dataset.line = String(r.line);
  if (r.end) el.dataset.end = String(r.end);
  el.tabIndex = 0;
  el.setAttribute("role", "link");
}

function unmark(el: HTMLElement) {
  delete el.dataset.fileRef;
  delete el.dataset.line;
  delete el.dataset.end;
  el.removeAttribute("tabindex");
  el.removeAttribute("role");
}

const linkAt = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-file-ref]") : null);

// useFileLinks marks the files a reply names, once it has drawn (and
// whenever its HTML changes), and answers its pointer, focus and keys.
// Outside a chat with a worktree, or in a draft still being written, it
// does nothing: the reply is drawn as it always was.
export function useFileLinks(body: RefObject<HTMLElement | null>, html: string, draft: boolean) {
  const scope = useContext(Links);
  const on = !!scope && !draft;
  const worktree = scope?.worktree;
  useLayoutEffect(() => {
    const el = body.current;
    if (!on || !worktree || !el) return;
    const ask: [HTMLElement, FileRef][] = [];
    for (const code of el.querySelectorAll<HTMLElement>("code")) {
      if (code.closest("pre, a")) continue;
      const r = parseRef(code.textContent ?? "", worktree.path);
      if (!r) continue;
      // Known already (a reply scrolled back to): marked before it paints.
      const known = knownFile(worktree, r.path);
      if (known) mark(code, r);
      else if (known === undefined) ask.push([code, r]);
    }
    let live = true;
    for (const [code, r] of ask) {
      void isFile(worktree, r.path).then((yes) => {
        if (live && yes && code.isConnected) mark(code, r);
      });
    }
    return () => {
      live = false;
      for (const code of el.querySelectorAll<HTMLElement>("[data-file-ref]")) unmark(code);
    };
  }, [body, html, on, worktree]);

  if (!on || !scope) return undefined;
  return {
    onPointerOver(e: PointerEvent) {
      const el = linkAt(e.target);
      if (el && e.pointerType !== "touch") scope.show(el);
    },
    onPointerOut(e: PointerEvent) {
      const el = linkAt(e.target);
      if (el && !el.contains(e.relatedTarget as Node | null)) scope.hide();
    },
    onFocus(e: FocusEvent) {
      const el = linkAt(e.target);
      if (el && el === e.target && el.matches(":focus-visible")) scope.show(el, 0);
    },
    onBlur(e: FocusEvent) {
      if (linkAt(e.target)) scope.hide();
    },
    onKeyDown(e: KeyboardEvent) {
      const el = linkAt(e.target);
      if (!el) return;
      if (e.key === "Escape") scope.dismiss();
      if (e.key === "Enter") {
        e.preventDefault();
        scope.open(el, how(e));
      }
    },
    // A click on a link opens its file; true when it did.
    click(e: MouseEvent): boolean {
      const el = linkAt(e.target);
      if (!el) return false;
      // Text being selected across it is not a click on it.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return true;
      e.preventDefault();
      scope.open(el, how(e));
      return true;
    },
  };
}

// ⌥ opens it beside the chat and ⌘ in your editor, as in the ⌘P picker.
const how = (e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }): How => (e.altKey ? "split" : e.metaKey || e.ctrlKey ? "external" : "tab");
