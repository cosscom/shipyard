import type { BerthEvent, BerthPluginContext } from "@berth/plugin";

import { closeAnswers, closeKind, closeText, hasUnsaved, howItEnded, screenFoot, UNSAVED_CHECK, type BoxAnswer, type BoxRead, type Choice, choicesOnScreen, denyChoice, type GateLike, type GoneSession, type Item, type Known, lastMessage, type Marks, NO_MARKS, openForm, type OpenForm, permissionChoices, type SecretLike, type SessionLike, trackGone, type TranscriptItem } from "./model.ts";

// What's on the boxes, and what you did about it. It runs from the plugin's
// activation, not from a screen, so the sidebar's count is right before you open
// the Inbox. Marks stay on this computer until boxes can hold them.

export interface Detail {
  loading?: boolean;
  form?: OpenForm;
  message?: string;
  choices?: Choice[];
  // The foot of the agent's screen, when it waits on something with no form or
  // options to read, such as a trust prompt.
  screen?: string;
  // How its last turn ended, when it stopped rather than asked.
  ended?: string;
  error?: string;
}

export interface Pending {
  item: Item;
  until: number;
}

export interface InboxState {
  reads: Record<string, BoxRead>;
  loaded: boolean;
  marks: Marks;
  details: Record<string, Detail>;
  undo?: Pending;
  now: number;
}

let state: InboxState = { reads: {}, loaded: false, marks: NO_MARKS, details: {}, now: Date.now() };
const listeners = new Set<() => void>();

const set = (patch: Partial<InboxState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

export const getState = () => state;
export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

let berth: BerthPluginContext;
// Sessions stopped on purpose, and when: a read already on its way can still list
// one, so the name stays long enough not to look like a crash on the next read.
const stopped: Record<string, Map<string, number>> = {};
const STOPPED_MS = 2 * 60_000;
const noteStopped = (box: string, name: string) => (stopped[box] ??= new Map()).set(name, Date.now());
const recentlyStopped = (box: string) => new Set([...(stopped[box] ?? new Map<string, number>())].filter(([, at]) => Date.now() - at < STOPPED_MS).map(([n]) => n));
const known: Record<string, Record<string, Known>> = {};
const gone: Record<string, GoneSession[]> = {};
const timers = new Map<string, number>();
const reading = new Map<string, number>();

const saveMarks = () => berth.storage.set("marks", state.marks);
const saveTracked = () => {
  berth.storage.set("known", known);
  berth.storage.set("gone", gone);
};

const mark = (kind: keyof Marks, key: string, value: number | undefined) => {
  const next = { ...state.marks[kind] };
  if (value === undefined) delete next[key];
  else next[key] = value;
  set({ marks: { ...state.marks, [kind]: next } });
  saveMarks();
};

const WEEK_MS = 7 * 24 * 3_600_000;

// Old marks are for asks that are long over.
const pruned = (marks: Marks, now: number): Marks => {
  const keep = (m: Record<string, number>, ms: number) => Object.fromEntries(Object.entries(m).filter(([, t]) => t + ms > now));
  return { snoozed: keep(marks.snoozed, WEEK_MS), resolved: keep(marks.resolved, 2 * WEEK_MS), sent: keep(marks.sent, WEEK_MS) };
};

async function optional<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch {
    return fallback;
  }
}

async function readBox(box: string) {
  const turn = (reading.get(box) ?? 0) + 1;
  reading.set(box, turn);
  const sessions = (await berth.api.sessions(box)) as unknown as SessionLike[];
  const [gates, secrets] = await Promise.all([
    optional(berth.orchestrate.runs.list(box, { status: "waiting_gate" }) as unknown as Promise<GateLike[]>, []),
    optional(berth.api.request<SecretLike[]>(box, "GET", "secrets/requests"), []),
  ]);
  // Only a box's latest read lands: an older one answering late is dropped.
  if (reading.get(box) !== turn) return;
  const now = new Date().toISOString();
  const track = trackGone(known[box] ?? {}, sessions, recentlyStopped(box), now);
  known[box] = track.known;
  if (track.gone.length) gone[box] = [...(gone[box] ?? []), ...track.gone];
  saveTracked();
  set({ reads: { ...state.reads, [box]: { sessions, gates: gates ?? [], secrets: secrets ?? [], gone: gone[box] ?? [] } }, now: Date.now(), loaded: true });
}

async function readAll() {
  const boxes = await berth.api.boxes();
  const online = boxes.filter((b) => b.state === "online").map((b) => b.name);
  await Promise.all(online.map((b) => readBox(b).catch(() => {})));
  // An offline box's sessions can't be answered: they leave until it's back.
  const reads = Object.fromEntries(Object.entries(state.reads).filter(([b]) => online.includes(b)));
  set({ reads, now: Date.now(), loaded: true });
}

const soon = (box: string) => {
  window.clearTimeout(timers.get(box));
  timers.set(box, window.setTimeout(() => void readBox(box).catch(() => {}), 500));
};

export function startFeed(ctx: BerthPluginContext): () => void {
  berth = ctx;
  const now = Date.now();
  set({ marks: pruned({ ...NO_MARKS, ...berth.storage.get<Marks>("marks", NO_MARKS) }, now) });
  Object.assign(known, berth.storage.get<Record<string, Record<string, Known>>>("known", {}));
  Object.assign(gone, berth.storage.get<Record<string, GoneSession[]>>("gone", {}));
  const onEvent = (e: BerthEvent) => {
    if (!e.box) return;
    if (e.type === "session.stopped" && typeof e.data?.name === "string") noteStopped(e.box, e.data.name);
    soon(e.box);
  };
  const offs = ["agent.*", "session.*", "run.*", "secret.*", "box.*"].map((t) => berth.on(t, onEvent));
  void readAll();
  const every = window.setInterval(() => {
    set({ now: Date.now() });
    if (!document.hidden) void readAll();
  }, 30_000);
  return () => {
    window.clearInterval(every);
    for (const off of offs) off();
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  };
}

const transcriptPath = (s: string) => `sessions/${encodeURIComponent(s)}/transcript`;

export const readTranscript = async (box: string, session: string) => (await berth.api.request<{ items?: TranscriptItem[] }>(box, "GET", transcriptPath(session))).items ?? [];

async function readAsk(box: string, s: SessionLike): Promise<{ choices: Choice[]; screen?: string }> {
  if (s.ask?.choices?.length) return { choices: permissionChoices(s.ask.choices) };
  const r = await berth.api.request<{ screen?: string }>(box, "GET", `sessions/${encodeURIComponent(s.name)}/screen`);
  const screen = r.screen ?? "";
  const choices = permissionChoices(choicesOnScreen(screen));
  return { choices, screen: choices.length ? undefined : screenFoot(screen) };
}

// A card's form, last message and options. The agent's record can trail its
// waiting state by a moment, so a read that finds nothing tries a few times.
export async function loadDetail(item: Item, tries = 0): Promise<void> {
  if (!item.session || (item.kind !== "wait" && item.kind !== "marked" && item.kind !== "exited")) return;
  if (tries === 0 && state.details[item.key]?.form) return;
  if (tries === 0) set({ details: { ...state.details, [item.key]: { ...state.details[item.key], loading: !state.details[item.key] } } });
  try {
    const items = await readTranscript(item.box, item.session);
    const form = item.kind === "wait" ? openForm(items) : undefined;
    const s = item.source as SessionLike;
    const ask = item.kind === "wait" && !form && !s.soft_wait ? await optional(readAsk(item.box, s), { choices: [] as Choice[] }) : { choices: [] as Choice[] };
    const choices = ask.choices;
    set({ details: { ...state.details, [item.key]: { form, message: lastMessage(items), choices, ended: howItEnded(items), screen: "screen" in ask ? ask.screen : undefined } } });
    if (item.kind === "wait" && !form && !choices.length && !s.soft_wait && tries < 3) window.setTimeout(() => void loadDetail(item, tries + 1), 800 * 2 ** tries);
  } catch (err) {
    set({ details: { ...state.details, [item.key]: { error: errText(err) } } });
  }
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- Doing things ---

// Takes the card off at once. The box says so a moment later, and an answer that
// never takes effect brings the card back.
const noteSent = (item: Item) => {
  mark("sent", item.key, Date.now());
  soon(item.box);
};

export async function answerForm(item: Item, tool: string, answers: BoxAnswer[]) {
  await berth.api.request(item.box, "POST", `sessions/${encodeURIComponent(item.session!)}/answer`, { tool, answers });
  noteSent(item);
}

// Pressing a permission's key has to be forced, so first check that it's still
// this wait the key would go to.
export async function pressKey(item: Item, key: string) {
  const sessions = (await berth.api.sessions(item.box)) as unknown as SessionLike[];
  const now = sessions.find((s) => s.name === item.session);
  const was = item.source as SessionLike;
  if (!now || now.agent_state !== "waiting" || now.turn !== was.turn) throw new Error("It has moved on: this question isn't open any more.");
  await berth.orchestrate.send(item.box, item.session!, key, { enter: false, when: "now", force: true });
  noteSent(item);
}

// Words to an agent: at once if it's idle, and held if it's at a real prompt.
export async function reply(item: Item, text: string) {
  await berth.orchestrate.send(item.box, item.session!, text, { when: "idle" });
  noteSent(item);
}

export async function decideGate(item: Item, approve: boolean, note?: string) {
  const g = item.source as GateLike;
  await berth.orchestrate.runs.decide(item.box, g.id, { approve, note: note || undefined, step: g.gate?.path });
  noteSent(item);
}

export const snooze = (item: Item, until: number) => mark("snoozed", item.key, until);

const UNDO_MS = 5_000;
let undoTimer = 0;

async function stopSession(item: Item) {
  noteStopped(item.box, item.session!);
  await berth.api.request(item.box, "DELETE", `sessions/${encodeURIComponent(item.session!)}`);
  mark("resolved", item.key, Date.now());
  soon(item.box);
}

// Nothing to lose: it stops at once and costs no tokens. With unsaved work the
// agent saves what's worth keeping and closes itself. If the check can't run, it
// counts as unsaved, because stopping is the one you can't take back.
async function unsaved(item: Item): Promise<boolean> {
  const s = item.source as SessionLike;
  if (!s.location) return true;
  try {
    const r = await berth.orchestrate.exec(item.box, s.location, UNSAVED_CHECK, "30s");
    return r.exit_code !== 0 || hasUnsaved(r.output);
  } catch {
    return true;
  }
}

async function closeItem(item: Item, note: string | undefined, detail: Detail | undefined) {
  if (closeKind(item.kind) === "dismiss") return mark("resolved", item.key, Date.now());
  if (item.kind === "exited" || !(await unsaved(item))) return stopSession(item);
  if (detail?.screen !== undefined) throw new Error("It has unsaved work and is on a screen of its own, so it can't be told to save. Open the session to close it.");
  const told = `"${item.title}" has unsaved work, so it's saving and closing itself.`;
  if (detail?.form) await answerForm(item, detail.form.tool, closeAnswers(detail.form.questions, note));
  else {
    const deny = detail?.choices && denyChoice(detail.choices);
    if (deny) {
      await pressKey(item, deny.key);
      await berth.orchestrate.send(item.box, item.session!, closeText(note), { when: "idle" });
    } else await reply(item, closeText(note));
  }
  berth.notify("Inbox", told);
}

// A few seconds to change your mind, then it goes. Hidden meanwhile; closing the
// app in that time does nothing, so the card just comes back.
export function closeSession(item: Item, note: string | undefined) {
  flushUndo();
  const detail = state.details[item.key];
  mark("sent", item.key, Date.now());
  set({ undo: { item, until: Date.now() + UNDO_MS } });
  pendingSend = () => {
    closeItem(item, note, detail).catch((err) => {
      mark("sent", item.key, undefined);
      berth.notify("Couldn't close it", `${item.title}: ${errText(err)}`);
    });
  };
  undoTimer = window.setTimeout(flushUndo, UNDO_MS);
}

let pendingSend: (() => void) | undefined;

function flushUndo() {
  window.clearTimeout(undoTimer);
  const send = pendingSend;
  pendingSend = undefined;
  if (state.undo) set({ undo: undefined });
  send?.();
}

export function undoClose() {
  const u = state.undo;
  window.clearTimeout(undoTimer);
  pendingSend = undefined;
  if (u) mark("sent", u.item.key, undefined);
  set({ undo: undefined });
}

// Carries a conversation on, in its session or a new one. Only a box's chat
// sessions keep a record to resume from.
export async function resume(item: Item) {
  const list = await berth.api.request<{ id: string; session?: string }[]>(item.box, "GET", "conversations");
  const c = list.find((x) => x.session === item.session);
  if (!c) throw new Error("This box has no conversation record for it, so it can't resume from here. Open the worktree and run the agent's own resume.");
  await berth.api.request(item.box, "POST", `conversations/${encodeURIComponent(c.id)}/resume`, {});
  mark("resolved", item.key, Date.now());
  soon(item.box);
}

export const openSession = (item: Item) => {
  if (item.session) berth.openTerminal(item.box, item.session);
};
