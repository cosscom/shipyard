import { ArrowDownToLineIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useContext } from "react";

import { Tip } from "@/components/tip";
import { park, toggleZoom, useDeckOn } from "@/lib/deck";
import { PaneContext } from "@/lib/pane-context";
import { platformKeys } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { splitKey, useWorkspaces, useWorktreeRef } from "@/lib/workspaces";
import { shortLabel } from "@/lib/worktree-names";

export { useDeckOn };

// DeckPaneBits is what a pane's header adds in the workspace layout: where
// the pane is (its worktree and box), a quiet "needs you", and, with the
// actions, zoom and put away.
export function DeckPaneBits({ owner, needsYou, pane, focused, actions }: { owner: string; needsYou?: boolean; pane?: string; focused?: boolean; actions?: boolean }) {
  const info = useContext(PaneContext);
  const zoomed = useWorkspaces((s) => !!(info && s.spaces[info.wsKey]?.tabs.find((t) => t.id === info.tab)?.zoomed));
  const ref = useWorktreeRef(owner);
  const boxes = useStore((s) => s.boxes);
  if (actions) {
    if (!pane) return null;
    return (
      <>
        <Tip label={<Keys label={zoomed ? "Show all panes" : "Zoom"} keys={focused ? "⌘⇧↵" : undefined} />}>
          <button
            type="button"
            aria-label={zoomed ? "Show all panes" : "Zoom pane"}
            aria-pressed={zoomed}
            // The press focused the pane first (Pane's onMouseDownCapture).
            onClick={() => toggleZoom()}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          >
            {zoomed ? <Minimize2Icon /> : <Maximize2Icon />}
          </button>
        </Tip>
        <Tip label={<Keys label="Put away, to the strip" />}>
          <button type="button" aria-label="Put away" onClick={() => park(pane)} className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
            <ArrowDownToLineIcon />
          </button>
        </Tip>
      </>
    );
  }
  const place = ref ? shortLabel(ref, boxes) : undefined;
  const box = splitKey(owner).box;
  return (
    <>
      {place && (
        <span data-testid="pane-place" className="ml-1 min-w-0 shrink-[3] truncate text-muted-foreground @max-[22rem]:hidden">
          {place}
          <span className="ml-1.5 rounded-sm border px-1 py-px font-mono text-[10px] text-muted-foreground/80 @max-[30rem]:hidden">{box}</span>
        </span>
      )}
      {needsYou && <span className="shrink-0 rounded-full @max-[18rem]:hidden bg-warning/14 px-1.5 py-px font-medium text-[11px] text-warning-foreground">Needs you</span>}
    </>
  );
}

function Keys({ label, keys }: { label: string; keys?: string }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      {keys && <span className="text-muted-foreground">{platformKeys(keys)}</span>}
    </span>
  );
}
