import { CloudOffIcon, TriangleAlertIcon } from "lucide-react";

import { type SendFailure, boxOffline } from "@/lib/queue";
import { cn } from "@/lib/utils";

// When a box is away, a send dialog offers to queue the prompt instead of
// only failing: the laptop agent types it in once the box is back.

// offlineOffer is the offer a dialog opens with when the agent already
// knows the box is away, so the person need not wait out a send first.
export const offlineOffer = (box: string): SendFailure | undefined => (boxOffline(box) ? { kind: "offline", message: `${box} is offline.` } : undefined);

// queueLabel is the dialog's main button while an offer stands.
export const queueLabel = (f: SendFailure, box: string) => (f.kind === "offline" ? `Queue for when ${box} is back` : "Queue anyway");

export function QueueOffer({ failure, box, className }: { failure: SendFailure; box: string; className?: string }) {
  const offline = failure.kind === "offline";
  const Icon = offline ? CloudOffIcon : TriangleAlertIcon;
  return (
    <div role="status" className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-desc", offline ? "border-info/24 bg-info/6" : "border-warning/32 bg-warning/8", className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", offline ? "text-info-foreground dark:text-info" : "text-warning-foreground dark:text-warning")} />
      <div className="min-w-0">
        <p className="font-medium">{failure.message}</p>
        <p className="text-muted-foreground text-meta">
          {offline
            ? `Shipyard can keep the prompt on this Mac and type it in when ${box} is back, after the agent's current turn. It's listed under Queued in the status bar.`
            : "Queue it only if you're sure it didn't arrive; otherwise the agent gets it twice."}
        </p>
      </div>
    </div>
  );
}
