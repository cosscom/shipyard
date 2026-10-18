import { Columns2Icon, RotateCwIcon, Rows2Icon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { type DiffsModule, useDark, useDiffs } from "@/components/diff/load";
import type { FileDiffMetadata, LineNote } from "@/components/diff/diffs";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { SessionDiff } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { CommentComposer, CommentNote, DiffLines, type LineComments } from "@/lib/git/diff-view";
import { parseDiff } from "@/lib/git/parse";
import { load as loadPref, save as savePref } from "@/lib/storage";
import type { ToolDetail } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { scrollBehavior } from "@/lib/motion";

// An agent's edits in a chat, drawn by the app's diff renderer (@pierre/
// diffs, components/diff): highlighted, numbered by the file's own lines
// when the box knows them. The renderer loads the first time an edit is
// opened; a folded edit costs nothing. Past ~2k lines, or when the
// renderer can't load, the plain line views stand in.

const ROW = 20;
// Taller than this folds, with Show all beneath.
const FOLD_ROWS = 22;
// Longer than this is drawn plain: highlighting it would cost more than
// reading it is worth.
const HUGE = 2000;
// Split needs room for two columns of code. The chat's column is narrower
// (680px): where the pane around it has the room, an edit in split widens
// past it, up to SPLIT_MAX.
const SPLIT_MIN = 760;
const SPLIT_MAX = 1280;
const GUTTER = 32;

type Layout = "unified" | "split";
const LAYOUT_KEY = "berth.chat.diff-layout";
// One choice for every edit in every chat, remembered.
const useLayout = create<{ layout: Layout; set(l: Layout): void }>((set) => ({
  layout: loadPref<Layout>(LAYOUT_KEY, "unified"),
  set: (layout) => {
    savePref(LAYOUT_KEY, layout);
    set({ layout });
  },
}));

// useWidth is an element's width as it changes.
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const o = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    o.observe(el);
    return () => o.disconnect();
  }, []);
  return [ref, width] as const;
}

// LayoutSwitch picks unified or split, shown only where split fits.
function LayoutSwitch({ className }: { className?: string }) {
  const { layout, set } = useLayout();
  const options = [
    { value: "unified" as const, label: "Unified", Icon: Rows2Icon },
    { value: "split" as const, label: "Split", Icon: Columns2Icon },
  ];
  return (
    <div role="radiogroup" aria-label="Diff layout" className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {options.map(({ value, label, Icon }) => (
        <Tip key={value} label={label}>
          <button
            type="button"
            role="radio"
            aria-checked={layout === value}
            aria-label={label}
            onClick={() => set(value)}
            className={cn(
              "flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
              layout === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        </Tip>
      ))}
    </div>
  );
}

// ---- Building the diff ----

// changeOf is a tool call's change as the renderer draws it: by its hunks
// (the file's own line numbers) when the box sent them, else its old and
// new text, numbered from 1.
function changeOf(mod: DiffsModule, d: ToolDetail): FileDiffMetadata | undefined {
  const name = d.file || "change";
  if (d.hunks?.length) {
    const f = mod.fromHunks(name, d.hunks);
    if (f?.hunks.length) return f;
  }
  if (d.new == null && d.old == null) return undefined;
  const patch = d.old == null && d.new ? codexPatch(d.new, d.file) : undefined;
  if (patch) return mod.fromTexts(patch.file || name, patch.old, patch.next);
  return mod.fromTexts(name, d.old == null ? undefined : d.old, d.new ?? "");
}

// codexPatch reads Codex's apply_patch text ("*** Begin Patch", a file's
// section, its lines led by " ", "-" or "+") as the text it replaced and
// what it put there: the section for file, or the first.
export function codexPatch(text: string, file?: string): { file: string; old?: string; next: string } | undefined {
  if (!text.startsWith("*** Begin Patch")) return undefined;
  const sections: { file: string; add: boolean; old: string[]; next: string[] }[] = [];
  for (const line of text.split("\n")) {
    const head = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (head) {
      sections.push({ file: head[2].trim(), add: head[1] === "Add", old: [], next: [] });
      continue;
    }
    const cur = sections[sections.length - 1];
    if (!cur || line.startsWith("***") || line.startsWith("@@")) continue;
    const op = line[0], rest = line.slice(1);
    if (op === "-" || op === " ") cur.old.push(rest);
    if (op === "+" || op === " ") cur.next.push(rest);
  }
  const s = sections.find((x) => file && (x.file === file || x.file.endsWith(`/${file}`) || file.endsWith(`/${x.file}`))) ?? sections[0];
  if (!s) return undefined;
  return { file: s.file, old: s.add ? undefined : s.old.join("\n"), next: s.next.join("\n") };
}

function changeSize(d: ToolDetail): number {
  if (d.hunks?.length) return d.hunks.reduce((n, h) => n + h.lines.length, 0);
  return lines(d.old) + lines(d.new);
}
const lines = (s?: string) => (s ? s.split("\n").length : 0);

// ---- Drawing it ----

// DiffBox draws one file's diff, folded past FOLD_ROWS with Show all, and
// keeps the height it will have while the renderer loads, so opening an
// edit doesn't jump. fallback is the plain view, for huge diffs and a
// renderer that didn't load.
function DiffBox({ build, size, fallback, comments, wide }: { build(mod: DiffsModule): FileDiffMetadata | undefined; size: number; fallback: ReactNode; wide: boolean; comments?: LineComments }) {
  const huge = size > HUGE;
  const lib = useDiffs(!huge);
  const dark = useDark();
  const layout = useLayout((s) => s.layout);
  const [all, setAll] = useState(false);
  const [composing, setComposing] = useState<{ side: "old" | "new"; line: number }>();
  const mod = lib && "mod" in lib ? lib.mod : undefined;
  const fileDiff = useMemo(() => {
    if (!mod) return undefined;
    try {
      return build(mod);
    } catch {
      return undefined;
    }
  }, [mod, build]);

  // The notes change only when a comment comes or goes (the list itself is
  // new on every render).
  const placed = comments ? comments.list.map((c) => `${c.id}:${c.side}:${c.line}`).join(",") : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed names the list.
  const notes = useMemo<LineNote[] | undefined>(() => {
    if (placed === undefined) return undefined;
    const list: LineNote[] = (comments?.list ?? []).map((c) => ({ key: c.id, side: c.side, line: c.line }));
    if (composing) list.push({ key: "composer", ...composing });
    return list;
  }, [placed, composing]);

  if (huge || (lib && "error" in lib) || (mod && !fileDiff)) return <div className="max-h-96 overflow-auto">{fallback}</div>;

  // Rows as drawn unified; until the renderer is here, as many as the
  // change has lines.
  const rows = fileDiff ? mod!.rows(fileDiff) : size;
  const folds = rows > FOLD_ROWS + 4;
  const height = (folds && !all ? FOLD_ROWS : rows) * ROW;
  const style = { "--berth-diff-bg": "var(--card)" } as CSSProperties;
  return (
    <div>
      <div className={cn("relative", folds && !all && "overflow-hidden")} style={{ minHeight: Math.min(height, FOLD_ROWS * ROW), maxHeight: folds && !all ? height : undefined }}>
        {!fileDiff || !mod ? (
          <div aria-hidden className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : (
          <mod.Diff
            fileDiff={fileDiff}
            layout={wide && layout === "split" ? "split" : "unified"}
            dark={dark}
            style={style}
            notes={notes}
            onAddNote={comments ? (side, line) => setComposing({ side, line }) : undefined}
            renderNote={
              comments
                ? (n) => {
                    if (n.key === "composer")
                      return (
                        <CommentComposer
                          line={n.line}
                          onCancel={() => setComposing(undefined)}
                          onSave={(text) => {
                            comments.onAdd(n.line, n.side, text);
                            setComposing(undefined);
                          }}
                        />
                      );
                    const c = comments.list.find((x) => x.id === n.key);
                    return c ? <CommentNote c={c} onRemove={() => comments.onRemove(c.id)} /> : null;
                  }
                : undefined
            }
          />
        )}
        {folds && !all && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {folds && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="flex w-full items-center justify-center gap-1 border-t bg-muted/30 py-1 font-sans text-muted-foreground text-meta outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {all ? "Show less" : `Show all ${(fileDiff && mod ? mod.lines(fileDiff) : size).toLocaleString()} lines`}
        </button>
      )}
    </div>
  );
}

// EditChange is a tool call's change (Edit, MultiEdit, Write), with a
// header naming the file when it stands alone (a step in a group).
export function EditChange({ d, header = true }: { d: ToolDetail; header?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const wide = width >= SPLIT_MIN;
  const build = useMemo(() => (mod: DiffsModule) => changeOf(mod, d), [d]);
  return (
    <div ref={ref} data-selectable className="font-mono text-mono leading-5 [font-variant-ligatures:none]">
      {header && d.file && (
        <div className="flex h-8 items-center gap-2 border-b bg-muted/30 pr-1 pl-3 font-sans text-muted-foreground text-meta">
          <span className="min-w-0 flex-1 truncate">
            {d.old != null || d.hunks?.length ? "Updated" : "Created"} <span className="font-mono">{d.file}</span>
          </span>
          {wide && <LayoutSwitch />}
        </div>
      )}
      <DiffBox build={build} size={changeSize(d)} wide={wide} fallback={<ChangeLines old={d.old ?? ""} next={d.new ?? ""} />} />
    </div>
  );
}

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

// A call's change never changes: one read serves every later opening.
const changes = new Map<string, ToolDetail>();

// EditPanel is an opened edit in a chat: the agent's exact change ("This
// change", when its record names the call) and the file's whole
// uncommitted diff, where lines take comments.
export function EditPanel({ file, tool, estimate, loadDiff, loadTool, comments }: { file: string; tool?: string; estimate: number; loadDiff(file: string): Promise<SessionDiff>; loadTool?(id: string): Promise<ToolDetail>; comments?: LineComments }) {
  const exact = !!(tool && loadTool);
  const [view, setView] = useState<"change" | "file">(exact ? "change" : "file");
  const [change, setChange] = useState<Load<ToolDetail>>(() => (tool && changes.has(tool) ? { state: "ready", value: changes.get(tool)! } : { state: "loading" }));
  const [diff, setDiff] = useState<Load<SessionDiff>>({ state: "loading" });
  const ref = useRef<HTMLDivElement>(null);
  // The column's edges and the pane's around it.
  const [room, setRoom] = useState({ left: 0, column: 0, paneLeft: 0, pane: 0 });
  useLayoutEffect(() => {
    const column = ref.current?.parentElement;
    const pane = ref.current?.closest<HTMLElement>(".overflow-y-auto");
    if (!column) return;
    const measure = () => {
      const c = column.getBoundingClientRect();
      const p = pane?.getBoundingClientRect() ?? c;
      setRoom({ left: c.left, column: c.width, paneLeft: p.left, pane: pane?.clientWidth ?? c.width });
    };
    measure();
    const o = new ResizeObserver(measure);
    o.observe(column);
    if (pane) o.observe(pane);
    return () => o.disconnect();
  }, []);
  const layout = useLayout((s) => s.layout);
  const span = Math.min(room.pane - 2 * GUTTER, SPLIT_MAX);
  const wide = span >= SPLIT_MIN;
  // Split, it takes the room the pane has, centred on the column but kept
  // inside the pane; unified, the column's.
  const breakout = wide && layout === "split" && span > room.column;
  const at = breakout ? Math.min(Math.max(room.left + (room.column - span) / 2, room.paneLeft + GUTTER), room.paneLeft + room.pane - GUTTER - span) - room.left : 0;

  const readChange = () => {
    if (!exact) return;
    setChange({ state: "loading" });
    loadTool!(tool!).then(
      (value) => {
        if (changes.size > 64) changes.delete(changes.keys().next().value!);
        changes.set(tool!, value);
        setChange({ state: "ready", value });
      },
      (err) => setChange({ state: "error", message: errorMessage(err) }),
    );
  };
  const readDiff = () => {
    setDiff({ state: "loading" });
    loadDiff(file).then(
      (value) => setDiff({ state: "ready", value }),
      (err) => setDiff({ state: "error", message: errorMessage(err) }),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when opened.
  useEffect(() => {
    if (change.state !== "ready") readChange();
    readDiff();
  }, []);

  // The panel opens once what it shows is in (and the renderer with it,
  // loading alongside the reads), at its full height: not a spinner that
  // then jumps. A slow read shows a placeholder after a moment.
  const lib = useDiffs(true);
  const current = exact && view === "change" ? change.state : diff.state;
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLate(true), 600);
    return () => window.clearTimeout(t);
  }, []);
  const shown = late || (current !== "loading" && lib !== undefined);
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [shown, ref]);

  const buildFile = useMemo(() => (diff.state === "ready" ? (mod: DiffsModule) => mod.parse(diff.value.diff)[0] : undefined), [diff]);
  const fileSize = diff.state === "ready" ? lines(diff.value.diff) : estimate;

  return (
    <div
      ref={ref}
      className={cn("mt-2 scroll-mb-4 overflow-hidden rounded-lg border bg-card", !shown && "invisible mt-0 h-0 border-0")}
      style={breakout ? { width: span, marginLeft: at } : undefined}
      aria-busy={!shown}
    >
      {(exact || wide) && (
        <div className="flex items-center gap-1 border-b bg-muted/30 px-1.5 py-1 text-meta">
          {exact && (
            <div role="tablist" aria-label="Show" className="flex gap-1">
              {(
                [
                  ["change", "This change"],
                  ["file", "Uncommitted in file"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn("rounded-md px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring", view === v ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {wide && <LayoutSwitch className="ml-auto" />}
        </div>
      )}
      {exact && view === "change" && (
        <>
          {change.state === "loading" && <Placeholder rows={estimate} />}
          {change.state === "error" && <Failed what="Couldn't read this change" message={change.message} retry={readChange} />}
          {change.state === "ready" && (
<EditChange d={change.value} header={false} />
          )}
        </>
      )}
      {(!exact || view === "file") && (
        <>
          {diff.state === "loading" && <Placeholder rows={estimate} />}
          {diff.state === "error" && <Failed what="Couldn't read the diff" message={diff.message} retry={readDiff} />}
          {diff.state === "ready" && !diff.value.diff.trim() && <p className="px-3 py-3 text-muted-foreground text-body">No changes left in this file: they were committed or undone since.</p>}
          {diff.state === "ready" && diff.value.diff.trim() && buildFile && (
            <>
              <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1 text-muted-foreground text-meta">
                <span className="min-w-0 flex-1 truncate">{diff.value.untracked ? "A new file" : "Uncommitted changes in this file"}{comments && " · hover a line to comment"}</span>
                {diff.value.truncated && <span className="shrink-0 text-warning">first 64 KB</span>}
              </div>
              <div className="font-mono text-mono leading-5 [font-variant-ligatures:none]" data-selectable>
                <DiffBox
                  build={buildFile}
                  size={fileSize}
                  wide={wide}
                  comments={comments}
                  fallback={<DiffLines lines={parseDiff(diff.value.diff)} comments={comments} />}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Placeholder({ rows }: { rows: number }) {
  return (
    <div className="flex items-center justify-center text-muted-foreground" style={{ height: Math.max(64, Math.min(rows, FOLD_ROWS) * ROW) }}>
      <Spinner className="size-4" />
    </div>
  );
}

function Failed({ what, message, retry }: { what: string; message: string; retry(): void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-body">
      <span className="min-w-0 flex-1 text-destructive-foreground">
        {what}: {message}
      </span>
      <Button size="xs" variant="outline" onClick={retry}>
        <RotateCwIcon />
        Retry
      </Button>
    </div>
  );
}

// ChangeLines is an edit as the terminal shows it: the lines it took out
// and put in, numbered, the rest as context. A line diff of the two texts;
// the stand-in for the renderer.
export function ChangeLines({ old, next }: { old: string; next: string }) {
  const rows = useMemo(() => lineDiff(old ? old.split("\n") : [], next.split("\n")), [old, next]);
  let n = 0;
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map((r, i) => {
          if (r.op !== "-") n++;
          return (
            <tr key={i} className={r.op === "+" ? "bg-success/12" : r.op === "-" ? "bg-destructive/12" : undefined}>
              <td className="w-10 select-none pr-2 text-right align-top text-muted-foreground/70 tabular-nums">{r.op === "-" ? "" : n}</td>
              <td className={cn("w-4 select-none align-top", r.op === "+" ? "text-success-foreground" : r.op === "-" ? "text-destructive-foreground" : "text-muted-foreground/50")}>{r.op === " " ? "" : r.op}</td>
              <td className="whitespace-pre-wrap break-all pr-3">{r.text || " "}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// lineDiff: the longest common run of lines kept as context, the rest as
// removed or added. Large texts (past ~4M cells) show as removed then added.
function lineDiff(a: string[], b: string[]): { op: " " | "+" | "-"; text: string }[] {
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const m = a.length, k = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(k + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: " " | "+" | "-"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < m && j < k) {
    if (a[i] === b[j]) (out.push({ op: " ", text: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < m) out.push({ op: "-", text: a[i++] });
  while (j < k) out.push({ op: "+", text: b[j++] });
  return out;
}
