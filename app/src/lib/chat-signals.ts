import { create } from "zustand";

import type { ChatSignals } from "@/lib/chat-controls";

// A chat's signals (its mode, model, context, task list, background work)
// come with every read of its transcript (internal/transcript/signals.go),
// so the transcript feed (lib/transcript-feed) keeps the latest here, by
// chat (keyOf), for the chat's controls: one read of the box for both.

export const useFedSignals = create<{ byKey: Record<string, ChatSignals> }>()(() => ({ byKey: {} }));

export function noteSignals(key: string, sig: ChatSignals | undefined) {
  const next = sig ?? {};
  const was = useFedSignals.getState().byKey[key];
  // As it was: nothing to draw again.
  if (was && JSON.stringify(was) === JSON.stringify(next)) return;
  useFedSignals.setState((s) => ({ byKey: { ...s.byKey, [key]: next } }));
}
