import { PanelRightIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { TreePanel } from "@/components/files/file-tree";
import { Tip } from "@/components/tip";
import { NARROW, setTreeOpen, toggleTree, useTouchedLive, useTree, useWorkingSessions } from "@/lib/file-tree";
import { openFile, useFiles } from "@/lib/files";
import { findLeaf, paneWorktree } from "@/lib/layout";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useHereKey, useHereRef, useWorkspaces } from "@/lib/workspaces";

// The Files panel: the worktree's files at the right of its tabs, under the
// tab strip, beside whatever tab is in front (Chat, Shell, Preview, a File
// tab). It is the worktree's, not the app's: it follows the worktree in
// front, and ⌘⇧E (View › Files panel) or its button in the strip shows and
// hides it, for every worktree, across restarts (prefs.filesPanel). Below a
// 1100px window it floats over the tabs with a scrim instead of taking
// their room, and goes once you pick a file or press esc; floating doesn't
// change the pref. The app's sidebar stays projects and agents.

export const DOCK_W = 264;
const FLOAT_W = 280;

function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(NARROW);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(NARROW).matches,
  );
}

// useFrontFile is the file in front: the focused pane's, when it is a File
// tab of this worktree.
function useFrontFile(ws: string | undefined) {
  return useWorkspaces((s) => {
    const sp = s.current ? s.spaces[s.current] : undefined;
    const tab = sp?.tabs.find((t) => t.id === sp.active);
    const leaf = tab ? findLeaf(tab.root, tab.focus) : undefined;
    return leaf && leaf.content.kind === "file" && s.current && paneWorktree(s.current, leaf) === ws ? leaf.content.path : undefined;
  });
}

// usePanelOpen: the panel shows, docked or floating.
function usePanelOpen() {
  const docked = usePrefs((p) => p.filesPanel);
  const floating = useTree((s) => s.floating);
  return useNarrow() ? floating : docked;
}

export function TreeDockFrame({ showing, children }: { showing: boolean; children: React.ReactNode }) {
  const open = usePanelOpen();
  const ws = useHereKey();
  const ref = useHereRef();
  const hasTabs = useWorkspaces((s) => !!(s.current && s.spaces[s.current]?.tabs.length));
  const front = useFrontFile(ws);
  const narrow = useNarrow();
  const on = showing && open && !!ws && !!ref && hasTabs;
  const float = on && narrow;
  // A wider window docks the panel (or not) by the pref; the floating one
  // is forgotten.
  useEffect(() => {
    if (!narrow) useTree.setState({ floating: false });
  }, [narrow]);
  const working = useWorkingSessions(ref);
  useTouchedLive(ws, ref, on, working.size > 0);
  // The loops panel sits clear of a docked panel; a floating
  // one covers it with the rest.
  useEffect(() => {
    document.documentElement.style.setProperty("--berth-dock-w", on && !float ? `${DOCK_W}px` : "0px");
  }, [on, float]);
  // Floating, it takes the keys: the tree has focus, and esc closes it
  // before a terminal behind it could take esc as its own.
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!float) return;
    aside.current?.querySelector<HTMLElement>("[role=tree]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog], [role=alertdialog]")) return;
      // New file's own esc puts away the name first.
      if ((e.target as HTMLElement | null)?.closest?.("[data-testid=tree-new-file]")) return;
      e.preventDefault();
      e.stopPropagation();
      setTreeOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [float]);
  return (
    <>
      <div className="absolute inset-y-0 left-0" style={{ right: on && !float ? DOCK_W : 0 }}>
        {children}
      </div>
      {float && <div aria-hidden data-testid="tree-scrim" className="absolute inset-0 z-scrim bg-black/25 dark:bg-black/45" onClick={() => setTreeOpen(false)} />}
      {on && (
        <aside
          ref={aside}
          aria-label="Files in this worktree"
          data-testid="files-panel"
          data-float={float || undefined}
          className={cn("absolute inset-y-0 right-0 flex flex-col border-l bg-sidebar", float ? "z-drawer shadow-[-18px_0_40px_-10px_rgb(0_0_0/0.45)]" : "vibrancy:bg-transparent")}
          style={{ width: float ? FLOAT_W : DOCK_W }}
        >
          <TreePanel
            ws={ws}
            wref={ref}
            current={front}
            onOpen={(p, how) => {
              openFile(p, how);
              if (float && how !== "external") setTreeOpen(false);
            }}
            onClose={() => setTreeOpen(false)}
            className="flex-1"
          />
        </aside>
      )}
    </>
  );
}

// DockButton is the strip's button for the panel. Closed, it carries a
// blue dot while the agents have changed files this turn: the one place
// that says there is something to look at without opening anything.
export function DockButton() {
  const open = usePanelOpen();
  const ws = useHereKey();
  const ref = useHereRef();
  const n = useFiles((s) => (ws ? (s.touched[ws]?.files.length ?? 0) : 0));
  if (!ref) return null;
  return (
    <Tip label={open ? "Hide files (⌘⇧E)" : n > 0 ? `Files: ${n} changed this turn (⌘⇧E)` : "Files (⌘⇧E)"} side="bottom">
      <button
        type="button"
        aria-label={open ? "Hide files" : "Show files"}
        aria-pressed={open}
        data-testid="files-panel-button"
        onClick={toggleTree}
        className={cn("relative inline-flex size-6.5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", open && "bg-foreground/9 text-foreground")}
      >
        <PanelRightIcon className="size-3.5" />
        {!open && n > 0 && <span data-testid="files-panel-dot" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-info ring-2 ring-background" />}
      </button>
    </Tip>
  );
}
