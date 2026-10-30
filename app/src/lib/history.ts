import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { create } from "zustand";

import { isMock } from "@/hooks/use-berth-connection";
import type { Client, Session } from "@/lib/api";
import { keyOf, offOf, onSpill, useConversations } from "@/lib/conversation-store";
import { useStore } from "@/lib/store";
import type { ToolDetail, TranscriptItem } from "@/lib/transcript";

// A conversation's history beyond what the chat follows live (boxes with
// the "history" capability): older turns read a page at a time as the
// person scrolls up, the helpers' own conversations, the prompts sent
// before (Up and Down in the reply box), and a fork or rewind from any
// prompt. Everything here is held only while its chat is open, and bounded.

// The fields the box adds to items for history: where an item's line starts
// in the agent's record (older pages are read before it), and a prompt's
// own entry and the one before it (where a fork picks up).
export type ItemMeta = { off?: number; uuid?: string; parent?: string; tool?: string };
export const meta = (it: TranscriptItem) => it as TranscriptItem & ItemMeta;

export const hasHistory = (box: string) => isMock() || !!useStore.getState().boxes[box]?.info?.capabilities?.includes("history");
export const useHasHistory = (box: string) => useStore((s) => isMock() || !!s.boxes[box]?.info?.capabilities?.includes("history"));

export interface TranscriptPage {
  source: string;
  items: TranscriptItem[];
  next: number;
  more?: boolean;
}

// Helper is one of a session's helpers (a subagent) with its own record.
export interface Helper {
  id: string;
  tool?: string;
  type?: string;
  name: string;
  prompt?: string;
  started: number;
  updated: number;
  depth?: number;
  background?: boolean;
  state: "running" | "finished";
}

const s = encodeURIComponent;

export const historyApi = {
  older: (c: Client, box: string, session: string, before: number, limit = PAGE) =>
    c.box<TranscriptPage>(box, "GET", `sessions/${s(session)}/transcript?before=${before}&limit=${limit}`),
  helpers: async (c: Client, box: string, session: string) => (await c.box<{ helpers: Helper[] | null }>(box, "GET", `sessions/${s(session)}/subagents`)).helpers ?? [],
  helperTranscript: (c: Client, box: string, session: string, id: string, since: number) =>
    c.box<TranscriptPage>(box, "GET", `sessions/${s(session)}/subagents/${s(id)}/transcript?since=${since}`),
  helperTool: (c: Client, box: string, session: string, id: string, tool: string) => c.box<ToolDetail>(box, "GET", `sessions/${s(session)}/subagents/${s(id)}/tool/${s(tool)}`),
  helperToolImage: (c: Client, box: string, session: string, id: string, tool: string, n: number) => c.boxBlob(box, `sessions/${s(session)}/subagents/${s(id)}/tool/${s(tool)}/image/${n}`),
  fork: (c: Client, box: string, session: string, req: { at?: string; text?: string; title?: string; open?: "tab" | "split" }) => c.box<Session>(box, "POST", `sessions/${s(session)}/fork`, req),
  rewind: (c: Client, box: string, session: string, req: { text: string; nth?: number; restore?: "conversation" | "both" | "code" }) =>
    c.box<{ restored: "conversation" | "both" | "code"; text: string }>(box, "POST", `sessions/${s(session)}/rewind`, req),
};

// ---- Older turns ----------------------------------------------------------

const PAGE = 200;
// The most older items a chat holds: past it, the oldest go and can be read
// again by scrolling up.
const MAX_OLDER = 6000;

export interface Older {
  items: TranscriptItem[];
  // Earlier ones remain on the box.
  more: boolean;
  loading: boolean;
  error?: string;
  // Where the chat had read back to before it was hidden and let its older
  // turns go: read back to again once it shows (restoreOlder).
  depth?: number;
}

interface HistoryState {
  older: Record<string, Older>;
  // A prompt rewound to (its uuid): it and what followed are hidden until
  // the agent's record catches up.
  cut: Record<string, string>;
  // A prompt handed to the reply box ("Edit and resend", a rewind).
  draft: Record<string, { text: string; at: number }>;
  // Prompts sent from here this session, newest first.
  sent: Record<string, string[]>;
}

export const useHistory = create<HistoryState>()(() => ({ older: {}, cut: {}, draft: {}, sent: {} }));

const NO_OLDER: Older = { items: [], more: true, loading: false };
export const useOlder = (key: string) => useHistory((st) => st.older[key]) ?? NO_OLDER;

const patchOlder = (key: string, p: Partial<Older>) => useHistory.setState((st) => ({ older: { ...st.older, [key]: { ...(st.older[key] ?? NO_OLDER), ...p } } }));

// loadOlder reads the page before the oldest item the chat holds.
export async function loadOlder(box: string, session: string, before: number): Promise<void> {
  const key = keyOf(box, session);
  const client = useStore.getState().client;
  const cur = useHistory.getState().older[key] ?? NO_OLDER;
  if (!client || cur.loading || !cur.more || before <= 0) return;
  patchOlder(key, { loading: true, error: undefined });
  try {
    const page = await historyApi.older(client, box, session, before);
    const now = useHistory.getState().older[key] ?? NO_OLDER;
    // The chat moved on (closed, or started afresh) while this was read.
    if (!now.loading) return;
    const have = new Set(now.items.map((it) => it.id));
    const fresh = (page.items ?? []).filter((it) => !have.has(it.id) && (meta(it).off ?? 0) < before);
    let items = [...fresh, ...now.items];
    let more = !!page.more && fresh.length > 0;
    if (items.length > MAX_OLDER) {
      items = items.slice(items.length - MAX_OLDER);
      more = true;
    }
    patchOlder(key, { items, more, loading: false });
  } catch (err) {
    patchOlder(key, { loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// dropOlder lets a closed chat's older turns go. A hidden one (keepDepth)
// remembers how far back it had read, to read back to when it shows.
export function dropOlder(key: string, keepDepth = false) {
  useHistory.setState((st) => {
    const cur = st.older[key];
    if (!cur) return st;
    const older = { ...st.older };
    const depth = cur.items.length ? offOf(cur.items[0]) : cur.depth;
    if (keepDepth && depth !== undefined) older[key] = { ...NO_OLDER, depth };
    else delete older[key];
    return { older };
  });
}

// restoreOlder reads a shown chat's older turns back to where it had read
// before it was hidden, a page at a time; it says whether it still reads.
export function restoreOlder(box: string, session: string, oldest: number | undefined): boolean {
  const key = keyOf(box, session);
  const cur = useHistory.getState().older[key];
  if (cur?.depth === undefined) return false;
  if (cur.error || !cur.more || oldest === undefined || oldest <= cur.depth) {
    patchOlder(key, { depth: undefined });
    return false;
  }
  if (!cur.loading) void loadOlder(box, session, oldest);
  return true;
}

// The live chat's oldest items, let go past what it keeps, join its older
// turns when it has read some, so nothing between them is missing.
onSpill((key, items) => {
  const cur = useHistory.getState().older[key];
  if (!cur) return;
  const have = new Set(cur.items.map((it) => it.id));
  let list = [...cur.items, ...items.filter((it) => !have.has(it.id))];
  let more = cur.more;
  if (list.length > MAX_OLDER) {
    list = list.slice(list.length - MAX_OLDER);
    more = true;
  }
  patchOlder(key, { items: list, more });
});

// ---- Prompts: recall, edit and resend --------------------------------------

const MAX_PROMPTS = 200;

// promptsOf is a chat's prompts, newest first, each once.
export function promptsOf(items: TranscriptItem[], sent: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const x = t.trim();
    if (!x || seen.has(x)) return;
    seen.add(x);
    out.push(x);
  };
  for (const t of sent) add(t);
  for (let i = items.length - 1; i >= 0 && out.length < MAX_PROMPTS; i--) {
    const it = items[i];
    if (it.kind === "user") add(it.text);
  }
  return out.slice(0, MAX_PROMPTS);
}

// noteSent remembers a prompt sent from here, before the agent's record
// has it.
export function noteSent(box: string, session: string, text: string) {
  const key = keyOf(box, session);
  useHistory.setState((st) => ({ sent: { ...st.sent, [key]: [text, ...(st.sent[key] ?? []).filter((t) => t !== text)].slice(0, 50) } }));
}

// putDraft hands a prompt to a chat's reply box.
export function putDraft(box: string, session: string, text: string) {
  const key = keyOf(box, session);
  useHistory.setState((st) => ({ draft: { ...st.draft, [key]: { text, at: Date.now() } } }));
}

// usePromptRecall is the terminal's history in a reply box: Up in an empty
// box (or on a recalled prompt) goes back through the prompts sent before,
// newest first; Down comes forward, and past the newest empties the box.
// Editing a recalled prompt keeps it, and Up then moves the caret as usual.
// It also takes a prompt handed over by putDraft. The handler returns true
// when it used the key.
export function usePromptRecall(box: string | undefined, session: string | undefined, value: string, setValue: (v: string) => void, input?: RefObject<HTMLTextAreaElement | null>) {
  const key = box && session ? keyOf(box, session) : "";
  const at = useRef(-1);
  const recalled = useRef("");
  const draft = useHistory((st) => (key ? st.draft[key] : undefined));
  useEffect(() => {
    at.current = -1;
  }, [key]);
  useEffect(() => {
    if (!draft || !key) return;
    setValue(draft.text);
    at.current = -1;
    useHistory.setState((st) => {
      const d = { ...st.draft };
      delete d[key];
      return { draft: d };
    });
    // The caret at the end, ready to edit.
    requestAnimationFrame(() => {
      const el = input?.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft, key, setValue, input]);

  return (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!key || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.nativeEvent.isComposing) return false;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
    const recalling = at.current >= 0 && value === recalled.current;
    if (value !== "" && !recalling) return false;
    const el = e.currentTarget;
    // In a recalled prompt of several lines, Up and Down move between its
    // lines until the caret is on its first or last.
    if (recalling && e.key === "ArrowUp" && el.value.lastIndexOf("\n", el.selectionStart - 1) >= 0) return false;
    if (recalling && e.key === "ArrowDown" && el.value.indexOf("\n", el.selectionEnd) >= 0) return false;
    const st = useHistory.getState();
    const prompts = promptsOf([...(st.older[key]?.items ?? []), ...(useConversations.getState().items[key] ?? [])], st.sent[key]);
    const next = e.key === "ArrowUp" ? at.current + 1 : at.current - 1;
    if (next >= prompts.length) return e.key === "ArrowUp" && recalling ? (e.preventDefault(), true) : false;
    e.preventDefault();
    if (next < 0) {
      at.current = -1;
      recalled.current = "";
      setValue("");
      return true;
    }
    at.current = next;
    recalled.current = prompts[next];
    setValue(prompts[next]);
    // The caret at its end, as the terminal leaves it.
    requestAnimationFrame(() => {
      const t = input?.current ?? el;
      t.setSelectionRange(t.value.length, t.value.length);
    });
    return true;
  };
}

// ---- Rewind ---------------------------------------------------------------

export function setCut(box: string, session: string, uuid: string | undefined) {
  const key = keyOf(box, session);
  useHistory.setState((st) => {
    const cut = { ...st.cut };
    if (uuid) cut[key] = uuid;
    else delete cut[key];
    return { cut };
  });
}

// applyCut hides a rewound prompt and the turns after it, keeping what the
// pane adds live (a prompt just sent, Thinking…).
export function applyCut(items: TranscriptItem[], uuid: string | undefined): TranscriptItem[] {
  if (!uuid) return items;
  const i = items.findIndex((it) => it.kind === "user" && meta(it).uuid === uuid);
  if (i < 0) return items;
  return [...items.slice(0, i), ...items.slice(i).filter((it) => it.id.startsWith("live:") || it.id.startsWith("sent:"))];
}

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__berthHistory = useHistory;
