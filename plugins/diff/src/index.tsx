import { definePlugin, useEvent, useStorage, worktreeLocation, type WorktreePanelProps } from "@berth/plugin";
import { Button, type DiffFile, type DiffsModule, type DiffViewerItem, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Icon, Input, loadDiffs, PickOne, Spinner, Tip, cn } from "@berth/plugin/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type DiffResult, fetchDiff, type FileStat, LIMIT, type Scope, splitPath, startsCollapsed } from "./git";

// Diff: the whole of a branch's change in one scrolling view, the way a pull
// request shows it, drawn with the app's diff renderer (@pierre/diffs,
// diffs.com), shared with its chats. The diff is read with git on the box;
// the renderer, its highlighter and their languages load only once a Diff
// panel has something to show.

export default definePlugin((berth) => {
  berth.addWorktreePanel({ id: "diff", title: "Diff", icon: "FileDiff", Component: DiffPanel });
  berth.addCommand({ id: "open", title: "Show this branch's diff", group: "Git", run: () => berth.openPanel("diff") });
});

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: DiffResult };
type Layout = "split" | "unified";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "branch", label: "Branch" },
  { value: "uncommitted", label: "Uncommitted" },
  { value: "all", label: "All" },
];

const SCOPE_HELP: Record<Scope, string> = {
  branch: "The branch's commits since it left the default branch",
  uncommitted: "What isn't committed yet, new files included",
  all: "Commits and uncommitted work since the default branch",
};

// useWorktreeWatch calls onChange when the worktree's branch or commit moves
// (and, with dirty, its uncommitted work): an agent mid-turn checks out,
// commits and rebases without any event saying so. It looks every 15s while
// the window is shown, and at once on coming back to it.
function useWorktreeWatch(run: (command: string, timeout?: string) => Promise<{ output: string }>, onChange: () => void, dirty = false) {
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let live = true;
    let last: string | undefined;
    let timer = 0;
    const cmd = `git symbolic-ref -q --short HEAD; git rev-parse -q --verify HEAD${dirty ? "; git status --porcelain 2>/dev/null | cksum" : ""}`;
    const look = async () => {
      window.clearTimeout(timer);
      if (!document.hidden) {
        try {
          const { output } = await run(cmd, "15s");
          if (!live) return;
          if (last !== undefined && output !== last) changed.current();
          last = output;
        } catch {
          // The box is away; the panel says so when it loads.
        }
      }
      if (live) timer = window.setTimeout(() => void look(), 15_000);
    };
    void look();
    const back = () => void look();
    window.addEventListener("focus", back);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", back);
    };
  }, [run, dirty]);
}

// The app's light or dark look, which follows .dark on <html>.
function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

function DiffPanel({ berth, box, location, worktree, path, main }: WorktreePanelProps) {
  const where = worktreeLocation({ location, worktree, main });
  const [scope, setScope] = useStorage<Scope>("scope", "branch");
  const [layout, setLayout] = useStorage<Layout>("layout", "split");
  const [wrap, setWrap] = useStorage<boolean>("wrap", false);
  const [list, setList] = useStorage<boolean>("files", true);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);

  const run = useCallback((command: string, timeout = "60s") => berth.orchestrate.exec(box, where, command, timeout), [berth, box, where]);
  const refresh = useCallback(() => setStamp((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    setBusy(true);
    // A refresh keeps what is on screen until the new diff is in.
    setLoad((l) => (l.state === "ready" && l.value.kind === "ok" ? l : { state: "loading" }));
    fetchDiff(run, scope, ctl.signal)
      .then((value) => live && setLoad({ state: "ready", value }))
      .catch((err) => live && setLoad({ state: "error", message: String(err?.message ?? err) }))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
      ctl.abort();
    };
  }, [run, scope, stamp]);

  // An agent finishing, or a terminal here ending, likely changed the diff.
  useEvent("agent.finished", (e) => e.box === box && e.data?.path === path && refresh());
  useEvent("session.stopped", (e) => e.box === box && refresh());
  // A branch switched, a commit or a rebase mid-turn changes it too.
  useWorktreeWatch(run, refresh, scope !== "branch");

  const result = load.state === "ready" ? load.value : undefined;
  const ok = result?.kind === "ok" ? result : undefined;
  const added = ok?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = ok?.files.reduce((n, f) => n + f.removed, 0) ?? 0;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-pane">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{ok?.branch || (result?.kind === "nobase" ? result.branch : "") || (ok ? "detached HEAD" : "…")}</span>
        {ok?.base && scope !== "uncommitted" && (
          <Tip label={`Compared with ${ok.base} at ${ok.mergeBase.slice(0, 8)}, where the branch left it`}>
            <span className="@max-2xl:hidden shrink-0 text-muted-foreground text-xs">vs {ok.base}</span>
          </Tip>
        )}
        <PickOne label="What to compare" className="ml-1" value={scope} onChange={(v: string) => setScope(v as Scope)} options={SCOPES.map((s) => ({ value: s.value, label: <Tip label={SCOPE_HELP[s.value]}><span>{s.label}</span></Tip> }))} />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums">
          {ok && ok.files.length > 0 && (
            <span className="@max-3xl:hidden flex items-center gap-2">
              <span className="text-muted-foreground">
                {ok.files.length} file{ok.files.length === 1 ? "" : "s"}
              </span>
              <span className="font-mono text-success">+{added}</span>
              <span className="font-mono text-destructive">−{removed}</span>
            </span>
          )}
        </span>
        <PickOne
          label="Diff layout"
          value={layout}
          onChange={(v: string) => setLayout(v as Layout)}
          options={[
            { value: "split", label: "Split", icon: <Icon name="columns-2" className="size-3.5" /> },
            { value: "unified", label: "Unified", icon: <Icon name="rows-2" className="size-3.5" /> },
          ]}
        />
        <Tip label={list ? "Hide the file list" : "Show the file list"}>
          <Button size="icon-sm" variant="ghost" aria-label="File list" aria-pressed={list} className={cn("@max-2xl:hidden", list && "bg-accent text-foreground")} onClick={() => setList(!list)}>
            <Icon name="PanelLeft" className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={wrap ? "Don't wrap long lines" : "Wrap long lines"}>
          <Button size="icon-sm" variant="ghost" aria-label="Wrap long lines" aria-pressed={wrap} className={cn(wrap && "bg-accent text-foreground")} onClick={() => setWrap(!wrap)}>
            <Icon name="WrapText" className="size-3.5" />
          </Button>
        </Tip>
        <Tip label="Read the diff again">
          <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={refresh} disabled={busy && load.state !== "ready"}>
            {busy ? <Spinner className="size-3.5" /> : <Icon name="RefreshCw" className="size-3.5" />}
          </Button>
        </Tip>
      </header>
      <Body load={load} scope={scope} setScope={setScope} refresh={refresh} layout={layout} wrap={wrap} list={list} />
    </div>
  );
}

function Body({ load, scope, setScope, refresh, layout, wrap, list }: { load: Load; scope: Scope; setScope(s: Scope): void; refresh(): void; layout: Layout; wrap: boolean; list: boolean }) {
  if (load.state === "loading") {
    return (
      <Centered>
        <Spinner className="size-4" /> Reading the diff…
      </Centered>
    );
  }
  if (load.state === "error") {
    return (
      <Message title="Couldn't read the diff" detail={<span className="whitespace-pre-wrap font-mono text-xs">{load.message}</span>}>
        <Button size="sm" variant="outline" onClick={refresh}>
          Try again
        </Button>
      </Message>
    );
  }
  const r = load.value;
  if (r.kind === "notgit") return <Message title="Not a git repository" detail="This worktree's folder isn't inside a git repository, so there is no diff to show." />;
  if (r.kind === "nohead" || r.kind === "nobase") {
    return (
      <Message
        title={r.kind === "nohead" ? "No commits yet" : "No default branch to compare with"}
        detail={r.kind === "nohead" ? "This repository has no commits, so there is no branch to diff yet." : "None of origin/HEAD, origin/main, main or master exists here."}
      >
        <Button size="sm" variant="outline" onClick={() => setScope("uncommitted")}>
          Show uncommitted changes
        </Button>
      </Message>
    );
  }
  if (r.files.length === 0) {
    const detail = {
      branch: `${r.branch || "This branch"} has no commits that ${r.base} doesn't have.`,
      uncommitted: "Everything here is committed.",
      all: `Nothing here differs from ${r.base}.`,
    }[scope];
    return (
      <Message title={scope === "uncommitted" ? "No uncommitted changes" : "No changes"} detail={detail}>
        {scope === "branch" && (
          <Button size="sm" variant="outline" onClick={() => setScope("uncommitted")}>
            Show uncommitted changes
          </Button>
        )}
      </Message>
    );
  }
  return <Files result={r} scope={scope} layout={layout} wrap={wrap} list={list} />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-40 flex-1 items-center justify-center gap-2 p-6 text-muted-foreground text-sm">{children}</div>;
}

function Message({ title, detail, children }: { title: string; detail: ReactNode; children?: ReactNode }) {
  return (
    <Centered>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="max-w-md">{detail}</EmptyDescription>
        </EmptyHeader>
        {children}
      </Empty>
    </Centered>
  );
}

const STATUS = {
  new: { letter: "A", label: "Added", tone: "text-success" },
  deleted: { letter: "D", label: "Deleted", tone: "text-destructive" },
  change: { letter: "M", label: "Modified", tone: "text-warning" },
  "rename-pure": { letter: "R", label: "Renamed", tone: "text-info" },
  "rename-changed": { letter: "R", label: "Renamed", tone: "text-info" },
} as const;

interface Entry {
  stat: FileStat;
  // The shortest end of its path no other file shares ("de/payments.json"),
  // and the folders before it.
  label: { short: string; rest: string };
  fileDiff?: DiffFile;
  // Why it starts folded: a lockfile, generated, large.
  why?: string;
}

function Files({ result, scope, layout, wrap, list }: { result: DiffResult & { kind: "ok" }; scope: Scope; layout: Layout; wrap: boolean; list: boolean }) {
  const dark = useDark();
  const [mod, setMod] = useState<{ value: DiffsModule } | { error: string }>();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState<string>();
  const [jump, setJump] = useState<{ id: string; n: number }>();
  const [filter, setFilter] = useState("");
  // Each item's version: new for each diff read and each fold or unfold, so
  // the view redraws exactly the files that changed.
  const versions = useRef({ n: 0, of: new WeakMap<object, { open?: number; folded?: number }>() });

  useEffect(() => {
    let live = true;
    loadDiffs().then(
      (value) => live && setMod({ value }),
      (err) => live && setMod({ error: String(err?.message ?? err) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const parsed = useMemo(() => (mod && "value" in mod ? mod.value.parse(result.patch) : undefined), [mod, result.patch]);

  const entries = useMemo<Entry[]>(() => {
    const byName = new Map(parsed?.map((f) => [f.name, f]));
    const short = uniqueEnds(result.files.map((f) => f.path));
    return result.files.map((stat, i) => {
      const fileDiff = byName.get(stat.path);
      return { stat, fileDiff, label: short[i], why: stat.binary ? "Binary" : startsCollapsed(stat) };
    });
  }, [parsed, result.files]);

  const isOpen = useCallback((e: Entry) => (e.fileDiff?.hunks.length ? (open[e.stat.path] ?? !e.why) : false), [open]);

  const items = useMemo<DiffViewerItem[]>(
    () =>
      entries.flatMap((e) => {
        if (!e.fileDiff) return [];
        const collapsed = !isOpen(e);
        const v = versions.current;
        const known = v.of.get(e.fileDiff) ?? {};
        v.of.set(e.fileDiff, known);
        if (collapsed) known.folded ??= ++v.n;
        else known.open ??= ++v.n;
        const version = (collapsed ? known.folded : known.open) ?? 0;
        return [{ id: e.stat.path, fileDiff: e.fileDiff, collapsed, version }];
      }),
    [entries, isOpen],
  );

  const missing = entries.filter((e) => !e.fileDiff).length;
  const byId = useMemo(() => new Map(entries.map((e) => [e.stat.path, e])), [entries]);
  const toggle = useCallback((id: string) => {
    const e = byId.get(id);
    if (e) setOpen((o) => ({ ...o, [id]: !isOpen(e) }));
  }, [byId, isOpen]);

  // A jump names the file it went to, even when the view can't scroll it
  // to the top (the last few files).
  const jumpedAt = useRef(0);
  const follow = useCallback((id: string) => {
    if (Date.now() - jumpedAt.current > 800) setActive(id);
  }, []);
  const goTo = (e: Entry) => {
    if (!e.fileDiff) return;
    jumpedAt.current = Date.now();
    setActive(e.stat.path);
    setJump((j) => ({ id: e.stat.path, n: (j?.n ?? 0) + 1 }));
  };

  const shown = filter.trim() ? entries.filter((e) => e.stat.path.toLowerCase().includes(filter.trim().toLowerCase())) : entries;

  return (
    <div className="flex min-h-0 flex-1">
      {/* A narrow panel gives all its width to the diff. */}
      <aside className={cn("@max-2xl:hidden flex w-60 shrink-0 flex-col border-r", !list && "hidden")}>
        <div className="shrink-0 p-2 pb-1">
          <Input size="sm" value={filter} onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setFilter(ev.target.value)} placeholder={`Filter ${entries.length} file${entries.length === 1 ? "" : "s"}`} aria-label="Filter files" />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {shown.map((e) => (
            <FileRow key={e.stat.path} entry={e} active={e.stat.path === (active ?? items[0]?.id)} onSelect={() => goTo(e)} />
          ))}
          {shown.length === 0 && <li className="px-2 py-3 text-muted-foreground text-xs">No file matches.</li>}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {result.truncated && (
          <p className="flex shrink-0 items-center gap-2 border-b bg-warning/8 px-3 py-1.5 text-warning-foreground text-xs">
            <Icon name="TriangleAlert" className="size-3.5 shrink-0" />
            The diff is longer than {LIMIT >> 20} MB, so it stops there: {missing} file{missing === 1 ? " isn't" : "s aren't"} shown.
          </p>
        )}
        {!mod ? (
          <Centered>
            <Spinner className="size-4" />
          </Centered>
        ) : "error" in mod ? (
          <Message title="Couldn't load the diff viewer" detail={<span className="font-mono text-xs">{mod.error}</span>} />
        ) : (
          <div className="min-h-0 flex-1">
            <mod.value.default
              items={items}
              layout={layout}
              wrap={wrap}
              dark={dark}
              jump={jump}
              resetKey={scope}
              onActive={follow}
              renderHeader={(id) => {
                const e = byId.get(id);
                return e ? <FileHeader entry={e} open={isOpen(e)} onToggle={() => toggle(id)} /> : null;
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}

// uniqueEnds names each path by its file name, or by as many of its last
// folders as it takes to tell it apart from the others.
function uniqueEnds(paths: string[]) {
  const parts = paths.map((p) => p.split("/"));
  const depth = parts.map(() => 1);
  for (let round = 0; round < 8; round++) {
    const seen = new Map<string, number>();
    const ends = parts.map((p, i) => p.slice(-depth[i]).join("/"));
    for (const e of ends) seen.set(e, (seen.get(e) ?? 0) + 1);
    let again = false;
    ends.forEach((e, i) => {
      if ((seen.get(e) ?? 0) > 1 && depth[i] < parts[i].length) {
        depth[i]++;
        again = true;
      }
    });
    if (!again) break;
  }
  return parts.map((p, i) => ({ short: p.slice(-depth[i]).join("/"), rest: p.slice(0, -depth[i]).join("/") }));
}

function Counts({ stat }: { stat: FileStat }) {
  if (stat.binary) return <span className="text-muted-foreground">binary</span>;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-success">+{stat.added}</span> <span className="text-destructive">−{stat.removed}</span>
    </span>
  );
}

function status(e: Entry) {
  if (e.fileDiff) return STATUS[e.fileDiff.type];
  if (e.stat.from) return STATUS["rename-changed"];
  return { letter: "M", label: "Changed", tone: "text-muted-foreground" };
}

function FileRow({ entry, active, onSelect }: { entry: Entry; active: boolean; onSelect(): void }) {
  const { stat, fileDiff, label } = entry;
  const s = status(entry);
  return (
    <li>
      <Tip side="right" label={fileDiff ? `${s.label}: ${stat.from ? `${stat.from} → ` : ""}${stat.path}` : `${stat.path}: past the ${LIMIT >> 20} MB limit, not shown`}>
        <button
          type="button"
          onClick={onSelect}
          aria-current={active || undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent/60",
            active && "bg-accent text-foreground",
            !fileDiff && "cursor-default opacity-50 hover:bg-transparent",
          )}
        >
          <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", s.tone)}>{s.letter}</span>
          <span className="min-w-0 flex-1 truncate">
            {label.short}
            {label.rest && <span className="ml-1.5 text-muted-foreground">{label.rest}</span>}
          </span>
          <Counts stat={stat} />
        </button>
      </Tip>
    </li>
  );
}

function FileHeader({ entry, open, onToggle }: { entry: Entry; open: boolean; onToggle(): void }) {
  const { stat, fileDiff, why } = entry;
  const s = status(entry);
  const { name, dir } = splitPath(stat.path);
  const empty = !fileDiff?.hunks.length;
  const note = stat.binary ? "Binary file, not shown" : empty ? (fileDiff?.type === "rename-pure" ? "Renamed, no changes" : "No content changes") : !open && why ? (why === "Large" ? "Large diff, folded" : `${why}, folded`) : undefined;
  return (
    <div className="flex h-9 items-center gap-2 border-y bg-background px-2 font-sans text-xs vibrancy:bg-(--content-solid)">
      <Button size="icon-xs" variant="ghost" aria-label={open ? "Fold this file" : "Unfold this file"} aria-expanded={open} disabled={empty} onClick={onToggle} className="shrink-0">
        <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </Button>
      <Tip label={s.label}>
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", s.tone)}>{s.letter}</span>
      </Tip>
      <button type="button" onClick={empty ? undefined : onToggle} className={cn("flex min-w-0 items-baseline gap-1 truncate text-left font-mono", empty && "cursor-default")}>
        {stat.from && <span className="truncate text-muted-foreground">{stat.from} →</span>}
        {dir && <span className="truncate text-muted-foreground">{dir}/</span>}
        <span className="shrink-0 font-medium text-foreground">{name}</span>
      </button>
      {note && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{note}</span>}
      <span className="ml-auto" />
      <Counts stat={stat} />
    </div>
  );
}
