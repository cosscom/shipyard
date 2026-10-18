import { ChevronRightIcon, CircleStopIcon, ClockIcon, CoinsIcon, FlaskConicalIcon, GitCompareArrowsIcon, GitPullRequestIcon, HandIcon, RepeatIcon, WebhookIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { BoxFilter, shownBoxes } from "@/components/box-filter";
import { FilterChip } from "@/components/filter-chip";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { toastManager } from "@/components/ui/toast";
import type { Run, RunStep, RunUsage } from "@/lib/api";
import { ago, errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { ErrorText } from "@/components/error-note";
import { NeedsUpdate } from "@/components/upgrade-box";
import { allRuns, type BoxRun, boxHasRuns, getRun, isActive, runs as runsApi, scheduleRuns, useRuns } from "@/lib/runs";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CATALOG } from "@/views/automations/catalog";
import { STEP_KINDS } from "@/views/automations/flows/model";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import { RunStatus } from "@/views/automations/flows/run-status";
import type { BoxRun as BoxFlowRun } from "@/views/automations/flows/use-runs";

// RunsTab is every run on every box, newest first: flows' runs, loops,
// attempts, reviews, hand-offs and broadcasts, each a timeline of its steps
// read from the run's journal on the box, with what its agents spent where
// they report it. A run waiting at a gate can be decided here. Boxes from
// before runs show their flows' runs as they always did.

type Kind = "" | "flow" | "loop" | "attempts" | "other";
const KINDS: { value: Kind; label: string }[] = [
  { value: "", label: "All runs" },
  { value: "flow", label: "Flows" },
  { value: "loop", label: "Loops" },
  { value: "attempts", label: "Attempts" },
  { value: "other", label: "Reviews, hand-offs, broadcasts" },
];

const kindOf = (t: string): Kind => (t === "flow" || t === "loop" || t === "attempts" ? t : "other");

export function RunsTab({ runs: legacy, boxes, names }: { runs: BoxFlowRun[]; boxes: string[]; names: (box: string, scope: string, id: string) => string }) {
  const byBox = useRuns((s) => s.byBox);
  const [hidden, setHidden] = useState<string[]>(() => load("berth.runs.hiddenBoxes", []));
  const [kind, setKind] = useState<Kind>("");
  const [failed, setFailed] = useState(false);
  const [needsYou, setNeedsYou] = useState(false);
  const hide = (next: string[]) => {
    setHidden(next);
    save("berth.runs.hiddenBoxes", next);
  };
  useEffect(() => {
    for (const b of boxes) if (boxHasRuns(b)) scheduleRuns(b, 0);
  }, [boxes.join(",")]);

  // Boxes with runs list them all; older boxes their flows' runs.
  const fromRuns = allRuns(byBox).filter((r) => boxes.includes(r.box));
  const old: BoxRun[] = legacy
    .filter((r) => !boxHasRuns(r.box))
    .map((r) => ({ id: r.id, box: r.box, template: "flow", flow_id: r.flow, scope: r.scope, status: r.status, created: r.started, updated: r.finished ?? r.started, finished: r.finished, error: r.error, test: r.test, title: names(r.box, r.scope, r.flow) }));
  const all = [...fromRuns, ...old].sort((a, b) => b.created.localeCompare(a.created));

  if (all.length === 0)
    return (
      <Empty className="mt-12">
        <EmptyHeader>
          <EmptyMedia>
            <Scene name="chart" />
          </EmptyMedia>
          <EmptyTitle>No runs yet</EmptyTitle>
          <EmptyDescription>Flows, loops, attempts, reviews and hand-offs run on your boxes and show up here, step by step, with what their agents spent.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const on = shownBoxes(boxes, hidden);
  const shown = all.filter((r) => on.includes(r.box) && (!kind || kindOf(r.template) === kind) && (!failed || r.status === "failed") && (!needsYou || r.status === "waiting_gate"));
  const filtered = on.length < boxes.length || !!kind || failed || needsYou;
  const waiting = all.filter((r) => r.status === "waiting_gate").length;
  const clear = () => {
    hide([]);
    setKind("");
    setFailed(false);
    setNeedsYou(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <SimpleSelect size="sm" className="min-w-0" value={kind} onChange={(v) => setKind(v as Kind)} options={KINDS} />
        </div>
        <Tip label="Runs waiting for you at a gate">
          <FilterChip pressed={needsYou} onPressedChange={setNeedsYou}>
            Needs you{waiting ? ` (${waiting})` : ""}
          </FilterChip>
        </Tip>
        <Tip label="Only runs that failed">
          <FilterChip pressed={failed} onPressedChange={setFailed}>
            Failed
          </FilterChip>
        </Tip>
        {filtered && (
          <Button size="xs" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        )}
        <BoxFilter className="ml-auto" boxes={boxes} hidden={hidden} onChange={hide} />
      </div>
      {shown.length === 0 ? (
        <Empty className="rounded-xl border py-12">
          <EmptyHeader>
            <EmptyTitle>No runs match</EmptyTitle>
            <EmptyDescription>None of the {all.length} runs kept passes every filter.</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" variant="outline" onClick={clear}>
            Clear filters
          </Button>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="grid grid-cols-[20px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_80px_70px] gap-3 border-b px-4 py-2 text-label text-muted-foreground">
            <span />
            <span>Run</span>
            <span>Where</span>
            <span>Started by</span>
            <span>When</span>
            <span className="text-right">Took</span>
          </div>
          <ol className="divide-y divide-border/70">
            {shown.map((r) => (
              <RunRow key={`${r.box}:${r.id}`} run={r} name={r.template === "flow" && r.flow_id ? names(r.box, r.scope ?? "box", r.flow_id) : (r.title ?? r.template)} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const eventLabel = (type: string) => CATALOG.find((e) => e.on === type)?.label;

const TEMPLATE_LABEL: Record<string, string> = { loop: "Loop", attempts: "Attempts", review: "Review", handoff: "Hand-off", broadcast: "Broadcast", "fix-ci": "Fix CI", "address-review": "Review comments", exec: "Command" };

export function took(r: { created: string; finished?: string }): string {
  const ms = (r.finished ? new Date(r.finished).getTime() : Date.now()) - new Date(r.created).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function tokens(u?: RunUsage): string {
  if (!u) return "";
  const n = (u.input ?? 0) + (u.output ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
  const k = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  return [n ? `${k} tokens` : "", u.usd ? `$${u.usd.toFixed(2)}` : ""].filter(Boolean).join(" · ");
}

function startedBy(r: BoxRun) {
  const origin = r.origin ?? "";
  if (r.test)
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <FlaskConicalIcon className="size-3" />
        Test run
      </span>
    );
  if (origin === "schedule" || /^schedule/.test(r.idem_key ?? ""))
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ClockIcon className="size-3" />
        Scheduled
      </span>
    );
  if ((r.idem_key ?? "").startsWith("github:"))
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <GitPullRequestIcon className="size-3" />
        GitHub
      </span>
    );
  if ((r.idem_key ?? "").startsWith("webhook:"))
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <WebhookIcon className="size-3" />
        Webhook
      </span>
    );
  const who = origin.startsWith("laptop:") ? origin.slice(7) : origin.startsWith("flow:") ? eventLabel(r.template) ?? "Its trigger" : origin || "—";
  return <span className="text-muted-foreground">{who}</span>;
}

function RunRow({ run: r, name }: { run: BoxRun; name: string }) {
  const [open, setOpen] = useState(r.status === "waiting_gate");
  const where = r.path?.split("/").pop();
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} className="grid w-full grid-cols-[20px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_80px_70px] min-h-row items-center gap-3 px-4 py-1 text-left text-body hover:bg-accent/40">
        <RunStatus status={r.status} />
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="truncate font-medium">{name}</span>
          {r.template !== "flow" && (
            <Badge variant="outline" size="sm" className="shrink-0 text-muted-foreground">
              {TEMPLATE_LABEL[r.template] ?? r.template}
            </Badge>
          )}
          {r.status === "waiting_gate" && (
            <Badge variant="warning" size="sm" className="shrink-0">
              <HandIcon />
              Needs you
            </Badge>
          )}
        </span>
        {r.scope && r.scope !== "box" ? <ProjectLabel box={r.box} scope={r.scope} className="text-meta text-muted-foreground" /> : <span className="truncate text-meta text-muted-foreground">{[r.box, where].filter(Boolean).join(" · ")}</span>}
        <span className="truncate text-meta">{startedBy(r)}</span>
        <Tip label={new Date(r.created).toLocaleString()}>
          <span className="text-meta text-muted-foreground">{ago(r.created)}</span>
        </Tip>
        <span className="text-right font-mono text-meta text-muted-foreground tabular-nums">{took(r)}</span>
      </button>
      {open && <RunTimeline box={r.box} id={r.id} summary={r} />}
    </li>
  );
}

// RunTimeline is a run's steps as a timeline: each step with its status,
// how long it took on a bar against the run's span, and its output.
export function RunTimeline({ box, id, summary }: { box: string; id: string; summary: BoxRun }) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const legacy = !boxHasRuns(box);
  useEffect(() => {
    if (legacy) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await getRun(box, id);
        if (!stop) setRun(r);
        if (!stop && isActive(r)) setTimeout(tick, 2000);
      } catch (err) {
        if (!stop) setError(plainError(err));
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [box, id, summary.updated]);
  if (legacy)
    return (
      <div className="flex flex-col gap-2 bg-muted/20 px-4 py-3 pl-12 text-muted-foreground text-meta">
        {summary.error && <ErrorText text={summary.error} />}
        <NeedsUpdate box={box}>{box} keeps its flows' runs without a timeline.</NeedsUpdate>
      </div>
    );
  if (error) return <ErrorText className="bg-muted/20 px-4 py-3 pl-12 text-destructive-foreground text-meta" text={error} />;
  if (!run) return <div className="bg-muted/20 px-4 py-3 pl-12 text-muted-foreground text-meta">Loading…</div>;
  const t0 = new Date(run.created).getTime();
  const t1 = run.finished ? new Date(run.finished).getTime() : Date.now();
  const span = Math.max(1, t1 - t0);
  const decide = async (approve: boolean, pick?: number) => {
    try {
      await runsApi.decide(box, id, { approve, pick });
      scheduleRuns(box, 0);
      setRun(await getRun(box, id));
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't decide the gate", description: errorMessage(err) });
    }
  };
  return (
    <div className="space-y-2 bg-muted/20 px-4 pt-1 pb-3 pl-12">
      <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
        <span className="font-mono">{run.id}</span>
        {run.usage && (
          <span className="inline-flex items-center gap-1">
            <CoinsIcon className="size-3" />
            {tokens(run.usage)}
          </span>
        )}
        {run.error && <span className="text-destructive-foreground">{run.error}</span>}
        {isActive(run) && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              void runsApi
                .cancel(box, id)
                .then(() => scheduleRuns(box, 0))
                .catch((err) => toastManager.add({ type: "error", title: "Couldn't cancel", description: errorMessage(err) }))
            }
          >
            <CircleStopIcon />
            Cancel run
          </Button>
        )}
      </div>
      {run.gate && (
        <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-body">
          <p className="font-medium">{run.gate.title}</p>
          {run.gate.text && <p className="mt-0.5 whitespace-pre-wrap text-desc text-muted-foreground">{run.gate.text}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {run.gate.pick && (run.candidates?.length ?? 0) > 0 ? (
              <>
                {run.candidates!.map((c) => (
                  <Button key={c.index} size="xs" variant={c.index === run.gate!.default ? "default" : "outline"} onClick={() => void decide(true, c.index)}>
                    Pick {c.index + 1} · {c.agent}
                  </Button>
                ))}
                <Button size="xs" variant="ghost" onClick={() => useStore.getState().setView({ kind: "review", run: { box, id } })}>
                  <GitCompareArrowsIcon />
                  Compare
                </Button>
              </>
            ) : (
              <Button size="xs" onClick={() => void decide(true)}>
                Approve
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => void decide(false)}>
              Reject
            </Button>
          </div>
        </div>
      )}
      <Steps steps={run.steps} t0={t0} span={span} depth={0} />
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  loop: "Loop",
  round: "Round",
  map: "Fan out",
  item: "Item",
  join: "Join",
  judge: "Judge",
  gate: "Gate",
  if: "If",
  then: "Then",
  else: "Else",
  sleep: "Sleep",
  check: "Check",
  headless: "Headless agent",
  collect: "Collect",
  handoff: "Handoff packet",
  pr: "Pull request",
  cleanup: "Archive the rest",
};

function Steps({ steps, t0, span, depth }: { steps: RunStep[]; t0: number; span: number; depth: number }) {
  return (
    <div className={cn("space-y-1", depth > 0 && "border-l pl-3")}>
      {steps
        .filter((s) => s.status !== "skipped")
        .map((s) => (
          <Step key={s.path} s={s} t0={t0} span={span} depth={depth} />
        ))}
    </div>
  );
}

function Step({ s, t0, span, depth }: { s: RunStep; t0: number; span: number; depth: number }) {
  const [open, setOpen] = useState(s.status === "failed" || s.status === "waiting");
  const m = STEP_KINDS[s.kind as keyof typeof STEP_KINDS];
  const label = m?.label ?? STEP_LABEL[s.kind] ?? s.id;
  const Icon = m?.Icon ?? (s.kind === "loop" || s.kind === "round" ? RepeatIcon : s.kind === "gate" ? HandIcon : ChevronRightIcon);
  const start = s.started ? new Date(s.started).getTime() - t0 : 0;
  const end = s.ended ? new Date(s.ended).getTime() - t0 : s.status === "running" || s.status === "waiting" ? Date.now() - t0 : start;
  const group = !!s.children?.length;
  return (
    <div className={cn(group ? "" : "rounded-lg border bg-card")}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left text-meta" onClick={() => setOpen(!open)} disabled={!group && !s.output && !s.error}>
        <Icon className={cn("size-3.5 shrink-0", m?.tone ?? "text-muted-foreground")} />
        <span className="font-medium">{s.kind === "round" || s.kind === "item" ? `${label} ${s.id.replace(/^\D+/, "") ? Number(s.id.replace(/^\D+/, "")) + (s.kind === "item" ? 1 : 0) : ""}` : label}</span>
        {s.id && !/^\d+$/.test(s.id) && s.kind !== "round" && s.kind !== "item" && <span className="text-muted-foreground">{s.id}</span>}
        {s.output && !group && <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.output.split("\n")[0]}</span>}
        {(group || !s.output) && <span className="flex-1" />}
        {s.started && depth < 3 && (
          <span className="relative hidden h-1.5 w-24 shrink-0 rounded-full bg-muted sm:block" aria-hidden>
            <span className="absolute inset-y-0 rounded-full bg-primary/50" style={{ left: `${(start / span) * 100}%`, width: `${Math.max(2, ((end - start) / span) * 100)}%` }} />
          </span>
        )}
        {s.usage && <span className="text-muted-foreground">{tokens(s.usage)}</span>}
        <span className={cn("shrink-0", s.status === "failed" ? "text-destructive-foreground" : s.status === "succeeded" ? "text-success" : "text-muted-foreground")}>{s.status}</span>
        {s.kind === "check" && s.status !== "running" && <span className="text-muted-foreground">exit {s.exit_code}</span>}
        {s.duration && <span className="font-mono text-meta text-muted-foreground">{s.duration}</span>}
      </button>
      {open && !group && (s.output || s.error) && <pre className="max-h-48 overflow-auto border-t px-3 py-2 font-mono text-mono text-muted-foreground">{[s.error, s.output].filter(Boolean).join("\n")}</pre>}
      {open && group && <Steps steps={s.children!} t0={t0} span={span} depth={depth + 1} />}
    </div>
  );
}
