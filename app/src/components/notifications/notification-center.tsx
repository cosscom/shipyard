import {
  AlarmClockIcon,
  BellIcon,
  BellOffIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CloudOffIcon,
  EllipsisIcon,
  GitPullRequestArrowIcon,
  GlobeIcon,
  KeyRoundIcon,
  MailIcon,
  MailOpenIcon,
  MegaphoneIcon,
  MessageCircleQuestionIcon,
  PackageIcon,
  PuzzleIcon,
  SendIcon,
  ServerCrashIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SquareTerminalIcon,
  TrashIcon,
  WorkflowIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { watchReviewNotes } from "@/components/notifications/review-source";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Scene } from "@/components/art/scenes";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Session } from "@/lib/api";
import { sessionAgent, sessionName, sessionPlace, sessionState } from "@/lib/derive";
import {
  type Category,
  categoryInfo,
  clearEarlier,
  dismiss,
  markAllRead,
  markRead,
  type Note,
  needsYou,
  noteLabel,
  openNote,
  quietNow,
  runAction,
  quietState,
  setDoNotDisturb,
  setNotificationsOpen,
  snooze,
  snoozed,
  toggleNotifications,
  unsnooze,
  useNotifications,
  useNotifyPrefs,
  useUnread,
} from "@/lib/notifications";
import { type BoxData, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { titleAt } from "@/lib/worktree-names";

// useMinute re-renders once a minute, so relative times and snoozes move.
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

// NotificationBell opens the centre. The count is what is unread; it turns
// amber while anything needs the person.
export function NotificationBell({ className, size = "sm" }: { className?: string; size?: "sm" | "rail" }) {
  const now = useMinute();
  const { unread, needs } = useUnread(now);
  const open = useNotifications((s) => s.open);
  const quiet = useNotifyPrefs((p) => quietNow(p, new Date(now)));
  const label = [
    "Notifications",
    needs ? `${needs} need${needs === 1 ? "s" : ""} you` : unread ? `${unread} unread` : "",
    quiet ? "Do not disturb is on" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = quiet ? BellOffIcon : BellIcon;
  return (
    <Tip
      label={
        <span className="flex items-center gap-2">
          {label}
          <Kbd>⌘⇧N</Kbd>
        </span>
      }
      side={size === "rail" ? "right" : "top"}
    >
      <button
        type="button"
        aria-label={label}
        aria-keyshortcuts="Meta+Shift+N"
        onClick={toggleNotifications}
        className={cn(
          "relative inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          size === "rail" ? "size-8 rounded-lg [&_svg]:size-4" : "size-6.5 [&_svg]:size-3.5",
          open && "bg-sidebar-accent text-foreground",
          needs > 0 && "text-warning-foreground dark:text-warning",
          className,
        )}
      >
        <Icon />
        {unread > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 font-semibold text-tag tabular-nums leading-none",
              needs > 0 ? "bg-warning text-black" : "bg-foreground/80 text-background",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </Tip>
  );
}

const icons: Record<Category, React.ComponentType<{ className?: string }>> = {
  waiting: MessageCircleQuestionIcon,
  finished: CircleCheckIcon,
  review: GitPullRequestArrowIcon,
  flowFailed: WorkflowIcon,
  setupFailed: WrenchIcon,
  serviceFailed: ServerCrashIcon,
  guard: ShieldAlertIcon,
  kit: PackageIcon,
  notify: MegaphoneIcon,
  opened: SquareTerminalIcon,
  plugin: PuzzleIcon,
  secret: KeyRoundIcon,
  queueDelivered: SendIcon,
  queueFailed: CloudOffIcon,
};

// ---- Filters -----------------------------------------------------------

type Kind = "agents" | "problems" | "messages";
type Filter = "all" | "unread" | Kind;

// The kinds the filter offers. A category not listed here counts as a
// message.
const kinds: Partial<Record<Category, Kind>> = {
  waiting: "agents",
  finished: "agents",
  review: "agents",
  opened: "agents",
  queueDelivered: "agents",
  flowFailed: "problems",
  setupFailed: "problems",
  serviceFailed: "problems",
  secret: "problems",
  queueFailed: "problems",
  guard: "problems",
  kit: "problems",
};
const kindOf = (c: Category): Kind => kinds[c] ?? "messages";

const FILTERS: { id: Filter; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "Nothing here." },
  { id: "unread", label: "Unread", empty: "Nothing unread." },
  { id: "agents", label: "Agents", empty: "Nothing from agents." },
  { id: "problems", label: "Problems", empty: "No problems." },
  { id: "messages", label: "Messages", empty: "No messages from automations or plugins." },
];

const matches = (f: Filter, n: Note) => (f === "all" ? true : f === "unread" ? !n.read : kindOf(n.category) === f);

// ---- Shaping -----------------------------------------------------------

function short(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// contextOf says where a note happened the way the sidebar does: "shop /
// checkout-fix · devl", or "shop · devl" for a main checkout.
function contextOf(n: Note, boxes: Record<string, BoxData>): string {
  // A worktree given a display name since is called by it.
  const wt = (n.box && n.path && !placeIsMain(n) && titleAt(n.box, n.path, boxes)) || n.worktree;
  let where = n.project ? (wt && wt !== n.project ? `${n.project} / ${wt}` : n.project) : wt;
  if (!where && n.box && n.session) {
    const data = boxes[n.box];
    const s = data?.sessions?.find((x) => x.name === n.session);
    if (s) where = sessionPlace(s, data?.locations);
  }
  return [where, n.box].filter(Boolean).join(" · ");
}

const placeIsMain = (n: Note) => !n.worktree && !!n.project;

// An item is one row: a note, or resolved repeats of one folded together.
interface Item {
  note: Note;
  ids: string[];
  count: number;
}

const DAY = 86_400_000;

function dayOf(iso: string, now: number): "Today" | "Yesterday" | "Older" {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t = new Date(iso).getTime();
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  return "Older";
}

// fold groups Earlier by day, and folds resolved repeats of the same thing
// (the same agent waiting, then answered, again and again) into one row.
function fold(notes: Note[], now: number): { title: string; items: Item[] }[] {
  const groups: { title: string; items: Item[] }[] = [];
  for (const n of notes) {
    const title = dayOf(n.time, now);
    let g = groups.find((x) => x.title === title);
    if (!g) groups.push((g = { title, items: [] }));
    const same = n.resolved ? g.items.find((i) => i.note.resolved && i.note.key === n.key) : undefined;
    if (same) {
      same.ids.push(n.id);
      same.count += n.count;
    } else {
      g.items.push({ note: n, ids: [n.id], count: n.count });
    }
  }
  return groups;
}

const byTime = (a: Note, b: Note) => b.time.localeCompare(a.time);

// The status bar's height (status-bar.tsx, h-6.5): the sheet ends above it,
// so its counts stay readable while the centre is open.
const STATUS_BAR = 26;

// ---- Agents waiting now ------------------------------------------------

// A live agent waiting for the person that no note covers: the centre only
// hears events while Shipyard is open, so an agent that asked before then (or
// whose note was cleared) would otherwise leave "all caught up" showing
// while the status bar says one is waiting.
interface Live {
  key: string;
  box: string;
  session: Session;
  name: string;
  place: string;
}

function liveWaiting(boxes: Record<string, BoxData>, notes: Note[]): Live[] {
  const out: Live[] = [];
  for (const [box, data] of Object.entries(boxes)) {
    for (const s of data.sessions ?? []) {
      if (s.exited || sessionState(s, data.stats) !== "waiting") continue;
      const covered = notes.some((n) => n.category === "waiting" && !n.resolved && n.box === box && (n.session ? n.session === s.name : n.path === s.dir));
      if (covered) continue;
      out.push({ key: `${box}|${s.name}`, box, session: s, name: sessionName(s, { sessions: data.sessions }), place: [sessionAgent(s), sessionPlace(s, data.locations), box].filter(Boolean).join(" · ") });
    }
  }
  return out;
}

// ---- The centre --------------------------------------------------------

// NotificationCenter is the sheet, mounted once beside the other dialogs.
// Rows answer the keyboard: ↑/↓ move, Enter opens, R toggles read, E or
// Backspace dismisses, Esc closes.
export function NotificationCenter() {
  const open = useNotifications((s) => s.open);
  const notes = useNotifications((s) => s.notes);
  const error = useNotifications((s) => s.error);
  const boxes = useStore((s) => s.boxes);
  const prefs = useNotifyPrefs();
  const now = useMinute();
  const hush = quietState(prefs, new Date(now));
  const quiet = hush.on;
  const [filter, setFilter] = useState<Filter>("all");
  // The row that takes Tab, so the list is one stop and arrows move in it.
  const [active, setActive] = useState<string>();
  // Focus lands on the panel itself, not on its first button.
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => watchReviewNotes(), []);

  // With no notes the filter is hidden, so it can't hide the agents.
  const live = notes.length === 0 || filter === "all" || filter === "agents" || filter === "unread" ? liveWaiting(boxes, notes) : [];
  const shown = notes.filter((n) => matches(filter, n)).sort(byTime);
  const needs = shown.filter((n) => needsYou(n, now)).map((n): Item => ({ note: n, ids: [n.id], count: n.count }));
  const groups = fold(
    shown.filter((n) => !needsYou(n, now)),
    now,
  );
  const items = [...needs, ...groups.flatMap((g) => g.items)];
  const unread = notes.some((n) => !n.read);
  const anyEarlier = notes.some((n) => !needsYou(n, now));
  // The panel is as tall as its rows, up to the window. A box without a set
  // height can't pass one down, so the list's viewport is capped itself:
  // the window less the inset (2rem), the status bar the sheet stays
  // above (26px), the header and the banners.
  const chrome = 32 + STATUS_BAR + 49 + (quiet ? 29 : 0) + (error ? 33 : 0);
  const current = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const tabStop = items.some((i) => i.note.id === active) || live.some((l) => l.key === active) ? active : (items[0]?.note.id ?? live[0]?.key);

  const settings = () => {
    setNotificationsOpen(false);
    useStore.getState().setView({ kind: "settings", section: "notifications" });
  };

  const rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>("[data-note]") ?? []);
  const focusRow = (i: number) => {
    const all = rows();
    if (!all.length) return;
    all[Math.max(0, Math.min(all.length - 1, i))].focus();
  };

  // Arrows work from the header too, so ↓ after opening lands on the first
  // row. Keys from menus (portalled, but React bubbles them here) are left
  // alone.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (!(e.currentTarget as HTMLElement).contains(target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const row = target.closest<HTMLElement>("[data-note]");
    const fromHeader = target === panel.current;
    if (!row && !fromHeader) return;
    const all = rows();
    const at = row ? all.indexOf(row) : -1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(at + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (at > 0) focusRow(at - 1);
        else panel.current?.focus();
        return;
      case "Home":
        e.preventDefault();
        focusRow(0);
        return;
      case "End":
        e.preventDefault();
        focusRow(all.length - 1);
        return;
    }
    // The rest act on the focused row itself, not a button inside it.
    if (!row || target !== row) return;
    const one = live.find((l) => l.key === row.dataset.note);
    if (one) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLive(one);
      }
      return;
    }
    const item = items.find((i) => i.note.id === row.dataset.note);
    if (!item) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(item.note);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      markRead(item.note.id, !item.note.read);
    } else if (e.key === "e" || e.key === "E" || e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      // Stay in the list: focus moves to the row that slides up into this
      // place (rows are keyed, so it keeps its element) before this one goes.
      (all[at + 1] ?? all[at - 1] ?? panel.current)?.focus();
      for (const id of item.ids) dismiss(id);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setNotificationsOpen}>
      <SheetPopup
        variant="inset"
        className="outline-none sm:h-auto sm:max-h-[calc(100%-26px)] sm:max-w-[420px] sm:self-start"
        showCloseButton={false}
        initialFocus={panel}
        data-notification-center=""
        onKeyDown={onKeyDown}
      >
        <div ref={panel} tabIndex={-1} className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-4 outline-none">
          <SheetTitle className="mr-1 text-heading">Notifications</SheetTitle>
          {notes.length > 0 && (
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost" data-filter="" aria-label={`Show: ${current.label}`} className="gap-1 px-1.5 text-muted-foreground" />}
              >
                {current.label}
                <ChevronDownIcon className="size-3 opacity-70" />
              </MenuTrigger>
              <MenuPopup align="start" className="min-w-44">
                <MenuRadioGroup value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                  {FILTERS.map((f, i) => {
                    const count = notes.filter((n) => matches(f.id, n)).length;
                    return (
                      <Fragment key={f.id}>
                        {i === 2 && <MenuSeparator />}
                        <MenuRadioItem value={f.id} closeOnClick>
                          <span className="flex items-center gap-4">
                            <span className="flex-1">{f.label}</span>
                            <span className="text-muted-foreground text-meta tabular-nums">{count || ""}</span>
                          </span>
                        </MenuRadioItem>
                      </Fragment>
                    );
                  })}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {notes.length > 0 && (
              <Button size="xs" variant="ghost" disabled={!unread} onClick={markAllRead} className="text-muted-foreground">
                <CheckCheckIcon />
                Mark all read
              </Button>
            )}
            <Menu>
              <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="More" className="text-muted-foreground" />}>
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-56">
                {quiet ? (
                  <MenuItem onClick={() => setDoNotDisturb(false)}>
                    <BellIcon />
                    Turn off Do not disturb
                  </MenuItem>
                ) : (
                  <>
                    <MenuItem onClick={() => setDoNotDisturb(true, new Date(Date.now() + 3600_000))}>
                      <BellOffIcon />
                      Do not disturb for 1 hour
                    </MenuItem>
                    <MenuItem onClick={() => setDoNotDisturb(true)}>
                      <BellOffIcon />
                      Do not disturb until I turn it off
                    </MenuItem>
                  </>
                )}
                <MenuSeparator />
                <MenuItem disabled={!anyEarlier} onClick={clearEarlier}>
                  <TrashIcon />
                  Clear all but what needs you
                </MenuItem>
                <MenuItem onClick={settings}>
                  <SettingsIcon />
                  Notification settings
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button size="icon-xs" variant="ghost" aria-label="Close" className="text-muted-foreground" onClick={() => setNotificationsOpen(false)}>
              <XIcon />
            </Button>
          </div>
        </div>

        {quiet && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-muted-foreground text-meta">
            <BellOffIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Do not disturb{hush.until ? ` until ${clock(hush.until.toISOString())}` : ""}
              {prefs.dnd.allowWaiting ? "; waiting agents still come through." : "; they still collect here."}
            </span>
          </div>
        )}

        {notes.length === 0 && live.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
            <Empty className="p-0">
              <EmptyHeader>
                <EmptyMedia>
                  <Scene name="bottle" width={128} className="text-muted-foreground" />
                </EmptyMedia>
                <EmptyTitle className="text-heading">You're all caught up</EmptyTitle>
                <EmptyDescription className="text-body">Agents that need you, failures and finished work land here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <ScrollArea
            className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:max-h-(--list-max)"
            style={{ "--list-max": `calc(100dvh - ${chrome}px)` } as React.CSSProperties}
            scrollFade
          >
            <div ref={list} className="px-1.5 pt-1.5 pb-2">
              {needs.length + live.length > 0 ? (
                <Section title="Needs you" count={needs.length + live.length} amber>
                  {needs.map((i) => (
                    <Row key={i.note.id} item={i} now={now} boxes={boxes} tabStop={tabStop === i.note.id} onFocus={setActive} />
                  ))}
                  {live.map((l) => (
                    <LiveRow key={l.key} live={l} now={now} tabStop={tabStop === l.key} onFocus={setActive} />
                  ))}
                </Section>
              ) : (
                filter === "all" && (
                  <p className="flex h-8 items-center gap-2 px-2.5 text-muted-foreground text-meta">
                    <CheckIcon className="size-3.5 shrink-0 text-success-foreground dark:text-success" />
                    Nothing needs you right now
                  </p>
                )
              )}
              {groups.map((g) => (
                <Section key={g.title} title={g.title}>
                  {g.items.map((i) => (
                    <Row key={i.note.id} item={i} now={now} boxes={boxes} tabStop={tabStop === i.note.id} onFocus={setActive} />
                  ))}
                </Section>
              ))}
              {items.length === 0 && live.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground text-meta">
                  {current.empty}
                  <Button size="xs" variant="ghost" onClick={() => setFilter("all")}>
                    Show all
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        )}

        {error && (
          <div className="flex h-8 shrink-0 items-center gap-2 border-t px-4 text-tag text-destructive-foreground dark:text-destructive">
            <span className="min-w-0 flex-1 truncate" title={error}>
              Not saved: the Shipyard agent did not take the history.
            </span>
          </div>
        )}
      </SheetPopup>
    </Sheet>
  );
}

function Section({ title, count, amber, children }: { title: string; count?: number; amber?: boolean; children: React.ReactNode }) {
  return (
    <section className="not-first:mt-1.5">
      <h3 className="flex h-7 items-center gap-1.5 px-2.5 font-medium text-tag text-muted-foreground">
        {amber && <span className="size-1.5 rounded-full bg-warning" />}
        {title}
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

// activate is a row's click: open what it is about, or, for a note with
// nothing to open, just mark it read.
function activate(n: Note) {
  if (noteLabel(n)) openNote(n.id);
  else markRead(n.id);
}

function Row({
  item,
  now,
  boxes,
  tabStop,
  onFocus,
}: {
  item: Item;
  now: number;
  boxes: Record<string, BoxData>;
  tabStop: boolean;
  onFocus(id: string): void;
}) {
  const n = item.note;
  const Icon = n.category === "opened" && n.title.startsWith("Preview") ? GlobeIcon : (icons[n.category] ?? BellIcon);
  const label = noteLabel(n);
  const isSnoozed = snoozed(n, now);
  const needs = needsYou(n, now);
  const info = categoryInfo(n.category);
  const context = contextOf(n, boxes);
  const folded = n.resolved;
  // Tone only where it signals: something that needs the person.
  const tone = !needs ? "text-muted-foreground" : n.tone === "error" ? "text-destructive-foreground dark:text-destructive" : "text-warning-foreground dark:text-warning";
  const status = isSnoozed && n.snoozedUntil ? `Snoozed until ${clock(n.snoozedUntil)}` : folded ? (n.category === "review" ? "Reviewed" : "Resolved") : undefined;
  const line = [status, context, folded ? undefined : n.detail].filter(Boolean).join(" · ");

  const cluster = (
    <span className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex">
      {n.category === "waiting" && !n.resolved && (
        <RowButton label={isSnoozed ? "Unsnooze" : "Snooze 1 hour"} onClick={() => (isSnoozed ? unsnooze(n.id) : snooze(n.id))}>
          <AlarmClockIcon />
        </RowButton>
      )}
      {!folded && (
        <RowButton label={n.read ? "Mark unread" : "Mark read"} shortcut="R" onClick={() => markRead(n.id, !n.read)}>
          {n.read ? <MailIcon /> : <MailOpenIcon />}
        </RowButton>
      )}
      <RowButton label={item.ids.length > 1 ? `Dismiss all ${item.ids.length}` : "Dismiss"} shortcut="E" onClick={() => item.ids.forEach(dismiss)}>
        <XIcon />
      </RowButton>
    </span>
  );
  const time = (
    <span className="shrink-0 text-tag text-muted-foreground tabular-nums group-focus-within/row:hidden group-hover/row:hidden">{short(n.time, now)}</span>
  );

  return (
    <li
      data-note={n.id}
      aria-label={[n.read ? undefined : "Unread", n.title, line].filter(Boolean).join(", ")}
      tabIndex={tabStop ? 0 : -1}
      onFocus={(e) => e.target === e.currentTarget && onFocus(n.id)}
      onClick={() => activate(n)}
      className={cn(
        "group/row relative flex cursor-default gap-2 rounded-md px-1.5 outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring/60",
        folded ? "py-1" : "py-1.5",
      )}
    >
      {/* Unread: a dot in its own column, so titles stay aligned. */}
      <span className="flex h-5 w-1.5 shrink-0 items-center" aria-hidden>
        {!n.read && <span className={cn("size-1.5 rounded-full", needs ? "bg-warning" : "bg-info")} />}
      </span>
      <Tip label={folded ? `${info.label} · ${status}` : info.label} side="left" delay={600}>
        <span className={cn("flex h-5 shrink-0 items-center [&_svg]:size-4", tone, folded && "opacity-60 [&_svg]:size-3.5")}>
          <Icon />
        </span>
      </Tip>
      {folded ? (
        <div className="flex h-5 min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 shrink truncate text-muted-foreground text-meta">{n.title}</span>
          {item.count > 1 && <span className="shrink-0 text-tag text-muted-foreground tabular-nums">×{item.count}</span>}
          <span className="min-w-0 flex-1 truncate text-tag text-muted-foreground">{line}</span>
          {time}
          {cluster}
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-1.5">
            <span className={cn("min-w-0 truncate text-desc", n.read ? "text-foreground/80" : "font-medium text-foreground")}>{n.title}</span>
            {item.count > 1 && <span className="shrink-0 text-tag text-muted-foreground tabular-nums">×{item.count}</span>}
            <span className="flex-1" />
            {time}
            {cluster}
          </div>
          {(line || label) && (
            <div className="flex h-4.5 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-muted-foreground text-meta" title={line}>
                {line}
              </span>
              {label && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openNote(n.id);
                  }}
                  className="hidden shrink-0 text-foreground/80 text-meta underline-offset-2 hover:text-foreground hover:underline group-focus-within/row:inline group-hover/row:inline"
                >
                  {label}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function openLive(l: Live) {
  setNotificationsOpen(false);
  runAction({ kind: "session", box: l.box, session: l.session.name });
}

// LiveRow is an agent waiting now with no note of its own. It reads like a
// note's row, but there is nothing to mark read or dismiss: it goes when
// the agent stops waiting.
function LiveRow({ live, now, tabStop, onFocus }: { live: Live; now: number; tabStop: boolean; onFocus(id: string): void }) {
  const since = live.session.state_since;
  return (
    <li
      data-note={live.key}
      aria-label={`${live.name} needs you, ${live.place}`}
      tabIndex={tabStop ? 0 : -1}
      onFocus={(e) => e.target === e.currentTarget && onFocus(live.key)}
      onClick={() => openLive(live)}
      className="group/row relative flex cursor-default gap-2 rounded-md px-1.5 py-1.5 outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring/60"
    >
      <span className="flex h-5 w-1.5 shrink-0 items-center" aria-hidden>
        <span className="size-1.5 rounded-full bg-warning" />
      </span>
      <Tip label={categoryInfo("waiting").label} side="left" delay={600}>
        <span className="flex h-5 shrink-0 items-center text-warning-foreground dark:text-warning [&_svg]:size-4">
          <MessageCircleQuestionIcon />
        </span>
      </Tip>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-desc text-foreground">{live.name} needs you</span>
          <span className="flex-1" />
          {since && <span className="shrink-0 text-tag text-muted-foreground tabular-nums">{short(since, now)}</span>}
        </div>
        <div className="flex h-4.5 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-meta">{live.place}</span>
          <span className="hidden shrink-0 text-foreground/80 text-meta group-focus-within/row:inline group-hover/row:inline">Open session</span>
        </div>
      </div>
    </li>
  );
}

function RowButton({ label, shortcut, onClick, children }: { label: string; shortcut?: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tip
      label={
        <span className="flex items-center gap-2">
          {label}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="-my-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
