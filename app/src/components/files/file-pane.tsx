import { ArrowUpRightIcon, BookOpenTextIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CodeXmlIcon, Columns2Icon, FileX2Icon, GitCompareArrowsIcon, TriangleAlertIcon, WrapTextIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { agentName, FileGlyph, useEditorName } from "@/components/files/file-bits";
import { MarkdownView } from "@/components/files/markdown-view";
import { useDiffs } from "@/components/diff/load";
import { ErrorText } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useActiveTheme } from "@/hooks/use-theme";
import { agentMarks, conflictLines } from "@/lib/file-marks";
import { fileName } from "@/lib/file-match";
import { docKey, type Doc, edit, filesApi, type Goto, isDirty, keepMine, type MdView, openDoc, openFile, poll, reload, save, setComparing, setMdView, setWrap, useFiles } from "@/lib/files";
import { ago } from "@/lib/format";
import { isMarkdown } from "@/lib/md-links";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorktreeRef } from "@/lib/workspaces";

// The editor is its own chunk: nothing of CodeMirror loads until a File
// tab or the picker's preview shows.
const CodeEditor = lazy(() => import("@/components/files/code-editor"));

interface Props {
  path: string;
  // The worktree the pane belongs to (paneWorktree).
  owner: string;
  visible: boolean;
  onClose(): void;
}

// usePolling asks the box every couple of seconds, while the tab shows,
// whether its file changed; every eighth time also what the agent's turn
// did to it. A tab coming back into view asks at once.
function usePolling(key: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const tick = () => {
      if (document.visibilityState === "visible") void poll(key, ++n % 8 === 0);
    };
    void poll(key, true);
    const id = window.setInterval(tick, 2000);
    const onVis = () => document.visibilityState === "visible" && void poll(key);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key, active]);
}

// FilePane is a File tab: a file of the pane's worktree in the editor, what
// the agent changed this turn in the margin, and, when the agent writes it
// under your unsaved edits, a banner to choose what to keep.
export function FilePane({ path, owner, visible, onClose }: Props) {
  const ref = useWorktreeRef(owner);
  const key = docKey(owner, path);
  const doc = useFiles((s) => s.docs[key]);
  const wrapPref = useFiles((s) => s.wrap);
  const [narrow, setNarrow] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const o = new ResizeObserver(() => setNarrow(el.clientWidth < 720));
    o.observe(el);
    return () => o.disconnect();
  }, [doc?.state]);
  const wrap = wrapPref ?? narrow;
  // A Markdown file shows as a page, its source, or both; a narrow pane
  // has no room for both, so it shows the page.
  const mdPref = useFiles((s) => s.mdView);
  const [hunk, setHunk] = useState(0);
  const [reveal, setReveal] = useState(0);
  // A line asked for (a path named in a chat) shows instead of the agent's
  // first change, until you step through the changes.
  const goto = useFiles((s) => (s.goto?.key === key ? s.goto : undefined));
  const [jump, setJump] = useState<Goto>();
  useEffect(() => {
    if (!goto) return;
    setJump(goto);
    setReveal((r) => r + 1);
    useFiles.setState({ goto: undefined });
  }, [goto]);

  useEffect(() => {
    if (ref) void openDoc(owner, ref, path);
  }, [ref, owner, path]);
  usePolling(key, visible && !!doc && (doc.state === "ready" || doc.state === "gone"));

  // The marks follow your typing a beat behind, so a long file stays quick.
  const text = useDeferredValue(doc?.text ?? "");
  const marks = useMemo(() => (doc?.state === "ready" && !doc.binary && !doc.tooLarge ? agentMarks(doc.turn ? doc.turn.before : undefined, doc.agentText, doc.base, text) : undefined), [doc?.state, doc?.binary, doc?.tooLarge, doc?.turn, doc?.agentText, doc?.base, text]);
  const conflicted = useMemo(() => (doc?.conflict?.content !== undefined ? conflictLines(doc.base, text, doc.conflict.content) : undefined), [doc?.conflict, doc?.base, text]);
  const hunks = marks?.hunks ?? [];
  const at = Math.min(hunk, Math.max(0, hunks.length - 1));
  const step = (d: number) => {
    if (!hunks.length) return;
    setHunk((at + d + hunks.length) % hunks.length);
    setJump(undefined);
    setReveal((r) => r + 1);
  };

  if (!doc || doc.state === "loading")
    return (
      <div className="flex flex-1 items-center justify-center bg-pane" data-testid="file-pane" data-state="loading">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );

  const dirty = isDirty(doc);
  const showCompare = doc.comparing && doc.conflict?.content !== undefined;
  const isText = !doc.binary && !doc.tooLarge && doc.state === "ready";
  const view: MdView | undefined = isText && isMarkdown(path) ? (narrow && mdPref === "split" ? "preview" : mdPref) : undefined;
  let body: React.ReactNode;
  if (doc.state === "error") body = <Refusal path={path} title={`Couldn't open ${fileName(path)}`} detail={<ErrorText text={doc.error} className="items-center text-muted-foreground text-meta" />} retry={() => ref && void openDoc(owner, ref, path)} />;
  else if (doc.state === "gone") body = <Refusal path={path} icon={<FileX2Icon className="size-5 text-muted-foreground" />} title={`${fileName(path)} isn't in this worktree any more`} detail="It was deleted or moved on the box." onClose={onClose} />;
  else if (doc.image && !doc.tooLarge) body = <ImageView doc={doc} />;
  else if (doc.binary || doc.tooLarge) body = <Refusal path={path} title={doc.tooLarge ? "Too large to open here" : "Not a text file"} detail={doc.reason} external />;
  else if (showCompare) body = <CompareMine doc={doc} />;
  else if (view === "preview") body = <MarkdownView doc={doc} text={text} className="flex-1" />;
  else {
    const editor = (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner className="size-4 text-muted-foreground" /></div>}>
        <CodeEditor path={path} text={doc.text} onChange={(t) => edit(key, t)} onSave={() => void save(key)} changes={marks} conflictLines={conflicted} revealLine={jump?.line ?? hunks[at]?.from} revealEnd={jump?.end} reveal={reveal} wrap={wrap} className="min-h-0 min-w-0 flex-1 basis-0" />
      </Suspense>
    );
    body =
      view === "split" ? (
        <div className="flex min-h-0 min-w-0 flex-1" data-testid="file-split">
          {editor}
          <MarkdownView doc={doc} text={text} className="flex-1 basis-0 border-l" />
        </div>
      ) : (
        editor
      );
  }

  return (
    <div ref={frame} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-pane" data-testid="file-pane" data-state={doc.state} data-path={path} data-wrap={wrap || undefined}>
      <FileHeader narrow={narrow} doc={doc} dirty={dirty} added={marks?.added} removed={marks?.removed} hunks={view === "preview" ? 0 : hunks.length} at={at} onStep={step} wrap={wrap} text={isText} view={view} />
      {doc.conflict && !showCompare && <ConflictBanner doc={doc} />}
      {body}
    </div>
  );
}

// ---- The header ----

function Crumbs({ path, dirty, compact }: { path: string; dirty: boolean; compact?: boolean }) {
  const parts = path.split("/");
  // A narrow pane (a split, or beside the Files panel) shows the name
  // alone, rather than folders squeezed to a stray chevron.
  const dirs = compact ? [] : parts.slice(0, -1);
  return (
    <span className="flex min-w-0 items-center gap-0.5 text-meta" aria-label={path} data-testid="file-crumbs">
      {dirs.map((p, i) => (
        // Narrow, only the nearest folders stay.
        <span key={i} className={cn("flex min-w-0 shrink items-center gap-0.5 text-muted-foreground", i < dirs.length - 2 && "max-[1099px]:hidden", i < dirs.length - 1 && "max-[759px]:hidden")}>
          <span className="truncate">{p}</span>
          <ChevronRightIcon className="size-3 shrink-0 opacity-50" />
        </span>
      ))}
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 font-medium text-foreground">
        <FileGlyph path={path} className="size-3" />
        <span className="truncate">{parts[parts.length - 1]}</span>
        {dirty && <span role="img" aria-label="Unsaved" className="size-1.5 shrink-0 rounded-full bg-foreground/70" />}
      </span>
    </span>
  );
}

export function OpenInEditor({ path, line, compact }: { path: string; line?: number; compact?: boolean }) {
  const name = useEditorName();
  return (
    <Tip label={`Open in ${name}`} side="bottom">
      <button type="button" aria-label={`Open in ${name}`} onClick={() => openFile(path, "external", line)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-meta hover:bg-accent hover:text-foreground">
        {!compact && <span className="max-[759px]:hidden">{name}</span>}
        <ArrowUpRightIcon className="size-3.5" />
      </button>
    </Tip>
  );
}

const IconButton = ({ label, onClick, pressed, children }: { label: string; onClick(): void; pressed?: boolean; children: React.ReactNode }) => (
  <Tip label={label} side="bottom">
    <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", pressed && "bg-accent text-foreground")}>
      {children}
    </button>
  </Tip>
);

function SaveState({ doc }: { doc: Doc }) {
  const [, tick] = useState(0);
  const recent = !!doc.savedAt && Date.now() - doc.savedAt < 2500;
  useEffect(() => {
    if (!recent) return;
    const id = window.setTimeout(() => tick((n) => n + 1), 2600);
    return () => window.clearTimeout(id);
  }, [recent, doc.savedAt]);
  if (doc.saving) return <span className="shrink-0 text-muted-foreground text-meta">Saving…</span>;
  if (doc.saveError)
    return (
      <Tip label={doc.saveError} side="bottom">
        <span role="alert" className="flex shrink-0 items-center gap-1 text-destructive-foreground text-meta">
          <TriangleAlertIcon className="size-3" /> Not saved
        </span>
      </Tip>
    );
  if (recent) return <span className="shrink-0 text-muted-foreground text-meta" data-testid="file-saved">Saved</span>;
  return null;
}

function FileHeader({ narrow, doc, dirty, added, removed, hunks, at, onStep, wrap, text, view }: { narrow?: boolean; doc: Doc; dirty: boolean; added?: number; removed?: number; hunks: number; at: number; onStep(d: number): void; wrap: boolean; text: boolean; view?: MdView }) {
  const turn = doc.turn;
  const [, tick] = useState(0);
  // "2m ago" keeps up.
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex h-bar-pane shrink-0 items-center gap-2 border-b px-edge" data-testid="file-header">
      <Crumbs path={doc.path} dirty={dirty} compact={narrow} />
      <SaveState doc={doc} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {turn && text && (
          <span className="flex items-center gap-1.5 py-0.5 pl-1.5 text-muted-foreground text-meta" data-testid="file-turn">
            <AgentIcon agent={turn.agent} className="size-3" />
            <span className="max-[979px]:hidden">
              {agentName(turn.agent)}
              {turn.at ? `, ${ago(new Date(turn.at).toISOString())}` : ""}
            </span>
            <span className="font-mono text-tag tabular-nums">
              <span className="text-success-foreground">+{added ?? turn.added}</span> <span className="text-destructive-foreground">−{removed ?? turn.removed}</span>
            </span>
            {hunks > 0 && (
              <span className="ml-0.5 flex items-center" role="group" aria-label="Changes">
                <IconButton label="Previous change" onClick={() => onStep(-1)}>
                  <ChevronUpIcon className="size-3.5" />
                </IconButton>
                <span className="min-w-7 text-center text-tag tabular-nums" data-testid="file-hunk">
                  {at + 1}/{hunks}
                </span>
                <IconButton label="Next change" onClick={() => onStep(1)}>
                  <ChevronDownIcon className="size-3.5" />
                </IconButton>
              </span>
            )}
          </span>
        )}
        {turn && text && <span aria-hidden className="mx-0.5 h-3.5 w-px bg-border" />}
        {view && <MdViewSwitch view={view} narrow={narrow} />}
        {text && view !== "preview" && (
          <IconButton label={wrap ? "Don't wrap long lines" : "Wrap long lines"} pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapTextIcon className="size-3.5" />
          </IconButton>
        )}
        <OpenInEditor path={doc.path} />
      </div>
    </div>
  );
}

// MdViewSwitch picks how a Markdown file shows: the page, its source, or
// both (not in a narrow pane, which shows the page instead).
const MD_VIEWS: { view: MdView; label: string; icon: React.ReactNode }[] = [
  { view: "preview", label: "Preview", icon: <BookOpenTextIcon className="size-3.5" /> },
  { view: "source", label: "Source", icon: <CodeXmlIcon className="size-3.5" /> },
  { view: "split", label: "Source and preview side by side", icon: <Columns2Icon className="size-3.5" /> },
];

function MdViewSwitch({ view, narrow }: { view: MdView; narrow?: boolean }) {
  return (
    <span role="group" aria-label="Show as" className="flex items-center gap-0.5 rounded-md bg-muted/50 p-px" data-testid="md-view">
      {MD_VIEWS.filter((v) => !(narrow && v.view === "split")).map((v) => (
        <IconButton key={v.view} label={v.label} pressed={view === v.view} onClick={() => setMdView(v.view)}>
          {v.icon}
        </IconButton>
      ))}
    </span>
  );
}

// ---- The conflict ----

function ConflictBanner({ doc }: { doc: Doc }) {
  const who = doc.turn ? `${agentName(doc.turn.agent)} ${doc.conflict?.deleted ? "deleted" : "changed"} this.` : doc.conflict?.deleted ? "This file was deleted on the box." : "This file changed on the box.";
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-l-2 border-l-warning bg-warning/8 py-1.5 pr-3 pl-2.5 text-meta" data-testid="file-conflict">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning-foreground" />
        <span className="shrink-0 font-medium text-foreground">{who}</span>
        <span className="truncate text-muted-foreground">Your unsaved edits are still here.</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => reload(doc.key)}>
          {doc.conflict?.deleted ? "Discard mine" : "Reload"}
        </Button>
        <Button size="xs" variant={doc.conflict?.deleted ? "default" : "outline"} onClick={() => keepMine(doc.key)}>
          Keep mine
        </Button>
        {!doc.conflict?.deleted && (
          <Button size="xs" onClick={() => setComparing(doc.key, true)}>
            <GitCompareArrowsIcon />
            Compare
          </Button>
        )}
      </span>
    </div>
  );
}

// CompareMine shows your version beside the agent's, in the diff view.
function CompareMine({ doc }: { doc: Doc }) {
  const diffs = useDiffs(true);
  const dark = useActiveTheme().appearance === "dark";
  const theirs = doc.conflict?.content ?? "";
  const fd = useMemo(() => (diffs && "mod" in diffs ? diffs.mod.fromTexts(doc.path, doc.text, theirs) : undefined), [diffs, doc.path, doc.text, theirs]);
  const who = agentName(doc.turn?.agent);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-compare">
      <div className="flex h-bar-pane shrink-0 items-center gap-2 border-b bg-warning/6 px-edge text-meta">
        <GitCompareArrowsIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Yours</span>
        <span className="text-muted-foreground/60">→</span>
        <span className="flex items-center gap-1">
          {doc.turn && <AgentIcon agent={doc.turn.agent} className="size-3" />} {doc.turn ? `${who}'s` : "On the box"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => reload(doc.key)}>
            Take {doc.turn ? `${who}'s` : "theirs"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => keepMine(doc.key)}>
            Keep mine
          </Button>
          <IconButton label="Back to the file" onClick={() => setComparing(doc.key, false)}>
            <XIcon className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {diffs && "error" in diffs ? <ErrorText text={diffs.error} className="m-6 text-muted-foreground text-meta" /> : fd && diffs && "mod" in diffs ? <diffs.mod.Diff fileDiff={fd} layout="split" dark={dark} /> : <Spinner className="m-6 size-4" />}
      </div>
    </div>
  );
}

// ---- Files the editor doesn't hold ----

function Refusal({ path, icon, title, detail, external, retry, onClose }: { path: string; icon?: React.ReactNode; title: string; detail?: React.ReactNode; external?: boolean; retry?(): void; onClose?(): void }) {
  const name = useEditorName();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="file-refusal">
      <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">{icon ?? <FileGlyph path={path} className="size-5" />}</span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-row">{title}</p>
        {typeof detail === "string" ? <p className="text-muted-foreground text-meta">{detail}</p> : detail}
      </div>
      <div className="flex items-center gap-2">
        {external && (
          <Button size="sm" variant="outline" onClick={() => openFile(path, "external")}>
            Open in {name}
            <ArrowUpRightIcon />
          </Button>
        )}
        {retry && (
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="outline" onClick={onClose}>
            Close tab
          </Button>
        )}
      </div>
    </div>
  );
}

const sizeWords = (n?: number) => (n === undefined ? "" : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

// ImageView shows a picture from the worktree, as the box serves it.
function ImageView({ doc }: { doc: Doc }) {
  const c = useStore((s) => s.client);
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState<string>();
  const [dims, setDims] = useState<{ w: number; h: number }>();
  useEffect(() => {
    if (!c) return;
    let live = true;
    let made: string | undefined;
    filesApi.image(c, doc.ref, doc.path).then(
      (b) => {
        made = URL.createObjectURL(b);
        if (live) setUrl(made);
      },
      (e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [c, doc.ref, doc.path, doc.etag]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-image">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(color-mix(in_oklab,var(--muted)_70%,transparent)_0%_25%,transparent_0%_50%)] bg-size-[16px_16px] p-8">
        {err ? <ErrorText text={err} className="text-muted-foreground text-meta" /> : url ? <img src={url} alt={fileName(doc.path)} onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} className="max-h-full max-w-full rounded-sm object-contain shadow-sm" /> : <Spinner className="size-4 text-muted-foreground" />}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-tag text-muted-foreground tabular-nums">
        <span>{doc.image?.replace("image/", "").toUpperCase()}</span>
        {dims && (
          <span>
            {dims.w} × {dims.h}
          </span>
        )}
        <span>{sizeWords(doc.size)}</span>
      </div>
    </div>
  );
}

export default FilePane;
