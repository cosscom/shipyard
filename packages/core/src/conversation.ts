import type { TranscriptItem } from "./transcript.ts";

// How a chat's items change as the box sends more of an agent's record:
// the app's conversation store (app/src/lib/conversation-store.ts) and the
// phone app both keep their lists with these.

// Where an item's line starts in the agent's record (boxes send it as off;
// 0 is left out).
export const offOf = (it: TranscriptItem) => (it as { off?: number }).off ?? 0;

// mergeItems replaces items with the same id and appends the rest, as the
// box resends a tool group that was still open.
export function mergeItems(list: TranscriptItem[], incoming: TranscriptItem[]): TranscriptItem[] {
  const out = [...list];
  const at = new Map(out.map((it, i) => [it.id, i]));
  for (const it of incoming) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, out.length);
      out.push(it);
    } else out[i] = it;
  }
  return out;
}

// resyncItems takes a window the box read afresh: what the chat holds from
// before start stays, the rest is the window's, so nothing it showed goes.
// fresh: another conversation, nothing stays.
export function resyncItems(list: TranscriptItem[], window: TranscriptItem[], start: number, fresh?: boolean): TranscriptItem[] {
  const held = fresh ? [] : list.filter((it) => offOf(it) < start);
  const ids = new Set(window.map((it) => it.id));
  return [...held.filter((it) => !ids.has(it.id)), ...window];
}

// fillItems puts items read between what was held and a window into place,
// or returns undefined when they add nothing.
export function fillItems(list: TranscriptItem[], items: TranscriptItem[]): TranscriptItem[] | undefined {
  const have = new Set(list.map((it) => it.id));
  const add = items.filter((it) => !have.has(it.id));
  if (!add.length) return undefined;
  // In the record's order; a sort that keeps the order of equals.
  return [...list, ...add]
    .map((it, i) => [it, i] as const)
    .sort((a, b) => offOf(a[0]) - offOf(b[0]) || a[1] - b[1])
    .map(([it]) => it);
}
