import { create } from "zustand";

import { mergeItems, resyncItems } from "@berth/core/conversation.ts";
import { coalesce } from "@berth/core/net.ts";
import type { PairedBox } from "@berth/core/pairing.ts";
import { meaningfulTail } from "@berth/core/screen.ts";
import type { TranscriptItem } from "@berth/core/transcript.ts";

import { can, phone } from "./api";
import { follow, refreshFor, type Follow } from "./events";
import { DEMO_BOXES, isDemo } from "./mock";
import { loadBoxes, saveBoxes, toBox } from "./storage";
import type { Box, PhoneEvent, PhoneInfo, PhoneSession, Run } from "./types";

// What the app knows: the boxes this phone is paired with, and for each its
// sessions, runs and state; the conversations someone opened. A box at
// version 2 says what changes as it happens (lib/events); an older one is
// read every few seconds, as the web phone app does.

export interface BoxData {
  info?: PhoneInfo;
  sessions?: PhoneSession[];
  runs?: Run[];
  // Why the last read failed; cleared by the next that works.
  error?: string;
  // The stream is open (version 2 boxes).
  live?: boolean;
  // The last event seen, to catch up from.
  seq?: number;
  // The last few lines of each working or waiting agent's screen, for its
  // card, when its hooks didn't say what it asks.
  tails: Record<string, string[]>;
}

export interface Conversation {
  items: TranscriptItem[];
  next: number;
  gen?: string;
  record?: string;
  source?: string;
  reason?: string;
  error?: string;
}

interface State {
  ready: boolean;
  demo: boolean;
  boxes: Box[];
  data: Record<string, BoxData>;
  conversations: Record<string, Conversation>;
  // The session on screen ("<box name>/<session>"), whose notifications
  // aren't shown.
  showing?: string;

  load(): Promise<void>;
  pair(list: PairedBox[]): Promise<Box[]>;
  forget(id: string): Promise<void>;
  startDemo(): void;
  endDemo(): void;
  refresh(id: string, what?: { sessions?: boolean; runs?: boolean }): Promise<void>;
  refreshAll(): Promise<void>;
  readConversation(id: string, session: string): Promise<void>;
  setShowing(key: string | undefined): void;
}

export const convKey = (id: string, session: string) => `${id}/${session}`;

const blank = (): BoxData => ({ tails: {} });

export const useStore = create<State>()((set, get) => {
  const patch = (id: string, p: Partial<BoxData>) => set((s) => ({ data: { ...s.data, [id]: { ...(s.data[id] ?? blank()), ...p } } }));
  const boxOf = (id: string) => get().boxes.find((b) => b.id === id);

  return {
    ready: false,
    demo: false,
    boxes: [],
    data: {},
    conversations: {},

    async load() {
      const boxes = await loadBoxes();
      set({ boxes, ready: true });
    },

    async pair(list) {
      const fresh = list.map(toBox);
      const kept = get().demo ? [] : get().boxes.filter((b) => !fresh.some((f) => f.id === b.id));
      const boxes = [...kept, ...fresh];
      await saveBoxes(boxes, get().boxes);
      set({ boxes, demo: false, data: get().demo ? {} : get().data });
      return fresh;
    },

    async forget(id) {
      const before = get().boxes;
      const boxes = before.filter((b) => b.id !== id);
      if (!get().demo) await saveBoxes(boxes, before);
      const data = { ...get().data };
      delete data[id];
      set({ boxes, data });
    },

    startDemo() {
      set({ demo: true, boxes: DEMO_BOXES, data: {}, conversations: {} });
    },

    endDemo() {
      set({ demo: false, boxes: [], data: {}, conversations: {} });
      void get().load();
    },

    async refresh(id, what = { sessions: true, runs: true }) {
      const box = boxOf(id);
      if (!box) return;
      try {
        let info = get().data[id]?.info;
        if (!info) {
          info = await phone.info(box);
          patch(id, { info });
        }
        const [sessions, runs] = await Promise.all([
          what.sessions ? phone.sessions(box) : Promise.resolve(get().data[id]?.sessions),
          // An older box has no runs, which is not an error.
          what.runs ? phone.runs(box).catch(() => [] as Run[]) : Promise.resolve(get().data[id]?.runs),
        ]);
        patch(id, { sessions, runs, error: undefined });
        if (what.sessions && sessions) await readTails(box, sessions, (tails) => patch(id, { tails }));
      } catch (err) {
        patch(id, { error: (err as Error).message });
      }
    },

    async refreshAll() {
      await Promise.all(get().boxes.map((b) => get().refresh(b.id)));
    },

    async readConversation(id, session) {
      const box = boxOf(id);
      if (!box) return;
      const key = convKey(id, session);
      const held = get().conversations[key];
      try {
        const res = await phone.transcript(box, session, held?.next ?? 0, held?.gen);
        // Another conversation in the same session (/clear): start over.
        const fresh = !held || (!!held.record && !!res.record && held.record !== res.record);
        const before = fresh ? [] : held.items;
        const items = res.reset ? resyncItems(before, res.items, res.start ?? 0, fresh) : mergeItems(before, res.items);
        set((s) => ({
          conversations: {
            ...s.conversations,
            [key]: { items: items.slice(-300), next: res.next, gen: res.gen, record: res.record, source: res.source, reason: res.reason },
          },
        }));
      } catch (err) {
        set((s) => ({ conversations: { ...s.conversations, [key]: { ...(held ?? { items: [], next: 0 }), error: (err as Error).message } } }));
      }
    },

    setShowing(key) {
      set({ showing: key });
    },
  };
});

// readTails reads the screens of agents at work or waiting whose hooks
// didn't say what they ask, a dozen at most, for their cards.
async function readTails(box: Box, sessions: PhoneSession[], done: (tails: Record<string, string[]>) => void) {
  const want = sessions.filter((s) => s.agent && !s.exited && s.agent_state !== "idle" && !s.ask).slice(0, 12);
  const tails: Record<string, string[]> = {};
  await Promise.all(
    want.map(async (s) => {
      try {
        tails[s.name] = meaningfulTail((await phone.screen(box, s.name)).screen, 3);
      } catch {
        // A card without its lines is fine.
      }
    }),
  );
  done(tails);
}

// startFeeds keeps every box current while the app is open: a stream for
// boxes that offer one, reading every four seconds for the rest. It returns
// the function that stops them all.
export function startFeeds(): () => void {
  const streams = new Map<string, Follow>();
  const polls = new Map<string, ReturnType<typeof setInterval>>();
  // Read each box's list once at a time, however many events ask.
  const readers = new Map<string, Record<"sessions" | "runs", () => Promise<void>>>();
  const reader = (id: string) => {
    let r = readers.get(id);
    if (!r) {
      r = {
        sessions: coalesce(() => useStore.getState().refresh(id, { sessions: true })),
        runs: coalesce(() => useStore.getState().refresh(id, { runs: true })),
      };
      readers.set(id, r);
    }
    return r;
  };

  const onEvent = (id: string) => (e: PhoneEvent) => {
    const st = useStore.getState();
    useStore.setState((s) => ({ data: { ...s.data, [id]: { ...(s.data[id] ?? blank()), seq: e.seq } } }));
    const r = refreshFor(e);
    if (r.sessions) void reader(id).sessions();
    if (r.runs) void reader(id).runs();
    if (r.session && st.conversations[convKey(id, r.session)]) void st.readConversation(id, r.session);
  };

  const sync = async () => {
    const { boxes } = useStore.getState();
    for (const [id, f] of streams) if (!boxes.some((b) => b.id === id)) (f.stop(), streams.delete(id));
    for (const [id, t] of polls) if (!boxes.some((b) => b.id === id)) (clearInterval(t), polls.delete(id));
    for (const box of boxes) {
      if (streams.has(box.id) || polls.has(box.id)) continue;
      await useStore.getState().refresh(box.id);
      const info = useStore.getState().data[box.id]?.info;
      if (!isDemo(box) && can(info, "events")) {
        streams.set(
          box.id,
          follow(box, {
            since: () => useStore.getState().data[box.id]?.seq,
            onEvent: onEvent(box.id),
            onState: (live, error) => {
              useStore.setState((s) => ({ data: { ...s.data, [box.id]: { ...(s.data[box.id] ?? blank()), live, ...(error && !live ? { error } : {}) } } }));
              // Connected again: read what was missed.
              if (live) void useStore.getState().refresh(box.id);
            },
          }),
        );
      } else {
        polls.set(box.id, setInterval(() => void useStore.getState().refresh(box.id), 4000));
      }
    }
  };

  void sync();
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.boxes !== prev.boxes) void sync();
  });
  return () => {
    unsubscribe();
    for (const f of streams.values()) f.stop();
    for (const t of polls.values()) clearInterval(t);
  };
}
