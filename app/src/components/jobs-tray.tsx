import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleStopIcon, MinusIcon, XIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cancelJob, dismissJob, FADE_MS, type Job, type JobItem, leftOver, outcomeOf, progressOf, setFolded, settled, useJobs } from "@/lib/jobs";
import { cn } from "@/lib/utils";

// The background-jobs tray (lib/jobs.ts): bottom right, above the status
// bar (26px) and the loops panel (--berth-loops-h), and above a bar floating
// at a page's bottom (--berth-bar-lift, hooks/lift-toasts.ts) so it never
// hides the bar's buttons. Toasts stack above it through --berth-jobs-h. Jobs stack newest on top. Folded, it is
// one line with the progress. With no jobs it is gone and reserves no room.
const STATUS_BAR = 26;
const GAP = 12;
const FADE = 700;

export function JobsTray() {
  const jobs = useJobs((s) => s.jobs);
  const folded = useJobs((s) => s.folded);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) {
      root.style.setProperty("--berth-jobs-h", "0px");
      return;
    }
    // Hidden (Settings), it takes no room.
    const sync = () => root.style.setProperty("--berth-jobs-h", `${el.offsetHeight ? el.offsetHeight + GAP : 0}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--berth-jobs-h", "0px");
    };
  }, [jobs.length, folded]);

  if (!jobs.length) return null;
  const style = { bottom: `max(calc(var(--berth-status-h, ${STATUS_BAR}px) + ${GAP}px + var(--berth-loops-h, 0px)), var(--berth-bar-lift, 0px))`, right: `calc(${GAP}px + var(--berth-dock-w, 0px))` };
  if (folded) {
    const outcomes = jobs.map(outcomeOf);
    const all = jobs.flatMap((j) => j.items);
    const label = jobs.length === 1 ? lineOf(jobs[0]) : `${jobs.length} jobs${outcomes.includes("running") ? ` · ${all.filter(settled).length}/${all.length}` : ""}`;
    return (
      <div ref={ref} style={style} className="fixed z-40" role="region" aria-label="Background jobs">
        <Button size="sm" variant="outline" className="max-w-88 rounded-full bg-popover shadow-lg/5" onClick={() => setFolded(false)} aria-expanded={false}>
          <OutcomeIcon outcome={outcomes.includes("running") ? "running" : outcomes.includes("report") ? "report" : "clean"} />
          <span className="truncate tabular-nums">{label}</span>
          <ChevronUpIcon />
        </Button>
      </div>
    );
  }
  return (
    <div ref={ref} style={style} className="fixed z-40 flex max-h-[50vh] w-88 flex-col gap-2 overflow-y-auto" role="region" aria-label="Background jobs">
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}

// lineOf is a job in one line: what it is doing and how far it got (a
// one-row job just says what it is doing), or, once done, what it did.
function lineOf(j: Job) {
  if (j.summary !== undefined) return j.summary;
  const p = progressOf(j);
  return p.total > 1 ? `${j.title} · ${p.settled}/${p.total}` : j.title;
}

function OutcomeIcon({ outcome }: { outcome: ReturnType<typeof outcomeOf> }) {
  if (outcome === "running") return <Spinner className="size-3.5 shrink-0" />;
  if (outcome === "report") return <AlertTriangleIcon className="size-3.5 shrink-0 text-warning-foreground" />;
  return <CheckIcon className="size-3.5 shrink-0 text-success" />;
}

const JobCard = memo(function JobCard({ job: j }: { job: Job }) {
  const outcome = outcomeOf(j);
  const fading = useFading(j, outcome === "clean");
  // Running, every row; a report, only what didn't go as asked; clean,
  // just the summary.
  const rows = outcome === "running" ? j.items : outcome === "report" ? leftOver(j) : [];
  const groups = [...new Set(rows.map((i) => i.group))].sort();
  const unsent = j.items.some((i) => i.state === "queued");
  return (
    <div
      role="group"
      aria-label={j.title}
      className={cn(
        "rounded-xl border bg-popover p-3 text-body shadow-lg/5 transition-opacity",
        outcome === "report" && "border-warning/60",
        outcome === "clean" && "border-success/40",
        fading && "opacity-0",
      )}
      style={{ transitionDuration: `${FADE}ms` }}
    >
      <div className="flex items-center gap-2">
        <OutcomeIcon outcome={outcome} />
        <span className="min-w-0 flex-1 break-words font-medium tabular-nums">
          {lineOf(j)}
        </span>
        <Tip label="Fold">
          <Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground" aria-label="Fold" aria-expanded onClick={() => setFolded(true)}>
            <ChevronDownIcon />
          </Button>
        </Tip>
        {outcome !== "running" && (
          <Tip label="Dismiss">
            <Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground" aria-label="Dismiss" onClick={() => dismissJob(j.id)}>
              <XIcon />
            </Button>
          </Tip>
        )}
      </div>
      {rows.length > 0 && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border">
          {groups.map((g) => {
            const group = rows.filter((i) => i.group === g);
            const all = j.items.filter((i) => i.group === g);
            return (
              <div key={g}>
                {groups.length > 1 || (outcome === "running" && j.items.length > 1) ? (
                  <div className="sticky top-0 z-1 flex items-center gap-2 border-b bg-muted/80 px-3 py-1 font-mono text-meta text-muted-foreground backdrop-blur-sm">
                    <span className="flex-1">{g}</span>
                    {outcome === "running" && (
                      <span className="tabular-nums">
                        {all.filter(settled).length}/{all.length}
                      </span>
                    )}
                  </div>
                ) : null}
                <ul className="divide-y divide-border/60">
                  {group.map((i) => (
                    <JobRow key={i.key} item={i} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {outcome === "running" && j.cancellable && unsent && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={j.cancelling} onClick={() => cancelJob(j.id)}>
            <CircleStopIcon />
            {j.cancelling ? "Stopping the rest…" : "Stop the rest"}
          </Button>
        </div>
      )}
    </div>
  );
});

// useFading starts a clean job's fade just before the store lets it go.
function useFading(j: Job, clean: boolean) {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!clean || j.finished === undefined) return;
    const t = setTimeout(() => setFading(true), Math.max(0, j.finished + FADE_MS - FADE - Date.now()));
    return () => clearTimeout(t);
  }, [clean, j.finished]);
  return fading;
}

// How a row looks in each state: its icon, and the colour of its message.
const looks: Record<JobItem["state"], { icon: ReactNode; tone: string }> = {
  queued: { icon: <MinusIcon className="size-3.5 text-muted-foreground" />, tone: "text-muted-foreground" },
  running: { icon: <Spinner className="size-3.5" />, tone: "text-muted-foreground" },
  done: { icon: <CheckIcon className="size-3.5 text-success" />, tone: "text-muted-foreground" },
  kept: { icon: <AlertTriangleIcon className="size-3.5 text-warning-foreground" />, tone: "text-warning-foreground" },
  cancelled: { icon: <AlertTriangleIcon className="size-3.5 text-warning-foreground" />, tone: "text-warning-foreground" },
  failed: { icon: <XIcon className="size-3.5 text-destructive-foreground" />, tone: "text-destructive-foreground" },
};

const JobRow = memo(function JobRow({ item: i }: { item: JobItem }) {
  const look = looks[i.state];
  return (
    <li className="flex items-start gap-2.5 px-3 py-1.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{look.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="max-w-[70%] shrink-0 truncate">{i.label}</span>
          {i.aside && <span className="min-w-0 truncate text-muted-foreground text-meta">{i.aside}</span>}
        </span>
        {i.message && (
          <span className={cn("block whitespace-normal break-words text-meta", look.tone)}>{i.message}</span>
        )}
      </span>
    </li>
  );
});
