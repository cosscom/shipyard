import { HeaderBand, useHeaderPicture } from "@/components/art/header-band";
import { Scene } from "@/components/art/scenes";
import { TaskComposer } from "@/components/conversation/task-composer";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/lib/prefs";
import { HomeGrid } from "@/views/home/widgets/grid";
import { TeamSuggestCards } from "@/views/home/team-suggest-card";
import { setSwitchboardOpen } from "@/lib/switchboard";
import { Layers3Icon } from "lucide-react";
import { platformKeys } from "@/lib/platform";

// HomeView is the workspace before any worktree is open: one composer to
// start work (lib/composer), then the person's own grid of widgets
// (views/home/widgets): the agents that need them, pull requests, their
// boxes, whatever they put there. Labs puts the header picture (the
// harbour unless chosen otherwise) across the top, dissolving into the
// page, with the composer at the seam.
const BAND = "clamp(220px, 50vh, 500px)";

export function HomeView() {
  const labs = usePrefs((p) => p.labs);
  const picture = useHeaderPicture();
  const band = labs ? picture : undefined;
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="relative min-h-full">
        {band && <HeaderBand picture={band} position={0.42} fade={0.45} className="absolute inset-x-0 top-0" style={{ height: BAND }} />}
        <div className="relative mx-auto flex w-full max-w-[640px] flex-col items-center px-6 pb-10" style={{ paddingTop: band ? `calc(${BAND} - 84px)` : "clamp(48px, 16vh, 160px)" }}>
          {!labs && (
            <div aria-hidden className="mb-2">
              <Scene name="dawn" width={136} />
            </div>
          )}
          <h1 className={cn("mb-4 text-balance text-center font-heading text-page-title", band && "[text-shadow:0_0_6px_var(--background),0_0_16px_var(--background)]")}>What should your agents work on?</h1>
          <TaskComposer autoFocus />
          <button type="button" onClick={() => setSwitchboardOpen(true)} className="mt-3 inline-flex items-center gap-2 rounded-lg border bg-background/80 px-3 py-1.5 text-meta text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground">
            <Layers3Icon className="size-3.5" /> Open Switchboard <span className="ml-2 font-mono">{platformKeys("⌘⇧K")}</span>
          </button>
          <TeamSuggestCards />
        </div>
        <div className="relative mx-auto w-full max-w-[1180px] px-6 pb-12">
          <HomeGrid />
        </div>
      </div>
    </div>
  );
}
