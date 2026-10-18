import { SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { confirm } from "@/components/sidebar/confirm";
import type { Location, Worktree } from "@/lib/api";
import { cn } from "@/lib/utils";
import { boxNamesWorktrees, renameWorktree, startRenamingWorktree, suggestedTitle, WORKTREE_TITLE_MAX } from "@/lib/worktree-names";

// Renaming a worktree gives it a display name; its branch and folder keep
// theirs. In the sidebar the row turns into a field (double-click, F2, or
// Rename… in its menu); anywhere else the same asks in a dialog.

// branchHint says what stays as it is, under the field.
function branchHint(box: string, wt: Pick<Worktree, "name" | "branch">): string {
  const keeps = wt.branch && wt.branch !== wt.name ? `The branch stays ${wt.branch}` : `The branch stays ${wt.name}`;
  return boxNamesWorktrees(box) === false ? `${keeps}. Kept on this laptop: ${box} is older.` : `${keeps}.`;
}

// openRenameWorktree renames a worktree: in place when its sidebar row is
// on screen (unless inPlace is false), else in a dialog.
export function openRenameWorktree(box: string, loc: Location, wt: Worktree, { inPlace = true } = {}) {
  const row = inPlace && document.querySelector(`[data-testid="worktree-row"][data-worktree="${CSS.escape(`${box}/${wt.name}`)}"]`);
  if (row) return startRenamingWorktree(box, wt.path);
  const suggestion = suggestedTitle(box, wt);
  confirm({
    title: `Rename ${wt.title || wt.name}`,
    description: `A display name for every device you use Shipyard on. ${branchHint(box, wt)} Leave it empty to show ${wt.name} again.`,
    input: { label: "Display name", initial: wt.title ?? "", placeholder: suggestion ?? wt.name },
    confirm: "Rename",
    run: async (_c, value) => {
      if (!(await renameWorktree(box, loc, wt, value))) throw new Error("It wasn't renamed.");
    },
  });
}

// WorktreeNameField is a sidebar row while it is renamed: the field, then
// what stays as it is and, when its agent's task reads as a name, that name
// to use. Enter or leaving the field saves; Esc puts it back.
export function WorktreeNameField({ box, loc, wt, onDone }: { box: string; loc: Location; wt: Worktree; onDone(): void }) {
  const [v, setV] = useState(wt.title ?? "");
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // A menu that asked gives focus back to its trigger as it closes: take it
  // after that, and only count a blur once the field has had it.
  const ready = useRef(false);
  const suggestion = suggestedTitle(box, wt);
  useEffect(() => {
    const t = window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
      ready.current = true;
    }, 60);
    return () => window.clearTimeout(t);
  }, []);
  const finish = (next?: string, refocus = false) => {
    if (done.current) return;
    done.current = true;
    onDone();
    if (next !== undefined) void renameWorktree(box, loc, wt, next);
    // Enter and Esc hand the keyboard back to the row, not to the page.
    if (refocus)
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="worktree-row"][data-worktree="${CSS.escape(`${box}/${wt.name}`)}"]`)?.focus());
  };
  return (
    <div data-testid="worktree-rename" className="flex flex-col gap-1 rounded-lg bg-sidebar-accent/60 px-1.5 py-1">
      <input
        ref={input}
        value={v}
        maxLength={WORKTREE_TITLE_MAX}
        aria-label={`Display name for ${wt.name}`}
        aria-describedby={`wt-hint-${CSS.escape(wt.path)}`}
        placeholder={wt.name}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(v, true);
          if (e.key === "Escape") finish(undefined, true);
        }}
        onBlur={(e) => {
          // A click on the suggestion is not leaving.
          if ((e.relatedTarget as HTMLElement | null)?.dataset?.suggestion !== undefined) return;
          if (ready.current) finish(v);
        }}
        className="h-6 w-full min-w-0 rounded-md border border-ring bg-background px-1.5 text-desc text-foreground outline-none ring-2 ring-ring/24 placeholder:text-muted-foreground/72"
      />
      <span id={`wt-hint-${CSS.escape(wt.path)}`} className="px-0.5 text-tag text-muted-foreground [overflow-wrap:anywhere]">
        The branch stays <span className="font-mono text-tag text-foreground/75">{wt.branch || wt.name}</span>.
        {boxNamesWorktrees(box) === false ? ` Kept on this laptop: ${box} is older.` : ""} Empty shows its name.
      </span>
      {suggestion && suggestion !== v.trim() && (
        <button
          type="button"
          data-suggestion=""
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setV(suggestion);
            input.current?.focus();
          }}
          className={cn("flex min-w-0 items-center gap-1 rounded-md px-0.5 text-left text-tag text-muted-foreground hover:text-foreground")}
        >
          <SparklesIcon className="size-3 shrink-0" />
          <span className="truncate">Use “{suggestion}”</span>
        </button>
      )}
    </div>
  );
}
