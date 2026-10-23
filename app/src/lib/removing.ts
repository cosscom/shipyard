import { create } from "zustand";

import { oneAtATime } from "./one-at-a-time.ts";

// Worktrees on their way out. The box answers a removal once the folder is
// gone, which for a big checkout (node_modules) takes seconds. A repository
// with an archive script has the box run it first, in the background, and
// the worktree only goes when it succeeds: minutes, sometimes. From the
// moment it is asked until the box says it is gone (worktree.removed) or
// that archiving failed, the app shows it as "Archiving…" or "Removing…"
// and keeps it from being opened, so nobody starts work in a folder that is
// about to go.
//
// No imports from "@/": pnpm test runs this file in plain node.

export type RemovalKind = "archive" | "remove";

export interface Removal {
  kind: RemovalKind;
  name?: string;
  // When it was asked, for the stale check below.
  since: number;
  // The box is running the archive script: the answer came back 202.
  script?: boolean;
}

// The box gives an archive script 30 minutes. A mark older than that lost
// its event (the app was closed, the box went away) and is dropped.
export const STALE_MS = 31 * 60 * 1000;

export const removalKey = (box: string, path: string) => `${box}:${path}`;

export const useRemovals = create<{ byKey: Record<string, Removal> }>()(() => ({ byKey: {} }));

export function markRemoving(box: string, path: string, kind: RemovalKind, name?: string, now = Date.now()) {
  useRemovals.setState((s) => ({ byKey: { ...s.byKey, [removalKey(box, path)]: { kind, name, since: now } } }));
}

// markScript notes the box is running the archive script, so the worktree
// stays (dimmed) until it reports.
export function markScript(box: string, path: string) {
  const key = removalKey(box, path);
  useRemovals.setState((s) => (s.byKey[key] ? { byKey: { ...s.byKey, [key]: { ...s.byKey[key], script: true } } } : s));
}

// clearRemoving drops the mark and returns what it was.
export function clearRemoving(box: string, path: string): Removal | undefined {
  const key = removalKey(box, path);
  const was = useRemovals.getState().byKey[key];
  if (!was) return undefined;
  useRemovals.setState((s) => {
    const { [key]: _gone, ...byKey } = s.byKey;
    return { byKey };
  });
  return was;
}

export function removalOf(byKey: Record<string, Removal>, box: string, path: string, now = Date.now()): Removal | undefined {
  const r = byKey[removalKey(box, path)];
  return r && now - r.since < STALE_MS ? r : undefined;
}

export const useRemoval = (box: string, path: string | undefined) => useRemovals((s) => (path ? removalOf(s.byKey, box, path) : undefined));

// Each box's removals, in line. A box takes one at a time, so a slow
// teardown never has others half done beside it; another box's don't wait.
const lines = new Map<string, ReturnType<typeof oneAtATime>>();

// inTurn runs job once the box's earlier removals are done, whether they
// worked or failed.
export function inTurn<T>(box: string, job: () => Promise<T>): Promise<T> {
  let line = lines.get(box);
  if (!line) lines.set(box, (line = oneAtATime()));
  return line(job);
}

// removalLabel is what a row says meanwhile.
export const removalLabel = (r: Removal) => (r.kind === "archive" ? "Archiving…" : "Removing…");

// removeResult reads a DELETE's answer. Older boxes sent the 202 of
// an archive as text/plain, which the client hands back as a string.
export function removeResult(res: unknown): { archive?: string } {
  if (typeof res === "string") {
    try {
      const v = JSON.parse(res) as unknown;
      return v && typeof v === "object" ? (v as { archive?: string }) : {};
    } catch {
      return {};
    }
  }
  return res && typeof res === "object" ? (res as { archive?: string }) : {};
}

// pruneRemovals drops marks for worktrees a box no longer lists: it went
// while the event was missed.
export function pruneRemovals(box: string, listed: Set<string>) {
  useRemovals.setState((s) => {
    let changed = false;
    const byKey: Record<string, Removal> = {};
    for (const [k, r] of Object.entries(s.byKey)) {
      if (k.startsWith(`${box}:`) && !listed.has(k.slice(box.length + 1))) changed = true;
      else byKey[k] = r;
    }
    return changed ? { byKey } : s;
  });
}
