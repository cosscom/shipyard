import { ClockIcon, SearchIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { agentName, FileGlyph, useEditorName } from "@/components/files/file-bits";
import { useLabel } from "@/components/workspace/worktree-tone";
import { CommandDialog, CommandDialogPopup, CommandFooter, CommandPanel } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { rank } from "@/lib/file-match";
import { filesApi, type How, loadTouched, openFile, setPickerOpen, type TouchedFile, useFiles } from "@/lib/files";
import { explain } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useHereKey, useHereRef } from "@/lib/workspaces";
import { focusNewPane } from "@/lib/focus-home";

// The preview, with the editor, is its own chunk.
const Preview = lazy(() => import("@/components/files/file-preview"));

// The preview column shows from this window width up.
const WIDE = "(min-width: 1180px)";

function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(WIDE).matches,
  );
}

interface Entry {
  path: string;
  hits: number[];
  touched?: TouchedFile;
  recent?: boolean;
}

interface Group {
  id: string;
  label: string;
  agent?: string;
  items: Entry[];
}

// FilePicker (⌘P) finds a file in the worktree you are acting in. Empty,
// it lists what the agent changed this turn, then what you opened lately;
// typed, a fuzzy match over every file (the box's list), its matched
// letters marked. ↵ opens a File tab, ⌥↵ opens it beside the focused pane,
// ⌘↵ in your editor. On a wide window the highlighted file shows at the
// agent's first change beside the list.
export function FilePicker() {
  const open = useFiles((s) => s.pickerOpen);
  return (
    <CommandDialog open={open} onOpenChange={(o) => setPickerOpen(o)}>
      {open && <Picker />}
    </CommandDialog>
  );
}

function Picker() {
  const ws = useHereKey();
  const ref = useHereRef();
  const { label: where } = useLabel(ws);
  const client = useStore((s) => s.client);
  // Asked again when its box comes back, so an error from while it was away
  // doesn't stay.
  const online = useStore((s) => (ref ? s.status?.boxes.find((b) => b.name === ref.box)?.state === "online" : false));
  const recent = useFiles((s) => (ws ? s.recent[ws] : undefined));
  const touched = useFiles((s) => (ws ? s.touched[ws] : undefined));
  const wide = useWide();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; files: string[]; truncated?: boolean }>();
  const [error, setError] = useState<string>();
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const editor = useEditorName();

  useEffect(() => {
    if (ws && ref) void loadTouched(ws, ref);
  }, [ws, ref]);

  // Typed: the box's best matches, asked for a beat after the last key.
  useEffect(() => {
    const q = query.trim();
    if (!q || !client || !ref) return;
    const ac = new AbortController();
    const id = window.setTimeout(() => {
      filesApi.list(client, ref, q, 120, ac.signal).then(
        (r) => {
          setFound({ q, files: r.files ?? [], truncated: r.truncated });
          setError(undefined);
        },
        (err: unknown) => {
          if (ac.signal.aborted) return;
          // In words (a box away, one not answering), not the transport's.
          const e = explain(err, { box: ref.box });
          setError(`${e.title}. ${e.message}`);
        },
      );
    }, 50);
    return () => {
      window.clearTimeout(id);
      ac.abort();
    };
  }, [query, client, ref, online]);

  const groups = useMemo<Group[]>(() => {
    const files = touched?.files.filter((f) => !f.deleted) ?? [];
    const byPath = new Map(files.map((f) => [f.path, f]));
    const mine = recent ?? [];
    const q = query.trim();
    if (!q) {
      const agents = new Set(files.map((f) => f.agent));
      const who = agents.size === 1 ? agentName([...agents][0]) : "agents";
      return [
        { id: "agent", label: `Changed by ${who} this turn`, agent: agents.size === 1 ? [...agents][0] : undefined, items: files.map((f) => ({ path: f.path, hits: [], touched: f })) },
        { id: "recent", label: "Recently opened", items: mine.filter((p) => !byPath.has(p)).slice(0, 8).map((p) => ({ path: p, hits: [], recent: true })) },
      ].filter((g) => g.items.length);
    }
    if (!found) return [];
    // The box's list, ranked here as it ranks, the agent's files and
    // recent ones lifted, and the letters to mark.
    const pool = [...new Set([...found.files, ...files.map((f) => f.path), ...mine])];
    const ranked = rank(q, pool, (p) => (byPath.has(p) ? 6 : 0) + (mine.includes(p) ? 3 : 0)).slice(0, 60);
    if (!ranked.length) return [];
    return [{ id: "found", label: ranked.length === 1 ? "1 file" : `${ranked.length} files`, items: ranked.map((m) => ({ path: m.path, hits: m.hits, touched: byPath.get(m.path), recent: mine.includes(m.path) })) }];
  }, [query, found, touched, recent]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(at, flat.length - 1)];
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (e: Entry | undefined, how: How) => {
    if (!e) return;
    setPickerOpen(false);
    openFile(e.path, how);
    // The file takes the keyboard, in its tab or beside (not in an editor app).
    if (how !== "external") focusNewPane();
  };
  // ↵ before the box has answered what you typed opens its best match as
  // soon as it does.
  const [pending, setPending] = useState<How>();
  const q = query.trim();
  const searching = !!q && (!found || found.q !== q) && !error;
  useEffect(() => {
    if (pending && !searching) {
      setPending(undefined);
      choose(flat[0], pending);
    }
    // choose reads only store setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, searching, flat]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setAt((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      const how: How = e.metaKey || e.ctrlKey ? "external" : e.altKey ? "split" : "tab";
      if (searching) setPending(how);
      else choose(current, how);
    }
  };

  const preview = wide && !!ws && !!ref;

  return (
    <CommandDialogPopup className={cn(preview ? "h-[min(36rem,82vh)] max-h-[min(36rem,82vh)] max-w-5xl" : "max-h-[min(32rem,80vh)] max-w-2xl")} data-testid="file-picker" aria-label="Go to file">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground opacity-80" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={where ? `Go to a file in ${where}…` : "Go to a file…"}
          aria-label="Go to file"
          aria-controls="file-picker-list"
          aria-activedescendant={current ? `file-option-${at}` : undefined}
          role="combobox"
          aria-expanded
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground/80"
        />
        {searching && <Spinner className="size-3.5 text-muted-foreground" />}
        {ref && <span className="shrink-0 rounded-md border bg-muted/60 px-1.5 py-px font-mono text-tag text-muted-foreground">{ref.box}</span>}
      </div>
      <CommandPanel className={cn("flex min-h-0", preview && "flex-1")}>
        <div className={cn("flex min-h-0 min-w-0 flex-col", preview ? "w-[24rem] shrink-0 border-r" : "flex-1")}>
          <Results groups={groups} at={at} setAt={setAt} choose={choose} listRef={list} empty={!ws ? "Open a worktree first: ⌘P finds files in the one in front." : error ? error : q ? (searching ? "" : "No file matches.") : touched ? "Type a file's name." : ""} />
        </div>
        {preview && <div className="min-w-0 flex-1">{current ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-4 text-muted-foreground" /></div>}><Preview ws={ws!} path={current.path} /></Suspense> : <div className="h-full" />}</div>}
      </CommandPanel>
      <CommandFooter className="justify-start gap-4 text-tag">
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌥↵</Kbd> split
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘↵</Kbd> {editor}
        </span>
        {/* Past the box's 20,000-file list (internal/box/commands.go): the
            search covers those, plus what the agents touched. */}
        {q && found?.truncated && (
          <span className="ml-auto truncate text-muted-foreground" data-testid="file-picker-truncated">
            Searching the first 20,000 files
          </span>
        )}
        <span className={cn("flex items-center gap-1", !(q && found?.truncated) && "ml-auto")}>
          <Kbd>esc</Kbd> close
        </span>
      </CommandFooter>
    </CommandDialogPopup>
  );
}

function Results({ groups, at, setAt, choose, listRef, empty }: { groups: Group[]; at: number; setAt(i: number): void; choose(e: Entry, how: How): void; listRef: React.RefObject<HTMLDivElement | null>; empty: string }) {
  let i = -1;
  return (
    <div ref={listRef} id="file-picker-list" role="listbox" aria-label="Files" className="h-full min-h-0 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]">
      {!groups.length && empty && <p className="px-2 py-8 text-center text-muted-foreground text-body">{empty}</p>}
      {groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.label} className="[[role=group]+&]:mt-2">
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-muted-foreground text-label">
            {g.id === "agent" && <AgentIcon agent={g.agent} className="size-3" />}
            {g.label}
          </div>
          {g.items.map((e) => {
            i++;
            const idx = i;
            return <Row key={e.path} e={e} index={idx} active={idx === at} onHover={() => setAt(idx)} onPick={(how) => choose(e, how)} grouped={g.id === "agent"} />;
          })}
        </div>
      ))}
    </div>
  );
}

// Marked is text with the matched letters (indexes into the whole path;
// offset is where text starts in it) bold and underlined.
function Marked({ text, hits, offset, className }: { text: string; hits: number[]; offset: number; className?: string }) {
  if (!hits.length) return <span className={className}>{text}</span>;
  const set = new Set(hits);
  const out: React.ReactNode[] = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (!run) return;
    out.push(
      on ? (
        <mark key={k} className="bg-transparent font-semibold text-foreground underline decoration-foreground/35 underline-offset-[3px]">
          {run}
        </mark>
      ) : (
        <span key={k}>{run}</span>
      ),
    );
    run = "";
  };
  for (let k = 0; k < text.length; k++) {
    const hit = set.has(offset + k);
    if (hit !== on) {
      flush(k);
      on = hit;
    }
    run += text[k];
  }
  flush(text.length);
  return <span className={className}>{out}</span>;
}

function Row({ e, index, active, onHover, onPick, grouped }: { e: Entry; index: number; active: boolean; onHover(): void; onPick(how: How): void; grouped: boolean }) {
  const slash = e.path.lastIndexOf("/");
  const name = e.path.slice(slash + 1);
  const dir = slash >= 0 ? e.path.slice(0, slash) : "";
  const t = e.touched;
  return (
    <div
      id={`file-option-${index}`}
      role="option"
      aria-selected={active}
      data-index={index}
      data-path={e.path}
      onMouseMove={onHover}
      onClick={(ev) => onPick(ev.metaKey || ev.ctrlKey ? "external" : ev.altKey ? "split" : "tab")}
      className={cn("flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body", active && "bg-accent text-accent-foreground")}
    >
      <FileGlyph path={e.path} className="size-4" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <Marked text={name} hits={e.hits} offset={slash + 1} className="shrink-0 text-foreground" />
        {dir && <Marked text={dir} hits={e.hits} offset={0} className="min-w-0 truncate text-muted-foreground text-meta" />}
      </span>
      {t && !grouped && <AgentIcon agent={t.agent} className="size-3" />}
      {t && (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-tag tabular-nums">
          {t.created && <span className="rounded bg-success/12 px-1 font-medium font-sans text-tag text-success-foreground">new</span>}
          <span className="text-success-foreground">+{t.added}</span>
          {t.removed > 0 && <span className="text-destructive-foreground">−{t.removed}</span>}
        </span>
      )}
      {!t && e.recent && <ClockIcon aria-label="Opened lately" className="size-3 shrink-0 text-muted-foreground/70" />}
    </div>
  );
}

