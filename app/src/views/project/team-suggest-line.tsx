import { UsersRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dismissSuggestion, reviewSuggestion, useProjectSuggestion } from "@/lib/team-suggest";
import { orgName, sentence, setsUpLine } from "@/lib/team-suggest-model";
import { openTeamKit } from "@/views/team/team-kit-sheet";

// TeamSuggestLine is Project settings' word that the project's org
// publishes a team setup the person hasn't accepted (lib/team-suggest.ts):
// what it sets up for this repo, as it declares it, with Review… (the Team
// setup page, using this clone as it is) and Not for me (no more
// suggestions for the org).
export function TeamSuggestLine({ box, location }: { box: string; location: string }) {
  const found = useProjectSuggestion(box, location);
  if (!found) return null;
  const { suggestion: s, project: p } = found;
  return (
    <section aria-label="Team setup" data-testid="team-suggest-line" className="flex items-start gap-3 rounded-xl border bg-card/40 px-4 py-3">
      <UsersRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="text-section">Team setup</h2>
        <p className="mt-0.5 text-desc text-muted-foreground">
          {sentence(setsUpLine(s, p))}{" "}
          {p.kit_applied ? `This project follows its kit; the rest waits until you review it.` : "Nothing changes here until you review it and set it up."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void dismissSuggestion(s)}>
          Not for me
        </Button>
        {p.kit && !p.kit_applied && (
          <Button size="xs" variant="ghost" data-testid="team-suggest-kit" onClick={() => openTeamKit({ org: s.org, name: orgName(s), box, location })}>
            Use {s.org}'s kit…
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => reviewSuggestion(s, box)}>
          Review…
        </Button>
      </div>
    </section>
  );
}
