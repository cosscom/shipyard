import { create } from "zustand";

import type { BoxInfo } from "@/lib/api";
import { boxesBehind, editKey, newestSet, type ReadState, readDue, SUB_STATES_CAPABILITY, type SubStateSet, subStatesApi } from "@/lib/substates";
import { useStore } from "@/lib/store";

// Each box keeps its own copy of the sub-states. This reads them, and spreads
// the newest edit to every box that can take it: when a box's info loads (it
// comes online, is added, or an edit on it changes its revision), so an
// agent's edit on one box reaches the fleet. A box refuses anything not newer
// than what it holds, so two laptops doing this at once can't flip it.

type Info = BoxInfo & { substates_revision?: number; substates_stamp?: string };

export const useSubStateSets = create<{ sets: Record<string, SubStateSet> }>(() => ({ sets: {} }));

// keepSubStateSet remembers what a box holds now, and spreads it if newer.
export function keepSubStateSet(box: string, set: SubStateSet) {
  useSubStateSets.setState((s) => ({ sets: { ...s.sets, [box]: set } }));
}

// How long before a failed read or spread tries again.
const RETRY_MS = 15_000;

// startSubStatesSync starts keeping boxes alike; the function it returns stops.
export function startSubStatesSync(): () => void {
  const reads = new Map<string, ReadState>();
  // What was last spread to each box, and the info it went against: a refresh
  // that brings the same info back, or a box that refused it (a hook, say),
  // isn't sent it again until something changes. retryAt is a failed try's.
  const sent = new Map<string, { key: string; info: Info; retryAt?: number }>();
  const timers = new Set<number>();
  const later = () => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      sync();
    }, RETRY_MS);
    timers.add(t);
  };
  const sync = () => {
    const { client, boxes, status } = useStore.getState();
    if (!client) return;
    const online = new Set(status?.boxes.filter((b) => b.state === "online").map((b) => b.name));
    const here: Record<string, SubStateSet> = {};
    const infos: Record<string, Info> = {};
    const now = Date.now();
    for (const [box, data] of Object.entries(boxes)) {
      const info = data.info as Info | undefined;
      if (!online.has(box) || !info?.capabilities?.includes(SUB_STATES_CAPABILITY)) continue;
      infos[box] = info;
      const edit = editKey(info.substates_revision, info.substates_stamp);
      const held = useSubStateSets.getState().sets[box];
      if (held) here[box] = held;
      if (!readDue(reads.get(box), edit, now)) continue;
      // No revision: it never had a set, which is all a read would say.
      if (!info.substates_revision) {
        reads.set(box, { edit });
        keepSubStateSet(box, { states: [] });
        continue;
      }
      reads.set(box, { ...reads.get(box), reading: true, retryAt: undefined });
      subStatesApi.get(client, box).then(
        (set) => {
          reads.set(box, { edit });
          keepSubStateSet(box, set);
        },
        () => {
          reads.set(box, { ...reads.get(box), reading: false, retryAt: Date.now() + RETRY_MS });
          later();
        },
      );
    }
    // The newest known, even on a box gone offline, goes to those here that
    // have been read and are behind. A box takes only what is newer, so one
    // not read yet is simply left for later.
    const newest = newestSet(Object.values(useSubStateSets.getState().sets));
    if (!newest) return;
    const key = `${newest.revision}:${newest.stamp}`;
    for (const box of boxesBehind(here, newest)) {
      const last = sent.get(box);
      if (last && last.key === key && (last.retryAt ?? 0) > now) continue;
      if (last && last.key === key && !last.retryAt && last.info === infos[box]) continue;
      sent.set(box, { key, info: infos[box] });
      subStatesApi.spread(client, box, newest).then(
        (set) => keepSubStateSet(box, set),
        (err) => {
          // Refused is refused until something changes; anything else, try again.
          if ((err as { status?: number }).status === 403 || (err as { status?: number }).status === 400) return;
          sent.set(box, { key, info: infos[box], retryAt: Date.now() + RETRY_MS });
          later();
        },
      );
    }
  };
  const unsub = useStore.subscribe((s, prev) => {
    if (s.boxes !== prev.boxes || s.client !== prev.client || s.status !== prev.status) sync();
  });
  const unsubSets = useSubStateSets.subscribe(sync);
  sync();
  return () => {
    unsub();
    unsubSets();
    for (const t of timers) window.clearTimeout(t);
    timers.clear();
  };
}

// useSubStateSet is the newest set the app knows of, the one the board and
// Settings show. Undefined when no box ever had one.
export function useSubStateSet(): SubStateSet | undefined {
  return useSubStateSets((s) => newestSet(Object.values(s.sets)));
}
