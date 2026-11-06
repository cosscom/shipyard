// The Inbox's rules, pure so the screen and its tests share them: what becomes
// an item, which group it's in, the order, and exactly what each answer sends.

export type Group = "decision" | "action" | "review" | "blocked";

// How the list reads, top to bottom.
export const GROUPS: { id: Group; title: string }[] = [
  { id: "decision", title: "Needs my decision" },
  { id: "action", title: "Needs an action from me" },
  { id: "review", title: "Ready to review or merge" },
  { id: "blocked", title: "Blocked or crashed" },
];

// The walk-through unblocks first: one answer can free a whole session.
const WALK_ORDER: Group[] = ["decision", "action", "blocked", "review"];

// Rough seconds per item, for "7 left, about 9 min".
const ESTIMATE_S: Record<Group, number> = { decision: 60, action: 120, review: 120, blocked: 90 };

// A session as the Inbox reads it. Sub-states come from a box with turn check's
// sorting of Needs you; a box without them leaves agent_sub_state unset.
export interface SessionLike {
  name: string;
  location?: string;
  title?: string;
  agent?: string;
  agent_state?: string;
  agent_sub_state?: string;
  state_since?: string;
  created?: string;
  exited?: boolean;
  turn?: string;
  queued?: number;
  parked?: boolean;
  unfinished?: boolean;
  soft_wait?: boolean;
  driver?: string;
  ask?: { tool?: string; input?: string; why?: string; message?: string; choices?: Choice[] };
}

export interface Choice {
  key: string;
  label: string;
  title?: string;
}

export interface GateLike {
  id: string;
  title?: string;
  template?: string;
  session?: string;
  updated?: string;
  created?: string;
  gate?: { path: string; title: string; text?: string; approve_label?: string; reject_label?: string; pick?: boolean };
}

export interface SecretLike {
  id: string;
  name: string;
  reason?: string;
  session?: string;
  location?: string;
  created?: string;
}

export interface GoneSession {
  name: string;
  title?: string;
  location?: string;
  agent?: string;
  state?: string;
  gone_at: string;
}

export type ItemKind = "wait" | "gate" | "secret" | "exited" | "gone" | "marked";

export interface Item {
  // Stable for one ask: a session's next wait is a new item, so a snooze or a
  // resolve doesn't swallow it.
  key: string;
  kind: ItemKind;
  group: Group;
  box: string;
  session?: string;
  title: string;
  why?: string;
  location?: string;
  agent?: string;
  since?: string;
  source: SessionLike | GateLike | SecretLike | GoneSession;
}

export interface BoxRead {
  sessions: SessionLike[];
  gates?: GateLike[];
  secrets?: SecretLike[];
  gone?: GoneSession[];
}

// Marks at the start of a title are a plain convention agents can use, and the
// only signal some have today: a blocked agent's turn ends like any other.
const BLOCKED_MARK = "⛔";
const ASKING_MARK = "❓";
const MARKS = /^[\p{Extended_Pictographic}️‍\s→]+/u;

export const cleanTitle = (title: string | undefined, fallback: string) => (title ?? "").replace(MARKS, "").trim() || fallback;

const waitKey = (box: string, s: SessionLike) => `${box}/${s.name}/${s.turn ?? s.state_since ?? "wait"}`;

function fromSession(box: string, s: SessionLike): Item | undefined {
  const base = {
    box,
    session: s.name,
    location: s.location,
    agent: s.agent,
    since: s.state_since ?? s.created,
    source: s,
    title: cleanTitle(s.title, s.name),
  };
  const title = s.title ?? "";
  if (s.exited) return s.agent ? { ...base, kind: "exited", group: "blocked", key: `${box}/${s.name}/exited`, why: "The agent's program ended" } : undefined;
  if (s.parked || s.unfinished || (s.queued ?? 0) > 0) return undefined;
  if (s.agent_state === "waiting") {
    // A form's input is its question, which the card shows anyway.
    const what = s.ask?.input && s.ask.tool !== "AskUserQuestion" ? `${s.ask.tool ?? "A tool"}: ${s.ask.input}` : undefined;
    const why = s.ask?.message || s.ask?.why || what;
    return { ...base, kind: "wait", group: s.agent_sub_state === "act" ? "action" : "decision", key: waitKey(box, s), why };
  }
  if (s.agent_state === "running") return undefined;
  if (title.startsWith(BLOCKED_MARK)) return { ...base, kind: "marked", group: "blocked", key: waitKey(box, s), why: "It says it's blocked" };
  if (title.startsWith(ASKING_MARK)) return { ...base, kind: "marked", group: "decision", key: waitKey(box, s), why: "Its title says it's asking" };
  return undefined;
}

// Every open item a box's read makes.
export function itemsOf(box: string, read: BoxRead): Item[] {
  const items: Item[] = [];
  for (const s of read.sessions) {
    const it = fromSession(box, s);
    if (it) items.push(it);
  }
  for (const g of read.gates ?? [])
    if (g.gate)
      items.push({
        key: `${box}/run/${g.id}/${g.gate.path}`,
        kind: "gate",
        group: "decision",
        box,
        session: g.session,
        title: g.gate.title,
        why: g.gate.text,
        since: g.updated ?? g.created,
        source: g,
      });
  for (const r of read.secrets ?? [])
    items.push({
      key: `${box}/secret/${r.id}`,
      kind: "secret",
      group: "action",
      box,
      session: r.session,
      location: r.location,
      title: `Add the secret ${r.name}`,
      why: r.reason,
      since: r.created,
      source: r,
    });
  for (const g of read.gone ?? [])
    items.push({
      key: `${box}/${g.name}/gone/${g.gone_at}`,
      kind: "gone",
      group: "blocked",
      box,
      session: g.name,
      location: g.location,
      agent: g.agent,
      title: cleanTitle(g.title, g.name),
      why: `It ended while it was ${g.state ?? "working"}`,
      since: g.gone_at,
      source: g,
    });
  return items;
}

const age = (it: Item) => (it.since ? Date.parse(it.since) : 0) || 0;

// Oldest first in a group: what's been forgotten longest comes up first.
export const byAge = (a: Item, b: Item) => age(a) - age(b) || a.key.localeCompare(b.key);

export interface Marks {
  snoozed: Record<string, number>;
  resolved: Record<string, number>;
  // Answered from here, until the box agrees it moved on.
  sent: Record<string, number>;
}

export const NO_MARKS: Marks = { snoozed: {}, resolved: {}, sent: {} };

// An answer that hasn't taken effect after this long comes back, saying so.
export const SENT_GRACE_MS = 60_000;

// What's open now. A count is always the length of this list.
export function openItems(items: Item[], marks: Marks, now: number): Item[] {
  return items.filter((it) => {
    if (marks.resolved[it.key]) return false;
    if ((marks.snoozed[it.key] ?? 0) > now) return false;
    const sent = marks.sent[it.key];
    return !(sent && now - sent < SENT_GRACE_MS);
  });
}

export const didntLand = (it: Item, marks: Marks, now: number) => {
  const sent = marks.sent[it.key];
  return !!sent && now - sent >= SENT_GRACE_MS;
};

export const snoozedItems = (items: Item[], marks: Marks, now: number) => items.filter((it) => !marks.resolved[it.key] && (marks.snoozed[it.key] ?? 0) > now);

export const inList = (items: Item[]): { group: Group; title: string; items: Item[] }[] =>
  GROUPS.map((g) => ({ group: g.id, title: g.title, items: items.filter((i) => i.group === g.id).sort(byAge) }));

export const walkOrder = (items: Item[]): Item[] => WALK_ORDER.flatMap((g) => items.filter((i) => i.group === g).sort(byAge));

export function nextAfter(order: Item[], key: string | undefined, step = 1): Item | undefined {
  if (!order.length) return undefined;
  const at = order.findIndex((i) => i.key === key);
  if (at < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + step))];
}

// The item the screen should show: the current one stays while it's open, so a
// new arrival never takes over a card you're on.
export function holdCurrent(order: Item[], current: string | undefined, leaving?: Item[]): Item | undefined {
  const here = order.find((i) => i.key === current);
  if (here) return here;
  if (leaving && current) {
    const at = leaving.findIndex((i) => i.key === current);
    if (at >= 0) for (let i = at + 1; i < leaving.length; i++) {
      const next = order.find((o) => o.key === leaving[i].key);
      if (next) return next;
    }
  }
  return order[0];
}

export function estimate(items: Item[]): string {
  const s = items.reduce((n, i) => n + ESTIMATE_S[i.group], 0);
  const left = `${items.length} left`;
  if (!items.length) return left;
  return s < 90 ? `${left}, about 1 min` : `${left}, about ${Math.round(s / 60)} min`;
}

export function ago(since: string | undefined, now: number): string {
  const t = since ? Date.parse(since) : NaN;
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export const snoozeTimes = (now: number): { id: string; label: string; until: number }[] => {
  const d = new Date(now);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8).getTime();
  const nextWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((8 - d.getDay()) % 7 || 7), 8).getTime();
  return [
    { id: "hour", label: "In 1 hour", until: now + 3_600_000 },
    { id: "tomorrow", label: "Tomorrow", until: tomorrow },
    { id: "week", label: "Next week", until: nextWeek },
  ];
};

// --- Questions ---

export interface Option {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multi?: boolean;
  options: Option[];
}

export interface TranscriptItem {
  kind: string;
  id: string;
  tool?: string;
  done?: boolean;
  questions?: Question[];
  text?: string;
  verb?: string;
  items?: { verb?: string; target?: string }[];
  file?: string;
  command?: string;
  detail?: string;
  answers?: string[];
  notice?: string;
}

export type OpenForm = TranscriptItem & { tool: string; questions: Question[] };

export function openForm(items: TranscriptItem[]): OpenForm | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "question") return !it.done && it.tool && it.questions?.length ? (it as OpenForm) : undefined;
    if (it.kind === "user") return undefined;
  }
  return undefined;
}

export function lastMessage(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "text" && it.text?.trim()) return it.text.trim();
    if (it.kind === "user") return undefined;
  }
  return undefined;
}

// How its last turn ended, when that's the last thing in the record: a person
// has to know it stopped, whatever its title still says.
const ENDINGS: Record<string, string> = {
  interrupted: "It was interrupted, and waits for what to do instead.",
  exited: "The agent's program ended.",
  stop_failure: "Its turn ended on a failure.",
  api_error: "Its turn ended on an API error.",
  limit: "It hit a usage limit.",
  rate_limit: "It hit a rate limit.",
  auth: "It lost its sign-in.",
  billing: "It stopped on a billing problem.",
};

export function howItEnded(items: TranscriptItem[]): string | undefined {
  const last = items[items.length - 1];
  return last?.kind === "notice" ? (ENDINGS[last.notice ?? ""] ?? last.text) : undefined;
}

// The record as a chat reads it: runs of tool calls fold into one line, and
// everything else stays as it is.
export type PeekRow = { kind: "item"; item: TranscriptItem } | { kind: "work"; id: string; summary: string; items: TranscriptItem[] };

const WORK = new Set(["tools", "edit"]);

function workSummary(items: TranscriptItem[]): string {
  let ran = 0;
  let read = 0;
  let edited = 0;
  for (const it of items) {
    if (it.kind === "edit") edited++;
    else for (const t of it.items?.length ? it.items : [{ verb: it.verb }]) /^read/i.test(t.verb ?? "") ? read++ : ran++;
  }
  const n = (c: number, one: string, many: string) => (c ? `${c} ${c === 1 ? one : many}` : "");
  const parts = [ran && `ran ${n(ran, "command", "commands")}`, read && `read ${n(read, "file", "files")}`, edited && `edited ${n(edited, "file", "files")}`].filter(Boolean);
  return `Worked · ${parts.join(", ")}`;
}

export function peekRows(items: TranscriptItem[]): PeekRow[] {
  const rows: PeekRow[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (run.length) rows.push({ kind: "work", id: run[0].id, summary: workSummary(run), items: run });
    run = [];
  };
  for (const it of items) {
    if (WORK.has(it.kind)) run.push(it);
    else {
      flush();
      rows.push({ kind: "item", item: it });
    }
  }
  flush();
  return rows;
}

const RECOMMENDED = /\s*\(\s*recommended\s*\)\s*$/i;

export const isRecommended = (o: Option) => RECOMMENDED.test(o.label);
export const shownLabel = (o: Option) => o.label.replace(RECOMMENDED, "");

// A box takes one line in the person's own words. On the chat driver the answer
// comes back as "question"="answer" text with nothing escaped, so a straight
// double quote would cut the answer short there.
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().replace(/"/g, "”");

export interface Pick {
  picks: string[];
  note?: string;
}

export interface BoxAnswer {
  picks?: string[];
  other?: string;
}

// The box's answer for one question. A single choice takes one answer, a pick
// or the person's words and not both, so a pick with a note goes as words that
// name the pick: the agent reads both.
export function answerFor(q: Question, p: Pick): BoxAnswer {
  const note = oneLine(p.note ?? "");
  if (q.multi) return { picks: p.picks, ...(note ? { other: note } : {}) };
  const pick = p.picks[0];
  if (pick && note) return { other: `${oneLine(shownLabel({ label: pick }))}. ${note}` };
  if (pick) return { picks: [pick] };
  return { other: note };
}

export const complete = (p: Pick | undefined) => !!p && (p.picks.length > 0 || !!oneLine(p.note ?? ""));

// Closing a session with unsaved work: the agent saves what's worth keeping and
// closes itself. No double quotes: they'd be cut on the chat driver (see oneLine).
export const CLOSE_LINE = "This session is being closed from the Inbox. Commit and push anything worth keeping, then end by running: berthd session kill $BERTH_SESSION";

export const closeText = (note?: string) => {
  const n = oneLine(note ?? "");
  return n ? `${CLOSE_LINE} Note: ${n}` : CLOSE_LINE;
};

export const closeAnswers = (qs: Question[], note?: string): BoxAnswer[] => qs.map(() => ({ other: closeText(note) }));

// What the card's second button does. A session can be closed. A secret request or
// a session already gone can only leave the list. A run gate has its own Reject.
export const closeKind = (kind: ItemKind): "close" | "dismiss" | undefined => (kind === "gate" ? undefined : kind === "secret" || kind === "gone" ? "dismiss" : "close");

// Prints anything uncommitted, and commits on no remote. Empty means safe to stop.
// Outside a repository there's nothing to lose this way.
export const UNSAVED_CHECK = "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; git status --porcelain; git log --oneline -5 HEAD --not --remotes";

export const hasUnsaved = (output: string | undefined) => !!output?.trim();

// --- Permission prompts ---

// The numbered options on an agent's screen ("❯ 1. Yes / 2. No, and tell…").
export function choicesOnScreen(screen: string): Choice[] {
  const lines = screen.trimEnd().split("\n").slice(-16);
  const out: Choice[] = [];
  for (const l of lines) {
    const m = l.match(/^[\s│|]*[❯>›]?\s*(\d)\.\s+(.+?)[\s│|]*$/);
    if (m) out.push({ key: m[1], label: m[2] });
  }
  return out.filter((c, i) => out.findIndex((x) => x.key === c.key) === i);
}

export const screenFoot = (screen: string) => screen.split("\n").map((l) => l.trimEnd()).filter((l) => l && !/^[─━-]+$/.test(l.trim())).slice(-12).join("\n");

export function permissionChoices(choices: Choice[]): Choice[] {
  const always = choices.find((c) => /don.t ask again|always|allow all|this session/i.test(c.label));
  const allow = choices.find((c) => c !== always && /^(yes|allow|approve|proceed)\b/i.test(c.label));
  const deny = choices.find((c) => /^(no|deny|reject)\b/i.test(c.label));
  if (!allow || !deny) return choices;
  return [{ key: allow.key, label: "Allow", title: allow.label }, ...(always ? [{ key: always.key, label: "Always allow", title: always.label }] : []), { key: deny.key, label: "Deny", title: deny.label }];
}

export const denyChoice = (choices: Choice[]) => choices.find((c) => /^(no|deny|reject)\b/i.test(c.label) || /^(no|deny|reject)\b/i.test(c.title ?? ""));

// --- Sessions that vanish ---

export interface Known {
  name: string;
  title?: string;
  location?: string;
  agent?: string;
  state?: string;
}

// What a read of a box means for sessions we saw working: one that was running
// or waiting, is gone now and wasn't stopped on purpose ended unexpectedly.
export function trackGone(known: Record<string, Known>, sessions: SessionLike[], stopped: Set<string>, nowIso: string): { known: Record<string, Known>; gone: GoneSession[] } {
  const live = new Set(sessions.map((s) => s.name));
  const gone: GoneSession[] = [];
  for (const [name, k] of Object.entries(known)) if (!live.has(name) && !stopped.has(name)) gone.push({ ...k, name, gone_at: nowIso });
  const next: Record<string, Known> = {};
  for (const s of sessions)
    if (s.agent && !s.exited && (s.agent_state === "running" || s.agent_state === "waiting")) next[s.name] = { name: s.name, title: s.title, location: s.location, agent: s.agent, state: s.agent_state };
  return { known: next, gone };
}
