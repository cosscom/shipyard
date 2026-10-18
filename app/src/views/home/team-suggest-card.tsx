import { Button } from "@/components/ui/button";
import { notNow, reviewSuggestion, useHomeSuggestions } from "@/lib/team-suggest";
import { orgName, projectsLine } from "@/lib/team-suggest-model";
import { GitHubMark } from "@/views/team/team-parts";

// TeamSuggestCards are Home's one-time word that an org the person's
// projects come from publishes a team setup (lib/team-suggest.ts). Not now
// puts the card away for good; the sidebar and Project settings keep
// their quieter hints until the setup is reviewed or turned down.
export function TeamSuggestCards() {
  const cards = useHomeSuggestions();
  if (!cards.length) return null;
  return (
    <div className="mt-5 w-full space-y-2">
      {cards.slice(0, 2).map((s) => (
        <section key={s.org} aria-label={`${orgName(s)} has a team setup`} data-testid="team-suggest-card" className="flex items-center gap-3 rounded-xl border bg-card/60 px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
            <GitHubMark className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-row">{orgName(s)} has a team setup</h2>
            <p className="text-pretty text-desc text-muted-foreground">
              For {projectsLine(s)}, in <span className="font-mono">{s.repo}</span>. Nothing runs until you review it.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => notNow(s.org)}>
              Not now
            </Button>
            <Button size="xs" variant="outline" onClick={() => reviewSuggestion(s)}>
              Review…
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
