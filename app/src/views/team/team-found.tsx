import { ArrowDownToLineIcon, CheckIcon, FolderGitIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type ExistingClone, plural } from "@/lib/team";
import { cn } from "@/lib/utils";

// Clones the box already has of a repo, found by their origin: a Shipyard
// project, or a folder in the usual places (~/code, ~/work, …). The page
// decides which one a repo uses, or a fresh clone; nothing found is used
// without a choice here, but for the one clean clone it starts on.

function Choice({ on, onClick, children, testId }: { on: boolean; onClick(): void; children: React.ReactNode; testId?: string }) {
  return (
    <Button size="xs" variant={on ? "secondary" : "ghost"} aria-pressed={on} data-testid={testId} className={cn(!on && "text-muted-foreground")} onClick={onClick}>
      {on && <CheckIcon />}
      {children}
    </Button>
  );
}

export function FoundClones({
  id,
  repo,
  clones,
  use,
  onUse,
  note,
  initDetail,
  onPull,
}: {
  id: string;
  repo: string;
  clones: ExistingClone[];
  // The path chosen, or "" for a fresh clone.
  use: string;
  onUse(path: string): void;
  note?: string;
  initDetail?: string;
  onPull?(c: ExistingClone): Promise<void>;
}) {
  const [pulling, setPulling] = useState<string>();
  const chosen = clones.find((c) => c.path === use);
  return (
    <div data-testid={`found-${id}`} className="space-y-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-meta">
      {clones.slice(0, 3).map((c, i) => (
        <div key={c.path} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="font-medium">
              Found <span className="font-mono">{c.display}</span>
            </span>
            <span className="text-muted-foreground">
              , a clone of <span className="font-mono">{repo}</span> ({c.branch ? <>on branch <span className="font-mono text-foreground">{c.branch}</span></> : c.head ? <>at <span className="font-mono">{c.head}</span></> : null}
              {c.branch || c.head ? ", " : ""}
              {c.dirty ? plural(c.dirty, "uncommitted change") : "no uncommitted changes"})
              {c.location && <> · the Shipyard project {c.location}</>}
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Choice on={use === c.path} onClick={() => onUse(c.path)} testId={i ? `use-${id}-${i}` : `use-${id}`}>
              Use this
            </Choice>
            {clones.length === 1 && (
              <>
                <span className="text-muted-foreground/60">/</span>
                <Choice on={!chosen} onClick={() => onUse("")} testId={`fresh-${id}`}>
                  Clone a fresh copy
                </Choice>
              </>
            )}
          </span>
        </div>
      ))}
      {clones.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">{clones.length} clones found; pick one, or</span>
          <Choice on={!chosen} onClick={() => onUse("")} testId={`fresh-${id}`}>
            Clone a fresh copy
          </Choice>
        </div>
      )}
      {note && <p className="text-muted-foreground">{note}</p>}
      {chosen && (
        <ul data-testid={`found-review-${id}`} className="space-y-1 border-t pt-2 text-muted-foreground">
          <li>
            Runs in your existing checkout <span className="font-mono text-foreground">{chosen.display}</span>
            {initDetail ? <>: {initDetail}, leaving what is already there.</> : ", as it is."}
          </li>
          {chosen.dirty > 0 && <li className="text-foreground">Your uncommitted changes stay as they are.</li>}
          <li>Its branch stays {chosen.branch ? <span className="font-mono">{chosen.branch}</span> : "as it is"}: nothing is checked out, stashed, reset or pulled, and an existing .env keeps its values.</li>
          {chosen.location && <li>It is the Shipyard project {chosen.location} already: its worktrees and settings stay.</li>}
          {!!chosen.worktrees && <li>{chosen.worktrees === 1 ? "Its other worktree shows in the sidebar, set up the first time you open it." : `Its ${chosen.worktrees} other worktrees show in the sidebar, each set up the first time you open it.`}</li>}
          {!!chosen.behind && onPull && (
            <li className="flex flex-wrap items-center gap-2">
              {plural(chosen.behind, "commit")} behind its upstream, as of its last fetch.
              <Button
                size="xs"
                variant="outline"
                disabled={pulling === chosen.path}
                onClick={async () => {
                  setPulling(chosen.path);
                  try {
                    await onPull(chosen);
                  } finally {
                    setPulling(undefined);
                  }
                }}
              >
                {pulling === chosen.path ? <Spinner className="size-3" /> : <ArrowDownToLineIcon />} Pull
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// adoptedLine says, on a run's row, that a repo uses a clone it found.
export function adoptedLine(p: { adopted?: boolean; path?: string; first_open?: number; note?: string }): string | undefined {
  if (!p.adopted || !p.path) return;
  const home = p.path.replace(/^\/(Users|home)\/[^/]+/, "~");
  return [`In your existing checkout ${home}, as it was`, p.first_open ? `${plural(p.first_open, "worktree")} set up on first open` : "", p.note ?? ""].filter(Boolean).join(" · ");
}

