import { useMemo } from "react";

import { Tip } from "@/components/tip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { assignTones, labelsFor, NARROW, nameFromKey, TINY, type Tone, toneVar } from "@/lib/groups";
import { type BoxData, useStore } from "@/lib/store";
import { shortLabel, worktreeLabel } from "@/lib/worktree-names";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/lib/prefs";
import { groupKeys, onScreenOf, splitKey, useWorkspaces, type WorktreeRef } from "@/lib/workspaces";

type BoxesData = Record<string, BoxData>;

// Worktrees side by side: each worktree on screen wears one colour (its
// tone) and a name that tells it apart. With one worktree on screen there
// are no tones at all, so the app looks as it always has.

// Narrow (lib/groups.ts NARROW): the strip folds the groups you are not in,
// and pane chips shrink to their dot and a short name. Tiny (TINY): only
// the group in front shows its tabs; the others wait as chips.
export const useNarrow = () => useMediaQuery(NARROW);
export const useTiny = () => useMediaQuery(TINY);

// useOnScreen is the worktrees on screen, in the strip's order. Joined in
// the selector, so it only changes when they do.
export function useOnScreen(): string[] {
  // Labs decides whether groups count: read it so a change shows at once.
  usePrefs((p) => p.labs);
  const joined = useWorkspaces((s) => onScreenOf(s).join("\n"));
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}

// useGroups is the worktrees whose tabs share the strip (Labs), in order.
export function useGroups(): string[] {
  const labs = usePrefs((p) => p.labs);
  const joined = useWorkspaces((s) => (labs ? groupKeys(s) : s.current ? [s.current] : []).join("\n"));
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}

// useTones is each on-screen worktree's tone, while there is more than one.
export function useTones(): Record<string, Tone> {
  const keys = useOnScreen();
  const picked = useWorkspaces((s) => s.tones);
  return useMemo(() => (keys.length > 1 ? assignTones(keys, picked) : {}), [keys, picked]);
}

// useTone is a worktree's colour (a CSS value), unset while it is alone.
export function useTone(key: string | undefined): string | undefined {
  const t = useTones()[key ?? ""];
  return t ? toneVar(t) : undefined;
}

// A worktree is named by its display name when it has one (lib/worktree-names).
const nameOf = (ref: WorktreeRef, boxes: BoxesData) => shortLabel(ref, boxes);

// useLabel names a worktree as the sidebar does, with its box added when
// another on screen has the same name (the same repository on two boxes).
export function useLabel(key: string | undefined): { label: string; ref?: WorktreeRef } {
  const keys = useOnScreen();
  const spaces = useWorkspaces((s) => s.spaces);
  const boxes = useStore((s) => s.boxes);
  return useMemo(() => {
    if (!key) return { label: "" };
    const refOf = (k: string): WorktreeRef | undefined => {
      if (spaces[k]) return spaces[k].ref;
      const { box, path } = splitKey(k);
      for (const loc of boxes[box]?.locations ?? []) {
        const wt = loc.worktrees?.find((w) => w.path === path);
        if (wt) return { box, location: loc.name, worktree: wt.name, path, main: wt.main };
      }
      return undefined;
    };
    const named = [...new Set([key, ...keys])].map((k) => {
      const ref = refOf(k);
      return { key: k, name: ref ? nameOf(ref, boxes) : nameFromKey(k), box: splitKey(k).box };
    });
    return { label: labelsFor(named)[key], ref: refOf(key) };
  }, [key, keys, spaces, boxes]);
}

// useLabels is useLabel for several worktrees, in order.
export function useLabels(keys: string[]): string[] {
  const onScreen = useOnScreen();
  const spaces = useWorkspaces((s) => s.spaces);
  const boxes = useStore((s) => s.boxes);
  const joined = keys.join("\n");
  return useMemo(() => {
    const want = joined ? joined.split("\n") : [];
    const named = [...new Set([...want, ...onScreen])].map((k) => {
      const ref = spaces[k]?.ref;
      const { box, path } = splitKey(k);
      const wt = ref ? undefined : boxes[box]?.locations?.flatMap((l) => (l.worktrees ?? []).map((w) => ({ l, w }))).find((x) => x.w.path === path);
      const name = ref ? nameOf(ref, boxes) : wt ? worktreeLabel(wt.w, wt.l) : nameFromKey(k);
      return { key: k, name, box };
    });
    const labels = labelsFor(named);
    return want.map((k) => labels[k]);
  }, [joined, onScreen, spaces, boxes]);
}

// WtDot is a worktree's colour as a dot; nothing while it is alone.
export function WtDot({ wsKey, className }: { wsKey?: string; className?: string }) {
  const tone = useTone(wsKey);
  if (!tone) return null;
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: tone }} />;
}

// WtChip names a worktree in its colour: on a pane's header in a tab that
// mixes worktrees. Narrow, it is the dot and a short name, the whole name
// in the tooltip: colour is never all that tells two worktrees apart.
export function WtChip({ wsKey, className }: { wsKey: string; className?: string }) {
  const tone = useTone(wsKey);
  const { label, ref } = useLabel(wsKey);
  const narrow = useNarrow();
  if (!tone) return null;
  const tip = ref ? `${label}${label !== (ref.main ? ref.location : ref.worktree) ? ` (${ref.worktree})` : ""} on ${ref.box} · ${ref.path}` : label;
  if (narrow)
    return (
      <Tip label={tip} side="bottom" align="start">
        <span aria-label={`Pane of ${label}`} className={cn("inline-flex max-w-20 shrink-0 items-center gap-1 font-medium text-tag", className)} style={{ color: tone }}>
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: tone }} />
          <span className="truncate">{label}</span>
        </span>
      </Tip>
    );
  return (
    <Tip label={tip} side="bottom" align="start">
      <span
        aria-label={`Pane of ${label}`}
        className={cn("inline-flex h-4.5 max-w-40 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-tag", className)}
        style={{ background: `color-mix(in oklab, ${tone} 14%, transparent)`, color: tone }}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="truncate">{label}</span>
      </span>
    </Tip>
  );
}
