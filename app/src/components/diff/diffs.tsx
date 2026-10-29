// The diff renderer, @pierre/diffs (diffs.com): Shiki highlighting in two
// workers, themed to the app. This module and its chunks load the first
// time something shows a diff (a Diff panel, an edit opened in a chat),
// never with the app; load.ts is the way in. One copy and one worker pool
// serve the whole app, the Diff plugin included (@berth/plugin/ui).
import { type FileDiffMetadata, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem, type DiffLineAnnotation, File as FileView, FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useActiveTheme } from "@/hooks/use-theme";
import { syntaxThemes } from "@/themes/apply";
import { useFollow } from "@/components/workspace/compare-sync";

export type { FileDiffMetadata };

// The highlighter caches by key, so a key names the contents: the same diff
// read again reuses its highlighting, a changed one never does.
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// parse reads a git patch: one entry per file.
export function parse(patch: string): FileDiffMetadata[] {
  if (!patch.trim()) return [];
  return parsePatchFiles(patch, `berth-diff-${hash(patch)}-${patch.length}`).flatMap((p) => p.files);
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// fromHunks is a change from its hunks (Claude Code's structuredPatch),
// numbered by the file's own lines. jsdiff counts an empty side's start
// from the line after it; a patch, from the line before.
export function fromHunks(name: string, hunks: Hunk[]): FileDiffMetadata | undefined {
  const head = `--- a/${name}\n+++ b/${name}\n`;
  const body = hunks
    .map((h) => `@@ -${h.oldLines ? h.oldStart : Math.max(0, h.oldStart - 1)},${h.oldLines} +${h.newLines ? h.newStart : Math.max(0, h.newStart - 1)},${h.newLines} @@\n${h.lines.join("\n")}\n`)
    .join("");
  return parse(head + body)[0];
}

// fromTexts is a change from the text it replaced and what it put there,
// numbered from 1; with no old text, a new file.
export function fromTexts(name: string, old: string | undefined, next: string): FileDiffMetadata {
  // A snippet's end isn't the file's: no "No newline at end of file".
  const end = (t: string) => (t && !t.endsWith("\n") ? `${t}\n` : t);
  old = old == null ? old : end(old);
  next = end(next);
  const key = `berth-edit-${hash(`${old ?? ""}\0${next}`)}`;
  return parseDiffFromFile(old == null ? null : { name, contents: old, cacheKey: `${key}-a` }, { name, contents: next, cacheKey: `${key}-b` });
}

// Code is coloured by the app theme's own Shiki theme (Theme.syntax:
// Dracula's diffs in Dracula), Pierre's light or dark without one. Shiki's
// themes are each a chunk of their own, loaded the first time a diff shows
// in that theme, never with the app.
type Syntax = { dark: string; light: string };

function useSyntax(): Syntax {
  const theme = useActiveTheme();
  const { dark, light } = syntaxThemes(theme);
  return useMemo(() => ({ dark, light }), [dark, light]);
}

// The app's look inside the library's shadow DOM: its background (a host
// can set --berth-diff-bg, a chat's card say), borders and mono font, and
// the diff colours the app uses elsewhere.
const CSS = `
:host {
  --diffs-font-family: "JetBrains Mono Variable", ui-monospace, monospace;
  --diffs-header-font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif;
  --diffs-font-size: 0.75rem;
  --diffs-line-height: 1.25rem;
  --diffs-font-features: "calt" 0, "liga" 0;
  --diffs-light-bg: var(--berth-diff-bg, var(--background));
  --diffs-dark-bg: var(--berth-diff-bg, var(--background));
  --diffs-addition-color-override: var(--success);
  --diffs-deletion-color-override: var(--destructive);
  --diffs-modified-color-override: var(--info);
  --diffs-fg-number-override: color-mix(in srgb, var(--muted-foreground) 70%, transparent);
  --diffs-bg-buffer-override: color-mix(in srgb, var(--berth-diff-bg, var(--background)) 97%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--berth-diff-bg, var(--background)) 96%, var(--foreground));
}
pre, code { font-variant-ligatures: none; }
[data-content-buffer], [data-gutter-buffer] { background-image: none; }
[data-separator] { font-size: 0.6875rem; color: var(--muted-foreground); }
`;

// In a chat the card frames the code: no padding above its first line.
const CHAT_CSS = `${CSS}
[data-code] { padding-block: 0; }
[data-line-annotation], [data-gutter-buffer=annotation] { --diffs-annotation-bg: var(--berth-diff-bg, var(--background)); }
`;

function workerFactory() {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

// The pool: two workers, enough to keep up with scrolling, without the
// eight a pool starts by default. It outlives the views that use it for a
// while, so folding an edit and opening the next doesn't start it again.
const POOL_OPTIONS = { workerFactory, poolSize: 2, totalASTLRUCacheSize: 40 };
const IDLE = 120_000;
let users = 0;
let idle = 0;

function usePool() {
  const syntax = useSyntax();
  const [pool] = useState(() => getOrCreateWorkerPoolSingleton({ poolOptions: POOL_OPTIONS, highlighterOptions: { theme: syntax, langs: [] } }));
  // A new app theme re-colours what is open; the pool ignores a pair it has.
  useEffect(() => {
    void pool.setRenderOptions({ theme: syntax });
  }, [pool, syntax]);
  useEffect(() => {
    users++;
    window.clearTimeout(idle);
    return () => {
      if (--users > 0) return;
      idle = window.setTimeout(() => users === 0 && terminateWorkerPoolSingleton(), IDLE);
    };
  }, []);
  return pool;
}

// ---- Code in a chat reply ----

// highlightCode colours a reply's code block in the pool's workers, with
// the theme's syntax colours: the block's text as HTML, one span per
// token, each carrying --diffs-token-light and --diffs-token-dark for
// conversation.css to pick from. Undefined when the language is unknown
// or the result wouldn't read back as the same text.
export async function highlightCode(code: string, lang: string, syntax: Syntax): Promise<string | undefined> {
  const pool = getOrCreateWorkerPoolSingleton({ poolOptions: POOL_OPTIONS, highlighterOptions: { theme: syntax, langs: [] } });
  // Used outside a view, the pool still goes once idle.
  if (users === 0) {
    window.clearTimeout(idle);
    idle = window.setTimeout(() => users === 0 && terminateWorkerPoolSingleton(), IDLE);
  }
  await pool.initialize();
  const current = pool.getFileRenderOptions().theme;
  if (typeof current === "string" || current.dark !== syntax.dark || current.light !== syntax.light) await pool.setRenderOptions({ theme: syntax });
  const file = { name: `reply.${lang}`, contents: code, lang, cacheKey: `berth-code-${lang}-${hash(code)}-${code.length}` };
  await pool.primeFileHighlightCache(file);
  const result = pool.getFileResultCache(file)?.result;
  if (!result) return undefined;
  const html = result.code.map((line) => toHTML(line)).join("\n");
  return unescape(html.replace(/<[^>]+>/g, "")) === code ? html : undefined;
}

type Hast = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Hast[] };

const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// toHTML keeps a line's text and its tokens' colours, nothing else of the
// library's markup: the block stays the plain <code> it was.
function toHTML(node: unknown): string {
  const n = node as Hast;
  if (n.type === "text") return n.value === "\n" ? "" : escape(n.value ?? "");
  const inner = (n.children ?? []).map(toHTML).join("");
  const style = n.properties?.style;
  return n.tagName === "span" && typeof style === "string" && style.includes("--diffs-token") ? `<span style="${escape(style).replace(/"/g, "&quot;")}">${inner}</span>` : inner;
}

function Pool({ children }: { children: ReactNode }) {
  return <WorkerPoolContext.Provider value={usePool()}>{children}</WorkerPoolContext.Provider>;
}

// ---- Many files: the Diff panel ----

export interface ViewItem {
  id: string;
  fileDiff: FileDiffMetadata;
  collapsed: boolean;
  version: number;
}

export interface ViewerProps {
  items: ViewItem[];
  layout: "split" | "unified";
  wrap: boolean;
  dark: boolean;
  // Scrolls to a file; n changes for each jump, so the same file can be
  // jumped to twice.
  jump?: { id: string; n: number };
  // The file at the top of the view, as it scrolls.
  onActive?(id: string): void;
  renderHeader(id: string): ReactNode;
  // A different diff (another scope): start again from its top.
  resetKey?: string;
}

export default function Viewer(props: ViewerProps) {
  return (
    <Pool>
      <Files key={props.resetKey} {...props} />
    </Pool>
  );
}

function Files({ items, layout, wrap, dark, jump, onActive, renderHeader }: ViewerProps) {
  const syntax = useSyntax();
  const ref = useRef<CodeViewHandle<undefined, undefined>>(null);
  const ids = useRef<string[]>([]);
  ids.current = items.map((i) => i.id);
  const frame = useRef(0);

  const viewItems = useMemo<CodeViewItem<undefined>[]>(
    () => items.map((i) => ({ id: i.id, type: "diff", fileDiff: i.fileDiff, collapsed: i.collapsed, version: i.version })),
    [items],
  );

  const options = useMemo(
    () => ({
      theme: syntax,
      themeType: dark ? ("dark" as const) : ("light" as const),
      diffStyle: layout,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      stickyHeaders: true,
      unsafeCSS: CSS,
    }),
    [dark, layout, wrap, syntax],
  );

  useEffect(() => {
    if (!jump) return;
    const go = () => ref.current?.scrollTo({ type: "item", id: jump.id, align: "start", offset: 8 });
    go();
    // Files between here and there are measured as they render, which can
    // move the target: settle on it once they have.
    const t = setTimeout(go, 150);
    return () => clearTimeout(t);
  }, [jump]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // In a Compare tab, scrolling to a file takes the other side's diff there.
  const follow = useFollow("file", (id) => {
    if (!ids.current.includes(String(id))) return false;
    const go = () => ref.current?.scrollTo({ type: "item", id: String(id), align: "start", offset: 8 });
    go();
    setTimeout(go, 150);
    return true;
  });

  // Stable callbacks: a new one each render would reset the view's options,
  // and with them a scroll on its way to a file.
  const latest = useRef({ renderHeader, onActive });
  latest.current = { renderHeader, onActive };
  const header = useCallback((item: CodeViewItem<undefined>) => latest.current.renderHeader(item.id), []);
  const scrolled = useCallback((top: number, viewer: { getTopForItem(id: string): number | undefined }) => {
    if (!latest.current.onActive && !follow.current.on) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      let active = ids.current[0];
      for (const id of ids.current) {
        const t = viewer.getTopForItem(id);
        if (t === undefined || t > top + 8) break;
        active = id;
      }
      if (active) latest.current.onActive?.(active);
      if (active) follow.current.moved(active);
    });
  }, [follow]);

  return (
    <CodeView
      ref={ref}
      className="berth-diff-view h-full min-h-0 overflow-auto overscroll-contain"
      items={viewItems}
      options={options}
      renderCustomHeader={header}
      onScroll={scrolled}
    />
  );
}

// ---- One file: an edit in a chat ----

// A note under a line: side "old" is a removed line's number, "new" any
// other's.
export interface LineNote {
  key: string;
  side: "old" | "new";
  line: number;
}

export interface DiffProps {
  fileDiff: FileDiffMetadata;
  layout: "split" | "unified";
  dark: boolean;
  wrap?: boolean;
  // Off for lines that number nothing: a reply's bare +/- lines.
  lineNumbers?: boolean;
  className?: string;
  style?: CSSProperties;
  // Notes drawn under their lines, and a button in the gutter to add one.
  notes?: LineNote[];
  renderNote?(note: LineNote): ReactNode;
  onAddNote?(side: "old" | "new", line: number): void;
}

export function Diff({ fileDiff, layout, dark, wrap = true, lineNumbers = true, className, style, notes, renderNote, onAddNote }: DiffProps) {
  const add = useRef(onAddNote);
  add.current = onAddNote;
  const commentable = !!onAddNote;
  const syntax = useSyntax();
  const options = useMemo(
    () => ({
      theme: syntax,
      themeType: dark ? ("dark" as const) : ("light" as const),
      diffStyle: layout,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "simple" as const,
      disableFileHeader: true,
      disableLineNumbers: !lineNumbers,
      unsafeCSS: CHAT_CSS,
      enableGutterUtility: commentable,
      onGutterUtilityClick: commentable
        ? (r: { start: number; side?: "deletions" | "additions" }) => add.current?.(r.side === "deletions" ? "old" : "new", r.start)
        : undefined,
    }),
    [dark, layout, wrap, lineNumbers, commentable, syntax],
  );
  const annotations = useMemo<DiffLineAnnotation<string>[] | undefined>(
    () => notes?.map((n) => ({ side: n.side === "old" ? "deletions" : "additions", lineNumber: n.line, metadata: n.key })),
    [notes],
  );
  const byKey = useMemo(() => new Map(notes?.map((n) => [n.key, n])), [notes]);
  return (
    <Pool>
      <FileDiff<string>
        fileDiff={fileDiff}
        options={options}
        className={className}
        style={style}
        lineAnnotations={annotations}
        renderAnnotation={renderNote ? (a) => {
          const n = byKey.get(a.metadata);
          return n ? renderNote(n) : null;
        } : undefined}
      />
    </Pool>
  );
}

// ---- A file's lines: a path named in a chat, on hover ----

// The lines a reply points at, picked out as the selection is, in the
// theme's own wash (the ring colour, faint), so it reads in every theme.
const LINES_CSS = `${CHAT_CSS}
:host { --diffs-bg-selection-override: var(--ring); }
`;

export interface FileLinesProps {
  name: string;
  text: string;
  // The lines to pick out, numbered as the file numbers them.
  from?: number;
  to?: number;
  dark: boolean;
  className?: string;
  style?: CSSProperties;
}

// FileLines draws a whole file as the chat's edits are drawn (the same
// font, numbers and colours), its lines one row each (no wrapping), so the
// card around it can scroll to a line by its number.
export function FileLines({ name, text, from, to, dark, className, style }: FileLinesProps) {
  const syntax = useSyntax();
  const options = useMemo(
    () => ({ theme: syntax, themeType: dark ? ("dark" as const) : ("light" as const), overflow: "scroll" as const, disableFileHeader: true, unsafeCSS: LINES_CSS }),
    [dark, syntax],
  );
  const file = useMemo(() => ({ name, contents: text, cacheKey: `berth-file-${hash(text)}-${text.length}` }), [name, text]);
  const selected = useMemo(() => (from ? { start: from, end: to ?? from } : null), [from, to]);
  return (
    <Pool>
      <FileView file={file} options={options} selectedLines={selected} className={className} style={style} />
    </Pool>
  );
}

// lines is how many of the file's lines a diff shows.
export function lines(fileDiff: FileDiffMetadata): number {
  return fileDiff.hunks.reduce((n, h) => n + h.unifiedLineCount, 0);
}

// rows is how many lines a diff draws unified: for sizing its box before
// it draws.
export function rows(fileDiff: FileDiffMetadata): number {
  // A row for each line; the rule between hunks is a few pixels.
  return lines(fileDiff);
}
