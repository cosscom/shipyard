import { useBoxes, worktreeLocation, type BerthPluginContext, type WorktreePanelProps } from "@berth/plugin";
import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, HelperBox, type HelperCopy, Icon, Input, PickOne, Skeleton, Tip, cn, useHelperState } from "@berth/plugin/ui";
import { type ReactNode, useCallback, useMemo } from "react";

import { leadline, type Leadline, type Scope, type Source } from "./api";
import { ago, span } from "./format.ts";
import { type Fault, useLive, useVisible, useWindow, type Window, WINDOWS } from "./live";
import { commandOf, sourceOf } from "./source.ts";

// The program this plugin installs on a box, as its manifest names it.
export const HELPER = "berth-leadline";

// What Leadline says of its helper where the app's HelperBox draws a box's
// state and its switch (the Leadline screen's rows, and a panel on a box
// where it is off).
export const COPY: HelperCopy = {
  name: "Leadline",
  program: HELPER,
  icon: "Anchor",
  does: (box) => `It records what the dev servers Shipyard starts on that box do (their queries, traces and logs) into a folder on the box. Nothing it records leaves ${box}.`,
  about: (box) => (
    <>
      It shows what your code did in development: every database query, each request's trace, and the logs. Turning it on installs and runs <code>{HELPER}</code> on {box}; what it records stays there.
    </>
  ),
  off: (box) => `Nothing is recorded while it is off. Turning it on installs ${HELPER} on ${box} and keeps it running there; what it recorded before, if anything, is kept on the box until you remove it.`,
  remove: {
    title: (box) => `Remove what Leadline recorded on ${box}?`,
    body: () => "deletes everything it recorded there: every worktree's queries, traces and logs. It can't be undone. Turn Leadline on again to start afresh.",
    done: (box) => `Removed Leadline's data on ${box}`,
  },
  left: (services, n) => `Restart ${services}: ${n === 1 ? "it was" : "they were"} started while Leadline was on, and ${n === 1 ? "its" : "their"} telemetry and database connection still go to it.`,
};

// What a panel's body is given once the helper is running on its box.
export interface PanelContext {
  berth: BerthPluginContext;
  api: Leadline;
  box: string;
  // The worktree's name in the helper, and in words.
  source: string;
  worktree: string;
  // Its folder on the box, and its name in the box's API ("shop/fix-orders").
  path: string;
  where: string;
  window: Window;
  // The window as of now: asked for at every read, so it rolls forward.
  scope(): Scope;
  // False while the panel is out of sight: nothing is read then.
  active: boolean;
  // A request failed: if the helper went off, the panel says so.
  onFault(fault: Fault): void;
}

// PanelShell is what the four panels share: it reads the helper's state on
// the worktree's box, says so when there is nothing to show (the box is
// offline, its berthd is too old, the helper is off, installing or failed),
// and otherwise draws the panel for the worktree's source.
export function PanelShell({ berth, box, location, worktree, main, path, panel, children }: WorktreePanelProps & { panel: string; children(ctx: PanelContext): ReactNode }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const online = useBoxes().find((b) => b.name === box)?.state === "online";
  const helper = useHelperState(berth, box, visible && online);
  const [window] = useWindow(berth);
  const source = sourceOf({ location, worktree, main });
  const api = useMemo(() => leadline(berth), [berth]);
  const running = helper.status?.state === "running";
  const refresh = helper.refresh;
  const onFault = useCallback(
    (fault: Fault) => {
      if (fault.code === "helper_off" || fault.status === 503) refresh();
    },
    [refresh],
  );
  const ctx: PanelContext = {
    berth,
    api,
    box,
    source,
    worktree: main ? location : worktree,
    path,
    where: worktreeLocation({ location, worktree, main }),
    window,
    scope: () => ({ box, source, sinceMs: Date.now() - window.ms }),
    active: visible && online && running,
    onFault,
  };
  return (
    <div ref={ref} data-testid="leadline" data-leadline={panel} data-state={online ? (helper.status?.state ?? "reading") : "offline"} className="@container flex h-full min-h-0 flex-col bg-pane text-sm">
      {!online ? (
        <Notice icon="CloudOff" title={`${box} is offline`} body="Leadline's helper runs on the box and keeps what it records there, so there is nothing to read until the box is back." />
      ) : running ? (
        children(ctx)
      ) : (
        <HelperBox variant="panel" berth={berth} box={box} copy={COPY} testId="leadline" onAbout={() => berth.openScreen("leadline")} />
      )}
    </div>
  );
}

export function Notice({ icon, title, body, actions }: { icon: ReactNode; title: string; body?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-1 items-center justify-center p-6" data-testid="leadline-notice">
      <Empty>
        <EmptyHeader>
          {typeof icon === "string" ? <Icon name={icon} className="mx-auto mb-2 size-5 text-muted-foreground" /> : icon}
          <EmptyTitle>{title}</EmptyTitle>
          {body && <EmptyDescription className="max-w-md text-pretty">{body}</EmptyDescription>}
        </EmptyHeader>
        {actions && <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
      </Empty>
    </div>
  );
}

// Toolbar is a panel's strip: what narrows the list on the left, how many
// there are, and the time window every panel shares on the right.
export function Toolbar({ ctx, children, note }: { ctx: PanelContext; children?: ReactNode; note?: ReactNode }) {
  const [window, setWindow] = useWindow(ctx.berth);
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
      {children}
      <span className="ml-auto truncate text-muted-foreground text-xs tabular-nums" data-testid="leadline-count">
        {note}
      </span>
      <PickOne label="Time window" value={window.value} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} onChange={setWindow} />
    </div>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }) {
  return <Input className="w-56 max-w-full" size="sm" type="search" placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} />;
}

// Waiting is a list before its first answer: rows at their height, or why
// there is no answer.
export function Waiting({ fault, onRetry }: { fault?: Fault; onRetry?(): void }) {
  if (fault) return <Notice icon="TriangleAlert" title="Couldn't read from Leadline" body={<FaultText fault={fault} />} actions={onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>} />;
  return (
    <div className="space-y-2 p-3" aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

export function FaultText({ fault }: { fault: Fault }) {
  return (
    <>
      {fault.message}
      {fault.hint && <span className="mt-1 block text-muted-foreground">{fault.hint}</span>}
    </>
  );
}

// StaleNote is one line over a list that could not be read again: what is
// shown is the last answer.
export function StaleNote({ fault }: { fault?: Fault }) {
  if (!fault) return null;
  return (
    <p role="status" className="shrink-0 border-b bg-warning/8 px-3 py-1.5 text-warning-foreground text-xs">
      Couldn't read again: {fault.message}
    </p>
  );
}

// useSource is what the helper has heard from this worktree, read while a
// list is empty, to tell "nothing in this window" from "nothing yet".
function useSource(ctx: PanelContext, active: boolean): { known: boolean; source?: Source } | undefined {
  const live = useLive(() => ctx.api.sources(ctx.box, ctx.source), `${ctx.box}\n${ctx.source}`, { every: 5000, active: ctx.active && active, onFault: ctx.onFault });
  if (!live.data) return undefined;
  const source = live.data.sources.find((s) => s.name === ctx.source);
  return { known: !!source && source.spans + source.logs > 0, source };
}

// Nothing is a list with no rows. With a search or a filter on, that is all
// it says. Otherwise it asks the helper whether this worktree has ever sent
// anything: if it has, the window is the reason; if not, the app isn't
// sending yet, and it says what an app needs.
export function Nothing({ ctx, what, filtered }: { ctx: PanelContext; what: string; filtered?: boolean }) {
  const heard = useSource(ctx, !filtered);
  if (filtered) return <Notice icon="Search" title={`No ${what} match`} body={`Nothing in the last ${span(ctx.window.ms)} matches what you typed or picked.`} />;
  if (!heard) return <Waiting />;
  if (heard.known && heard.source) {
    return (
      <Notice
        icon="Hourglass"
        title={`No ${what} in the last ${span(ctx.window.ms)}`}
        body={`${ctx.worktree} last sent something ${ago(Date.now() - heard.source.last_seen_ms)}. Make a request to the app, or pick a wider window.`}
      />
    );
  }
  return (
    <Notice
      icon="Anchor"
      title={`Nothing from ${ctx.worktree} yet`}
      body={
        <>
          Leadline is running on {ctx.box}, and this worktree's app hasn't sent it anything. Start the app as one of the worktree's services, so Shipyard gives it the variables that point at Leadline. Queries to a Postgres on the box are then recorded as they are; traces and logs need an OpenTelemetry SDK in the app.
        </>
      }
      actions={
        <Button size="sm" variant="outline" onClick={() => ctx.berth.openScreen("leadline")}>
          What an app needs
        </Button>
      }
    />
  );
}

// Split lays a list beside the detail of the row picked in it. In a narrow
// pane the detail takes the list's place, with a way back.
export function Split({ list, detail }: { list: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className={cn("min-h-0 min-w-0 flex-col", detail ? "hidden @3xl:flex @3xl:w-[42%] @3xl:border-r" : "flex flex-1")}>{list}</div>
      {detail && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>}
    </div>
  );
}

// DetailHeader names what is open, with its actions and the way back to
// the list.
export function DetailHeader({ children, actions, onClose, label }: { children: ReactNode; actions?: ReactNode; onClose(): void; label: string }) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <Tip label={label}>
        <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClose}>
          <Icon name="ArrowLeft" className="size-3.5 @3xl:hidden" />
          <Icon name="X" className="hidden size-3.5 @3xl:block" />
        </Button>
      </Tip>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions}
    </div>
  );
}

// Stats is a row of figures at the top of a detail.
export function Stats({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @md:grid-cols-4">{children}</dl>;
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="bg-background px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn("mt-0.5 flex flex-wrap items-baseline gap-x-1.5 font-medium tabular-nums", tone === "warn" && "text-warning-foreground", tone === "bad" && "text-destructive-foreground")}>
        {value}
        {note && <span className="whitespace-nowrap font-normal text-muted-foreground text-xs">{note}</span>}
      </dd>
    </div>
  );
}

// Section is a titled block of a detail.
export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-baseline gap-2 font-medium text-sm">
        {title}
        {hint && <span className="font-normal text-muted-foreground text-xs">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}

export function None({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">{children}</p>;
}

// Meter is a bar for one row's share of the largest in its column.
export function Meter({ value, max, tone }: { value: number; max: number; tone?: "bad" }) {
  return (
    <span className="block h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className={cn("block h-full rounded-full", tone === "bad" ? "bg-destructive" : "bg-primary/70")} style={{ width: `${Math.max(2, Math.min(100, (value / Math.max(max, 1e-9)) * 100))}%` }} />
    </span>
  );
}

// Spark is a row's requests over the window, a bar for each bucket.
export function Spark({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const w = 3;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${values.length * w} 16`} className="h-4 w-[72px] shrink-0 text-primary/70" preserveAspectRatio="none">
      {values.map((v, i) => (v > 0 ? <rect key={i} x={i * w} y={16 - Math.max(2, (v / max) * 16)} width={w - 1} height={Math.max(2, (v / max) * 16)} fill="currentColor" /> : null))}
    </svg>
  );
}

// SortHead is a column heading that orders the list by its column: once
// for largest first, again for smallest.
export function SortHead<K extends string>({ id, sort, dir, onSort, children, className }: { id: K; sort: K; dir: "asc" | "desc"; onSort(id: K): void; children: ReactNode; className?: string }) {
  const on = sort === id;
  return (
    <th scope="col" aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : undefined} className={cn("h-8 whitespace-nowrap px-2 font-medium text-muted-foreground text-xs", className)}>
      <button type="button" onClick={() => onSort(id)} className={cn("inline-flex items-center gap-0.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", on && "text-foreground")}>
        {children}
        {on && <Icon name={dir === "asc" ? "ArrowUp" : "ArrowDown"} className="size-3" />}
      </button>
    </th>
  );
}

export function Head({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("h-8 whitespace-nowrap px-2 font-medium text-muted-foreground text-xs", className)}>
      {children}
    </th>
  );
}

// Service marks a row that came from a worktree's second command.
export function Command({ service }: { service: string }) {
  const command = commandOf(service);
  if (!command) return null;
  return (
    <Badge variant="outline" size="sm" className="shrink-0 font-normal">
      {command}
    </Badge>
  );
}

// More is the row under a list that has older or further rows to load.
export function More({ onClick, loading, children }: { onClick(): void; loading?: boolean; children: ReactNode }) {
  return (
    <div className="flex justify-center border-t p-2">
      <Button size="xs" variant="ghost" loading={loading} onClick={onClick}>
        {children}
      </Button>
    </div>
  );
}

// A row someone can open: a real button for the keyboard, drawn as a row.
export const rowClass = (on?: boolean) => cn("cursor-pointer border-b outline-none hover:bg-accent/50 focus-visible:bg-accent/60", on && "bg-accent/60");

// Problem badges, the same wherever a row has one.
export function NPlusOne({ times }: { times: number }) {
  return (
    <Tip label={`One request ran this statement ${times} times: an N+1`}>
      <Badge variant="warning" size="sm" className="shrink-0 tabular-nums">
        N+1 ×{times}
      </Badge>
    </Tip>
  );
}
