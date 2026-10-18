import { CircleArrowUpIcon, RefreshCwIcon } from "lucide-react";

import { ErrorDetails } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { explain } from "@/lib/errors";
import { updateBoxes, useOutdated, useOutdatedBoxes } from "@/lib/outdated";
import { cn } from "@/lib/utils";

// UpgradeBox updates a box's berthd to the build this Shipyard ships: the same
// upgrade as Settings → Boxes and the status bar's Update all, sharing their
// progress, so pressing it in one place shows it running in all of them.
// Agents keep running; once the box answers with the new build, whatever
// was waiting on it loads by itself.
export function UpgradeBox({ box, size = "default", variant = "default", label, className }: { box: string; size?: "default" | "sm" | "xs"; variant?: "default" | "outline" | "ghost"; label?: string; className?: string }) {
  const u = useOutdated((s) => s.updating[box]);
  const busy = u?.state === "queued" || u?.state === "running";
  const button = (
    <Button size={size} variant={variant} className={className} onClick={() => void updateBoxes([box])} disabled={busy}>
      {busy ? <Spinner /> : <RefreshCwIcon />}
      {busy ? (u?.state === "queued" ? `${box} is next…` : `Updating ${box}…`) : (label ?? `Update ${box}`)}
    </Button>
  );
  // While it runs, the upgrade's latest line is a hover away.
  return busy && u?.line ? <Tip label={u.line}>{button}</Tip> : button;
}

// useUpdateAll is the app-wide notice's state: the outdated boxes, which
// are being updated, and Update all.
export function useUpdateAll() {
  const outdated = useOutdatedBoxes();
  const updating = useOutdated((s) => s.updating);
  const active = Object.entries(updating).filter(([, u]) => u.state === "queued" || u.state === "running");
  const running = active.find(([, u]) => u.state === "running")?.[0];
  const total = active.length + Object.values(updating).filter((u) => u.state === "done").length;
  const done = Object.values(updating).filter((u) => u.state === "done").length;
  return {
    outdated,
    busy: active.length > 0,
    running,
    progress: active.length ? `${Math.min(done + 1, total)} of ${total}` : undefined,
    updateAll: () => void updateBoxes(outdated),
  };
}

// OutdatedNotice is the calm, app-wide line: "2 boxes run an older berthd
// — Update all", with progress while it runs. Not a modal; nothing waits
// on it.
export function OutdatedNotice({ className }: { className?: string }) {
  const { outdated, busy, running, progress, updateAll } = useUpdateAll();
  if (!outdated.length && !busy) return null;
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-info/32 bg-info/4 px-3 py-2 text-body", className)}>
      <CircleArrowUpIcon className="size-4 shrink-0 text-info" />
      <span className="min-w-0 flex-1">
        {busy ? (
          <>
            Updating {running ?? "boxes"}… <span className="text-muted-foreground">({progress}) Agents keep running.</span>
          </>
        ) : (
          <>
            {outdated.length === 1 ? `${outdated[0]} runs` : `${outdated.length} boxes run`} an older berthd.{" "}
            <span className="text-muted-foreground">Updating keeps {outdated.length === 1 ? "its" : "their"} agents running.</span>
          </>
        )}
      </span>
      <Button size="xs" variant="outline" disabled={busy} onClick={updateAll}>
        {busy ? <Spinner /> : <RefreshCwIcon />}
        {busy ? "Updating…" : outdated.length === 1 ? `Update ${outdated[0]}` : "Update all"}
      </Button>
    </div>
  );
}

// BoxError is what a view says when a box couldn't give it what it asked
// for: the one-click update when the box is too old for it, or else the
// error in plain words with the box's own behind Details.
export function BoxError({ box, error, what, className }: { box: string; error: string; what: string; className?: string }) {
  const e = explain(error, { box });
  if (e.step === "update-box") {
    return (
      <NeedsUpdate box={box} className={className}>
        <span className="font-medium">{box}</span> runs an older berthd without {what}. Updating keeps its agents running.
      </NeedsUpdate>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1 text-muted-foreground text-meta", className)}>
      <span>
        <span className="font-medium text-foreground">{box}</span>: couldn't read {what}. {e.message}
      </span>
      <ErrorDetails text={e.details} />
    </div>
  );
}

// NeedsUpdate is the inline note a feature shows on a box too old for it:
// what's missing, and the one button that fixes it.
export function NeedsUpdate({ box, children, className }: { box: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-info/32 bg-info/4 px-3 py-2 text-body", className)}>
      <span className="min-w-0 flex-1">{children}</span>
      <UpgradeBox box={box} size="xs" variant="outline" />
    </div>
  );
}
