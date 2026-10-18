import { AlertTriangleIcon, ArrowDownIcon, ArrowUpIcon, CheckIcon, HouseIcon, PauseIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { agentOf, sessionName, sessionState } from "@/lib/derive";
import { ago } from "@/lib/format";
import { previewUrl } from "@/lib/preview";
import { NONE, useStore } from "@/lib/store";
import { removalLabel, useRemoval } from "@/lib/removing";
import { cn } from "@/lib/utils";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import type { RowProgress } from "@/views/worktrees/use-bulk";
import type { Row } from "@/views/worktrees/use-worktrees";
import { sessionWord } from "@/lib/state-model";

export interface Group {
  key: string;
  box: string;
  location: string;
  rows: Row[];
}

// One grid for the header and every row, so the columns line up. Below
// 1024px of table the port moves into the worktree's tooltip and agents
// narrow, so the last commit keeps room to be read.
export const COLS =
  "grid-cols-[2rem_minmax(180px,1.2fr)_6rem_6rem_minmax(240px,2fr)_5.5rem_4rem_1.5rem] @max-5xl:grid-cols-[2rem_minmax(160px,1.2fr)_5.5rem_5.5rem_minmax(200px,2fr)_4.5rem_1.5rem]";


// WorktreeTable lists worktrees by project, one line each. Checkboxes
// select, shift-click selects a range, and a row click opens its history.
//
// From the keyboard the rows are one stop: Tab lands on the last row
// focused (the first, to begin with), ↑ and ↓ move between rows across
// projects, Home and End jump, Space selects (⇧Space a range) and Enter
// opens.
export function WorktreeTable({
  groups,
  selected,
  progress,
  onToggle,
  onToggleGroup,
  onToggleAll,
  onOpen,
  openKey,
}: {
  groups: Group[];
  selected: Set<string>;
  progress: Record<string, RowProgress>;
  onToggle(r: Row, shift: boolean): void;
  onToggleGroup(g: Group, on: boolean): void;
  onToggleAll(on: boolean): void;
  onOpen(r: Row): void;
  openKey?: string;
}) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const flat = groups.flatMap((g) => g.rows.map((r) => r.key));
  const [cursor, setCursor] = useState<string>();
  // The row that takes Tab: the last one focused, while it is still shown.
  const stop = cursor && flat.includes(cursor) ? cursor : (openKey && flat.includes(openKey) ? openKey : flat[0]);
  const listRef = useRef<HTMLDivElement>(null);
  const move = (from: string, key: string) => {
    const i = flat.indexOf(from);
    const to = key === "ArrowDown" ? i + 1 : key === "ArrowUp" ? i - 1 : key === "Home" ? 0 : flat.length - 1;
    const next = flat[Math.max(0, Math.min(flat.length - 1, to))];
    if (!next || next === from) return;
    setCursor(next);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"]`)?.focus();
  };
  return (
    <div ref={listRef} className="@container">
      <div className={cn("sticky top-0 z-20 grid h-8 items-center gap-3 border-b bg-background px-4 text-label text-muted-foreground", COLS)}>
        <Tip
          label={
            <span className="flex items-center gap-1.5">
              Select all <Kbd>⌘A</Kbd> · <Kbd>⇧</Kbd>-click selects a range
            </span>
          }
        >
          <span className="flex items-center">
            <Checkbox checked={selected.size > 0 && selected.size === total} indeterminate={selected.size > 0 && selected.size < total} onCheckedChange={(on) => onToggleAll(!!on)} aria-label="Select every worktree shown" />
          </span>
        </Tip>
        <span>Worktree</span>
        <Tip className="max-w-sm" label="Commits ahead of its base, and behind it">
          <span className="w-fit">vs base</span>
        </Tip>
        <Tip className="max-w-sm" label="Uncommitted: modified and untracked files">
          <span className="w-fit">Changes</span>
        </Tip>
        <span>Last commit</span>
        <Tip className="max-w-sm" label="Sessions in it, and dev servers it runs">
          <span className="w-fit">Agents</span>
        </Tip>
        <Tip className="max-w-sm" label="Its first port, on its own box">
          <span className="w-fit justify-self-end @max-5xl:hidden">Port</span>
        </Tip>
        <span />
      </div>
      {groups.map((g) => {
        const n = g.rows.filter((r) => selected.has(r.key)).length;
        return (
          <section key={g.key} aria-label={`${g.location} on ${g.box}`}>
            <header className={cn("sticky top-8 z-10 grid h-8 items-center gap-3 border-b bg-[color-mix(in_srgb,var(--color-muted)_60%,var(--color-background))] px-4", COLS)}>
              <Checkbox
                checked={n > 0 && n === g.rows.length}
                indeterminate={n > 0 && n < g.rows.length}
                onCheckedChange={(on) => onToggleGroup(g, !!on)}
                aria-label={`Select every worktree in ${g.location} on ${g.box}`}
              />
              <span className="col-[2/-1] flex items-center gap-2 text-label">
                <ProjectLabel box={g.box} scope={`repo:${g.location}`} />
                <span className="font-normal text-muted-foreground tabular-nums">{g.rows.length}</span>
              </span>
            </header>
            <div role="listbox" aria-multiselectable aria-label={`Worktrees in ${g.location} on ${g.box}`}>
              {g.rows.map((r) => (
                <WorktreeRow
                  key={r.key}
                  row={r}
                  selected={selected.has(r.key)}
                  progress={progress[r.key]}
                  open={openKey === r.key}
                  tabStop={stop === r.key}
                  onFocus={() => setCursor(r.key)}
                  onMove={(key) => move(r.key, key)}
                  onToggle={(shift) => onToggle(r, shift)}
                  onOpen={() => onOpen(r)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function WorktreeRow({
  row: r,
  selected,
  progress,
  open,
  tabStop,
  onFocus,
  onMove,
  onToggle,
  onOpen,
}: {
  row: Row;
  selected: boolean;
  progress?: RowProgress;
  open: boolean;
  tabStop: boolean;
  onFocus(): void;
  onMove(key: string): void;
  onToggle(shift: boolean): void;
  onOpen(): void;
}) {
  const sessions = useStore((s) => s.boxes[r.box]?.sessions) ?? NONE;
  const stats = useStore((s) => s.boxes[r.box]?.stats);
  const services = useStore((s) => s.boxes[r.box]?.services) ?? NONE;
  const mine = sessions.filter((s) => s.dir === r.path && !s.exited);
  const serving = services.filter((s) => s.path === r.path);
  const c = r.last_commit;
  const name = r.main ? r.location : r.name;
  const base = r.base ?? "its base";
  const s = (n: number) => (n === 1 ? "" : "s");
  // Being archived or removed: dimmed, and nothing opens it (lib/removing.ts).
  const leaving = useRemoval(r.box, r.path);

  return (
    <div
      role="option"
      data-row={r.key}
      tabIndex={tabStop ? 0 : -1}
      aria-selected={selected}
      aria-label={name}
      aria-disabled={leaving ? true : undefined}
      aria-busy={leaving ? true : undefined}
      onClick={leaving ? undefined : onOpen}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Enter") {
          if (!leaving) onOpen();
        } else if (e.key === " ") {
          e.preventDefault();
          onToggle(e.shiftKey);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          onMove(e.key);
        }
      }}
      className={cn(
        // scroll-mt: clear of the two sticky headers when ↑ scrolls a row in.
        "group grid h-row scroll-mt-16 cursor-pointer items-center gap-3 border-b border-border/60 px-4 text-body outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/48 focus-visible:ring-inset",
        COLS,
        selected && "bg-primary/[0.06] hover:bg-primary/[0.09]",
        open && "bg-accent/60",
        r.paused && "text-muted-foreground",
        leaving && "cursor-default text-muted-foreground hover:bg-transparent [&>*:not(:nth-child(-n+2))]:opacity-50",
      )}
    >
      {/* The checkbox selects; it never opens the row. */}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onToggle(e.shiftKey);
        }}
        className="flex h-full items-center"
      >
        <Checkbox checked={selected} tabIndex={-1} aria-label={`Select ${name}`} className="pointer-events-none" />
      </span>

      <Tip className="max-w-sm" label={<NameTip row={r} />}>
        <div className="flex min-w-0 items-center gap-1.5">
          {r.main && <HouseIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Main checkout" />}
          <span className="max-w-full shrink-0 truncate text-row">{name}</span>
          {r.branch && r.branch !== name && <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">{r.branch}</span>}
          {r.paused && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/12 px-1.5 py-px text-tag text-warning-foreground">
              <PauseIcon className="size-2.5" />
              Paused
            </span>
          )}
          {leaving && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-tag text-muted-foreground">
              <Spinner className="size-2.5" />
              {removalLabel(leaving)}
            </span>
          )}
        </div>
      </Tip>

      <Tip className="max-w-sm" label={r.ahead || r.behind ? `${r.ahead} commit${s(r.ahead)} ahead of ${base}, ${r.behind} behind` : `Even with ${base}`}>
        <div className="flex w-fit items-center gap-2 font-mono text-meta tabular-nums">
          <span className={cn("inline-flex items-center gap-0.5", r.ahead ? "text-foreground" : "text-muted-foreground")}>
            <ArrowUpIcon className="size-3" />
            {r.ahead}
          </span>
          <span className={cn("inline-flex items-center gap-0.5", r.behind >= 10 ? "text-warning-foreground" : r.behind ? "text-foreground" : "text-muted-foreground")}>
            <ArrowDownIcon className="size-3" />
            {r.behind}
          </span>
        </div>
      </Tip>

      <Tip className="max-w-sm" label={r.changed || r.untracked ? [r.changed && `${r.changed} modified`, r.untracked && `${r.untracked} untracked`].filter(Boolean).join(", ") : "No uncommitted changes"}>
        <div className="flex w-fit items-center gap-2 text-meta tabular-nums">
          {r.changed === 0 && r.untracked === 0 ? (
            <span className="text-muted-foreground">Clean</span>
          ) : (
            <>
              {r.changed > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-warning" />
                  {r.changed}
                </span>
              )}
              {r.untracked > 0 && <span className="text-success-foreground">+{r.untracked}</span>}
            </>
          )}
        </div>
      </Tip>

      <div className="min-w-0">
        {c ? (
          <Tip
            label={
              <>
                <span className="font-mono">{c.short}</span> · {c.author} · {new Date(c.time).toLocaleString()}
              </>
            }
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{c.subject}</span>
              <span className="shrink-0 text-meta text-muted-foreground">{ago(c.time)}</span>
            </div>
          </Tip>
        ) : (
          <span className="text-meta text-muted-foreground">{r.error ?? "No commits"}</span>
        )}
      </div>

      {mine.length === 0 && serving.length === 0 ? (
        <span className="text-meta text-muted-foreground/50">—</span>
      ) : (
        <Tip
          label={
            <span className="flex flex-col gap-0.5">
              {mine.map((x) => {
                const a = agentOf(x);
                return <span key={x.name}>{a ? `${sessionName(x, { sessions: mine })} ${r.paused ? "paused" : sessionWord(sessionState(x, stats), true)}` : sessionName(x, { sessions: mine })}</span>;
              })}
              {serving.map((x) => (
                <span key={x.port}>
                  :{x.port} {x.process ?? "server"} {r.paused ? "stopped" : "running"}
                </span>
              ))}
            </span>
          }
        >
          <div className="flex w-fit items-center gap-1.5">
            {mine.slice(0, 3).map((x) => (
              <span key={x.name} className="inline-flex items-center gap-0.5">
                <AgentIcon agent={agentOf(x)} />
                {!r.paused && <StateGlyph state={sessionState(x, stats)} className="size-3" />}
              </span>
            ))}
            {mine.length > 3 && <span className="text-meta text-muted-foreground">+{mine.length - 3}</span>}
            {serving.length > 0 && (
              <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", r.paused ? "bg-muted-foreground/40" : "bg-success")} />
                {serving.length}
              </span>
            )}
          </div>
        </Tip>
      )}

      <span className="text-right font-mono text-meta text-muted-foreground tabular-nums @max-5xl:hidden">{r.port ?? ""}</span>

      <ProgressMark p={progress} />
    </div>
  );
}

// NameTip says where a worktree is: its branch, and the port and address
// its dev server answers on, which are per box.
function NameTip({ row: r }: { row: Row }) {
  const loc = useStore((s) => s.boxes[r.box]?.locations?.find((l) => l.name === r.location));
  const wt = loc?.worktrees?.find((w) => w.path === r.path);
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {r.main ? "Main checkout" : "Worktree"} on {r.box}
        {r.branch && (
          <>
            {" · "}
            <span className="font-mono">{r.branch}</span>
          </>
        )}
      </span>
      {r.port !== undefined && (
        <span className="text-muted-foreground">
          Port {r.port} on {r.box}
          {loc && wt ? ` · ${previewUrl(r.box, loc, wt, r.port)}` : ""}
        </span>
      )}
    </span>
  );
}

function ProgressMark({ p }: { p?: RowProgress }) {
  if (!p) return <span />;
  const body =
    p.state === "running" ? (
      <Spinner className="size-3.5" />
    ) : p.state === "queued" ? (
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
    ) : p.state === "ok" ? (
      <CheckIcon className="size-3.5 text-success-foreground" />
    ) : p.state === "conflict" ? (
      <AlertTriangleIcon className="size-3.5 text-warning" />
    ) : p.state === "failed" ? (
      <XIcon className="size-3.5 text-destructive-foreground" />
    ) : (
      <span className="text-tag text-muted-foreground">—</span>
    );
  const label =
    p.state === "queued"
      ? "Waiting its turn"
      : p.state === "running"
        ? "Working…"
        : p.conflicts?.length
          ? `Conflicts in ${p.conflicts.length} file${p.conflicts.length === 1 ? "" : "s"}: ${p.conflicts.join(", ")}`
          : p.state === "skipped"
            ? `Skipped: ${p.message ?? ""}`
            : (p.message ?? p.state);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center justify-center" />}>{body}</TooltipTrigger>
      <TooltipPopup className="max-w-sm">{label}</TooltipPopup>
    </Tooltip>
  );
}
