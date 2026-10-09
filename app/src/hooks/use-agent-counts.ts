import { useMemo } from "react";

import type { Session, Status } from "@/lib/api";
import { type SessionState, sessionState } from "@/lib/derive";
import { type BoxData, useStore } from "@/lib/store";

export interface SessionEntry {
  box: string;
  session: Session;
  state: SessionState;
}

// useAllSessions lists every session on every online box with its state.
// Every caller gets the same list for the same store (Home has a dozen), so
// what is derived from it can be worked out once (lastOf).
export function useAllSessions(): SessionEntry[] {
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  return allSessions(boxes, status);
}

const allSessions = lastOf((boxes: Record<string, BoxData>, status: Status | undefined): SessionEntry[] => {
  const online = new Set(status?.boxes.filter((b) => b.state === "online").map((b) => b.name));
  return Object.entries(boxes)
    .filter(([box]) => online.has(box))
    .flatMap(([box, d]) => (d.sessions ?? []).map((session) => ({ box, session, state: sessionState(session, d.stats) })));
});

// lastOf remembers fn's last answer, for the same arguments (by identity):
// a memo shared by every component that asks.
export function lastOf<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { args: A; out: R } | undefined;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.out;
    const out = fn(...args);
    last = { args, out };
    return out;
  };
}

export function useAgentCounts() {
  const all = useAllSessions();
  return useMemo(
    () => ({
      waiting: all.filter((e) => e.state === "waiting").length,
      running: all.filter((e) => e.state === "running").length,
      finished: all.filter((e) => e.state === "finished").length,
    }),
    [all],
  );
}
