import { useEffect } from "react";

import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import { type Art, fetchBody, hasArtifacts, latest, loadArtifacts, useArt } from "@/lib/art/model";
import { parseVdiff } from "@/lib/art/vdiff";
import { openArtifact, openBoard } from "@/lib/art/open";
import { previewUrl } from "@/lib/compare-actions";
import { paneKey, toggleDrawer } from "@/lib/devtools";
import { useStore } from "@/lib/store";
import type { ShowId } from "@/lib/whats-new-model";
import { worktreeLabel } from "@/lib/worktree-names";
import { closeSettings } from "@/views/settings/open";
import { here, openFor, recentWorktrees, refFor, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";

// What each "Show me" on the What's new card does: the app's own ways
// there, in the worktree you are in, else the one you were in last. One
// that has nowhere to go right now (no worktree open yet, no dev server
// running) isn't offered; the card shows its keys or its guide instead.

export interface Shower {
  // The button's words: where it goes.
  label: string;
  run(): void;
}

// candidates is the worktrees to show things in: the one in front, the
// ones opened last, then those with an agent at work on an online box.
function candidates(): string[] {
  const st = useStore.getState();
  const online = st.status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [];
  const busy = online.flatMap((box) => {
    const dirs = new Set((st.boxes[box]?.sessions ?? []).filter((x) => !x.exited).map((x) => x.dir));
    return (st.boxes[box]?.locations ?? []).flatMap((l) => (l.worktrees ?? []).filter((w) => dirs.has(w.path)).map((w) => wsKey(box, w.path)));
  });
  const keys = [here(), ...recentWorktrees(useWorkspaces.getState().spaces, 8).map((w) => wsKey(w.ref.box, w.ref.path)), ...busy];
  return [...new Set(keys.filter((k): k is string => !!k && !!refFor(k)))].slice(0, 12);
}

// A worktree's artifacts, read when the card opens (and as the boxes'
// lists arrive, when it opens with the app) so it knows where they are.
export function usePreloadArt(open: boolean) {
  const boxes = useStore((s) => s.boxes);
  const current = useWorkspaces((s) => s.current);
  useEffect(() => {
    if (!open) return;
    const known = useArt.getState();
    for (const k of candidates().slice(0, 8)) {
      const ref = refFor(k);
      if (ref && hasArtifacts(ref.box) && !(k in known.byWt) && !known.loading[k]) void loadArtifacts(ref);
    }
  }, [open, boxes, current]);
}

// openChanged opens the newest visual diff that found changes, else the
// newest.
async function openChanged(vds: Art[]) {
  for (const a of vds) {
    const body = await fetchBody(a, latest(a).n).catch(() => "");
    const v = body ? parseVdiff(body) : undefined;
    if (v?.pages.some((p) => p.shots.some((x) => x.verdict === "changed"))) return openArtifact(a);
  }
  openArtifact(vds[0]);
}

// showerFor is the Show me for id, as things stand, or undefined.
export function showerFor(id: ShowId): Shower | undefined {
  const st = useStore.getState();
  const keys = candidates();
  switch (id) {
    case "artifacts": {
      const art = useArt.getState().byWt;
      const withArt = keys.filter((k) => hasArtifacts(refFor(k)!.box));
      const h = here();
      const key = withArt.find((k) => art[k]?.length) ?? (h && withArt.includes(h) ? h : undefined);
      if (!key) return undefined;
      return { label: "Open the board", run: () => openBoard(key) };
    }
    case "visual-diff": {
      const art = useArt.getState().byWt;
      for (const k of keys) {
        const vds = art[k]?.filter((a) => a.kind === "visualdiff") ?? [];
        if (vds.length) return { label: "Open a visual diff", run: () => void openChanged(vds) };
      }
      return undefined;
    }
    case "devtools": {
      const key = keys.find((k) => previewUrl(k));
      if (!key) return undefined;
      return {
        label: "Open the console",
        run: () => {
          const ref = refFor(key);
          if (!ref) return;
          if (here() !== key) selectWorktree(ref);
          const at = openFor({ kind: "browser", url: previewUrl(key) });
          if (at) toggleDrawer(paneKey(at.pane), true);
        },
      };
    }
    case "rename": {
      // The worktree you are in; else the hardest name to read (one made
      // from a pasted link) that has no display name yet; else a recent one.
      const all = (st.status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? []).flatMap((box) =>
        (st.boxes[box]?.locations ?? []).flatMap((loc) => (loc.worktrees ?? []).filter((w) => !w.main).map((wt) => ({ box, loc, wt }))),
      );
      const h = here();
      const at = (k?: string) => all.find((x) => k === wsKey(x.box, x.wt.path));
      const long = all.filter((x) => !x.wt.title && x.wt.name.length >= 16).sort((a, b) => b.wt.name.length - a.wt.name.length)[0];
      const pick = at(h) ?? long ?? keys.map(at).find(Boolean);
      if (!pick) return undefined;
      return {
        label: `Rename ${worktreeLabel(pick.wt)}`,
        run: () => {
          // Settings has the sidebar's place: leave it, and rename in the row
          // once the sidebar is back.
          if (useStore.getState().view.kind !== "settings") return openRenameWorktree(pick.box, pick.loc, pick.wt);
          closeSettings();
          const row = `[data-testid="worktree-row"][data-worktree="${CSS.escape(`${pick.box}/${pick.wt.name}`)}"]`;
          let frames = 0;
          const go = () => (document.querySelector(row) || ++frames > 30 ? openRenameWorktree(pick.box, pick.loc, pick.wt) : requestAnimationFrame(go));
          requestAnimationFrame(go);
        },
      };
    }
    case "settings-boxes":
      return { label: "Settings › Boxes", run: () => st.setView({ kind: "settings", section: "boxes" }) };
  }
}
