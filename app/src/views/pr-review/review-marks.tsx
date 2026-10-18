import { ArrowRightIcon, GitPullRequestIcon } from "lucide-react";

import { Tip } from "@/components/tip";
import type { Location, Worktree } from "@/lib/api";
import { openUpdate, reviewOf, shortSha, statusKey, usePrReview } from "@/lib/pr-review";
import { cn } from "@/lib/utils";
import { useReviewStatus } from "@/views/pr-review/use-review-status";

// What the sidebar says about a review worktree: a small Review badge on its
// row, and under it, when there is something to do, one quiet line: the PR
// gained commits since the review was opened (Update to latest shows the
// sheet again), or the review is due for clean-up but has uncommitted
// changes, so it waits for you.

export function ReviewTag({ box, wt }: { box: string; wt: Worktree }) {
  const r = reviewOf(wt);
  const st = useReviewStatus(box, wt.path);
  if (!r) return null;
  const n = st?.new_commits ?? 0;
  return (
    <Tip label={`A review of ${r.repo}#${r.pr}${r.author ? ` by ${r.author}` : ""}, pinned at ${shortSha(r.sha)}${n ? `. ${n} new ${n === 1 ? "commit" : "commits"} since you opened it` : ""}`}>
      <span
        data-testid="review-badge"
        role="img"
        aria-label="Review"
        className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-sm", n ? "bg-info/12 text-info-foreground" : "bg-muted text-muted-foreground")}
      >
        <GitPullRequestIcon className="size-2.5" />
      </span>
    </Tip>
  );
}

const CLEANUP_WORDS = {
  merged: "PR merged",
  closed: "PR closed",
  idle: "Idle for a while",
};

export function ReviewNotice({ box, loc, wt, onRemove }: { box: string; loc: Location; wt: Worktree; onRemove(): void }) {
  const r = reviewOf(wt);
  const st = useReviewStatus(box, wt.path);
  const kept = usePrReview((s) => !!s.kept[statusKey(box, wt.path)]);
  if (!r) return null;
  if (r.cleanup && !kept) {
    return (
      <div data-testid="review-cleanup" className="ml-6 flex flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pb-1 text-tag text-muted-foreground">
        <span>{CLEANUP_WORDS[r.cleanup]}. Remove this review? It has uncommitted changes.</span>
        <span className="flex gap-1.5">
          <button type="button" className="font-medium text-foreground hover:underline" onClick={onRemove}>
            Remove…
          </button>
          <button
            type="button"
            className="hover:text-foreground hover:underline"
            onClick={() =>
              usePrReview.setState((s) => ({
                kept: { ...s.kept, [statusKey(box, wt.path)]: true },
              }))
            }
          >
            Keep
          </button>
        </span>
      </div>
    );
  }
  const n = st?.new_commits ?? 0;
  if (!n && !st?.forced) return null;
  return (
    <p data-testid="review-new-commits" className="ml-6 flex items-start gap-1.5 pr-2 pb-1 text-tag text-muted-foreground">
      <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-info" />
      <span className="min-w-0">
        {st?.forced && !n ? "The PR was rewritten since you opened it." : `${n} new ${n === 1 ? "commit" : "commits"} since you opened it.`}{" "}
        <button type="button" data-testid="review-update" className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline" onClick={() => openUpdate(box, loc, wt)}>
          Update to latest <ArrowRightIcon className="size-3" />
        </button>
      </span>
    </p>
  );
}
