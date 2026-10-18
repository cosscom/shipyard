import { LockIcon, PackageIcon, PlusIcon, Settings2Icon, WorkflowIcon } from "lucide-react";

import { Scene } from "@/components/art/scenes";
import { openProjectSettings } from "@/components/skills/project-settings-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { FlowRun, Scope, ScopedFlow } from "@/lib/flows";
import { isOverridden, overrides, scopeLocation } from "@/lib/flows";
import { ago } from "@/lib/format";
import type { Project } from "@/lib/project-groups";
import { cn } from "@/lib/utils";
import { STARTERS, type Starter, summary, kindMeta } from "@/views/automations/flows/model";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import { RunStatus } from "@/views/automations/flows/run-status";
import type { BoxFlows } from "@/views/automations/flows/use-flows";
import { Tip } from "@/components/tip";
import { BoxError } from "@/components/upgrade-box";

interface Group {
  box: string;
  scope: Scope;
  flows: ScopedFlow[];
}

// groupsOf orders a box's flows by where they live: the box's own first,
// then each repository's.
function groupsOf(bf: BoxFlows): Group[] {
  const byScope = new Map<Scope, ScopedFlow[]>([["box", []]]);
  for (const f of bf.flows ?? []) byScope.set(f.scope, [...(byScope.get(f.scope) ?? []), f]);
  return [...byScope.entries()].sort(([a], [b]) => (a === "box" ? -1 : b === "box" ? 1 : a.localeCompare(b))).map(([scope, flows]) => ({ box: bf.box, scope, flows }));
}

export function FlowList({
  boxes,
  byBox,
  projects,
  lastRun,
  onEdit,
  onToggle,
  onNew,
  onStarter,
}: {
  boxes: string[];
  byBox: Record<string, BoxFlows>;
  projects: Project[];
  lastRun(box: string, scope: string, id: string): FlowRun | undefined;
  onEdit(box: string, f: ScopedFlow): void;
  onToggle(box: string, f: ScopedFlow, on: boolean): void;
  onNew(box: string, scope: Scope): void;
  onStarter(s: Starter): void;
}) {
  const loaded = boxes.filter((b) => byBox[b]?.flows);
  const total = loaded.reduce((n, b) => n + (byBox[b].flows?.length ?? 0), 0);
  const firstBox = boxes[0];
  // A flow for a project on every box lives in the project's committed
  // config (.berth/config.json) or its kit, which every box layers in.
  const many = projects.filter((p) => new Set(p.members.map((m) => m.box.name)).size > 1);

  return (
    <div className="space-y-8">
      {/* No flows on any box yet: a course plotted, not yet sailed. */}
      {!total && boxes.length > 0 && loaded.length === boxes.length && (
        <div className="flex items-center gap-5 px-1">
          <Scene name="chart" width={112} />
          <div className="min-w-0">
            <p className="text-row">No flows yet</p>
            <p className="mt-0.5 max-w-md text-desc text-muted-foreground">A flow runs steps on a box when something happens, or on a schedule. Start with one of these and change it to fit.</p>
          </div>
        </div>
      )}
      <section>
        <h2 className="mb-2.5 text-section">{total ? "Start from a template" : "Start with one of these"}</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
          {STARTERS.map((s) => {
            const kinds = [...new Set(s.flow.steps.map((x) => x.kind))];
            return (
              <button
                key={s.id}
                type="button"
                disabled={!firstBox}
                onClick={() => onStarter(s)}
                className="group flex min-h-28 flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:border-ring/40 disabled:opacity-50"
              >
                <span className="flex items-center gap-1">
                  {kinds.map((k) => {
                    const m = kindMeta(k);
                    return (
                      <span key={k} className={cn("inline-flex size-6 items-center justify-center rounded-md bg-muted", m.tone)}>
                        <m.Icon className="size-3.5" />
                      </span>
                    );
                  })}
                </span>
                <span>
                  <span className="block text-row">{s.title}</span>
                  <span className="mt-0.5 block text-desc text-muted-foreground">{s.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {many.length > 0 && (
        <p className="rounded-xl border bg-muted/40 px-4 py-3 text-desc text-muted-foreground">
          To run a flow for {many[0].name}
          {many.length > 1 ? " and other projects" : ""} on every box that has it, commit it to the repository's <code>.berth/config.json</code> (or the project's kit): each box runs it from there. A flow saved here belongs to one box.
        </p>
      )}

      {boxes.map((box) => {
        const bf = byBox[box];
        if (!bf) return <Skeleton key={box} className="h-24 rounded-xl" />;
        if (bf.error)
          return (
            <section key={box} className="rounded-xl border px-4 py-3">
              <BoxError box={box} error={bf.error} what="its flows" />
            </section>
          );
        return groupsOf(bf).map((g) => <ScopeGroup key={`${box}|${g.scope}`} group={g} lastRun={lastRun} onEdit={onEdit} onToggle={onToggle} onNew={onNew} />);
      })}
    </div>
  );
}

function ScopeGroup({
  group,
  lastRun,
  onEdit,
  onToggle,
  onNew,
}: {
  group: Group;
  lastRun(box: string, scope: string, id: string): FlowRun | undefined;
  onEdit(box: string, f: ScopedFlow): void;
  onToggle(box: string, f: ScopedFlow, on: boolean): void;
  onNew(box: string, scope: Scope): void;
}) {
  const { box, scope, flows } = group;
  const loc = scopeLocation(scope);
  // A committed or kit flow overridden on this box shows once, as the
  // override: the box runs only that one.
  const shown = flows.filter((f) => !isOverridden(f, flows));

  return (
    <section>
      <header className="mb-2.5 flex items-center gap-2">
        <h2 className="min-w-0 text-section">
          <ProjectLabel box={box} scope={scope} />
        </h2>
        <span className="text-meta text-muted-foreground tabular-nums">{shown.length}</span>
        <span className="ml-auto flex items-center gap-1">
          {loc && (
            <Button size="xs" variant="ghost" onClick={() => openProjectSettings(box, loc)}>
              <Settings2Icon />
              Project settings
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => onNew(box, scope)}>
            <PlusIcon />
            New flow
          </Button>
        </span>
      </header>
      {shown.length === 0 ? (
        <button
          type="button"
          onClick={() => onNew(box, scope)}
          className="flex w-full items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-left text-muted-foreground text-body hover:border-ring/40 hover:text-foreground"
        >
          <WorkflowIcon className="size-4" />
          No flows {loc ? `for ${loc}` : `for every project on ${box}`} yet. Make one, or start from a template above.
        </button>
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border bg-card">
          {shown.map((f) => (
            <FlowRow key={`${f.source}:${f.flow.id}`} f={f} run={lastRun(box, scope, f.flow.id)} onEdit={() => onEdit(box, f)} onToggle={(on) => onToggle(box, f, on)} overridden={overrides(f, flows)} />
          ))}
        </div>
      )}
    </section>
  );
}

// SharedSection is a project's flows on every box that has it, each one
// flow standing for its copies; switching it switches every copy.
function FlowRow({ f, run, onEdit, onToggle, overridden }: { f: ScopedFlow; run?: FlowRun; onEdit(): void; onToggle(on: boolean): void; overridden: boolean }) {
  const { flow } = f;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => e.key === "Enter" && onEdit()}
      className={cn("group flex cursor-pointer items-center gap-4 px-4 py-row-pad outline-none hover:bg-accent/40 focus-visible:bg-accent/40", !flow.enabled && "opacity-60")}
    >
      <span className="flex shrink-0 items-center -space-x-1">
        {[...new Set(flow.steps.map((s) => s.kind))].slice(0, 3).map((k) => {
          const m = kindMeta(k);
          return (
            <span key={k} className={cn("inline-flex size-6 items-center justify-center rounded-md border-2 border-card bg-muted", m.tone)}>
              <m.Icon className="size-3.5" />
            </span>
          );
        })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-row">{flow.name}</span>
          {f.source === "repo" && (
            <Tip label="Committed in the repository's .berth/config.json">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-tag text-muted-foreground">
                <LockIcon className="size-2.5" />
                In repo
              </span>
            </Tip>
          )}
          {f.source === "kit" && (
            <Tip label="From the project's kit">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-tag text-muted-foreground">
                <PackageIcon className="size-2.5" />
                From kit
              </span>
            </Tip>
          )}
          {overridden && <span className="shrink-0 rounded-md border border-ring/30 px-1.5 py-px text-tag text-muted-foreground">Overridden here</span>}
        </div>
        <p className="mt-0.5 truncate text-desc text-muted-foreground">{summary(flow)}</p>
      </div>
      <div className="flex w-36 shrink-0 items-center justify-end gap-1.5 text-meta text-muted-foreground">
        {run ? (
          <>
            <RunStatus status={run.status} />
            <Tip label={new Date(run.started).toLocaleString()}>
              <span>{ago(run.started)}</span>
            </Tip>
          </>
        ) : (
          <span className="opacity-60">Never run</span>
        )}
      </div>
      {/* The switch acts on the flow, not the row that opens it. */}
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex shrink-0">
        <Switch checked={flow.enabled} onCheckedChange={onToggle} aria-label={flow.enabled ? `Turn off ${flow.name}` : `Turn on ${flow.name}`} />
      </span>
    </div>
  );
}
