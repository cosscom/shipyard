import { XIcon } from "lucide-react";
import { Suspense } from "react";

import { Tip } from "@/components/tip";
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

// WhatsNewNudge is the note at the foot of the sidebar after an update: one
// quiet line above the boxes, what's in it in its tip.
export function WhatsNewNudge() {
  const { nudge, release } = useWhatsNew();
  if (!nudge || !release) return null;
  const [a, b] = release.items;
  return (
    <div className="flex h-7 shrink-0 items-center gap-0.5 pr-[11px] pl-3.5 text-meta" data-testid="whats-new-nudge" role="region" aria-label="What's new">
      <Tip label={`${a.title}, ${b.title.toLowerCase()} and more.`} side="top" align="start">
        <span className="min-w-0 flex-1 truncate pl-2.5 font-medium text-foreground/80">New in Shipyard {release.version}</span>
      </Tip>
      <Button size="xs" variant="ghost" className="shrink-0 px-1.5 font-medium text-foreground" onClick={() => openWhatsNew("update", release)}>
        See what's new
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" className="shrink-0 text-muted-foreground" onClick={dismissNudge}>
        <XIcon />
      </Button>
    </div>
  );
}
