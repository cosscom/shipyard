import type { RunEvaluation, RunVersion } from "@berth/plugin";
import { ChevronRightIcon, CircleXIcon, HistoryIcon, ListChecksIcon, RefreshCwIcon, RotateCcwIcon, ScaleIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { ago } from "@/lib/format";
import { type EvaluationKind, evaluationKind, previousOf, splitEvaluations, versionLabel, whatChanged } from "@/lib/judge-evaluations";
import type { RunCompare } from "@/lib/orchestrate-core";
import { cn } from "@/lib/utils";

// JudgePanel is the judge's say on an attempts run in Review's Compare: the
// current evaluation (a verdict, the checks' pick standing in for one, or a
// failure), when it ran and which versions of the worktrees it saw, a rerun
// in flight, and the earlier evaluations to compare it with.

const kinds: Record<Exclude<EvaluationKind, "running">, { title: string; badge?: string; variant: "warning" | "error" | "info" | "outline"; icon: typeof ScaleIcon; tone: string; box: string }> = {
  verdict: { title: "Judge's verdict", variant: "outline", icon: ScaleIcon, tone: "text-primary", box: "bg-muted/30" },
  checks: { title: "Picked by the checks", variant: "info", icon: ListChecksIcon, tone: "text-info-foreground", box: "bg-muted/30" },
  fallback: { title: "No valid verdict from the judge", badge: "Fallback: the checks' pick", variant: "warning", icon: TriangleAlertIcon, tone: "text-warning-foreground", box: "border-warning/40 bg-warning/4" },
  failed: { title: "The judge gave no verdict", badge: "Failed", variant: "error", icon: CircleXIcon, tone: "text-destructive-foreground", box: "border-destructive/40 bg-destructive/4" },
  stopped: { title: "The judge stopped before it answered", badge: "Stopped", variant: "outline", icon: CircleXIcon, tone: "text-muted-foreground", box: "bg-muted/30" },
};

const badgeOf: Record<EvaluationKind, string> = { verdict: "Judge's verdict", checks: "By the checks", fallback: "Fallback by checks", failed: "No verdict", stopped: "Stopped", running: "Judging" };
const badgeVariant: Record<EvaluationKind, "outline" | "info" | "warning" | "error"> = { verdict: "outline", checks: "info", fallback: "warning", failed: "error", stopped: "outline", running: "outline" };

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export function JudgePanel({ label, data, busy, onRerun }: { label?: string; data: RunCompare; busy: boolean; onRerun(): void }) {
  const evs = data.evaluations ?? [];
  const { current, running, earlier } = splitEvaluations(evs);
  if (!current && !running && !data.judge && !data.can_rejudge) return null;
  const kind = current ? evaluationKind(current) : undefined;
  const k = kind && kind !== "running" ? kinds[kind] : undefined;
  const judging = !!running || busy;
  const retry = kind === "fallback" || kind === "failed" || kind === "stopped";
  const Icon = k?.icon ?? ScaleIcon;
  const changed = current && whatChanged(previousOf(evs, current), current);
  const name = label ? ` ${label}` : "";
  return (
    <section aria-label={`Judge${name}`} data-evaluation={kind ?? "none"} className={cn("mb-4 rounded-xl border px-4 py-3", k?.box ?? "bg-muted/30")}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", k?.tone ?? "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-row">
              {k?.title ?? "Judge"}
              {name}
            </p>
            {k?.badge && (
              <Badge variant={k.variant} size="sm">
                {k.badge}
              </Badge>
            )}
          </div>
          {current && (
            <p className="mt-0.5 text-meta text-muted-foreground">
              Evaluation {current.n}
              {current.rerun ? ", a rerun" : ", the run's own"}
              {current.agent && current.by === "agent" ? ` by ${current.agent}` : ""} ·{" "}
              <Tip label={when(current.ended ?? current.started)}>
                <span tabIndex={0} className="underline decoration-dotted underline-offset-2">
                  ran {ago(current.ended ?? current.started)}
                </span>
              </Tip>
            </p>
          )}
        </div>
        {data.can_rejudge && (
          <Tip label={judging ? "The judge is looking at the attempts as they are now" : "Judge the attempts again as their worktrees are now. The agents keep working; nothing is picked or archived."}>
            <Button size="xs" variant={retry ? "default" : "outline"} disabled={judging} onClick={onRerun}>
              {judging ? <Spinner className="size-3.5" /> : retry ? <RotateCcwIcon /> : <RefreshCwIcon />}
              {judging ? "Judging…" : retry ? "Retry" : "Rerun judge"}
            </Button>
          </Tip>
        )}
      </div>

      <div className="mt-2 space-y-1.5 pl-7 text-body">
        <Outcome ev={current} legacy={data.judge} />
        {changed && (
          <p className="flex items-center gap-1.5 text-meta text-muted-foreground">
            <HistoryIcon className="size-3.5" />
            Since evaluation {previousOf(evs, current!)!.n}: {changed}.
          </p>
        )}
        {current?.versions?.length ? <Versions versions={current.versions} /> : null}
        {running && (
          <p aria-live="polite" className="flex items-center gap-2 text-meta text-muted-foreground">
            <Spinner className="size-3.5" />
            Evaluation {running.n}: judging the attempts as they are now, started {ago(running.started)}. The worktrees stay as they are, and the pick stays yours.
          </p>
        )}
        {earlier.length > 0 && <Earlier evs={earlier} all={evs} />}
      </div>
    </section>
  );
}

function Outcome({ ev, legacy }: { ev?: RunEvaluation; legacy?: string }) {
  if (!ev) return legacy ? <p>{legacy}</p> : <p className="text-muted-foreground">The judge hasn't ranked these attempts yet.</p>;
  switch (evaluationKind(ev)) {
    case "fallback":
      return (
        <>
          <p className="text-warning-foreground">{sentence(ev.error ?? "the judge's reply was not valid")}</p>
          <p>
            By the checks instead: attempt {ev.winner! + 1}, whose check passed with the smallest diff. <span className="text-muted-foreground">This is a fallback, not the judge's verdict. Retry to ask the judge again.</span>
          </p>
        </>
      );
    case "failed":
      return (
        <>
          <p className="text-destructive-foreground">{sentence(ev.error ?? "the judge gave no verdict")}</p>
          <p className="text-muted-foreground">No attempt passed its check to fall back on. Retry, or pick one yourself.</p>
        </>
      );
    case "stopped":
      return <p className="text-muted-foreground">{sentence(ev.error ?? "stopped before the judge answered")} Retry to ask again.</p>;
    default:
      return <p>{ev.output}</p>;
  }
}

function Versions({ versions, compact }: { versions: RunVersion[]; compact?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-meta", !compact && "text-muted-foreground")}>
      {!compact && <span>Judged</span>}
      {[...versions]
        .sort((a, b) => a.index - b.index)
        .map((v) => (
          <Tip key={v.index} label={`Attempt ${v.index + 1} at ${v.head ?? "an unknown commit"}${v.dirty ? ", with changes not committed" : ""}: ${v.files} files +${v.added} −${v.removed}, ${v.commits} commits, check ${v.passed ? "passed" : "failed"}`}>
            <span tabIndex={0} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground" data-version={v.index}>
              <span>#{v.index + 1}</span>
              <span className="font-mono text-foreground/80">{versionLabel(v)}</span>
            </span>
          </Tip>
        ))}
    </div>
  );
}

function Earlier({ evs, all }: { evs: RunEvaluation[]; all: RunEvaluation[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 pt-0.5 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
        Earlier evaluations ({evs.length})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol className="mt-2 space-y-2 border-l pl-3" aria-label="Earlier evaluations">
          {evs.map((ev) => {
            const kind = evaluationKind(ev);
            const changed = whatChanged(previousOf(all, ev), ev);
            return (
              <li key={ev.n} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-meta">
                  <span className="text-foreground">Evaluation {ev.n}</span>
                  <Badge variant={badgeVariant[kind]} size="sm">
                    {badgeOf[kind]}
                  </Badge>
                  <Tip label={when(ev.ended ?? ev.started)}>
                    <span tabIndex={0} className="text-muted-foreground">
                      {ago(ev.ended ?? ev.started)}
                    </span>
                  </Tip>
                </div>
                <Line>{kind === "fallback" || kind === "failed" || kind === "stopped" ? sentence(ev.output ?? ev.error ?? "") : ev.output}</Line>
                {changed && (
                  <Line muted>
                    Since evaluation {previousOf(all, ev)!.n}: {changed}.
                  </Line>
                )}
                {ev.versions?.length ? <Versions versions={ev.versions} compact /> : null}
              </li>
            );
          })}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const Line = ({ children, muted }: { children: ReactNode; muted?: boolean }) => <p className={cn("text-meta", muted ? "text-muted-foreground" : "text-foreground/90")}>{children}</p>;

// currentPick is the attempt the current evaluation picked and how: the
// judge's verdict, or the checks' (by check, or standing in for the judge).
export function currentPick(data: RunCompare): { index: number; kind: EvaluationKind } | undefined {
  const { current } = splitEvaluations(data.evaluations);
  if (!current || current.winner === undefined) return undefined;
  return { index: current.winner, kind: evaluationKind(current) };
}

// seenVersion is the version of an attempt the current evaluation saw.
export function seenVersion(data: RunCompare, index: number): RunVersion | undefined {
  return splitEvaluations(data.evaluations).current?.versions?.find((v) => v.index === index);
}
