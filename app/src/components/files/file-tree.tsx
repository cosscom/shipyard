import { ChevronRightIcon, FilePlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { agentName, FileGlyph } from "@/components/files/file-bits";
import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { type Filter, loadDir, pickFilter, reveal, setCreating, toggleChangedDir, toggleDir, type TreeRow, useFilter, useTree, useTreeRows, useWorkingSessions } from "@/lib/file-tree";
import { filesApi, type How, type TouchedFile, useFiles } from "@/lib/files";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { folderOf, newFilePath, parentOf, type Touch } from "@/lib/tree-model";
import { cn } from "@/lib/utils";
import type { WorktreeRef } from "@/lib/workspaces";

// The Files panel's tree (components/files/tree-dock.tsx places it): the
// worktree's files a folder at a time (All), or only what its agents
// touched this turn (Changed), with +/− and A/M/D. A blue dot marks a
// folder with changes inside (amber means "needs you" in Shipyard, so not
// that); the file an agent is writing now gets a quiet live mark, and its
// folders' dots pulse. New file is the only thing it does to files: no
// rename, delete, move or drag.

const INDENT = 12;

// Badge is a file's letter: A, the turn made it; M, it changed it; D, it
// deleted it.
function Badge({ t }: { t: Touch }) {
  const [letter, cls, word] = t.deleted ? ["D", "text-destructive-foreground", "Deleted"] : t.created ? ["A", "text-success-foreground", "Added"] : ["M", "text-info-foreground", "Modified"];
  return (
    <span aria-label={`${word} by ${agentName(t.agent)} this turn`} data-testid="tree-badge" className={cn("w-3 shrink-0 text-center font-sans font-semibold text-tag leading-none", cls)}>
      {letter}
    </span>
  );
}

function Counts({ t }: { t: Touch }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-tag tabular-nums">
      {t.added > 0 && <span className="text-success-foreground">+{t.added}</span>}
      {t.removed > 0 && <span className="text-destructive-foreground">−{t.removed}</span>}
    </span>
  );
}

// Live is the quiet mark on a file the agent is writing now.
function Live({ agent }: { agent?: string }) {
  return (
    <Tip label={`${agentName(agent)} is writing this now`} side="left">
      <span data-testid="tree-live" className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-[#d97757]/25 [animation-duration:1.8s] motion-reduce:hidden" />
        <AgentIcon agent={agent} className="size-3" />
      </span>
    </Tip>
  );
}

function RowView({ row, index, active, current, filter, onPick }: { row: TreeRow; index: number; active: boolean; current: boolean; filter: Filter; onPick(row: TreeRow, how: How): void }) {
  const t = row.touched;
  const dir = row.kind === "dir";
  return (
    <div
      id={`tree-row-${index}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={dir && !row.empty ? !!row.open : undefined}
      aria-selected={active}
      aria-current={current ? "page" : undefined}
      data-index={index}
      data-path={row.path}
      data-kind={row.kind}
      data-live={row.live || undefined}
      onClick={(e) => onPick(row, e.metaKey || e.ctrlKey ? "external" : e.altKey ? "split" : "tab")}
      className={cn(
        "group/row relative flex h-[26px] cursor-default select-none items-center gap-1.5 rounded-[5px] pr-2 text-desc",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        current && !active && "bg-accent/60",
      )}
      style={{ paddingLeft: 6 + row.depth * INDENT }}
    >
      {/* Indent guides, one per level above. */}
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border/70" style={{ left: 6 + i * INDENT + 6 }} />
      ))}
      {dir ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {row.loading ? <Spinner className="size-3" /> : row.empty ? null : <ChevronRightIcon className={cn("size-3.5 transition-transform duration-100", row.open && "rotate-90")} />}
        </span>
      ) : (
        <FileGlyph path={row.path} className="size-3.5" />
      )}
      <span className={cn("min-w-0 truncate", dir ? "text-foreground/90" : t && !t.deleted ? "text-foreground" : "text-foreground/85", row.empty && "text-muted-foreground", current && "font-medium text-foreground", t?.deleted && "text-muted-foreground line-through decoration-muted-foreground/50")}>
        {dir && row.name.includes("/") ? (
          <>
            {row.name
              .split("/")
              .slice(0, -1)
              .map((p, i) => (
                <span key={i} className="text-muted-foreground">
                  {p}/
                </span>
              ))}
            {row.name.split("/").pop()}
          </>
        ) : (
          row.name
        )}
      </span>
      {dir && !!row.inside && (
        <Tip label={`${row.inside} ${row.inside === 1 ? "file" : "files"} changed inside`} side="left" delay={500}>
          <span data-testid="tree-dot" data-live={row.liveInside || undefined} className={cn("ml-0.5 size-1.5 shrink-0 rounded-full bg-info", row.open && filter === "all" && "opacity-45", row.liveInside && "animate-pulse")} />
        </Tip>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        {row.live && <Live agent={t?.agent} />}
        {t && filter === "changed" && !t.deleted && <Counts t={t} />}
        {t && <Badge t={t} />}
      </span>
    </div>
  );
}

// FilterSwitch is All | Changed, with how many files the agents changed.
function FilterSwitch({ filter, onChange, count }: { filter: Filter; onChange(f: Filter): void; count: number }) {
  const item = (f: Filter, label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={filter === f}
      data-testid={`tree-filter-${f}`}
      onClick={() => onChange(f)}
      className={cn("inline-flex h-[22px] items-center gap-1 rounded-[5px] px-2 text-label outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", filter === f ? "bg-background text-foreground shadow-xs dark:bg-accent" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
    </button>
  );
  return (
    <span role="radiogroup" aria-label="Show" className="ml-auto inline-flex shrink-0 items-center gap-px rounded-md bg-muted p-0.5">
      {item("all", "All")}
      {item(
        "changed",
        <>
          Changed
          {count > 0 && <span className={cn("tabular-nums", filter === "changed" ? "text-muted-foreground" : "text-muted-foreground/70")}>{count}</span>}
        </>,
      )}
    </span>
  );
}

// NewFile is New file: a name typed in place, in the folder you are on (a
// path from the top starts with /), made empty with If-None-Match: * so it
// never replaces a file, then opened in a File tab.
function NewFile({ ws, wref, dir, onDone }: { ws: string; wref: WorktreeRef; dir: string; onDone(path?: string): void }) {
  const client = useStore((s) => s.client);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    const path = newFilePath(dir, name);
    if (!path) {
      if (name.trim()) setError("Name a file in this worktree, like util.ts or lib/util.ts.");
      return;
    }
    if (!client || busy) return;
    setBusy(true);
    try {
      await filesApi.write(client, wref, path, "", undefined);
      reveal(ws, path);
      void loadDir(ws, wref, parentOf(path), true);
      onDone(path);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="mx-1.5 mt-1.5 mb-1 rounded-md border bg-background px-2 py-1.5 shadow-xs" data-testid="tree-new-file">
      <div className="flex items-center gap-1.5">
        <FilePlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void make();
            if (e.key === "Escape") onDone();
          }}
          onBlur={() => !name.trim() && !busy && onDone()}
          placeholder="new-file.ts"
          aria-label="New file's name"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-mono outline-none placeholder:text-muted-foreground/70"
        />
        {busy && <Spinner className="size-3" />}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-destructive-foreground text-tag">
          {error}
        </p>
      ) : (
        <p className="mt-1 flex min-w-0 gap-1 text-tag text-muted-foreground">
          {/* The folder's end shows when it is long: "…/lib/payments/". */}
          <span className="min-w-0 truncate" dir="rtl">
            <bdi>in {dir ? `${dir}/` : "the top folder"}</bdi>
          </span>
          <span className="shrink-0">· ↵ · esc</span>
        </p>
      )}
    </div>
  );
}

// treeKey moves through rows: ↑↓, → opens a folder or goes into it, ← closes
// it or goes up, ↵ opens a file (⌥↵ beside, ⌘↵ in your editor).
function treeKey(e: React.KeyboardEvent, rows: TreeRow[], at: number, setAt: (i: number) => void, pick: (row: TreeRow, how: How) => void, toggle: (row: TreeRow, open?: boolean) => void): boolean {
  const row = rows[at];
  if (e.key === "ArrowDown") setAt(Math.min(rows.length - 1, at + 1));
  else if (e.key === "ArrowUp") setAt(Math.max(0, at - 1));
  else if (e.key === "Home") setAt(0);
  else if (e.key === "End") setAt(rows.length - 1);
  else if (e.key === "ArrowRight" && row?.kind === "dir" && !row.empty) {
    if (!row.open) toggle(row, true);
    else if (rows[at + 1]?.depth === row.depth + 1) setAt(at + 1);
  } else if (e.key === "ArrowLeft" && row) {
    if (row.kind === "dir" && row.open) toggle(row, false);
    else {
      for (let i = at - 1; i >= 0; i--)
        if (rows[i].depth < row.depth) {
          setAt(i);
          break;
        }
    }
  } else if (e.key === "Enter" && row) {
    if (e.nativeEvent.isComposing) return true;
    pick(row, e.metaKey || e.ctrlKey ? "external" : e.altKey ? "split" : "tab");
  } else return false;
  e.preventDefault();
  return true;
}

// TreePanel is the tree with its header: Files, All | Changed, New file,
// and hide.
export function TreePanel({ ws, wref, current, onOpen, onClose, className }: { ws: string; wref: WorktreeRef; current?: string; onOpen(path: string, how: How): void; onClose(): void; className?: string }) {
  const working = useWorkingSessions(wref);
  const filter = useFilter(ws, working.size > 0);
  const creating = useTree((s) => (s.creating?.ws === ws ? s.creating : undefined));
  const touched = useFiles((s) => s.touched[ws]?.files);
  const { rows, truncated, loading, error } = useTreeRows(ws, wref, filter, working);
  const [at, setAt] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  // The open file's folders open with it.
  useEffect(() => {
    if (current) reveal(ws, current);
  }, [ws, current]);
  // Another worktree, view or file in front: the list's place is the file
  // in front again.
  useEffect(() => setAt(-1), [ws, filter, current]);
  const curIndex = useMemo(() => (current ? rows.findIndex((r) => r.path === current) : -1), [rows, current]);
  const focusAt = at >= 0 ? Math.min(at, rows.length - 1) : curIndex;
  // Scroll to the open file when it changes (once its row is there), and
  // with the keyboard; never when a folder opens above or below it.
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (at >= 0) list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  useEffect(() => {
    if (!current || shown.current === current || curIndex < 0) return;
    shown.current = current;
    list.current?.querySelector(`[data-index="${curIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, curIndex]);
  const count = touched?.length ?? 0;

  const toggle = (row: TreeRow, open?: boolean) => {
    if (row.empty) return;
    if (filter === "changed") toggleChangedDir(ws, row.path, open);
    else toggleDir(ws, row.path, open);
  };
  const pick = (row: TreeRow, how: How) => {
    setAt(rows.indexOf(row));
    if (row.kind === "dir") return toggle(row);
    onOpen(row.path, how);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-testid="file-tree" data-filter={filter}>
      {/* The File tab's header line: 32px, so the two read as one row. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3">
        <span className="text-muted-foreground text-label">Files</span>
        <FilterSwitch filter={filter} onChange={(f) => pickFilter(ws, f)} count={count} />
        <Tip label="New file" side="bottom">
          <button type="button" aria-label="New file" data-testid="tree-new-file-button" onClick={() => setCreating({ ws, dir: folderOf(rows[focusAt]) })} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <FilePlusIcon className="size-3.5" />
          </button>
        </Tip>
        <Tip label="Hide files (⌘⇧E)" side="bottom">
          <button type="button" aria-label="Hide files" onClick={onClose} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <XIcon className="size-3.5" />
          </button>
        </Tip>
      </div>
      {creating && (
        <NewFile
          key={creating.dir}
          ws={ws}
          wref={wref}
          dir={creating.dir}
          onDone={(p) => {
            setCreating(undefined);
            if (p) onOpen(p, "tab");
          }}
        />
      )}
      <div
        ref={list}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        aria-activedescendant={focusAt >= 0 ? `tree-row-${focusAt}` : undefined}
        onKeyDown={(e) => treeKey(e, rows, Math.max(0, focusAt), setAt, pick, toggle)}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pt-1 pb-2 outline-none [scrollbar-width:thin]"
      >
        {filter === "all" && loading && !rows.length ? (
          <div className="flex justify-center py-6">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        ) : filter === "all" && error ? (
          <p className="px-2 py-6 text-center text-muted-foreground text-meta">{error}</p>
        ) : filter === "changed" && !rows.length ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center" data-testid="tree-nothing-changed">
            <p className="text-foreground text-meta">Nothing changed this turn</p>
            <p className="text-tag text-muted-foreground">Files the agent edits show here as it goes.</p>
          </div>
        ) : (
          rows.map((r, i) => <RowView key={r.path} row={r} index={i} active={i === at} current={r.path === current} filter={filter} onPick={pick} />)
        )}
      </div>
      {filter === "changed" && count > 0 && <ChangedFooter files={touched ?? []} />}
      {filter === "all" && truncated && (
        <p className="shrink-0 border-t px-3 py-1.5 text-tag text-muted-foreground" data-testid="tree-truncated">
          A folder here has more than 5,000 entries; it lists the first 5,000.
        </p>
      )}
    </div>
  );
}

// ChangedFooter sums what the agents changed this turn.
function ChangedFooter({ files }: { files: TouchedFile[] }) {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const agents = [...new Set(files.map((f) => f.agent))];
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-t px-3 text-tag text-muted-foreground" data-testid="tree-changed-footer">
      {agents.length === 1 && <AgentIcon agent={agents[0]} className="size-3" />}
      <span>
        {files.length} {files.length === 1 ? "file" : "files"} this turn
      </span>
      <span className="ml-auto font-mono tabular-nums">
        <span className="text-success-foreground">+{added}</span> <span className="text-destructive-foreground">−{removed}</span>
      </span>
    </div>
  );
}
