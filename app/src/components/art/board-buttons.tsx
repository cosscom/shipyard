import { LayoutGridIcon } from "lucide-react";
import { useContext } from "react";

import { Tip } from "@/components/tip";
import { useArt, useWorktreeArt } from "@/lib/art/model";
import { openBoard } from "@/lib/art/open";
import { PaneContext } from "@/lib/pane-context";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useHereKey, wsKey } from "@/lib/workspaces";

// The ways to the board: "N artifacts" by the reply box (the worktree's,
// with a dot when one has a version not yet looked at), and a button in
// the worktree's toolbar beside Files.

function useFresh(list: { id: string }[]): boolean {
  return useArt((s) => list.some((a) => a.id in s.unseen));
}

// useSessionArt is the artifacts of the worktree a session runs in.
export function useSessionArt(box: string, session: string) {
  const dir = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session)?.dir);
  return useWorktreeArt(dir ? wsKey(box, dir) : undefined);
}

export function ArtBoardChip({ box, session, className }: { box: string; session: string; className?: string }) {
  const dir = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session)?.dir);
  const wt = dir ? wsKey(box, dir) : undefined;
  const list = useWorktreeArt(wt);
  const fresh = useFresh(list);
  const pane = useContext(PaneContext);
  if (!list.length || !wt) return null;
  const n = list.length;
  return (
    <Tip label="This worktree's artifacts, on its board · ⌘-click beside the chat">
      <button
        type="button"
        data-testid="art-chip"
        aria-label={`${n} ${n === 1 ? "artifact" : "artifacts"} in this worktree${fresh ? ", one updated" : ""}`}
        className={cn(className, fresh && "text-foreground/85")}
        onClick={(e) => openBoard(wt, { split: e.metaKey || e.ctrlKey, from: pane ? { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane } : undefined })}
      >
        <span className="relative flex">
          <LayoutGridIcon className="size-3.5" />
          {fresh && <span aria-hidden className="-top-0.5 -right-0.5 absolute size-1.5 rounded-full bg-info ring-2 ring-background" />}
        </span>
        <span className="tabular-nums">
          {n} {n === 1 ? "artifact" : "artifacts"}
        </span>
      </button>
    </Tip>
  );
}

export function BoardButton() {
  const key = useHereKey();
  const list = useWorktreeArt(key);
  const fresh = useFresh(list);
  if (!key || !list.length) return null;
  return (
    <Tip label={`Artifacts: ${list.length} in this worktree`} side="bottom">
      <button
        type="button"
        aria-label={`Artifacts board, ${list.length}`}
        data-testid="art-board-button"
        onClick={() => openBoard(key)}
        className="relative inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LayoutGridIcon className="size-3.5" />
        <span className="text-tag tabular-nums">{list.length}</span>
        {fresh && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-info ring-2 ring-background" />}
      </button>
    </Tip>
  );
}
