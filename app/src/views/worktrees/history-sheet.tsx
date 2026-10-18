import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CopyIcon, CornerDownLeftIcon, EllipsisIcon, PauseIcon, PlayIcon, SquareIcon, Trash2Icon, ArchiveIcon } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";

import { PickOne } from "@/components/pick-one";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveTheme } from "@/hooks/use-theme";
import { useGraphRowHeight } from "@/lib/density";
import { boxApi } from "@/lib/api";
import { ago } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { type CommitDetail, commitDetailCommand, parseCommitDetail } from "@/lib/git/parse";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { type Commit, worktreesApi } from "@/lib/worktrees";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import { branchOnly, type GraphRow, layout } from "@/views/worktrees/commit-graph";
import { GraphGutter, gutterWidth, laneColor, laneVars } from "@/views/worktrees/graph-gutter";
import { SyncButton } from "@/views/worktrees/sync-button";
import type { BulkAction, RowProgress } from "@/views/worktrees/use-bulk";
import { openWorktree, type Row } from "@/views/worktrees/use-worktrees";

const PAGE = 80;

// Past this many commits behind, the history starts on the branch's own
// commits; the base's newer ones are a toggle away.
const COLLAPSE_BEHIND = 5;

type Scope = "all" | "branch";

// A commit never changes, so what was read about one is kept for the session.
const details = new Map<string, CommitDetail>();

// HistorySheet is one worktree: where it stands, what you can do with it,
// and its commits, newest first, marking those not on its base yet and
// those on the base it lacks.
export function HistorySheet({ row, progress, busy, onClose, onAction, onDelete, onArchive }: { row?: Row; progress?: RowProgress; busy: boolean; onClose(): void; onAction(a: BulkAction): void; onDelete(): void; onArchive(): void }) {
  const client = useStore((s) => s.client);
  const dark = useActiveTheme().appearance === "dark";
  const [log, setLog] = useState<{ base: string; commits: Commit[] }>();
  const [error, setError] = useState<string>();
  const [limit, setLimit] = useState(PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scope, setScope] = useState<Scope>("all");

  useEffect(() => {
    setLimit(PAGE);
    setScope(row && row.behind > COLLAPSE_BEHIND ? "branch" : "all");
    // Only when another worktree opens, not when this one's counts move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.key]);
  useEffect(() => {
    if (limit === PAGE) {
      setLog(undefined);
      setError(undefined);
    }
    if (!row || !client) return;
    let cancelled = false;
    setLoadingMore(limit > PAGE);
    worktreesApi.log(client, row.box, row.location, row.name, limit, true).then(
      (l) => {
        if (cancelled) return;
        setLog({ base: l.base, commits: l.commits ?? [] });
        setLoadingMore(false);
      },
      (e) => {
        if (cancelled) return;
        setError(plainError(e));
        setLoadingMore(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // Refetch when a sync or anything else moves the branch.
  }, [client, row?.key, row?.ahead, row?.behind, row?.last_commit?.sha, limit]);

  const graph = useMemo(() => (log ? layout(scope === "branch" ? branchOnly(log.commits) : log.commits) : undefined), [log, scope]);
  const vars = useMemo(() => laneVars(dark), [dark]);
  const rowH = useGraphRowHeight();

  const baseRef = log?.base ?? row?.base ?? "origin/main";
  const base = baseRef.replace(/^origin\//, "");
  const branch = row?.branch ?? row?.name ?? "";
  // A main checkout is its own base: one line, one legend entry.
  const sameAsBase = branch === base;
  const showScope = !!row && row.behind > 0 && !sameAsBase;

  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetPopup className="w-[min(760px,100vw)] max-w-none">
        {row && (
          <>
            <SheetHeader className="gap-1.5">
              <SheetTitle className="flex items-center gap-2 text-heading">
                {row.main ? row.location : row.name}
                {row.paused && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/12 px-1.5 py-px font-normal text-tag text-warning-foreground">
                    <PauseIcon className="size-2.5" />
                    Paused
                  </span>
                )}
              </SheetTitle>
              <SheetDescription render={<div />} className="space-y-1">
                <ProjectLabel box={row.box} scope={`repo:${row.location}`} className="text-meta" />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
                  {row.branch && <code className="font-mono">{row.branch}</code>}
                  <span className="inline-flex items-center gap-2 font-mono tabular-nums">
                    <span className="inline-flex items-center">
                      <ArrowUpIcon className="size-3" />
                      {row.ahead}
                    </span>
                    <span className={cn("inline-flex items-center", row.behind >= 10 && "text-warning-foreground")}>
                      <ArrowDownIcon className="size-3" />
                      {row.behind}
                    </span>
                    <span className="font-sans">vs {row.base ?? "its base"}</span>
                  </span>
                  <span>{row.changed || row.untracked ? `${row.changed} changed, ${row.untracked} untracked` : "Clean"}</span>
                </div>
              </SheetDescription>
            </SheetHeader>

            {/* One line: the everyday actions, and the rest under ⋯. */}
            <div className="flex items-center gap-1.5 border-b px-6 pb-4">
              <SyncButton base={baseRef} disabled={busy} onSync={(mode) => onAction({ kind: "sync", mode, paused: true })} />
              {!row.main &&
                (row.paused ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction({ kind: "resume" })}>
                    <PlayIcon />
                    Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction({ kind: "pause" })}>
                    <PauseIcon />
                    Pause
                  </Button>
                ))}
              <Button size="sm" variant="ghost" onClick={() => openWorktree(row)}>
                <CornerDownLeftIcon />
                Open
              </Button>
              <Menu>
                <MenuTrigger render={<Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="More actions" />}>
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={busy || row.sessions === 0} onClick={() => onAction({ kind: "stop" })}>
                    <SquareIcon />
                    {row.sessions ? `Stop ${row.sessions} session${row.sessions === 1 ? "" : "s"}` : "No sessions running"}
                  </MenuItem>
                  {!row.main && (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={busy} onClick={onArchive}>
                        <ArchiveIcon />
                        Archive…
                      </MenuItem>
                      <MenuItem variant="destructive" disabled={busy} onClick={onDelete}>
                        <Trash2Icon />
                        Delete…
                      </MenuItem>
                    </>
                  )}
                </MenuPopup>
              </Menu>
            </div>
            {progress && progress.state !== "queued" && <ProgressLine p={progress} />}

            <div className="flex h-10 shrink-0 items-center gap-3 border-b px-6 text-meta">
              <span className="text-label text-muted-foreground">Commits</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: laneColor(sameAsBase ? 1 : 0) }} />
                <code className="truncate font-mono">{branch}</code>
                {!sameAsBase && <span className="shrink-0 text-muted-foreground tabular-nums">{row.ahead} ahead</span>}
              </span>
              {!sameAsBase && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2 shrink-0 rounded-full border-[1.5px]" style={{ borderColor: laneColor(1) }} />
                  <code className="truncate font-mono">{baseRef}</code>
                  {row.behind > 0 && <span className="shrink-0 text-muted-foreground tabular-nums">{row.behind} not in this branch</span>}
                </span>
              )}
              {showScope && (
                <PickOne<Scope>
                  label="Commits to show"
                  className="ml-auto shrink-0"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "branch", label: "This branch" },
                    { value: "all", label: `With ${base}` },
                  ]}
                />
              )}
            </div>

            <SheetPanel className="@container pt-2">
              {error ? (
                <p className="pt-2 text-destructive-foreground text-body">{error}</p>
              ) : !log ? (
                <div className="space-y-1 pt-1">
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <Skeleton key={i} className="h-6" />
                  ))}
                </div>
              ) : log.commits.length === 0 || !graph ? (
                <p className="pt-2 text-muted-foreground text-body">No commits.</p>
              ) : (
                <ol className="-mx-3" style={vars}>
                  {scope === "branch" && row.behind > 0 && (
                    <li>
                      <button type="button" className="flex h-7 w-full items-center gap-2 rounded-md px-3 text-left text-muted-foreground text-meta hover:bg-accent/50 hover:text-foreground" onClick={() => setScope("all")}>
                        <ArrowDownIcon className="size-3.5" />
                        {baseRef} has {row.behind} newer commit{row.behind === 1 ? "" : "s"} this branch doesn't. Show them
                      </button>
                    </li>
                  )}
                  {graph.rows.map((g, i) => (
                    <CommitRow
                      key={g.commit.sha}
                      row={g}
                      lanes={graph.lanes}
                      height={rowH}
                      // The branch's own commits share one bar down their run.
                      run={g.side === "ahead" ? { first: graph.rows[i - 1]?.side !== "ahead", last: graph.rows[i + 1]?.side !== "ahead" } : undefined}
                      base={baseRef}
                      branch={branch}
                      mergeBase={g.commit.sha === graph.mergeBase}
                      where={row}
                      vars={vars}
                    />
                  ))}
                  <li className="flex h-9 items-center" style={{ paddingLeft: gutterWidth(graph.lanes) }}>
                    {log.commits.length >= limit ? (
                      <Button size="xs" variant="ghost" loading={loadingMore} onClick={() => setLimit((l) => l + PAGE)}>
                        Load {PAGE} more
                      </Button>
                    ) : (
                      <span className="px-2 text-meta text-muted-foreground">Start of history</span>
                    )}
                  </li>
                </ol>
              )}
            </SheetPanel>
          </>
        )}
      </SheetPopup>
    </Sheet>
  );
}

// CommitRow is one line, like `git log --graph --oneline`: graph, hash,
// subject, refs, author, age. A click opens what the line leaves out.
function CommitRow({
  row,
  lanes,
  height,
  run,
  base,
  branch,
  mergeBase,
  where,
  vars,
}: {
  row: GraphRow;
  lanes: number;
  height: number;
  run?: { first: boolean; last: boolean };
  base: string;
  branch: string;
  mergeBase: boolean;
  where: Row;
  vars: CSSProperties;
}) {
  const c = row.commit;
  const refs = parseRefs(c.refs);
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                "relative flex w-full items-center gap-2 rounded-md pr-3 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/60 data-popup-open:bg-accent/70",
                mergeBase && "bg-info/[0.07]",
              )}
              style={{ height }}
            />
          }
        >
          {/* The branch's own commits carry a bar in its colour, one line down
              the run of them: it meets the next row's, rounded only at the ends. */}
          {run && <span className={cn("absolute inset-y-0 left-0 w-0.5", run.first && "top-1 rounded-t-full", run.last && "bottom-1 rounded-b-full")} style={{ background: laneColor(0) }} />}
          <GraphGutter row={row} lanes={lanes} height={height} highlight={mergeBase} />
          <code className={cn("w-[7ch] shrink-0 translate-y-px font-mono text-meta", row.side === "ahead" ? "text-foreground" : "text-muted-foreground")}>{c.short}</code>
          <Subject commit={c} merge={row.merge} className={cn("min-w-0 flex-1 truncate text-desc", row.side === "behind" ? "text-muted-foreground" : row.side === "shared" && "text-foreground/85")} />
          {mergeBase && <span className="shrink-0 rounded border border-info/40 px-1 text-tag text-info leading-4">Branched here</span>}
          {refs.map((r) => (
            <RefChip key={`${r.kind}:${r.name}`} r={r} />
          ))}
          <span className="hidden w-28 shrink-0 truncate text-meta text-muted-foreground @lg:block">{c.author}</span>
          <span className="w-12 shrink-0 text-right text-meta text-muted-foreground tabular-nums">{ago(c.time)}</span>
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" sideOffset={2} className="w-[min(28rem,var(--available-width))]" style={vars}>
          {open && <CommitDetails row={row} base={base} branch={branch} mergeBase={mergeBase} where={where} />}
        </PopoverPopup>
      </Popover>
    </li>
  );
}

// Subject shows a merge's own words (the branch it brought in) at full
// strength and git's boilerplate around them muted.
function Subject({ commit: c, merge, className }: { commit: Commit; merge: boolean; className?: string }) {
  const m = merge ? /^(Merge (?:pull request #\d+ from|remote-tracking branch|branch) )(.+?)( into .+)?$/.exec(c.subject) : null;
  if (!m) return <span className={className}>{c.subject}</span>;
  return (
    <span className={className}>
      <span className="text-muted-foreground">{m[1]}</span>
      {m[2]}
      {m[3] && <span className="text-muted-foreground">{m[3]}</span>}
    </span>
  );
}

// CommitDetails is what a log line leaves out: the whole message, how much
// it changed, where it stands, and its full hash to copy.
function CommitDetails({ row, base, branch, mergeBase, where }: { row: GraphRow; base: string; branch: string; mergeBase: boolean; where: Row }) {
  const c = row.commit;
  const client = useStore((s) => s.client);
  const key = `${where.box}/${where.location}:${c.sha}`;
  const [detail, setDetail] = useState<CommitDetail | "failed" | undefined>(() => details.get(key));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!client || details.has(key)) return;
    let cancelled = false;
    boxApi.exec(client, where.box, where.main ? where.location : `${where.location}/${where.name}`, commitDetailCommand(c.sha), "20s").then(
      (r) => {
        const d = r.exit_code === 0 ? parseCommitDetail(r.output) : undefined;
        if (d) details.set(key, d);
        if (!cancelled) setDetail(d ?? "failed");
      },
      () => !cancelled && setDetail("failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [client, key, where.box, where.location, where.name, where.main, c.sha]);

  const copy = () =>
    navigator.clipboard.writeText(c.sha).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );

  const standing = mergeBase
    ? `Where ${branch} last met ${base}`
    : row.side === "ahead"
      ? `Only on ${branch}, not on ${base} yet`
      : row.side === "behind"
        ? `On ${base}; ${branch} doesn't have it yet`
        : `On ${branch} and ${base}`;

  return (
    <div className="min-w-0 space-y-2.5 text-body">
      <div className="space-y-1">
        <p className="break-words text-row">{c.subject}</p>
        {detail === undefined ? (
          <Skeleton className="h-3.5 w-2/3" />
        ) : (
          detail !== "failed" && detail.body && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-desc text-muted-foreground">{detail.body}</p>
        )}
      </div>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
        <dt className="text-muted-foreground">Author</dt>
        <dd className="truncate">
          {c.author} · {new Date(c.time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </dd>
        <dt className="text-muted-foreground">Changed</dt>
        <dd>
          {detail === undefined ? (
            <Skeleton className="mt-0.5 h-3 w-32" />
          ) : detail === "failed" || detail.files === undefined ? (
            <span className="text-muted-foreground">{detail === "failed" ? "Couldn't read" : "Nothing"}</span>
          ) : (
            <span className="tabular-nums">
              {detail.files} file{detail.files === 1 ? "" : "s"}
              <span className="ml-2 text-success-foreground">+{detail.added}</span>
              <span className="ml-1.5 text-destructive-foreground">−{detail.removed}</span>
              {row.merge && <span className="ml-2 text-muted-foreground">vs its first parent</span>}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Where</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full" style={row.side === "behind" ? { border: `1.5px solid ${laneColor(row.color)}` } : { background: laneColor(row.color) }} />
          <span className="truncate">{standing}</span>
        </dd>
        {row.merge && (
          <>
            <dt className="text-muted-foreground">Parents</dt>
            <dd className="font-mono">{c.parents?.map((p) => p.slice(0, 7)).join(" + ")}</dd>
          </>
        )}
      </dl>
      <div className="flex items-center gap-2 border-t pt-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">{c.sha}</code>
        <Button size="xs" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy SHA"}
        </Button>
      </div>
    </div>
  );
}

interface Ref {
  name: string;
  kind: "head" | "tag" | "remote" | "branch";
}

function RefChip({ r }: { r: Ref }) {
  return (
    <span
      className={cn(
        "max-w-36 shrink-0 truncate rounded border px-1 font-mono text-tag leading-4",
        r.kind === "head" ? "border-info/50 bg-info/10 text-info" : r.kind === "tag" ? "border-border bg-muted text-foreground/80" : r.kind === "remote" ? "border-border text-muted-foreground" : "border-ring/40 text-foreground/80",
      )}
    >
      {r.kind === "head" && "HEAD → "}
      {r.kind === "tag" && "tag "}
      {r.name}
    </span>
  );
}

// parseRefs reads git's decoration, like "HEAD -> fix, origin/main, tag: v1".
function parseRefs(refs?: string): Ref[] {
  return (refs ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r && r !== "HEAD" && !r.endsWith("/HEAD"))
    .map((r): Ref => {
      if (r.startsWith("HEAD -> ")) return { name: r.slice(8), kind: "head" };
      if (r.startsWith("tag: ")) return { name: r.slice(5), kind: "tag" };
      if (/^(origin|upstream)\//.test(r)) return { name: r, kind: "remote" };
      return { name: r, kind: "branch" };
    })
    .slice(0, 3);
}

function ProgressLine({ p }: { p: RowProgress }) {
  const tone = p.state === "ok" ? "text-success-foreground" : p.state === "conflict" ? "text-warning-foreground" : p.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground";
  return (
    <div className={cn("border-b bg-muted/30 px-6 py-2 text-meta", tone)}>
      {p.state === "running" ? "Working…" : p.message}
      {p.conflicts?.length ? (
        <ul className="mt-1 space-y-0.5 font-mono text-meta text-muted-foreground">
          {p.conflicts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
