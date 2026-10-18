import { MessageSquarePlusIcon, MessageSquareTextIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PickOne } from "@/components/pick-one";
import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import type { ExecResult } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { committedDiffCommand, describeCode, type DiffLine, diffCommand, type FileChange, parseDiff, splitRows } from "@/lib/git/parse";
import { COMMENT_LIMIT, type LineComment } from "@/lib/review-comments";
import { load, save } from "@/lib/storage";
import { cn } from "@/lib/utils";

// The app's diff viewer: a file list and a unified or split diff, read with
// git on the box. The built-in Git changes plugin draws the same thing with
// the plugin kit; both parse with lib/git/parse.

export type Run = (command: string) => Promise<ExecResult>;

const toneClass = { add: "text-success-foreground", new: "text-success-foreground", del: "text-destructive-foreground", mod: "text-warning", ren: "text-info" } as const;

export function FileRow({ file, active, onSelect, comments }: { file: FileChange; active: boolean; onSelect(): void; comments?: number }) {
  const { label, tone } = describeCode(file.code);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash > 0 ? file.path.slice(0, slash) : "";
  return (
    <li>
      <Tip side="right" label={`${label}: ${file.from ? `${file.from} → ` : ""}${file.path}`}>
        <button
          type="button"
          onClick={onSelect}
          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-meta hover:bg-accent/60", active && "bg-accent text-foreground")}
        >
          <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", toneClass[tone])}>{file.code === "??" ? "U" : file.code.trim()[0]}</span>
          <span className="min-w-0 flex-1 truncate">
            {name}
            {dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}
          </span>
          {!!comments && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-tag text-primary tabular-nums" aria-label={`${comments} comment${comments === 1 ? "" : "s"}`}>
              <MessageSquareTextIcon className="size-3" />
              {comments}
            </span>
          )}
          {file.binary ? (
            <span className="text-muted-foreground">bin</span>
          ) : (
            <span className="shrink-0 font-mono text-tag tabular-nums">
              <span className="text-success-foreground">+{file.added ?? 0}</span> <span className="text-destructive-foreground">−{file.removed ?? 0}</span>
            </span>
          )}
        </button>
      </Tip>
    </li>
  );
}

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

const MODE_KEY = "berth.diff.mode";

// DiffView shows one file's diff: against HEAD, or, with base, what the
// branch's commits changed since it left base.
export function DiffView({ file, run, base, comments }: { file: FileChange; run: Run; base?: string; comments?: LineComments }) {
  const [diff, setDiff] = useState<Load<{ lines: DiffLine[]; truncated?: boolean }>>({ state: "loading" });
  const [mode, setMode] = useState<"unified" | "split">(() => load(MODE_KEY, "unified"));

  useEffect(() => {
    let live = true;
    setDiff({ state: "loading" });
    run(base ? committedDiffCommand(file, base) : diffCommand(file))
      .then((r) => live && setDiff({ state: "ready", value: { lines: parseDiff(r.output), truncated: r.truncated } }))
      .catch((err) => live && setDiff({ state: "error", message: plainError(err) }));
    return () => {
      live = false;
    };
  }, [file, run, base]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-meta">
        <span className="min-w-0 truncate font-mono">{file.from ? `${file.from} → ${file.path}` : file.path}</span>
        <Badge variant="outline" size="sm" className="shrink-0">
          {describeCode(file.code).label}
        </Badge>
        <PickOne<"unified" | "split">
          label="Diff layout"
          className="ml-auto"
          value={mode}
          onChange={(m) => {
            setMode(m);
            save(MODE_KEY, m);
          }}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-mono leading-5 [font-variant-ligatures:none]">
        {diff.state === "loading" && (
          <Centered>
            <Spinner className="size-4" />
          </Centered>
        )}
        {diff.state === "error" && <Centered>{diff.message}</Centered>}
        {diff.state === "ready" && diff.value.lines.length === 0 && <Centered>Nothing to show for this file.</Centered>}
        {diff.state === "ready" && diff.value.truncated && <p className="border-b bg-warning/8 px-3 py-1 font-sans text-warning text-meta">Only the end of this diff is shown: it is longer than 64 KB.</p>}
        {diff.state === "ready" && comments && mode === "split" && diff.value.lines.length > 0 && (
          <p className="border-b bg-muted/40 px-3 py-1 font-sans text-muted-foreground text-meta">Switch to Unified to comment on a line.</p>
        )}
        {diff.state === "ready" && (mode === "unified" ? <DiffLines lines={diff.value.lines} comments={comments} /> : <Split lines={diff.value.lines} />)}
      </div>
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-32 items-center justify-center gap-2 p-6 font-sans text-muted-foreground text-body">{children}</div>;
}

const lineBg = { add: "bg-success/10", del: "bg-destructive/10", ctx: "", hunk: "bg-info/8 text-info", meta: "text-muted-foreground italic" } as const;

function Num({ n }: { n?: number }) {
  return <span className="w-11 shrink-0 select-none pr-2 text-right text-muted-foreground/60">{n ?? ""}</span>;
}

// LineComments lets a person leave notes on a diff's lines for its agent
// (lib/review-comments): the ones for this file, and how to add or drop one.
export interface LineComments {
  list: LineComment[];
  onAdd(line: number, side: "new" | "old", text: string): void;
  onRemove(id: string): void;
}

// DiffLines is a unified diff. With comments, each line has a button in
// its gutter to comment on it, and its comments show beneath it.
export function DiffLines({ lines, comments }: { lines: DiffLine[]; comments?: LineComments }) {
  const [open, setOpen] = useState<string>();
  const at = (l: DiffLine) => (l.kind === "del" ? { side: "old" as const, line: l.oldNo ?? 0 } : { side: "new" as const, line: l.newNo ?? 0 });
  return (
    <div className="min-w-fit">
      {lines.map((l, i) => {
        if (l.kind === "hunk" || l.kind === "meta") {
          return (
            <div key={i} className={cn("flex whitespace-pre", lineBg[l.kind])}>
              <span className="px-3">{l.text}</span>
            </div>
          );
        }
        const where = at(l);
        const id = `${where.side}:${where.line}`;
        const here = comments?.list.filter((c) => c.side === where.side && c.line === where.line) ?? [];
        return (
          <div key={i}>
            <div className={cn("group/line relative flex whitespace-pre", lineBg[l.kind])}>
              {comments && (
                <button
                  type="button"
                  aria-label={`Comment on line ${where.line}`}
                  onClick={() => setOpen(open === id ? undefined : id)}
                  className="absolute top-0.5 left-0.5 z-10 flex size-4 items-center justify-center rounded bg-primary text-primary-foreground opacity-0 outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/line:opacity-100"
                >
                  <MessageSquarePlusIcon className="size-3" />
                </button>
              )}
              <Num n={l.oldNo} />
              <Num n={l.newNo} />
              <span className="w-4 shrink-0 select-none text-muted-foreground">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <span className="pr-4">{l.text || " "}</span>
            </div>
            {comments && here.map((c) => <CommentNote key={c.id} c={c} onRemove={() => comments.onRemove(c.id)} />)}
            {comments && open === id && (
              <CommentComposer
                line={where.line}
                onCancel={() => setOpen(undefined)}
                onSave={(text) => {
                  comments.onAdd(where.line, where.side, text);
                  setOpen(undefined);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CommentNote({ c, onRemove }: { c: LineComment; onRemove(): void }) {
  return (
    <div className="sticky left-0 flex w-full max-w-[min(100%,560px)] items-start gap-2 border-primary/60 border-l-2 bg-muted/50 py-1.5 pr-2 pl-3 font-sans text-meta">
      <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", c.sent && "text-muted-foreground")}>{c.text}</p>
      {c.sent ? (
        <Badge variant="outline" size="sm" className="shrink-0">
          Sent
        </Badge>
      ) : (
        <Tip label="Delete this comment">
          <Button size="icon-xs" variant="ghost" aria-label="Delete this comment" className="-my-0.5 shrink-0 text-muted-foreground" onClick={onRemove}>
            <Trash2Icon />
          </Button>
        </Tip>
      )}
    </div>
  );
}

export function CommentComposer({ line, onSave, onCancel }: { line: number; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const save = () => text.trim() && onSave(text);
  return (
    <div className="sticky left-0 flex w-full max-w-[min(100%,560px)] flex-col gap-2 border-primary border-l-2 bg-muted/50 py-2 pr-2 pl-3 font-sans">
      <Textarea
        autoFocus
        rows={2}
        size="sm"
        maxLength={COMMENT_LIMIT}
        value={text}
        aria-label={`Comment on line ${line}`}
        placeholder="What should the agent change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground text-meta">Line {line} · ⌘↵ to add</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!text.trim()} onClick={save}>
          Add comment
        </Button>
      </div>
    </div>
  );
}

function Split({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => splitRows(lines), [lines]);
  return (
    <div className="min-w-fit">
      {rows.map((r, i) =>
        r.hunk ? (
          <div key={i} className={cn("whitespace-pre px-3", lineBg.hunk)}>
            {r.hunk}
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2">
            <Half line={r.left} side="old" />
            <Half line={r.right} side="new" />
          </div>
        ),
      )}
    </div>
  );
}

function Half({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  if (!line) return <div className="border-r bg-muted/40" />;
  return (
    <div className={cn("flex min-w-0 whitespace-pre border-r", line.kind !== "ctx" && lineBg[line.kind])}>
      <Num n={side === "old" ? line.oldNo : line.newNo} />
      <span className="overflow-hidden pr-3">{line.text || " "}</span>
    </div>
  );
}
