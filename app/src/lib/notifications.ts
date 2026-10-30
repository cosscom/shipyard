import { create } from "zustand";

import { toastManager } from "@/components/ui/toast";
import { type BerthEvent, isTauri } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { usePrefs } from "@/lib/prefs";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { focusSession, refOf, selectWorktree } from "@/lib/workspaces";
import { titleAt } from "@/lib/worktree-names";
import { announce } from "@/lib/announce";

// The notification centre: one router every event-driven notification goes
// through, so the person's settings decide where each kind shows (the
// centre, a toast, a macOS notification) and when to stay quiet. History and
// read state live on the laptop agent (/v1/app/notifications), the last 500.
//
// Feedback on something the person just did ("Copied", "Removed") is not a
// notification and stays a plain toast.

export type Category =
  | "waiting"
  | "finished"
  | "review"
  | "flowFailed"
  | "setupFailed"
  | "serviceFailed"
  | "guard"
  | "kit"
  | "notify"
  | "opened"
  | "plugin"
  | "secret"
  | "queueDelivered"
  | "queueFailed";

export type Tone = "info" | "success" | "warning" | "error";

export interface Channels {
  centre: boolean;
  toast: boolean;
  system: boolean;
}

export interface CategoryInfo {
  id: Category;
  label: string;
  description: string;
  // Needs-you kinds sit at the top until they are dealt with.
  needs: boolean;
  defaults: Channels;
}

const all: Channels = { centre: true, toast: true, system: true };
const quietly: Channels = { centre: true, toast: true, system: false };

export const CATEGORIES: CategoryInfo[] = [
  { id: "waiting", label: "An agent needs you", description: "It asked a question, wants permission or asks for a secret.", needs: true, defaults: all },
  { id: "finished", label: "An agent is done", description: "Its turn ended, with or without changes.", needs: false, defaults: all },
  { id: "review", label: "Work is ready for review", description: "An agent left changes in the review inbox.", needs: false, defaults: { centre: true, toast: false, system: false } },
  { id: "flowFailed", label: "An automation failed", description: "A flow run ended with a failed step.", needs: true, defaults: all },
  { id: "setupFailed", label: "A worktree's setup or archive failed", description: "Its setup or archive script exited with an error; an archive leaves the worktree as it was.", needs: true, defaults: all },
  { id: "serviceFailed", label: "A service failed", description: "A worktree's dev server or service would not start.", needs: true, defaults: quietly },
  { id: "guard", label: "The resource guard acted", description: "It stopped services or paused a worktree to free memory.", needs: false, defaults: quietly },
  { id: "kit", label: "A kit installed with warnings", description: "Some of a kit's steps need a look.", needs: false, defaults: quietly },
  { id: "notify", label: "Messages from automations", description: "A flow's notify step.", needs: false, defaults: all },
  { id: "opened", label: "An agent opened something", description: "A terminal or preview it asked to show while you were elsewhere.", needs: false, defaults: quietly },
  { id: "plugin", label: "Messages from plugins", description: "What plugins send with notify().", needs: false, defaults: all },
  { id: "secret", label: "A secret could not be read", description: "A variable naming a 1Password or env secret was left unset.", needs: true, defaults: quietly },
  { id: "queueDelivered", label: "A queued prompt was sent", description: "A prompt kept while its box was offline reached its agent.", needs: false, defaults: quietly },
  { id: "queueFailed", label: "A queued prompt could not be sent", description: "Its session is gone, or it may have arrived already. Retry, move or discard it.", needs: true, defaults: all },
];

export const categoryInfo = (id: Category) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

// What a notification opens. Plain data, so it survives a restart.
export type NoteAction =
  | { kind: "session"; box: string; session: string }
  | { kind: "worktree"; box: string; path?: string; location?: string; worktree?: string }
  | { kind: "run"; box: string; flow?: string; scope?: string; run?: string }
  | { kind: "review"; box: string; path: string }
  | { kind: "project"; box: string; location: string };

export interface Note {
  id: string;
  key: string;
  category: Category;
  tone: Tone;
  title: string;
  detail?: string;
  box?: string;
  project?: string;
  worktree?: string;
  path?: string;
  session?: string;
  action?: NoteAction;
  // label names this session's richer action ("Open preview"); after a
  // restart the plain action stands in.
  label?: string;
  // time is the latest occurrence; count how many collapsed into this row.
  time: string;
  count: number;
  read: boolean;
  resolved?: boolean;
  snoozedUntil?: string;
}

export interface NoteInput {
  category: Category;
  title: string;
  detail?: string;
  tone?: Tone;
  box?: string;
  path?: string;
  // project and worktree are found from box and path when left out.
  project?: string;
  worktree?: string;
  session?: string;
  action?: NoteAction;
  label?: string;
  // run is this session's own handler for the action (a split beside the
  // terminal, say), used while the app stays open.
  run?: () => void;
  // key collapses repeats into one row; by default the same kind, title and
  // place.
  key?: string;
}

// ---- Settings ----------------------------------------------------------

export interface QuietHours {
  // on is "Do not disturb" switched on by hand, until a time if set.
  on: boolean;
  until?: string;
  scheduled: boolean;
  from: string;
  to: string;
  // Days the schedule applies, 0 = Sunday.
  days: number[];
  // Waiting agents still come through.
  allowWaiting: boolean;
  // skipUntil is the end of a scheduled stretch turned off by hand: the
  // schedule stays on, and picks up again next time.
  skipUntil?: string;
}

export interface NotifyPrefs {
  categories: Record<Category, Channels>;
  sound: boolean;
  dnd: QuietHours;
}

const PREFS_KEY = "berth.notifications";

function defaultPrefs(): NotifyPrefs {
  // The General settings' older switches carry over the first time.
  const old = usePrefs.getState().notify;
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c.id, { ...c.defaults }])) as Record<Category, Channels>;
  const off = (id: Category) => (categories[id] = { centre: true, toast: false, system: false });
  if (!old.waiting) off("waiting");
  if (!old.finished) off("finished");
  if (!old.setupFailed) off("setupFailed");
  return {
    categories,
    sound: old.sound,
    dnd: { on: false, scheduled: false, from: "22:00", to: "08:00", days: [0, 1, 2, 3, 4, 5, 6], allowWaiting: true },
  };
}

function loadPrefs(): NotifyPrefs {
  const base = defaultPrefs();
  const saved = load<Partial<NotifyPrefs> | null>(PREFS_KEY, null);
  if (!saved) return base;
  return { ...base, ...saved, categories: { ...base.categories, ...saved.categories }, dnd: { ...base.dnd, ...saved.dnd } };
}

export const useNotifyPrefs = create<NotifyPrefs>()(() => loadPrefs());
useNotifyPrefs.subscribe((p) => save(PREFS_KEY, p));

export function setChannel(id: Category, patch: Partial<Channels>) {
  useNotifyPrefs.setState((p) => ({ categories: { ...p.categories, [id]: { ...p.categories[id], ...patch } } }));
}

export function setQuietHours(patch: Partial<QuietHours>) {
  useNotifyPrefs.setState((p) => ({ dnd: { ...p.dnd, ...patch } }));
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

const at = (base: Date, hhmm: string, days = 0) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(Math.floor(minutes(hhmm) / 60), minutes(hhmm) % 60, 0, 0);
  return d;
};

// scheduledUntil is when the schedule's quiet stretch that holds now ends,
// or undefined when the schedule isn't quiet now. A stretch may run past
// midnight: its evening counts for the day it starts, its morning for the
// day before.
export function scheduledUntil(p: NotifyPrefs = useNotifyPrefs.getState(), now = new Date()): Date | undefined {
  const d = p.dnd;
  if (!d.scheduled) return undefined;
  const from = minutes(d.from);
  const to = minutes(d.to);
  const m = now.getHours() * 60 + now.getMinutes();
  if (from === to) return undefined;
  if (from < to) return d.days.includes(now.getDay()) && m >= from && m < to ? at(now, d.to) : undefined;
  if (m >= from) return d.days.includes(now.getDay()) ? at(now, d.to, 1) : undefined;
  return m < to && d.days.includes((now.getDay() + 6) % 7) ? at(now, d.to) : undefined;
}

export interface Quiet {
  on: boolean;
  // by says what turned it on: the person, or the schedule.
  by?: "hand" | "schedule";
  until?: Date;
}

// quietState says whether Do not disturb holds right now, why, and until
// when.
export function quietState(p: NotifyPrefs = useNotifyPrefs.getState(), now = new Date()): Quiet {
  const d = p.dnd;
  if (d.on && (!d.until || new Date(d.until) > now)) return { on: true, by: "hand", until: d.until ? new Date(d.until) : undefined };
  const end = scheduledUntil(p, now);
  if (end && !(d.skipUntil && new Date(d.skipUntil).getTime() >= end.getTime())) return { on: true, by: "schedule", until: end };
  return { on: false };
}

// quietNow says whether Do not disturb holds right now, by hand or by the
// schedule.
export const quietNow = (p: NotifyPrefs = useNotifyPrefs.getState(), now = new Date()): boolean => quietState(p, now).on;

// setDoNotDisturb is the one switch for it. On holds until it's turned off
// (or until a time); off ends it now, and when the schedule is what holds
// it, lets this stretch pass without changing the schedule.
export function setDoNotDisturb(on: boolean, until?: Date) {
  if (on) return setQuietHours({ on: true, until: until?.toISOString(), skipUntil: undefined });
  const end = scheduledUntil();
  setQuietHours({ on: false, until: undefined, skipUntil: end?.toISOString() });
}

// ---- The store ---------------------------------------------------------

const MAX = 500;
const DOC = "/v1/app/notifications";

interface State {
  notes: Note[];
  open: boolean;
  loaded: boolean;
  error?: string;
  // A review item to select when the review inbox opens.
  reviewFocus?: string;
}

export const useNotifications = create<State>()(() => ({ notes: [], open: false, loaded: false }));

// Handlers and toasts that only live while the app is open.
const runners = new Map<string, () => void>();
const toasts = new Map<string, string>();

// Opening the centre puts away the toasts it already lists.
export function setNotificationsOpen(open: boolean) {
  if (open) {
    for (const t of toasts.values()) toastManager.close(t);
    toasts.clear();
  }
  useNotifications.setState({ open });
}
export const toggleNotifications = () => setNotificationsOpen(!useNotifications.getState().open);

export const snoozed = (n: Note, now = Date.now()) => !!n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now;

// needsYou is what sits at the top: unresolved needs-you kinds, not snoozed.
export const needsYou = (n: Note, now = Date.now()) => categoryInfo(n.category).needs && !n.resolved && !snoozed(n, now);

// useUnread counts for the bell. now moves with useMinute so snoozes end.
export function useUnread(now = Date.now()): { unread: number; needs: number } {
  const unread = useNotifications((s) => s.notes.filter((n) => !n.read && !snoozed(n, now)).length);
  const needs = useNotifications((s) => s.notes.filter((n) => needsYou(n, now)).length);
  return { unread, needs };
}

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// placeOf finds a path's project and worktree names on a box.
export function placeOf(box?: string, path?: string): { project?: string; worktree?: string; main?: boolean } {
  if (!box || !path) return {};
  for (const loc of useStore.getState().boxes[box]?.locations ?? []) {
    const wt = loc.worktrees?.find((w) => w.path === path);
    if (wt) return { project: loc.name, worktree: wt.main ? undefined : wt.name, main: wt.main };
  }
  return {};
}

function update(fn: (notes: Note[]) => Note[]) {
  useNotifications.setState((s) => ({ notes: fn(s.notes) }));
  persist();
}

function upsert(input: NoteInput, now: string): Note {
  const place = input.project ? {} : placeOf(input.box, input.path);
  const key = input.key ?? [input.category, input.box ?? "", input.path ?? "", input.title].join("|");
  const prev = useNotifications.getState().notes.find((n) => n.key === key && !n.resolved);
  const note: Note = {
    id: prev?.id ?? newId(),
    key,
    category: input.category,
    tone: input.tone ?? "info",
    title: input.title,
    detail: input.detail,
    box: input.box,
    path: input.path,
    project: input.project ?? place.project,
    worktree: input.worktree ?? place.worktree,
    session: input.session,
    action: input.action,
    label: input.label,
    time: now,
    count: (prev?.count ?? 0) + 1,
    read: false,
    snoozedUntil: prev?.snoozedUntil,
  };
  update((notes) => {
    const rest = notes.filter((n) => n.id !== note.id);
    const next = [note, ...rest];
    if (next.length <= MAX) return next;
    // Over the cap: the oldest settled ones go first.
    const drop = new Set<string>();
    for (let i = next.length - 1; i >= 0 && next.length - drop.size > MAX; i--) {
      if (next[i].read || next[i].resolved) drop.add(next[i].id);
    }
    return next.filter((n) => !drop.has(n.id)).slice(0, MAX);
  });
  if (input.run) runners.set(note.id, input.run);
  return note;
}

// route is the one way in. The category's settings decide the centre, the
// toast and the macOS notification; Do not disturb silences the last two.
// It returns the note's id when the centre keeps it.
export function route(input: NoteInput): string | undefined {
  const prefs = useNotifyPrefs.getState();
  const ch = prefs.categories[input.category] ?? categoryInfo(input.category).defaults;
  const note = ch.centre ? upsert(input, new Date().toISOString()) : undefined;
  const quiet = quietNow(prefs) && !(input.category === "waiting" && prefs.dnd.allowWaiting);
  if (quiet) return note?.id;
  const named = input.box && input.path && (note?.worktree ?? input.worktree) ? titleAt(input.box, input.path) : undefined;
  const where = [named ?? note?.worktree ?? note?.project, input.box].filter(Boolean).join(" · ");
  const body = [where, input.detail].filter(Boolean).join(" · ") || undefined;
  let shown = false;
  // What needs you and what failed interrupts a screen reader; the rest
  // waits for a pause.
  const urgent = input.tone === "error" || categoryInfo(input.category).needs;
  if (ch.toast && !(note && useNotifications.getState().open)) {
    showToast(input, body, note, urgent);
    shown = true;
  } else if (note) {
    // Kept in the centre without a toast: heard all the same.
    announce([input.title, body].filter(Boolean).join(". "), urgent);
  }
  if (ch.system && !document.hasFocus()) {
    void systemNotification(input.title, body);
    shown = true;
  }
  if (shown && prefs.sound) chime();
  return note?.id;
}

function showToast(input: NoteInput, body: string | undefined, note?: Note, urgent = false) {
  const label = actionLabel(input.action, input.label, !!input.run);
  const act = input.run ?? (input.action ? () => runAction(input.action!) : undefined);
  let id = "";
  id = toastManager.add({
    title: input.title,
    description: body,
    type: input.tone ?? "info",
    // High: an alert, read out at once; low waits for the reader to pause.
    priority: urgent ? "high" : "low",
    actionProps: act
      ? {
          children: label,
          onClick: () => {
            toastManager.close(id);
            if (note) markRead(note.id);
            act();
          },
        }
      : undefined,
  });
  if (note) {
    const old = toasts.get(note.id);
    if (old && old !== id) toastManager.close(old);
    toasts.set(note.id, id);
  }
}

export function actionLabel(a?: NoteAction, label?: string, live = true): string {
  if (label && live) return label;
  switch (a?.kind) {
    case "session":
      return "Open session";
    case "worktree":
      return "Open worktree";
    case "run":
      return "Open run";
    case "review":
      return "Open review";
    case "project":
      return "Open project";
    default:
      return "Open";
  }
}

export function noteLabel(n: Note): string | undefined {
  if (!n.action && !runners.has(n.id)) return undefined;
  return actionLabel(n.action, n.label, runners.has(n.id));
}

export function runAction(a: NoteAction) {
  const st = useStore.getState();
  switch (a.kind) {
    case "session":
      void focusSession(a.box, a.session);
      return;
    case "worktree": {
      for (const loc of st.boxes[a.box]?.locations ?? []) {
        const wt = loc.worktrees?.find((w) => (a.path ? w.path === a.path : loc.name === a.location && (a.worktree ? w.name === a.worktree : w.main)));
        if (wt) return selectWorktree(refOf(a.box, loc, wt));
      }
      st.setView({ kind: "worktrees" });
      return;
    }
    case "run":
      st.setView(a.flow && a.scope ? { kind: "automations", open: { box: a.box, scope: a.scope, id: a.flow } } : { kind: "automations" });
      return;
    case "review":
      useNotifications.setState({ reviewFocus: `${a.box}|${a.path}` });
      st.setView({ kind: "review" });
      return;
    case "project":
      st.setView({ kind: "project", box: a.box, location: a.location });
      return;
  }
}

// openNote does a note's action, marks it read and closes the centre.
export function openNote(id: string) {
  const n = useNotifications.getState().notes.find((x) => x.id === id);
  if (!n) return;
  markRead(id);
  setNotificationsOpen(false);
  const run = runners.get(id);
  if (run) run();
  else if (n.action) runAction(n.action);
}

export function markRead(id: string, read = true) {
  update((notes) => notes.map((n) => (n.id === id ? { ...n, read } : n)));
}

export function markAllRead() {
  update((notes) => notes.map((n) => (n.read ? n : { ...n, read: true })));
}

export function dismiss(id: string) {
  runners.delete(id);
  const t = toasts.get(id);
  if (t) toastManager.close(t);
  toasts.delete(id);
  update((notes) => notes.filter((n) => n.id !== id));
}

// clearEarlier removes everything that no longer needs the person.
export function clearEarlier() {
  const now = Date.now();
  update((notes) => notes.filter((n) => needsYou(n, now)));
}

export function snooze(id: string, ms = 60 * 60 * 1000) {
  const until = new Date(Date.now() + ms).toISOString();
  update((notes) => notes.map((n) => (n.id === id ? { ...n, snoozedUntil: until, read: true } : n)));
}

export function unsnooze(id: string) {
  update((notes) => notes.map((n) => (n.id === id ? { ...n, snoozedUntil: undefined } : n)));
}

// resolve settles the notes whose cause has cleared: they move to Earlier,
// read, and their toast goes away.
export function resolve(match: (n: Note) => boolean) {
  const hit = useNotifications.getState().notes.filter((n) => !n.resolved && match(n));
  if (!hit.length) return;
  for (const n of hit) {
    const t = toasts.get(n.id);
    if (t) toastManager.close(t);
    toasts.delete(n.id);
  }
  const ids = new Set(hit.map((n) => n.id));
  update((notes) => notes.map((n) => (ids.has(n.id) ? { ...n, resolved: true, read: true, snoozedUntil: undefined } : n)));
}

// resolveFromEvent clears notes when what caused them is over: an agent no
// longer waiting, a service up again, a flow passing, a worktree gone.
export function resolveFromEvent(e: BerthEvent) {
  const d = e.data ?? {};
  const path = d.path as string | undefined;
  const same = (n: Note) => n.box === e.box;
  switch (e.type) {
    case "agent.started":
    case "agent.ready":
    case "agent.finished":
      resolve((n) => n.category === "waiting" && same(n) && !!path && n.path === path);
      return;
    case "session.stopped":
      resolve((n) => n.category === "waiting" && same(n) && !!d.name && n.session === d.name);
      return;
    case "service.started":
      resolve((n) => n.category === "serviceFailed" && same(n) && n.key === serviceKey(e.box, d.location, d.name, d.service));
      return;
    case "flow.finished":
      if (d.status === "succeeded") resolve((n) => n.category === "flowFailed" && same(n) && n.key === flowKey(e.box, d.flow, d.scope));
      return;
    case "secret.resolved":
      resolve((n) => n.category === "secret" && same(n) && n.key === secretKey(e.box, d.location, d.variable));
      return;
    // A secret request saved, declined or timed out: nobody is asked now.
    case "secret.request.ended":
      resolve((n) => n.category === "waiting" && same(n) && n.key === secretRequestKey(e.box, d.id));
      return;
    case "worktree.removed":
    case "worktree.setup.finished":
      resolve((n) => (n.category === "setupFailed" || (e.type === "worktree.removed" && n.category !== "notify")) && same(n) && (path ? n.path === path : n.project === d.location && n.worktree === d.name));
      return;
  }
}

export const serviceKey = (box?: string, location?: unknown, worktree?: unknown, service?: unknown) => `serviceFailed|${box}|${location}|${worktree}|${service}`;
export const secretKey = (box?: string, location?: unknown, variable?: unknown) => `secret|${box}|${location ?? ""}|${variable}`;
export const flowKey = (box?: string, flow?: unknown, scope?: unknown) => `flowFailed|${box}|${scope ?? ""}|${flow}`;
export const secretRequestKey = (box?: string, id?: unknown) => `waiting|${box}|secret|${id}`;

// A waiting note also clears when the box reports its agent working again,
// in case the event was missed.
useStore.subscribe((s, prev) => {
  if (s.boxes === prev.boxes) return;
  const open = useNotifications.getState().notes.filter((n) => n.category === "waiting" && !n.resolved && n.box && n.session);
  if (!open.length) return;
  resolve((n) => {
    if (!open.includes(n)) return false;
    const sessions = s.boxes[n.box!]?.sessions;
    if (!sessions) return false;
    const live = sessions.find((x) => x.name === n.session);
    if (!live || live.exited) return true;
    return live.agent_state !== "waiting" && !!live.state_since && live.state_since > n.time;
  });
});

// ---- Persistence -------------------------------------------------------

interface Doc {
  version: 1;
  notes: Note[];
}

let saveTimer = 0;
function persist() {
  if (!useNotifications.getState().loaded) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const client = useStore.getState().client;
    if (!client) return;
    const doc: Doc = { version: 1, notes: useNotifications.getState().notes.slice(0, MAX) };
    client.laptop("PUT", DOC, doc).then(
      () => useNotifications.setState({ error: undefined }),
      (err) => useNotifications.setState({ error: plainError(err) }),
    );
  }, 800);
}

// loadNotifications reads the history from the laptop agent, keeping
// anything that arrived before it answered.
export async function loadNotifications() {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    const doc = await client.laptop<Doc | null>("GET", DOC);
    const stored = Array.isArray(doc?.notes) ? doc.notes.filter((n) => n && n.id && n.title) : [];
    useNotifications.setState((s) => {
      const fresh = s.notes.filter((n) => !stored.some((x) => x.id === n.id || (x.key === n.key && !x.resolved)));
      return { notes: [...fresh, ...stored].sort((a, b) => b.time.localeCompare(a.time)).slice(0, MAX), loaded: true, error: undefined };
    });
  } catch (err) {
    useNotifications.setState({ loaded: true, error: plainError(err) });
  }
}

// ---- Delivery ----------------------------------------------------------

let permitted: boolean | undefined;

export async function systemNotification(title: string, body?: string) {
  // The live demo never asks a visitor's browser for notifications.
  if (__BERTH_DEMO__) return;
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      if (permitted === undefined) {
        permitted = (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
      }
      if (permitted) n.sendNotification({ title, body });
      return;
    }
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  } catch {
    // The centre has it.
  }
}

// chime is a short, soft two-note sound, at most every few seconds.
let lastChime = 0;
let audio: AudioContext | undefined;
export function chime() {
  const now = Date.now();
  if (now - lastChime < 3000) return;
  lastChime = now;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.06, t + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.35);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.4);
    }
  } catch {
    // No sound is fine.
  }
}
