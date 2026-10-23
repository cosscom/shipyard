import { useEffect, useRef, useState } from "react";

import { isMock } from "@/hooks/use-berth-connection";
import type { Session } from "@/lib/api";
import { mergeTail, openingPrompt } from "@/lib/chat-card";
import { offOf } from "@/lib/conversation-store";
import { historyApi, useHasHistory } from "@/lib/history";
import { useStore } from "@/lib/store";
import type { TranscriptItem } from "@/lib/transcript";
import type { TranscriptResult } from "@/lib/transcript-feed";
import { useCardRead } from "@/views/dashboard/use-screen-tail";

// How many of its newest items a card keeps: enough to reach back past
// the steps and markers to its last words.
const TAIL = 12;

// useChatTail is the newest few items of a chat-mode (structured) agent's
// conversation, for its board card. It reads the box's transcript the way
// a chat does (transcript?since=N, lib/transcript-feed): the recent window
// once, then only what was added since, which the box reads on from where
// it was rather than parsing the record again. It is read when a terminal
// card would read its screen, in its place (useCardRead).
export function useChatTail(box: string, session: Session, working: boolean, enabled: boolean): TranscriptItem[] | undefined {
  const supported = useStore((s) => isMock() || !!s.boxes[box]?.info?.capabilities?.includes("transcript"));
  const [items, setItems] = useState<TranscriptItem[]>();
  // Where the next read starts, in the reading gen counts in.
  const at = useRef<{ next: number; gen?: string }>({ next: 0 });
  useEffect(() => {
    at.current = { next: 0 };
    setItems(undefined);
  }, [box, session.name]);
  useCardRead(box, session, working, enabled && supported, async (client, alive) => {
    const { next, gen } = at.current;
    const g = next && gen ? `&gen=${encodeURIComponent(gen)}` : "";
    const r = await client.box<TranscriptResult>(box, "GET", `sessions/${encodeURIComponent(session.name)}/transcript?since=${next}${g}`);
    if (!alive()) return;
    if (r.source === "none") return setItems([]);
    // An older box reading another record now: start it afresh.
    if (r.gen === undefined && typeof r.next === "number" && r.next < next) {
      at.current = { next: 0 };
      return setItems([]);
    }
    // A whole window (the first read, or one the box read afresh) stands
    // alone; anything else is what was added since.
    const fresh = next === 0 || !!r.reset;
    if (r.file) recordOf.set(`${box}|${session.name}`, r.file);
    setItems((held) => mergeTail(fresh ? [] : (held ?? []), r.items ?? [], TAIL));
    at.current = { next: r.next ?? next, gen: r.gen };
  });
  return items;
}

// Where in its record a conversation's first prompt is looked for: before
// HEAD_BYTES, after the agent's opening frame (its tools and servers, tens
// of KB), HEAD_ITEMS at a time, back to the start in at most HEAD_PAGES.
const HEAD_BYTES = 256 << 10;
const HEAD_ITEMS = 50;
const HEAD_PAGES = 4;

// The record each session's card last read (newer boxes say), by box and
// session: a session that carries on another conversation reads another.
const recordOf = new Map<string, string>();

// The prompts conversations started with, by box and session, and the
// record each came from: one never changes for its record, so it is read
// once while the app runs, and again for another record.
const opening = new Map<string, { file?: string; prompt: string }>();

// useOpeningPrompt is the prompt a chat-mode session's conversation
// started with, or the command typed as one ("/ship ACME-12"): one read of
// the page at its record's start. Until there is one, it is read again as
// the session's state changes (since).
export function useOpeningPrompt(box: string, session: string, since: string | undefined, enabled: boolean): string | undefined {
  const client = useStore((s) => s.client);
  const supported = useHasHistory(box);
  const key = `${box}|${session}`;
  const [prompt, setPrompt] = useState(() => opening.get(key)?.prompt);

  useEffect(() => {
    if (!client || !enabled || !supported) return;
    const file = recordOf.get(key);
    const have = opening.get(key);
    // Read before its record was known, it is that record's.
    if (have && !have.file) have.file = file;
    if (have && have.file === file) return setPrompt(have.prompt);
    let alive = true;
    const head = async () => {
      let page = await historyApi.older(client, box, session, HEAD_BYTES, HEAD_ITEMS);
      // More items than one page before HEAD_BYTES: read back to the start.
      for (let i = 1; i < HEAD_PAGES && page.more && page.items?.length && offOf(page.items[0]) > 0 && alive; i++) page = await historyApi.older(client, box, session, offOf(page.items[0]), HEAD_ITEMS);
      return page;
    };
    head()
      .then((r) => {
        const p = openingPrompt(r.items, r.more) ?? "";
        if (p) opening.set(key, { file, prompt: p });
        if (alive) setPrompt(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, box, session, key, since, enabled, supported]);

  return prompt || undefined;
}
