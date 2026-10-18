import { UsersRoundIcon } from "lucide-react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { LocationConfig, RepoConfig } from "@/lib/flows";
import { Section, SourceBadge } from "@/views/project/parts";

// ReviewButtonSection is the project's "Review in Shipyard" button: when it
// is on, berthd adds the button to the description of each PR opened from
// one of the project's worktrees, once (box/reviewbutton.go). It is off
// unless the committed config, the kit or the team's team.json turns it on;
// this box can turn it on or off for itself.
export function ReviewButtonSection({ config, draft, setDraft, box }: { config: LocationConfig; draft: RepoConfig; setDraft(c: RepoConfig): void; box: string }) {
  const st = config.review_button;
  const inherited = st?.inherited ?? false;
  const own = draft.review_button;
  const on = own ?? inherited;
  const from = own !== undefined ? (st?.inherited_from ? "override" : "box") : st?.inherited_from;
  return (
    <Section
      id="review-button"
      title="Review button"
      description={
        <>
          Adds a <span className="text-foreground">Review in Shipyard</span> button to the description of each PR opened from this project's worktrees, so a teammate opens it on their own box in one click. Never for a fork's PR or one from outside the org.
        </>
      }
    >
      <div className="flex items-center gap-4 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-row">
            Add the button to new PRs
            {from === "team" ? (
              <Tip label="Turned on for every engineer by the team's team.json">
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-tag text-muted-foreground">
                  <UsersRoundIcon className="size-3" />
                  Team
                </span>
              </Tip>
            ) : (
              from && <SourceBadge source={from} box={box} />
            )}
          </div>
          <p className="mt-0.5 text-desc text-muted-foreground">
            Added once, below everything else, and never changes the rest of the description. Agents can set who it logs in as and which page it opens with <code className="rounded bg-muted px-1 py-px font-mono text-tag">berthd review-button --as EMAIL --path /x</code>.
          </p>
        </div>
        {own !== undefined && st?.inherited_from ? (
          <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, review_button: undefined })}>
            Use the {st.inherited_from === "team" ? "team's" : st.inherited_from === "kit" ? "kit's" : "repo's"} setting
          </Button>
        ) : null}
        <Switch
          checked={on}
          onCheckedChange={(v) => setDraft({ ...draft, review_button: st?.inherited_from ? (v === inherited ? undefined : v) : v || undefined })}
          aria-label="Add the Review in Shipyard button to new PRs"
          data-testid="review-button-switch"
        />
      </div>
    </Section>
  );
}
