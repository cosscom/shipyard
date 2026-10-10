import { useEffect } from "react";
import { create } from "zustand";

import type { BerthEvent } from "@/lib/api";
import { useStore } from "@/lib/store";
import { refFor, type WorktreeRef, wsKey } from "@/lib/workspaces";

// In-app artifacts: what an agent made for the person to look at — a
// berth.chart, a table, a diagram, notes or one small page — kept by the
// box for the worktree it was made in (`berthd artifact add`,
// internal/box/artifacts.go) and drawn here. Listed per worktree; each
// version's content is fetched once (a version never changes) and kept.
// artifact.added/updated/removed events keep every view live.

export interface ArtVersion {
  n: number;
  at: string;
  size: number;
  sha256: string;
  note?: string;
}

export interface Art {
  // The box it lives on (added here; the box doesn't say its own name).
  box: string;
  id: string;
  title: string;
  // chart, table, diagram, notes, page, or a kind added later (kinds.ts).
  kind: string;
  // chart, csv, tsv, json, mermaid, markdown, html.
  format: string;
  location: string;
  worktree: string;
  path: string;
  source?: string;
  file?: string;
  by: { session?: string; agent?: string; helper?: string };
  created: string;
  updated: string;
  watched?: boolean;
  problem?: string;
  versions: ArtVersion[];
}

export const latest = (a: Art): ArtVersion => a.versions[a.versions.length - 1];
export const atMs = (v: ArtVersion) => Date.parse(v.at);

// The capability a box advertises when it keeps artifacts.
export const hasArtifacts = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("artifacts");
export const useHasArtifacts = (box?: string) => useStore((s) => !!box && !!s.boxes[box]?.info?.capabilities?.includes("artifacts"));

interface ArtState {
  // A worktree's artifacts (by workspace key, box:path), newest change first.
  byWt: Record<string, Art[]>;
  loading: Record<string, boolean>;
  // Content by box/id/version.
  bodies: Record<string, string>;
  // When each artifact last got a new version here, for the live pulse.
  pulse: Record<string, number>;
  // Artifacts with a version not yet looked at: id → version.
  unseen: Record<string, number>;
  seen(id: string): void;
}

export const useArt = create<ArtState>((set) => ({
  byWt: {},
  loading: {},
  bodies: {},
  pulse: {},
  unseen: {},
  seen: (id) =>
    set((s) => {
      if (!(id in s.unseen)) return s;
      const { [id]: _, ...rest } = s.unseen;
      return { unseen: rest };
    }),
}));

const enc = encodeURIComponent;
export const artBase = (ref: Pick<WorktreeRef, "location" | "worktree">) => `locations/${enc(ref.location)}/worktrees/${enc(ref.worktree)}/artifacts`;
const bodyKey = (box: string, id: string, n: number) => `${box}/${id}/${n}`;

const client = () => useStore.getState().client;

// loadArtifacts reads a worktree's list; versions that are new since the
// last read pulse.
export async function loadArtifacts(ref: WorktreeRef): Promise<void> {
  const c = client();
  if (!c) return;
  const key = wsKey(ref.box, ref.path);
  useArt.setState((s) => ({ loading: { ...s.loading, [key]: true } }));
  try {
    const list = (await c.box<Omit<Art, "box">[] | null>(ref.box, "GET", artBase(ref))) ?? [];
    const next = list.map((a) => ({ ...a, box: ref.box }));
    useArt.setState((s) => {
      const before = new Map((s.byWt[key] ?? []).map((a) => [a.id, latest(a)?.n ?? 0]));
      const pulse = { ...s.pulse };
      const unseen = { ...s.unseen };
      const known = key in s.byWt;
      for (const a of next) {
        const was = before.get(a.id);
        const now = latest(a)?.n ?? 0;
        if (known && (was === undefined || now > was)) {
          pulse[a.id] = Date.now();
          unseen[a.id] = now;
        }
      }
      return { byWt: { ...s.byWt, [key]: next }, loading: { ...s.loading, [key]: false }, pulse, unseen };
    });
  } catch {
    useArt.setState((s) => ({ loading: { ...s.loading, [key]: false }, byWt: { ...s.byWt, [key]: s.byWt[key] ?? [] } }));
  }
}

// useWorktreeArt is a worktree's artifacts, read once the box can keep
// them, and kept live by events.
const NONE: Art[] = [];
export function useWorktreeArt(key?: string): Art[] {
  const box = key?.split(":")[0];
  const can = useHasArtifacts(box);
  const list = useArt((s) => (key ? (s.byWt[key] ?? NONE) : NONE));
  const known = useArt((s) => !!key && (key in s.byWt || !!s.loading[key]));
  const locations = useStore((s) => (box ? s.boxes[box]?.locations : undefined));
  useEffect(() => {
    if (!key || !can || known) return;
    // Several parts of a worktree's view ask for its list as it opens, in
    // one render: the first one's read is the read for all of them.
    const now = useArt.getState();
    if (key in now.byWt || now.loading[key]) return;
    const ref = refFor(key);
    if (ref) void loadArtifacts(ref);
  }, [key, can, known, locations]);
  return list;
}

export function findArt(id: string): Art | undefined {
  for (const list of Object.values(useArt.getState().byWt)) {
    const a = list.find((x) => x.id === id);
    if (a) return a;
  }
  return undefined;
}

// useArtifact is one artifact by id, from whichever worktree has it; with
// wt, it loads that worktree's list first.
export function useArtifact(id?: string, wt?: string): Art | undefined {
  useWorktreeArt(wt);
  return useArt((s) => {
    if (!id) return undefined;
    if (wt) return s.byWt[wt]?.find((a) => a.id === id);
    for (const list of Object.values(s.byWt)) {
      const a = list.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  });
}

const inflight = new Map<string, Promise<string>>();

export function fetchBody(a: Art, n: number): Promise<string> {
  const k = bodyKey(a.box, a.id, n);
  const have = useArt.getState().bodies[k];
  if (have !== undefined) return Promise.resolve(have);
  let p = inflight.get(k);
  if (!p) {
    const c = client();
    if (!c) return Promise.reject(new Error("not connected"));
    p = c
      .boxBlob(a.box, `${artBase(a)}/${enc(a.id)}/v/${n}`)
      .then((b) => b.text())
      .then((text) => {
        useArt.setState((s) => ({ bodies: { ...s.bodies, [k]: text } }));
        return text;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

// useArtBody is a version's content (the latest by default), or undefined
// while it loads; error when it couldn't be read.
export function useArtBody(a?: Art, n?: number): { body?: string; error?: string } {
  const v = a ? (n ?? latest(a)?.n) : undefined;
  const body = useArt((s) => (a && v ? s.bodies[bodyKey(a.box, a.id, v)] : undefined));
  const err = useArtErrors((s) => (a && v ? s.errors[bodyKey(a.box, a.id, v)] : undefined));
  useEffect(() => {
    if (!a || !v || body !== undefined) return;
    fetchBody(a, v).catch((e: unknown) => useArtErrors.setState((s) => ({ errors: { ...s.errors, [bodyKey(a.box, a.id, v)]: e instanceof Error ? e.message : String(e) } })));
  }, [a, v, body]);
  return { body, error: err };
}

const useArtErrors = create<{ errors: Record<string, string> }>(() => ({ errors: {} }));

// handleArtifactEvent keeps lists live: an artifact.* event reloads the
// worktree it names, if this app has shown it.
export function handleArtifactEvent(e: BerthEvent): void {
  if (!e.type.startsWith("artifact.") || !e.box) return;
  const path = typeof e.data?.path === "string" ? e.data.path : undefined;
  if (!path) return;
  const key = wsKey(e.box, path);
  if (!(key in useArt.getState().byWt)) return;
  const ref = refFor(key) ?? (typeof e.data?.location === "string" && typeof e.data?.name === "string" ? { box: e.box, location: e.data.location, worktree: e.data.name, path } : undefined);
  if (ref) void loadArtifacts(ref);
}

export function sizeLabel(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}
