import { ArrowLeftIcon, ChevronsUpDownIcon, ClockIcon, GitPullRequestIcon, FlaskConicalIcon, LayersIcon, LockIcon, PlusIcon, ServerIcon, Trash2Icon, ZapIcon } from "lucide-react";

import { confirm } from "@/components/sidebar/confirm";
import { Fragment, useMemo, useState } from "react";

import { PickOne } from "@/components/pick-one";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { sortedWorktrees } from "@/lib/derive";
import { DEFAULT_MAX_RUNS_PER_HOUR, type Flow, type FlowRun, type FlowSource, flowsApi, type GitHubOn, type Scope, type Step, type StepKind, scopeLocation, slug, type TriggerKind, triggerKind, triggerType } from "@/lib/flows";
import { plainError } from "@/lib/errors";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { isEditableKind, blankStep, describeCron, GITHUB_ONS, KIND_ORDER, SCHEDULE_PRESETS, STEP_KINDS, summary, TRIGGERS, variablesAt } from "@/views/automations/flows/model";
import { ProjectLabel, savedWhere } from "@/views/automations/flows/project-label";
import { StepCard } from "@/views/automations/flows/step-card";
import { ErrorText } from "@/components/error-note";

export interface EditTarget {
  box: string;
  scope: Scope;
  flow: Flow;
  // The id it was saved under; absent for a new flow.
  savedId?: string;
  readOnly?: boolean;
  // Where it comes from; a read-only flow is committed ("repo") or the
  // project's kit's ("kit").
  source?: FlowSource;
}

// FlowEditor is a flow as a vertical canvas: the trigger, then each step
// joined by a line, with failure steps branched off on an amber rail.
export function FlowEditor({
  target,
  scopes,
  onSave,
  onDelete,
  onOverride,
  onClose,
}: {
  target: EditTarget;
  // Where a new flow can go: [box, scope] pairs.
  scopes: { box: string; scope: Scope }[];
  onSave(box: string, scope: Scope, flow: Flow, previousId?: string): Promise<void>;
  onDelete?(): Promise<void>;
  onOverride?(): void;
  onClose(): void;
}) {
  const [flow, setFlow] = useState<Flow>(target.flow);
  const [where, setWhere] = useState({ box: target.box, scope: target.scope });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [run, setRun] = useState<FlowRun>();
  // A flow with run steps the editor can't change (loop, gate, map, …) is
  // edited in its JSON; here it is shown.
  const runSteps = target.flow.steps.some((s) => !isEditableKind(s.kind));
  const readOnly = target.readOnly || runSteps;
  const isNew = !target.savedId;
  const agents = useStore((s) => s.boxes[where.box]?.info?.agents) ?? NONE;
  const dirty = JSON.stringify(flow) !== JSON.stringify(target.flow) || where.scope !== target.scope || where.box !== target.box;

  const setStep = (i: number, s: Step) => setFlow((f) => ({ ...f, steps: f.steps.map((x, j) => (j === i ? s : x)) }));
  const insertStep = (at: number, kind: StepKind) => setFlow((f) => ({ ...f, steps: [...f.steps.slice(0, at), blankStep(kind), ...f.steps.slice(at)] }));
  const moveStep = (i: number, d: -1 | 1) =>
    setFlow((f) => {
      const steps = [...f.steps];
      [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
      return { ...f, steps };
    });

  // Deleting asks first.
  const askDelete = () => {
    if (!onDelete) return;
    const name = flow.name.trim() || target.savedId || "this flow";
    confirm({
      title: `Delete ${name}?`,
      description: `It stops running on ${target.box} straight away.`,
      confirm: "Delete flow",
      destructive: true,
      run: async () => {
        await onDelete();
        onClose();
      },
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const id = flow.id || slug(flow.name);
      // A flow kept in a project already runs only there.
      const trigger = scopeLocation(where.scope) && flow.trigger.where?.location ? { ...flow.trigger, where: { ...flow.trigger.where, location: undefined } } : flow.trigger;
      await onSave(where.box, where.scope, { ...flow, trigger, id, name: flow.name.trim() || id }, target.savedId);
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeftIcon />
          Automations
        </Button>
        <span className="h-4 w-px bg-border" />
        <Input
          value={flow.name}
          // A new flow starts by being named.
          autoFocus={isNew && !readOnly}
          readOnly={readOnly}
          onChange={(e) => setFlow({ ...flow, name: e.target.value })}
          placeholder="Name this flow"
          unstyled
          className="min-w-0 flex-1 text-heading"
          aria-label="Flow name"
        />
        <label className="flex items-center gap-2 text-muted-foreground text-meta">
          <Switch checked={flow.enabled} disabled={readOnly} onCheckedChange={(enabled) => setFlow({ ...flow, enabled })} />
          {flow.enabled ? "On" : "Off"}
        </label>
        {!isNew && <TestRun box={where.box} scope={where.scope} flow={flow} dirty={dirty} onRun={setRun} />}
        {!readOnly && onDelete && (
          <Tip label="Delete flow…">
            <Button size="icon-sm" variant="ghost" aria-label="Delete flow…" onClick={askDelete}>
              <Trash2Icon />
            </Button>
          </Tip>
        )}
        {!readOnly && (
          <Tip label={!flow.name.trim() ? "Name it first" : !dirty ? "Nothing changed" : undefined}>
            <Button size="sm" onClick={save} loading={saving} disabled={!flow.name.trim() || !dirty}>
              {isNew ? "Create flow" : "Save"}
            </Button>
          </Tip>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 pt-6 pb-24">
          {readOnly && (
            <div className="mb-5 flex items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-body">
              <LockIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                {target.source === "kit" ? (
                  <>From the project's kit. Change it in the kit, or override it on this box.</>
                ) : (
                  <>
                    Committed in the repository's <code className="font-mono text-mono">.berth/config.json</code>. Change it there, or override it on this box.
                  </>
                )}
              </span>
              {onOverride && (
                <Button size="sm" variant="outline" onClick={onOverride}>
                  Override on {target.box}
                </Button>
              )}
            </div>
          )}
          {runSteps && !target.readOnly && <p className="mb-5 rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-body">This flow uses run steps (loop, gate, map…) that the editor shows but does not change. Edit it in its JSON: the box's config or the repository's .berth/config.json.</p>}
          {error && <ErrorText className="mb-5 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-destructive-foreground text-body" text={error} />}
          {run && <RunBanner run={run} onClear={() => setRun(undefined)} />}

          <p className="mb-4 text-muted-foreground text-body">{summary(flow)}</p>

          <TriggerCard flow={flow} setFlow={setFlow} readOnly={readOnly} source={target.source} where={where} setWhere={setWhere} scopes={scopes} />

          {flow.steps.map((s, i) => (
            <Fragment key={i}>
              <Connector branch={s.when ?? "success"} onAdd={readOnly ? undefined : (k) => insertStep(i, k)} />
              <div className={cn("relative", s.when === "failure" && "ml-10 before:absolute before:-left-6 before:top-0 before:bottom-0 before:w-0.5 before:rounded-full before:bg-warning/40")}>
                <StepCard
                  step={s}
                  index={i}
                  count={flow.steps.length}
                  variables={variablesAt(flow, i)}
                  agents={agents}
                  readOnly={readOnly}
                  result={run?.steps[i]}
                  onChange={(n) => setStep(i, n)}
                  onMove={(d) => moveStep(i, d)}
                  onRemove={() => setFlow((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                />
              </div>
            </Fragment>
          ))}

          {!readOnly && (
            <div className="mt-3 flex flex-col items-center">
              <span className="h-5 w-px bg-border" />
              <AddStep onPick={(k) => insertStep(flow.steps.length, k)}>
                <Button size="sm" variant="outline">
                  <PlusIcon />
                  Add a step
                </Button>
              </AddStep>
            </div>
          )}

          <section className="mt-10 flex items-center gap-4 rounded-xl border bg-card/40 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-row">At most</div>
              <div className="text-desc text-muted-foreground">Stops a flow that triggers itself, or a busy repo, from running away. Empty means {DEFAULT_MAX_RUNS_PER_HOUR}, the default.</div>
            </div>
            <Input
              type="number"
              min={0}
              value={flow.max_runs_per_hour ?? ""}
              readOnly={readOnly}
              onChange={(e) => setFlow({ ...flow, max_runs_per_hour: Number(e.target.value) || undefined })}
              placeholder={`${DEFAULT_MAX_RUNS_PER_HOUR} (default)`}
              size="sm"
              className="w-28 text-right tabular-nums"
            />
            <span className="text-muted-foreground text-meta">runs an hour</span>
          </section>
        </div>
      </div>
    </div>
  );
}

function TriggerCard({
  flow,
  setFlow,
  readOnly,
  source,
  where,
  setWhere,
  scopes,
}: {
  flow: Flow;
  setFlow(f: Flow): void;
  readOnly?: boolean;
  source?: FlowSource;
  where: { box: string; scope: Scope };
  setWhere(w: { box: string; scope: Scope }): void;
  scopes: { box: string; scope: Scope }[];
}) {
  const agents = useStore((s) => s.boxes[where.box]?.info?.agents) ?? NONE;
  const w = flow.trigger.where ?? {};
  const setW = (patch: Partial<typeof w>) => {
    const next = { ...w, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k] || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
    setFlow({ ...flow, trigger: { ...flow.trigger, where: Object.keys(next).length ? next : undefined } });
  };
  const kind = triggerKind(flow.trigger);
  // Switching what starts it keeps where it applies, and drops the rest.
  const setKind = (k: TriggerKind) => {
    const base = { where: flow.trigger.where };
    // An agent filter is for events, an author filter for GitHub.
    const where = base.where && { ...base.where, agent: k === "event" ? base.where.agent : undefined, author: k === "github" ? base.where.author : undefined };
    if (k === "event") setFlow({ ...flow, trigger: { where, event: "agent.finished" } });
    if (k === "schedule") setFlow({ ...flow, trigger: { where, schedule: "0 2 * * *" } });
    if (k === "github") setFlow({ ...flow, trigger: { where, github: { on: "review_comment", poll: "2m" } } });
  };

  return (
    <article className="rounded-xl border border-ring/25 bg-card shadow-xs/5">
      <header className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <ZapIcon className="size-4" />
        </span>
        <h3 className="text-section">{kind === "schedule" ? "When it runs" : kind === "github" ? "When this happens on GitHub" : "When this happens"}</h3>
      </header>
      <div className="grid grid-cols-2 gap-3 px-3.5 py-3">
        <div className="col-span-2">
          <span className="mb-1 block text-label text-muted-foreground">Runs for</span>
          <RunsFor value={where} options={scopes} disabled={readOnly} onChange={setWhere} />
          <p className="mt-1.5 text-desc text-muted-foreground">{savedWhere(where.box, where.scope, readOnly ? (source === "kit" ? "kit" : "repo") : undefined)}</p>
          {where.scope === "box" && w.location && (
            <p className="mt-1 flex items-center gap-1.5 text-desc text-muted-foreground">
              Only events from {w.location}.
              {!readOnly && (
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => setW({ location: undefined })}>
                  Any project
                </button>
              )}
            </p>
          )}
        </div>
        <div className="col-span-2 flex flex-col gap-2">
          <span className="block text-label text-muted-foreground">Starts</span>
          {!readOnly && (
            <PickOne<TriggerKind>
              label="What starts it"
              value={kind}
              onChange={setKind}
              options={[
                { value: "event", label: "On an event", icon: <ZapIcon className="size-3.5" /> },
                { value: "schedule", label: "On a schedule", icon: <ClockIcon className="size-3.5" /> },
                { value: "github", label: "On GitHub", icon: <GitPullRequestIcon className="size-3.5" /> },
              ]}
            />
          )}
          {kind === "event" && (
            <SimpleSelect
              value={flow.trigger.event ?? ""}
              disabled={readOnly}
              onChange={(event) => setFlow({ ...flow, trigger: { ...flow.trigger, event } })}
              options={TRIGGERS.map((t) => ({ value: t.on, label: `${t.label} · ${t.on}` }))}
            />
          )}
          {kind === "schedule" && <ScheduleFields flow={flow} setFlow={setFlow} readOnly={readOnly} />}
          {kind === "github" && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <SimpleSelect
                value={flow.trigger.github?.on ?? "review_comment"}
                disabled={readOnly}
                onChange={(on) => setFlow({ ...flow, trigger: { ...flow.trigger, github: { ...flow.trigger.github, on: on as GitHubOn } } })}
                options={GITHUB_ONS.map((g) => ({ value: g.on, label: g.label }))}
              />
              <SimpleSelect
                value={flow.trigger.github?.poll ?? "2m"}
                disabled={readOnly}
                onChange={(poll) => setFlow({ ...flow, trigger: { ...flow.trigger, github: { on: flow.trigger.github?.on ?? "review_comment", poll } } })}
                options={["1m", "2m", "5m", "15m"].map((p) => ({ value: p, label: `Check every ${p.replace("m", " min")}` }))}
              />
              <p className="col-span-2 text-desc text-muted-foreground">
                The box checks each worktree's pull request with <code className="font-mono">gh</code>. Only what's new after the flow is turned on starts it.
              </p>
              {(flow.trigger.github?.on ?? "review_comment") !== "check_failed" && (flow.trigger.github?.on ?? "review_comment") !== "pr_merged" && (
                <label className="col-span-2 block">
                  <span className="mb-1 block text-label text-muted-foreground">From</span>
                  <Input
                    value={(w.author ?? []).join(", ")}
                    readOnly={readOnly}
                    onChange={(e) => setW({ author: e.target.value.split(/[\s,]+/).filter(Boolean) })}
                    placeholder="collaborators · or logins, or * for anyone"
                    className="font-mono text-mono"
                  />
                  <span className="mt-1 block text-desc text-muted-foreground">Comments reach the agent's prompt, marked as someone else's words. Anyone can comment on a public repository, so only collaborators count unless you list people.</span>
                </label>
              )}
            </div>
          )}
        </div>
        <div className={cn(kind !== "event" && "hidden")}>
          <span className="mb-1 block text-label text-muted-foreground">From agent</span>
          <SimpleSelect
            value={w.agent ?? ""}
            disabled={readOnly}
            onChange={(agent) => setW({ agent })}
            options={[{ value: "", label: "Any agent" }, ...(agents.length ? agents : [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }]).map((a) => ({ value: a.id, label: a.name }))]}
          />
        </div>
        <label className={cn("block", kind !== "event" && "col-span-2")}>
          <span className="mb-1 block text-label text-muted-foreground">On branch</span>
          <Input value={w.branch ?? ""} readOnly={readOnly} onChange={(e) => setW({ branch: e.target.value })} placeholder="Any · fix/* for a prefix" className="font-mono text-mono" />
        </label>
      </div>
    </article>
  );
}

// ScheduleFields picks when a scheduled flow runs: a preset or a cron
// expression, said back in plain words, and whether it runs per worktree.
function ScheduleFields({ flow, setFlow, readOnly }: { flow: Flow; setFlow(f: Flow): void; readOnly?: boolean }) {
  const expr = flow.trigger.schedule ?? "";
  const set = (patch: Partial<Flow["trigger"]>) => setFlow({ ...flow, trigger: { ...flow.trigger, ...patch } });
  const preset = SCHEDULE_PRESETS.some((p) => p.value === expr) ? expr : "custom";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
      <SimpleSelect
        value={preset}
        disabled={readOnly}
        onChange={(v) => v !== "custom" && set({ schedule: v })}
        options={[...SCHEDULE_PRESETS, { value: "custom", label: "Custom…" }]}
      />
      <Input value={expr} readOnly={readOnly} onChange={(e) => set({ schedule: e.target.value })} placeholder="0 2 * * *" className="font-mono text-mono" aria-label="Cron expression" />
      <p className="col-span-2 flex items-center gap-1.5 text-desc text-muted-foreground">
        <ClockIcon className="size-3.5" />
        {describeCron(expr)} · the box's local time
      </p>
      <label className="col-span-2 flex items-center gap-2 text-body">
        <Switch checked={!!flow.trigger.each_worktree} disabled={readOnly} onCheckedChange={(v) => set({ each_worktree: v || undefined })} />
        <span>Run once for each worktree</span>
        <span className="text-muted-foreground text-meta">{flow.trigger.each_worktree ? "every worktree matching the branch below" : "otherwise once, in the repo's main checkout"}</span>
      </label>
    </div>
  );
}

// RunsFor picks the project a flow runs for, grouped by box: every project
// on a box, or one of its repos.
function RunsFor({ value, options, disabled, onChange }: { value: { box: string; scope: Scope }; options: { box: string; scope: Scope }[]; disabled?: boolean; onChange(v: { box: string; scope: Scope }): void }) {
  const boxes = [...new Set(options.map((o) => o.box))];
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-body shadow-xs/5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-80 sm:h-8 dark:bg-input/32"
          />
        }
      >
        <ProjectLabel box={value.box} scope={value.scope} className="flex-1" />
        {!disabled && <ChevronsUpDownIcon className="size-4 shrink-0 opacity-60" />}
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-96 min-w-(--anchor-width)">
        {boxes.map((box, i) => (
          <MenuGroup key={box}>
            {i > 0 && <MenuSeparator />}
            <MenuGroupLabel className="flex items-center gap-1.5">
              <ServerIcon className="size-3" />
              {box}
            </MenuGroupLabel>
            {options
              .filter((o) => o.box === box)
              .map((o) => (
                <MenuItem key={o.scope} onClick={() => onChange(o)} className={cn(o.box === value.box && o.scope === value.scope && "bg-accent")}>
                  {o.scope === "box" ? (
                    <span className="flex items-center gap-1.5">
                      <LayersIcon className="size-3.5 text-muted-foreground" />
                      Any project on {box}
                    </span>
                  ) : (
                    <ProjectLabel box={box} scope={o.scope} chip={false} />
                  )}
                </MenuItem>
              ))}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

// Connector joins two cards, with a "+" to insert a step there, and says
// when the step below it runs.
function Connector({ branch, onAdd }: { branch: string; onAdd?(k: StepKind): void }) {
  const amber = branch === "failure";
  return (
    <div className="group relative flex h-10 items-center justify-center">
      <span className={cn("absolute inset-y-0 left-1/2 w-px -translate-x-1/2", amber ? "bg-warning/50" : branch === "always" ? "border-l border-dashed border-muted-foreground/40 bg-transparent" : "bg-border")} />
      {branch !== "success" && (
        <span className={cn("relative z-10 rounded-full border bg-background px-2 py-px text-tag", amber ? "border-warning/40 text-warning-foreground" : "text-muted-foreground")}>{amber ? "if it fails" : "always"}</span>
      )}
      {onAdd && (
        <AddStep onPick={onAdd}>
          <button
            type="button"
            aria-label="Add a step here"
            className={cn("absolute top-1/2 left-1/2 z-10 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100", branch !== "success" && "left-[calc(50%+64px)]")}
          >
            <PlusIcon className="size-3" />
          </button>
        </AddStep>
      )}
    </div>
  );
}

function AddStep({ onPick, children }: { onPick(k: StepKind): void; children: React.ReactElement }) {
  return (
    <Menu>
      <MenuTrigger render={children} />
      <MenuPopup align="center" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Add a step</MenuGroupLabel>
          {KIND_ORDER.map((k) => {
            const m = STEP_KINDS[k];
            return (
              <MenuItem key={k} onClick={() => onPick(k)}>
                <m.Icon className={m.tone} />
                <span className="flex flex-col">
                  <span>{m.label}</span>
                  <span className="text-muted-foreground text-meta">{m.hint}</span>
                </span>
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

// TestRun runs the saved flow now, for a worktree you pick, and shows how
// each step went on the canvas.
function TestRun({ box, scope, flow, dirty, onRun }: { box: string; scope: Scope; flow: Flow; dirty: boolean; onRun(r: FlowRun): void }) {
  const client = useStore((s) => s.client);
  const locations = useStore((s) => s.boxes[box]?.locations) ?? NONE;
  const sessions = useStore((s) => s.boxes[box]?.sessions) ?? NONE;
  const [busy, setBusy] = useState(false);
  const loc = scopeLocation(scope);
  const choices = useMemo(
    () => locations.filter((l) => !loc || l.name === loc).flatMap((l) => sortedWorktrees(l).map((wt) => ({ l, wt }))),
    [locations, loc],
  );

  const go = async (l: (typeof choices)[number]["l"], wt: (typeof choices)[number]["wt"]) => {
    if (!client) return;
    setBusy(true);
    try {
      const session = sessions.find((s) => s.dir === wt.path && s.agent);
      const data: Record<string, unknown> = { path: wt.path, location: l.name, name: wt.name, branch: wt.branch ?? "" };
      if (session) Object.assign(data, { session: session.name, agent: session.agent });
      onRun(await flowsApi.test(client, box, flow.id, scope, data));
    } catch (err) {
      onRun({ id: "", flow: flow.id, scope, started: new Date().toISOString(), status: "failed", event: { type: triggerType(flow.trigger), time: "" }, steps: [], error: plainError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" loading={busy} />}>
        <FlaskConicalIcon />
        Test run
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-96 min-w-64">
        <MenuGroup>
          <MenuGroupLabel>{dirty ? "Runs the saved version, for real, in" : "Runs it now, for real, in"}</MenuGroupLabel>
          {choices.length === 0 && <MenuItem disabled>No worktrees on {box}</MenuItem>}
          {choices.map(({ l, wt }) => (
            <MenuItem key={wt.path} onClick={() => void go(l, wt)}>
              <span className="flex-1 truncate">{wt.main ? l.name : wt.name}</span>
              <span className="text-muted-foreground text-meta">{loc ? wt.branch : l.name}</span>
            </MenuItem>
          ))}
        </MenuGroup>
        {dirty && (
          <>
            <MenuSeparator />
            <MenuItem disabled>Save first to test your changes</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function RunBanner({ run, onClear }: { run: FlowRun; onClear(): void }) {
  const ok = run.status === "succeeded";
  const ran = run.steps.filter((s) => s.status !== "skipped").length;
  // A step failed and a later on-failure step dealt with it, as designed.
  const caught = ok ? run.steps.findIndex((s) => s.status === "failed") : -1;
  const summary = run.error
    ? `Test run failed: ${run.error}`
    : run.status === "running"
      ? `Test run still running: ${ran} of ${run.steps.length} steps ran so far.`
      : caught >= 0
        ? `Test run succeeded: step ${caught + 1} failed and the steps after it handled that, as designed. Results are on each step below.`
        : `Test run ${run.status}: ${ran} of ${run.steps.length} steps ran. Results are on each step below.`;
  return (
    <div className={cn("mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-body", ok ? "border-success/30 bg-success/6" : "border-destructive/30 bg-destructive/6")}>
      <FlaskConicalIcon className={cn("size-4 shrink-0", ok ? "text-success" : "text-destructive-foreground")} />
      <span className="min-w-0 flex-1">
        {summary}
      </span>
      <Button size="xs" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
