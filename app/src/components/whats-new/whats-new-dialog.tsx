import { XIcon } from "lucide-react";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { lazyView } from "@/lib/lazy-view";
import { dismissNudge, openWhatsNew, useWhatsNew } from "@/lib/whats-new";

// The What's new card itself (spotlight.tsx) loads after the app has
// started: most starts have no release to show.
const SpotlightCard = lazyView(() => import("@/components/whats-new/spotlight").then((m) => m.SpotlightCard));

export function WhatsNewDialog() {
  const { open, release } = useWhatsNew();
  if (!release) return null;
  return (
    <Suspense>
      <SpotlightCard open={open} release={release} />
    </Suspense>
  );
}

// WhatsNewNudge is the note at the foot of the sidebar after an update.

export function WhatsNewNudge() {
  const { nudge, release } = useWhatsNew();
  if (!nudge || !release) return null;
  const [a, b] = release.items;
  return (
    <div className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-xs" data-testid="whats-new-nudge" role="region" aria-label="What's new">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 font-medium text-xs">New in Shipyard {release.version}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" className="-my-1 -mr-1.5" onClick={dismissNudge}>
            <XIcon />
          </Button>
        </div>
        <span className="text-muted-foreground text-xs leading-snug">
          {a.title}, {b.title.toLowerCase()} and more.
        </span>
      </div>
      <Button size="xs" variant="outline" className="self-start" onClick={() => openWhatsNew("update", release)}>
        See what's new
      </Button>
    </div>
  );
}
