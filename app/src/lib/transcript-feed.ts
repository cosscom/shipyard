import { useEffect, useRef, useState } from "react";

import { boxApi, type Client, type QueuedPrompt } from "@/lib/api";
import type { ChatSignals } from "@/lib/chat-controls";
import { noteSignals } from "@/lib/chat-signals";
import { keyOf, offOf, useConversations } from "@/lib/conversation-store";
import { dropOlder, historyApi } from "@/lib/history";
import { useEventLog } from "@/lib/events";
import { choicesIn, type Choice, keysOnly, questionFormIn } from "@/lib/screen";
import { useStore } from "@/lib/store";
import { useTranscriptPings } from "@/lib/transcript-pings";
import type { Artifact, CrewMember, TranscriptItem } from "@/lib/transcript";

// The conversation of a session on a box that streams transcripts (its
// info lists "transcript"): GET sessions/{name}/transcript?since=N returns
// the items from index N, the index to ask from next, and the crew. A tool
// group still open is sent again, so items merge by id. It is read while a
// conversation is showing: on open, every 2s, and at once when an event
// about the session arrives, or the box says the agent wrote to it
// (transcript.changed, newer boxes: within a few hundred milliseconds of a
// step); never while hidden.

export interface TranscriptResult {
  source: "claude" | "codex" | "none";
  items: TranscriptItem[];
  next: number;
  crew: CrewMember[];
  truncated?: boolean;
  // When the agent last wrote to its record (ms).
  last?: number;
  // The pages it published on claude.ai, newest last (newer boxes only).
  artifacts?: Artifact[];
  // The reading `next` counts in (newer boxes): asked with ?gen=, a box
  // that read the record afresh since answers reset, with the whole window
  // from start (the offset of its first item); file names the record.
  gen?: string;
  reset?: boolean;
  start?: number;
  file?: string;
  // The agent's mode, model, context and tasks, for the chat's controls
  // (lib/chat-signals).
  signals?: ChatSignals;
}

// The record each chat shows (newer boxes), kept while the app runs: a
// chat opened again on another record (after /clear) starts afresh.
const fileOf = new Map<string, string>();

// The most pages read to fill what a chat missed while it wasn't looking.
const MAX_GAP_PAGES = 10;

// fillGap reads what the record has between the last item a chat held
// before a window read afresh and that window's start, so the chat goes
// on without a hole.
async function fillGap(client: Client, box: string, session: string, key: string, start: number) {
  const held = (useConversations.getState().items[key] ?? []).filter((it) => offOf(it) < start);
  if (!held.length) return;
  const last = offOf(held[held.length - 1]);
  let before = start;
  for (let i = 0; i < MAX_GAP_PAGES; i++) {
    const page = await historyApi.older(client, box, session, before);
    const items = (page.items ?? []).filter((it) => offOf(it) > last && offOf(it) < start);
    if (items.length) useConversations.getState().fill(key, items);
    if (!page.more || !page.items?.length || items.length < page.items.length) return;
    before = offOf(page.items[0]);
  }
}

export type FeedState = "loading" | "ready" | "none" | "unsupported" | "error";

export const hasTranscripts = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("transcript");

// How long the first read of a chat may take before the chat says the box
// didn't answer (it offers Retry, and keeps reading behind it), and how long
// any later read may take before it is given up and tried again.
export const FIRST_READ_TIMEOUT = 8_000;
const READ_TIMEOUT = 30_000;

// attempt, when it changes, reads again from where it was (a Retry).
//
// One loop reads a chat while it shows: on open, every 2s, and at once when
// an event about the session arrives. An event never starts the loop over:
// an agent at work sends one with every tool call, and starting over threw
// away the answer on its way, so a box slower to answer than the agent's
// calls came never showed its first answer ("Reading the conversation…" for
// as long as the agent worked). An event during a read reads again once it
// is in. Every read has a time limit, so one the box never answers can't
// hold the chat either.
export function useTranscriptFeed(box: string, session: string, dir: string | undefined, enabled: boolean, attempt = 0): FeedState {
  const client = useStore((s) => s.client);
  const supported = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("transcript"));
  const pinged = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("draft"));
  // Until the box has said what it can do (just after the app starts or
  // reconnects), it is not "too old": it is still loading.
  const known = useStore((s) => !!s.boxes[box]?.info);
  const [state, setState] = useState<FeedState>(supported || !known ? "loading" : "unsupported");
  const next = useRef(0);
  // The reading next counts in (newer boxes).
  const gen = useRef<string | undefined>(undefined);
  // Reads now, from the loop that is running (a no-op while none is).
  const kick = useRef<() => void>(() => {});
  const key = keyOf(box, session);
  // The last event about this session: agent.* and session.* carry its
  // name or its directory.
  const latest = useEventLog((s) => s.events.find((e) => e.box === box && (e.type.startsWith("agent.") || e.type.startsWith("session.")) && (e.data?.session === session || e.data?.name === session || (!!dir && e.data?.path === dir)))?.time);
  const wrote = useTranscriptPings((s) => s.at[`${box}|${session}`]);

  // A different session starts from the beginning, and is read before it
  // shows anything (not the last session's state).
  useEffect(() => {
    next.current = 0;
    gen.current = undefined;
    setState((s) => (s === "unsupported" ? s : "loading"));
  }, [key]);

  useEffect(() => {
    if (!supported) {
      setState(known ? "unsupported" : "loading");
      return;
    }
    if (!client || !enabled) return;
    // A retry reads afresh rather than standing on the last failure.
    setState((s) => (s === "error" ? "loading" : s));
    let alive = true;
    let busy = false;
    // An event came while a read was out: read again once it is in.
    let again = false;
    let shown = false;
    let failures = 0;
    let inflight: AbortController | undefined;
    const read = async () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      if (document.hidden) return;
      busy = true;
      again = false;
      const ctl = new AbortController();
      inflight = ctl;
      const limit = shown || failures > 0 ? READ_TIMEOUT : FIRST_READ_TIMEOUT;
      const timer = window.setTimeout(() => ctl.abort(), limit);
      try {
        const since = next.current;
        const g = since && gen.current ? `&gen=${encodeURIComponent(gen.current)}` : "";
        const r = await client.box<TranscriptResult>(box, "GET", `sessions/${encodeURIComponent(session)}/transcript?since=${since}${g}`, undefined, ctl.signal);
        if (!alive) return;
        failures = 0;
        noteSignals(key, r.signals);
        if (r.source === "none") {
          setState("none");
          return;
        }
        if (r.gen !== undefined) {
          // A whole window: the first read, or one the box read afresh (it
          // restarted, let the conversation go while no one looked, or the
          // agent rewound). It is named as before, so the chat keeps what
          // it holds from before the window and takes the rest from it,
          // then reads what it missed in between. Another record is another
          // conversation (/clear): it starts afresh.
          if (since === 0 || r.reset) {
            const was = fileOf.get(key);
            const fresh = !!was && !!r.file && r.file !== was;
            if (fresh) dropOlder(key);
            useConversations.getState().resync(key, r.items ?? [], r.start ?? 0, fresh);
            if (!fresh) void fillGap(client, box, session, key, r.start ?? 0).catch(() => {});
          } else if (r.items?.length) useConversations.getState().merge(key, r.items);
          gen.current = r.gen;
          if (r.file) fileOf.set(key, r.file);
        } else if (typeof r.next === "number" && r.next < next.current) {
          // An older box. Fewer items than were read: it reads another file
          // for this session now (its own, once the agent writes one).
          // Start it afresh, so no other conversation's lines stay here.
          useConversations.setState((s) => ({ items: { ...s.items, [key]: [] } }));
          next.current = 0;
          again = true;
          return;
        } else if (r.items?.length) useConversations.getState().merge(key, r.items);
        useConversations.getState().setCrew(key, r.crew ?? []);
        if (r.last) useConversations.getState().setLast(key, r.last);
        useConversations.getState().setArtifacts(key, r.artifacts ?? []);
        next.current = r.next ?? next.current;
        shown = true;
        setState("ready");
      } catch (err) {
        if (!alive) return;
        failures++;
        // The session is gone: nothing more will come.
        if ((err as { status?: number } | null)?.status === 404) {
          stop();
          setState((s) => (s === "ready" ? s : "none"));
          return;
        }
        // Refused (401, 403), failed, or no answer in time: a chat with
        // nothing to show says so, with Retry; reading goes on behind it.
        setState((s) => (s === "ready" ? s : "error"));
      } finally {
        window.clearTimeout(timer);
        if (inflight === ctl) inflight = undefined;
        busy = false;
        if (alive && again) void read();
      }
    };
    kick.current = () => void read();
    void read();
    // An agent's record lands a moment after the event about it (its last
    // words after "finished"): look again soon rather than in 2s.
    const soon = [600, 1500].map((ms) => window.setTimeout(() => void read(), ms));
    // A box that says when a shown chat's transcript is written to
    // (transcript.changed, with "draft") is read at once on each, so the
    // look here is a backstop: every 4s, inside the 8s for which the box
    // keeps watching after a read (transcriptwatch.go). Others every 2s.
    const t = window.setInterval(() => void read(), pinged ? 4000 : 2000);
    const onVisible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    function stop() {
      alive = false;
      kick.current = () => {};
      inflight?.abort();
      window.clearInterval(t);
      for (const x of soon) window.clearTimeout(x);
      document.removeEventListener("visibilitychange", onVisible);
    }
    return stop;
  }, [client, box, session, key, supported, known, enabled, attempt, pinged]);

  // An event about the session, or a write to its transcript: read now, in
  // the loop that is running.
  useEffect(() => {
    if (latest || wrote) kick.current();
  }, [latest, wrote]);

  return state;
}

// useAsk is what an agent waiting for the person asks, from its screen: the
// numbered options, and the line above them as the question; form says it
// shows a form of questions with steps, which no one number answers. A
// menu is drawn a moment after the agent says it waits, so a screen
// without one is read again a few times.
export function useAsk(box: string, session: string, waiting: boolean, since?: string): { detail: string; choices: Choice[]; form?: boolean } | undefined {
  const client = useStore((s) => s.client);
  const [ask, setAsk] = useState<{ detail: string; choices: Choice[]; form?: boolean }>();
  useEffect(() => {
    if (!client || !waiting) {
      setAsk(undefined);
      return;
    }
    let alive = true;
    let tries = 0;
    let timer = 0;
    const read = () =>
      boxApi
      .screen(client, box, session)
      .then((r) => {
        if (!alive) return;
        const screen = r.screen ?? "";
        const choices = choicesIn(screen);
        const form = questionFormIn(screen);
        if (!choices.length && !form && ++tries < 4) timer = window.setTimeout(() => void read(), 600);
        const lines = screen.split("\n").map((l) => l.trim());
        const first = lines.findIndex((l) => /^(?:[❯›>]\s*)?1[.)]\s/.test(l));
        let detail = "";
        // A screen only keys answer (a trust question) asks nothing in
        // words: its own screen opens for it instead (live-screen.tsx).
        for (let i = keysOnly(screen) ? -1 : (first < 0 ? lines.length : first) - 1; i >= 0; i--) {
          const l = lines[i].replace(/^[│|╭╰─\s]+|[│|╮╯─\s]+$/g, "");
          if (l) {
            detail = l;
            break;
          }
        }
        setAsk({ detail, choices, form });
      })
      .catch(() => alive && setAsk({ detail: "", choices: [] }));
    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [client, box, session, waiting, since]);
  return ask;
}

export const hasQueue = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("queue");

// useQueued is what the box holds for a session until its agent is idle
// (boxes with the "queue" capability): read when the session's count
// changes or something is queued, sent or cancelled, never while hidden.
// refresh reads it again at once.
export function useQueued(box: string, session: string, count: number | undefined, enabled: boolean): { items: QueuedPrompt[]; refresh(): void } {
  const client = useStore((s) => s.client);
  const supported = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("queue"));
  const [items, setItems] = useState<QueuedPrompt[]>([]);
  const [tick, setTick] = useState(0);
  const latest = useEventLog((s) => s.events.find((e) => e.box === box && /^session\.(queued|unqueued|sent)$/.test(e.type) && e.data?.name === session)?.time);
  useEffect(() => {
    if (!client || !enabled || !supported || (!count && !tick)) {
      setItems([]);
      return;
    }
    let alive = true;
    boxApi
      .queue(client, box, session)
      .then((r) => alive && setItems(r))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [client, box, session, count, latest, enabled, supported, tick]);
  return { items, refresh: () => setTick((t) => t + 1) };
}
