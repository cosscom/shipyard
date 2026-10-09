import { invoke } from "@tauri-apps/api/core";
import { BanIcon, BugIcon, ChevronRightIcon, CircleXIcon, InfoIcon, SendIcon, SquareDashedMousePointerIcon, SquareTerminalIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { ErrorBadge } from "@/components/devtools-badge";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import type { BrowserContext } from "@/lib/browser-url";
import { agentOf } from "@/lib/derive";
import { clearLog, type PaneLog, setDrawerTab, toggleDrawer, useDrawerOpen, useDrawerTab, useErrorCount, useLog } from "@/lib/devtools";
import { type ConsoleEntry, consoleMessage, failed, formatMs, formatSize, isError, type NetEntry, requestMessage, shortAt, statusText } from "@/lib/devtools-model";
import { send as sendPrompt } from "@/lib/orchestrate";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// The Browser tab's developer tools: WebKit's own Web Inspector for the
// native page (Inspect), and Shipyard's Console and Network drawer under the
// page, whose rows go to the worktree's agent in a click.

// Tooltips in the drawer open downward: above it is the page, which in the
// app is a native view that would cover them.
const DOWN = "bottom" as const;

// InspectButton opens WebKit's Web Inspector for the pane's native page, in
// a window of its own. A frame (outside the Shipyard app) has none.
export function InspectButton({ id, native, disabled }: { id: string; native: boolean; disabled?: boolean }) {
  const label = native ? "Inspect: the Web Inspector for this page (or right-click it → Inspect Element)" : "The Web Inspector is in the Shipyard app's own browser";
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label="Inspect"
        disabled={disabled || !native}
        onClick={() => void invoke("browser_inspect", { id }).catch((err) => toastManager.add({ type: "error", title: "Couldn't open the Web Inspector", description: String(err) }))}
        className="inline-flex size-6.5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-3.5"
      >
        <SquareDashedMousePointerIcon />
      </button>
    </Tip>
  );
}

// DevtoolsToggle shows and hides the drawer, with the page's error count.
export function DevtoolsToggle({ logKey, disabled }: { logKey: string; disabled?: boolean }) {
  const open = useDrawerOpen(logKey);
  const errors = useErrorCount(logKey);
  const keys = keysFor("devtools");
  const label = `Console and network${keys ? ` (${keys})` : ""}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"} since the page loaded` : ""}`;
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label="Console and network"
        aria-pressed={open}
        data-testid="devtools-toggle"
        disabled={disabled}
        onClick={() => toggleDrawer(logKey)}
        className={cn(
          "relative inline-flex h-6.5 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-3.5",
          open && "bg-accent text-foreground",
        )}
      >
        <SquareTerminalIcon />
        {errors > 0 && <ErrorBadge n={errors} testId="devtools-badge" />}
      </button>
    </Tip>
  );
}

type Sending = { kind: "console"; entry: ConsoleEntry } | { kind: "request"; entry: NetEntry };

const HEIGHT_KEY = "berth.devtools.height";

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return n >= 120 && n <= 2000 ? n : 260;
  } catch {
    return 260;
  }
}

export interface DrawerProps {
  logKey: string;
  // The page the entries are from, for what the agent is sent.
  pageUrl: string;
  ctx: BrowserContext;
  // The page's requests can be listed: it goes through the laptop's proxy.
  proxied: boolean;
  // The agent's own browser's log, from its box: read only, no clear.
  agent?: boolean;
}

// DevtoolsDrawer is the Console and Network drawer under the page.
export function DevtoolsDrawer({ logKey, pageUrl, ctx, proxied, agent }: DrawerProps) {
  const log = useLog(logKey);
  const tab = useDrawerTab(logKey);
  const [height, setHeight] = useState(savedHeight);
  const [sending, setSending] = useState<Sending>();
  const root = useRef<HTMLElement>(null);
  const consoleErrors = useMemo(() => (log?.console ?? []).reduce((n, e) => n + (isError(e) ? e.count : 0), 0), [log?.console]);
  const failures = useMemo(() => (log?.network ?? []).filter(failed).length, [log?.network]);

  useEffect(() => setSending(undefined), [logKey]);

  // Drag the top edge to resize; the page above follows.
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = height;
    const max = Math.max(160, (root.current?.parentElement?.clientHeight ?? 800) - 120);
    const move = (ev: PointerEvent) => setHeight(Math.round(Math.min(max, Math.max(120, start + startY - ev.clientY))));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const h = Math.round(Math.min(max, Math.max(120, start + startY - ev.clientY)));
      try {
        localStorage.setItem(HEIGHT_KEY, String(h));
      } catch {
        // Only a convenience.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Or focus the edge: ↑ and ↓ (⇧ for bigger steps), Home and End.
  const nudge = (e: React.KeyboardEvent) => {
    const max = Math.max(160, (root.current?.parentElement?.clientHeight ?? 800) - 120);
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === "ArrowUp" ? height + step : e.key === "ArrowDown" ? height - step : e.key === "Home" ? 120 : e.key === "End" ? max : undefined;
    if (next === undefined) return;
    e.preventDefault();
    const h = Math.round(Math.min(max, Math.max(120, next)));
    setHeight(h);
    try {
      localStorage.setItem(HEIGHT_KEY, String(h));
    } catch {
      // Only a convenience.
    }
  };

  return (
    <section ref={root} data-testid="devtools-drawer" aria-label="Console and network" style={{ height }} className="relative flex max-h-[75%] min-h-30 shrink-0 flex-col border-t bg-background text-xs">
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize the drawer"
        aria-valuenow={height}
        aria-valuemin={120}
        onPointerDown={drag}
        onKeyDown={nudge}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize outline-none focus-visible:bg-ring"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5">
        <div
          role="tablist"
          aria-label="Console and network"
          className="flex items-center gap-0.5"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = tab === "console" ? "network" : "console";
            setDrawerTab(logKey, next);
            e.currentTarget.querySelector<HTMLElement>(`[data-drawer-tab=${next}]`)?.focus();
          }}
        >
          <DrawerTab id="console" active={tab === "console"} onClick={() => setDrawerTab(logKey, "console")} count={consoleErrors}>
            Console
          </DrawerTab>
          <DrawerTab id="network" active={tab === "network"} onClick={() => setDrawerTab(logKey, "network")} count={failures}>
            Network
          </DrawerTab>
        </div>
        {agent && <span className="ml-2 truncate text-[11px] text-muted-foreground">The agent's browser, on its box</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {!agent && (
            <Tip label={tab === "console" ? "Clear the console" : "Clear the requests"} side={DOWN}>
              <button type="button" aria-label="Clear" onClick={() => clearLog(logKey, tab)} className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
                <BanIcon />
              </button>
            </Tip>
          )}
          <Tip label={`Close${keysFor("devtools") ? ` (${keysFor("devtools")})` : ""}`} side={DOWN}>
            <button type="button" aria-label="Close the drawer" onClick={() => toggleDrawer(logKey, false)} className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
              <XIcon />
            </button>
          </Tip>
        </div>
      </div>
      {sending && <Sender sending={sending} pageUrl={pageUrl} ctx={ctx} agent={agent} onDone={() => setSending(undefined)} />}
      {tab === "console" ? (
        <ConsoleList log={log} agent={agent} sending={sending?.kind === "console" ? sending.entry : undefined} onSend={(entry) => setSending({ kind: "console", entry })} />
      ) : (
        <NetworkList log={log} pageUrl={pageUrl} proxied={proxied || !!agent} agent={agent} sending={sending?.kind === "request" ? sending.entry : undefined} onSend={(entry) => setSending({ kind: "request", entry })} />
      )}
    </section>
  );
}

function DrawerTab({ id, active, onClick, count, children }: { id: string; active: boolean; onClick(): void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      data-drawer-tab={id}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-[11.5px]", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
    >
      {children}
      {count > 0 && <ErrorBadge n={count} />}
    </button>
  );
}

// Chips filter a list: by level, or failed only.
function Chip({ on, onClick, children, label }: { on: boolean; onClick(): void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={cn("inline-flex h-5.5 items-center gap-1 rounded px-1.5 text-[11px] tabular-nums", on ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {children}
    </button>
  );
}

function FilterBar({ children, filter, onFilter }: { children: React.ReactNode; filter: string; onFilter(v: string): void }) {
  return (
    <div className="flex h-7.5 shrink-0 items-center gap-1 border-b bg-muted/30 px-1.5">
      <input
        aria-label="Filter"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        placeholder="Filter"
        spellCheck={false}
        className="h-5.5 w-36 min-w-0 rounded border bg-background px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/70 focus:border-ring"
      />
      <span className="mx-0.5 h-3.5 w-px bg-border" />
      {children}
    </div>
  );
}

type LevelFilter = "all" | "error" | "warn" | "info";

function ConsoleList({ log, agent, sending, onSend }: { log?: PaneLog; agent?: boolean; sending?: ConsoleEntry; onSend(e: ConsoleEntry): void }) {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [filter, setFilter] = useState("");
  const list = log?.console ?? [];
  const count = (l: ConsoleEntry["level"]) => list.reduce((n, e) => n + (e.level === l ? e.count : 0), 0);
  const shown = list.filter(
    (e) => (level === "all" || e.level === level || (level === "info" && (e.level === "log" || e.level === "debug"))) && (!filter || e.text.toLowerCase().includes(filter.toLowerCase())),
  );
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new lines while scrolled to the end, as a console does.
  const pinned = useRef(true);
  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);
  return (
    <>
      <FilterBar filter={filter} onFilter={setFilter}>
        <Chip on={level === "all"} onClick={() => setLevel("all")}>
          All
        </Chip>
        <Chip on={level === "error"} onClick={() => setLevel("error")} label="Errors">
          <CircleXIcon className="size-3 text-destructive" />
          Errors {count("error")}
        </Chip>
        <Chip on={level === "warn"} onClick={() => setLevel("warn")} label="Warnings">
          <TriangleAlertIcon className="size-3 text-warning" />
          Warnings {count("warn")}
        </Chip>
        <Chip on={level === "info"} onClick={() => setLevel("info")} label="Logs">
          Logs {count("info") + count("log") + count("debug")}
        </Chip>
      </FilterBar>
      <div
        ref={scroller}
        role="log"
        aria-label="Console"
        data-testid="devtools-console"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px] leading-[1.45]"
      >
        {log?.dropped ? <p className="border-b px-3 py-1 text-muted-foreground">{log.dropped} earlier messages were dropped: the page logged faster than they could be kept.</p> : null}
        {shown.map((e) => (
          <ConsoleRow key={rowKey(e)} e={e} sending={e === sending} onSend={onSend} />
        ))}
        {!shown.length && (
          <p className="px-3 py-3 font-sans text-muted-foreground">
            {list.length
              ? "Nothing matches the filter."
              : agent
                ? "The agent's page hasn't logged anything."
                : log?.heard
                  ? "Nothing logged since the page loaded. What it logs, and any error it throws, shows here."
                  : "Waiting for the page. Its console shows here once it loads in the Shipyard app, or through a worktree's address."}
          </p>
        )}
        <div ref={end} />
      </div>
    </>
  );
}

const LEVEL_STYLE: Record<ConsoleEntry["level"], string> = {
  error: "bg-destructive/[0.07] text-destructive-foreground border-destructive/15",
  warn: "bg-warning/[0.08] text-warning-foreground border-warning/20",
  info: "",
  log: "",
  debug: "text-muted-foreground",
};

function LevelIcon({ level }: { level: ConsoleEntry["level"] }) {
  if (level === "error") return <CircleXIcon aria-label="Error" className="mt-px size-3.5 shrink-0 text-destructive" />;
  if (level === "warn") return <TriangleAlertIcon aria-label="Warning" className="mt-px size-3.5 shrink-0 text-warning" />;
  if (level === "info") return <InfoIcon aria-label="Info" className="mt-px size-3.5 shrink-0 text-info" />;
  if (level === "debug") return <BugIcon aria-label="Debug" className="mt-px size-3.5 shrink-0 opacity-60" />;
  return <span className="size-3.5 shrink-0" />;
}

// Each entry's row keeps its key while newer lines push older ones out of
// the kept list (lib/devtools-model, CONSOLE_LIMIT): keyed by place, a page
// logging once a second remade every row of a full console every second.
const rowKeys = new WeakMap<ConsoleEntry, number>();
let nextRowKey = 0;
function rowKey(e: ConsoleEntry): number {
  let k = rowKeys.get(e);
  if (k === undefined) rowKeys.set(e, (k = ++nextRowKey));
  return k;
}

// A row draws again only when its entry or selection changes, not for each
// new line below it. onSend is the drawer's, which only sets state.
const ConsoleRow = memo(ConsoleRowView, (a, b) => a.e === b.e && a.sending === b.sending);

function ConsoleRowView({ e, sending, onSend }: { e: ConsoleEntry; sending: boolean; onSend(e: ConsoleEntry): void }) {
  const [open, setOpen] = useState(false);
  const stack = !!e.stack;
  const sendable = e.level === "error" || e.level === "warn";
  return (
    <div data-testid="console-row" data-level={e.level} data-selected={sending} className={cn("group relative flex items-start gap-1.5 border-b border-border/60 py-1 pr-2 pl-2", LEVEL_STYLE[e.level], sending && "shadow-[inset_2px_0_0_var(--color-ring)]")}>
      <LevelIcon level={e.level} />
      {stack ? (
        <button type="button" aria-label={open ? "Hide the stack" : "Show the stack"} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="mt-px inline-flex size-3.5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-foreground/10 hover:opacity-100">
          <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn("whitespace-pre-wrap break-words", stack && "cursor-pointer")} onClick={stack ? () => setOpen((o) => !o) : undefined}>
          {e.text}
        </div>
        {open && e.stack && <pre className="mt-0.5 whitespace-pre-wrap break-all pl-2 text-[11px] opacity-75">{e.stack}</pre>}
      </div>
      {e.count > 1 && <span className="mt-px shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums">{e.count}</span>}
      {e.at && (
        <Tip label={<span className="break-all font-mono">{e.at}</span>} side={DOWN} className="max-w-md">
          <span className="mt-px max-w-48 shrink-0 truncate text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2">{shortAt(e.at)}</span>
        </Tip>
      )}
      {sendable && <SendButton onClick={() => onSend(e)} />}
    </div>
  );
}

function SendButton({ onClick }: { onClick(): void }) {
  return (
    <Tip label="Send this to the worktree's agent, with the page's address" side={DOWN}>
      <button
        type="button"
        aria-label="Send to agent"
        onClick={(ev) => {
          ev.stopPropagation();
          onClick();
        }}
        className="-my-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded border bg-background px-1.5 font-sans text-[10.5px] text-foreground opacity-0 shadow-xs hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100"
      >
        <SendIcon className="size-3" />
        Send to agent
      </button>
    </Tip>
  );
}

const COLS = "grid grid-cols-[4rem_3.25rem_minmax(0,1fr)_4.5rem_4rem_4.25rem_auto] items-center gap-x-2";

function NetworkList({ log, pageUrl, proxied, agent, sending, onSend }: { log?: PaneLog; pageUrl: string; proxied: boolean; agent?: boolean; sending?: NetEntry; onSend(n: NetEntry): void }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number>();
  const list = log?.network ?? [];
  const failures = list.filter(failed).length;
  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return "";
    }
  })();
  const shown = list.filter((n) => (!onlyFailed || failed(n)) && (!filter || `${n.method} ${n.host}${n.path} ${n.status} ${n.type}`.toLowerCase().includes(filter.toLowerCase())));
  return (
    <>
      <FilterBar filter={filter} onFilter={setFilter}>
        <Chip on={!onlyFailed} onClick={() => setOnlyFailed(false)}>
          All {list.length}
        </Chip>
        <Chip on={onlyFailed} onClick={() => setOnlyFailed(true)} label="Failed">
          <CircleXIcon className="size-3 text-destructive" />
          Failed {failures}
        </Chip>
      </FilterBar>
      <div role="table" aria-label="Requests" data-testid="devtools-network" className="min-h-0 flex-1 overflow-y-auto text-[11.5px]">
        {proxied && list.length > 0 && (
          <div role="row" className={cn(COLS, "sticky top-0 z-[1] border-b bg-background px-2 py-1 font-medium text-[10.5px] text-muted-foreground")}>
            <span role="columnheader">Status</span>
            <span role="columnheader">Method</span>
            <span role="columnheader">Path</span>
            <span role="columnheader">Type</span>
            <span role="columnheader" className="text-right">
              Time
            </span>
            <span role="columnheader" className="text-right">
              Size
            </span>
            <span className="w-[5.75rem]" />
          </div>
        )}
        {shown.map((n) => {
          const bad = failed(n);
          const open = selected === n.seq;
          return (
            <div key={`${n.seq}:${n.path}`} role="rowgroup">
              <div
                role="row"
                data-testid="network-row"
                data-failed={bad}
                data-selected={open}
                aria-selected={open}
                onClick={() => setSelected(open ? undefined : n.seq)}
                className={cn(COLS, "group cursor-default border-b border-border/60 px-2 py-1 font-mono", bad ? "bg-destructive/[0.07] text-destructive-foreground" : "hover:bg-accent/50", open && !bad && "bg-accent/60", (open || n === sending) && "shadow-[inset_2px_0_0_var(--color-ring)]")}
              >
                <span role="cell" className={cn("tabular-nums", !bad && n.status >= 300 && "text-muted-foreground", n.error === "canceled" && "text-muted-foreground")}>
                  {statusText(n)}
                </span>
                <span role="cell" className="truncate">
                  {n.method}
                </span>
                <span role="cell" className="min-w-0 truncate">
                  {n.host && n.host !== pageHost && <span className="text-muted-foreground">{n.host}</span>}
                  {n.path}
                </span>
                <span role="cell" className="truncate text-muted-foreground">
                  {n.type}
                </span>
                <span role="cell" className="text-right text-muted-foreground tabular-nums">
                  {n.start || n.ms ? formatMs(n.ms) : ""}
                </span>
                <span role="cell" className="text-right text-muted-foreground tabular-nums">
                  {n.start || n.size ? formatSize(n.size) : ""}
                </span>
                <span role="cell" className="flex w-[5.75rem] justify-end">
                  {bad && <SendButton onClick={() => onSend(n)} />}
                </span>
              </div>
              {open && <RequestDetail n={n} pageUrl={pageUrl} />}
            </div>
          );
        })}
        {!shown.length && (
          <p className="px-3 py-3 text-muted-foreground">
            {list.length
              ? "Nothing matches the filter."
              : agent
                ? "No failed requests in the agent's browser."
                : proxied
                  ? "No requests since the page loaded."
                  : "Requests show here for a worktree's page, which goes through Shipyard's proxy. This page doesn't: use the Web Inspector's Network tab for it."}
          </p>
        )}
      </div>
    </>
  );
}

function RequestDetail({ n, pageUrl }: { n: NetEntry; pageUrl: string }) {
  const box = useRef<HTMLDivElement>(null);
  // Opened at the foot of the list, it scrolls into view.
  // (A block body: scrollIntoView may return a promise, which an effect
  // must not.)
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  let url = n.path;
  try {
    const page = new URL(pageUrl);
    url = n.host ? `${page.protocol}//${n.host}${page.port && !n.host.includes(":") ? `:${page.port}` : ""}${n.path}` : n.path;
  } catch {
    // The path alone.
  }
  return (
    <div ref={box} className="space-y-1 border-b bg-muted/40 px-3 py-2 font-mono text-[11px]">
      <p className="break-all">{url}</p>
      <p className="text-muted-foreground">
        {statusText(n)}
        {n.mime ? ` · ${n.mime}` : ""}
        {n.start ? ` · ${new Date(n.start).toLocaleTimeString()}` : ""}
      </p>
      {n.error && n.error !== "canceled" && <p className="text-destructive-foreground">{n.error}</p>}
      {n.body && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border bg-background p-1.5">{n.body}</pre>}
    </div>
  );
}

// Sender sends a console entry or a request to the worktree's agent, with
// an optional note.
function Sender({ sending, pageUrl, ctx, agent, onDone }: { sending: Sending; pageUrl: string; ctx: BrowserContext; agent?: boolean; onDone(): void }) {
  const ref = ctx.ref;
  const session = useStore((s) => (ref ? s.boxes[ref.box]?.sessions?.find((x) => x.dir === ref.path && !x.exited && agentOf(x)) : undefined));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const page = agent ? `${pageUrl} (in your own browser on the box)` : pageUrl;
  const message = sending.kind === "console" ? consoleMessage(sending.entry, page, note) : requestMessage(sending.entry, page, note);
  const summary = sending.kind === "console" ? sending.entry.text : `${sending.entry.method} ${sending.entry.path} → ${statusText(sending.entry)}`;
  const submit = async () => {
    if (!session || !ref) return;
    setBusy(true);
    try {
      await sendPrompt(ref.box, session.name, message, { when: "idle" });
      toastManager.add({ type: "success", title: "Sent to the agent", description: summary.slice(0, 120) });
      onDone();
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't send it", description: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="devtools-sender"
      className="flex shrink-0 items-center gap-2 border-b bg-accent/50 px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SendIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <Tip label={<pre className="max-h-64 max-w-lg overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px]">{message}</pre>} side={DOWN} className="max-w-lg">
        <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px]">{summary}</span>
      </Tip>
      <input
        autoFocus
        aria-label="A note for the agent"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={session ? "Add a note (optional)" : "No agent runs in this worktree"}
        disabled={!session}
        className="h-6 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:border-ring"
      />
      <Button type="submit" size="xs" disabled={!session || busy}>
        <SendIcon />
        Send to agent
      </Button>
      <button type="button" aria-label="Cancel" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onDone}>
        <XIcon className="size-3.5" />
      </button>
    </form>
  );
}
