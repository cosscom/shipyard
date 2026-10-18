import { ChevronRightIcon, FileCode2Icon } from "lucide-react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { nice } from "@/components/conversation/composer-pickers";
import { StartFrom } from "@/components/new-worktree/smart-input";
import { VariableFields, useTargetLabel } from "@/components/prompts/shared";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { NeedsUpdate } from "@/components/upgrade-box";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { SessionEntry } from "@/hooks/use-agent-counts";
import type { AgentPreset, Location, TaskTemplate, TemplateVariable } from "@/lib/api";
import type { AgentPick } from "@/lib/composer";
import type { Branch, ResolveKind, Resolution } from "@/lib/projects";
import type { PromptVariable } from "@/lib/prompts";
import { labelFor } from "@/lib/templates";
import { cn } from "@/lib/utils";

// The composer's options, below what to do: the new worktree (what it
// starts from, its name, branch, base and template), the attempts (each
// one's extra words and box, the check, the judge, what happens to the
// pick), and for a prompt to running agents, its variables, each agent's
// own copy, and whether to wait, queue or loop.

export function Section({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h3 className="flex items-center justify-between gap-2 text-muted-foreground text-label">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

function Labelled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-muted-foreground text-meta">{label}</span>
      {children}
    </label>
  );
}

export interface WorktreeValues {
  name: string;
  branch: string;
  base: string;
  template: string;
  vars: Record<string, string>;
}

// WorktreeOptions is the new worktree: what it starts from (unless the
// text above already is that, with no agent), and its name, branch and base
// as worked out, to change by hand.
export function WorktreeOptions({
  showStartFrom,
  startFrom,
  onStartFrom,
  kind,
  onKind,
  resolution,
  pending,
  error,
  branches,
  location,
  v,
  set,
  placeholders,
  templates,
  variables,
  nameOnly,
}: {
  showStartFrom: boolean;
  startFrom: string;
  onStartFrom(v: string): void;
  kind: ResolveKind;
  onKind(k: ResolveKind): void;
  resolution?: Resolution;
  pending: boolean;
  error?: string;
  branches?: { default?: string; branches: Branch[] };
  location?: Location;
  v: WorktreeValues;
  set(patch: Partial<WorktreeValues>, edited?: (keyof WorktreeValues)[]): void;
  placeholders: { name: string; branch: string; base: string };
  templates: TaskTemplate[];
  variables: TemplateVariable[];
  // A hand-off's new worktree: its name only.
  nameOnly?: boolean;
}) {
  if (nameOnly) {
    return (
      <Section title="New worktree">
        <Labelled label="Name">
          <Input size="sm" className="font-mono" value={v.name} placeholder={placeholders.name} spellCheck={false} onChange={(e) => set({ name: e.target.value }, ["name"])} />
        </Labelled>
      </Section>
    );
  }
  const scripts = location?.scripts;
  return (
    <Section title="New worktree">
      {showStartFrom && (
        <StartFrom value={startFrom} onChange={onStartFrom} kind={kind} onKind={onKind} resolution={resolution} pending={pending} error={error} branches={branches} defaultBranch={location?.default_branch} focus={false} />
      )}
      <div className="grid grid-cols-[1fr_1fr_9rem] gap-2">
        <Labelled label="Folder">
          <Input size="sm" className="font-mono" value={v.name} placeholder={placeholders.name} spellCheck={false} onChange={(e) => set({ name: e.target.value }, ["name"])} />
        </Labelled>
        <Labelled label="Branch">
          <Input size="sm" className="font-mono" value={v.branch} placeholder={placeholders.branch} spellCheck={false} onChange={(e) => set({ branch: e.target.value }, ["branch"])} />
        </Labelled>
        <Labelled label="From">
          <Input size="sm" className="font-mono" value={v.base} placeholder={placeholders.base} spellCheck={false} onChange={(e) => set({ base: e.target.value }, ["base"])} />
        </Labelled>
      </div>
      {templates.length > 0 && (
        <Labelled label="Template">
          <SimpleSelect size="sm" value={v.template} onChange={(id) => set({ template: id })} options={[{ value: "", label: "None" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
        </Labelled>
      )}
      {variables.map((variable) => (
        <Labelled key={variable.id} label={labelFor(variable)}>
          {variable.multiline ? (
            <Textarea size="sm" rows={2} value={v.vars[variable.id] ?? ""} onChange={(e) => set({ vars: { ...v.vars, [variable.id]: e.target.value } })} />
          ) : (
            <Input size="sm" value={v.vars[variable.id] ?? ""} onChange={(e) => set({ vars: { ...v.vars, [variable.id]: e.target.value } })} />
          )}
        </Labelled>
      ))}
      <p className="flex items-start gap-1.5 text-muted-foreground text-meta">
        <FileCode2Icon className="mt-0.5 size-3.5 shrink-0" />
        {scripts?.setup ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>Setup script {scripts.from === "repo" ? "from .berth/config.json" : "set on this project"}, runs after creating</span>
            <code className="truncate font-mono text-foreground/80" title={scripts.setup}>
              {scripts.setup}
            </code>
          </span>
        ) : (
          <span>No setup script. One in the repository's .berth/config.json runs in every new worktree.</span>
        )}
      </p>
    </Section>
  );
}

export interface AttemptValues {
  check: string;
  judge: string;
  auto: boolean;
  pr: boolean;
  extras: { suffix?: string; box?: string }[];
}

// AttemptsOptions is "Try N ways": each attempt in its own worktree, a
// check that verifies it, a judge that ranks them, and what the pick gets.
export function AttemptsOptions({
  picks,
  presets,
  box,
  otherBoxes,
  v,
  set,
  runsHere,
  names,
}: {
  picks: AgentPick[];
  presets: AgentPreset[];
  box: string;
  otherBoxes: string[];
  v: AttemptValues;
  set(patch: Partial<AttemptValues>): void;
  runsHere: boolean;
  // The attempts' worktrees: the name they share (each gets a suffix) and
  // the branch they start from.
  names: { name: string; base: string; namePlaceholder: string; basePlaceholder: string; set(patch: { name?: string; base?: string }): void };
}) {
  const name = (id: string) => presets.find((p) => p.id === id)?.name ?? id;
  const extra = (i: number, patch: { suffix?: string; box?: string }) => {
    const next = [...v.extras];
    next[i] = { ...next[i], ...patch };
    set({ extras: next });
  };
  return (
    <Section title={`${picks.length} attempts, each in its own worktree`}>
      {!runsHere && <NeedsUpdate box={box}>{box} runs an older berthd without runs, which trying several ways needs.</NeedsUpdate>}
      <div className="grid grid-cols-[1fr_10rem] gap-2">
        <Labelled label="Worktree names">
          <Input size="sm" className="font-mono" value={names.name} placeholder={names.namePlaceholder} spellCheck={false} onChange={(e) => names.set({ name: e.target.value })} />
        </Labelled>
        <Labelled label="From">
          <Input size="sm" className="font-mono" value={names.base} placeholder={names.basePlaceholder} spellCheck={false} onChange={(e) => names.set({ base: e.target.value })} />
        </Labelled>
      </div>
      <div className="flex flex-col gap-1.5">
        {picks.map((p, i) => (
          <div key={i} className="flex min-w-0 items-center gap-2">
            <span className="w-4 shrink-0 text-right text-muted-foreground text-meta tabular-nums">{i + 1}</span>
            <span className="flex w-40 min-w-0 shrink-0 items-center gap-1.5 text-desc">
              <AgentIcon agent={p.agent} className="size-3.5" />
              <span className="truncate">{[name(p.agent), p.model && nice(p.model), p.effort && nice(p.effort)].filter(Boolean).join(" · ")}</span>
            </span>
            <Input size="sm" aria-label={`Extra words for attempt ${i + 1}`} value={v.extras[i]?.suffix ?? ""} placeholder="and, for this one… (optional)" onChange={(e) => extra(i, { suffix: e.target.value })} />
            {otherBoxes.length > 0 && (
              <div className="w-28 shrink-0">
                <SimpleSelect aria-label={`Box for attempt ${i + 1}`} size="sm" className="min-w-0" value={v.extras[i]?.box || box} onChange={(b) => extra(i, { box: b })} options={[box, ...otherBoxes].map((b) => ({ value: b, label: b }))} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_10rem] gap-2">
        <Labelled label="Check, optional (exit 0 passes; a failure goes back once)">
          <Input size="sm" className="font-mono" value={v.check} placeholder="none: the judge reads the changes" onChange={(e) => set({ check: e.target.value })} />
        </Labelled>
        <Labelled label="Judge">
          <SimpleSelect size="sm" className="min-w-0" value={v.judge} onChange={(judge) => set({ judge })} options={presets.map((p) => ({ value: p.id, label: p.name }))} />
        </Labelled>
      </div>
      <div className="flex flex-wrap items-center gap-5 text-desc">
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={v.auto} onCheckedChange={(auto) => set({ auto })} />
          Take the judge's pick
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={v.pr} onCheckedChange={(pr) => set({ pr })} />
          Open a draft PR for the pick
        </label>
      </div>
    </Section>
  );
}

export interface SendValues {
  wait: boolean;
  queueOffline: boolean;
  loop: boolean;
  check: string;
  rounds: number;
}

// SendOptions is a prompt to running agents: its variables, each agent's
// copy to read and change, and what happens after it is typed in.
export function SendOptions({
  vars,
  values,
  onValue,
  chosen,
  textFor,
  edited,
  missingFor,
  onEdit,
  open,
  onOpen,
  awayChosen,
  v,
  set,
}: {
  vars: PromptVariable[];
  values: Record<string, string>;
  onValue(name: string, value: string): void;
  chosen: SessionEntry[];
  textFor(e: SessionEntry): string;
  edited(e: SessionEntry): boolean;
  missingFor(e: SessionEntry): string[];
  onEdit(e: SessionEntry, text?: string): void;
  open?: string;
  onOpen(key?: string): void;
  awayChosen: number;
  v: SendValues;
  set(patch: Partial<SendValues>): void;
}) {
  return (
    <>
      {vars.length > 0 && (
        <Section title="Variables">
          <VariableFields vars={vars} values={values} onChange={onValue} />
        </Section>
      )}
      {chosen.length > 0 && (
        <Section title={chosen.length === 1 ? "Goes to" : `Goes to ${chosen.length} agents, one after another`}>
          <div className="overflow-hidden rounded-lg border bg-background">
            {chosen.map((e) => {
              const k = `${e.box}/${e.session.name}`;
              return <TargetRow key={k} entry={e} expanded={open === k} onExpand={() => onOpen(open === k ? undefined : k)} text={textFor(e)} edited={edited(e)} missing={missingFor(e)} onEdit={(t) => onEdit(e, t)} />;
            })}
          </div>
        </Section>
      )}
      <Section title="Then">
        <div className="flex flex-col gap-2 text-desc">
          <label className={cn("flex cursor-pointer items-center gap-2", v.loop && "opacity-50")}>
            <Switch checked={v.wait && !v.loop} disabled={v.loop} onCheckedChange={(wait) => set({ wait })} />
            Wait for each turn to end, and show what they said
          </label>
          {awayChosen > 0 && (
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={v.queueOffline} onCheckedChange={(queueOffline) => set({ queueOffline })} />
              Queue for the {awayChosen === 1 ? "agent" : `${awayChosen} agents`} on offline boxes, to send when they're back
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={v.loop} onCheckedChange={(loop) => set({ loop })} />
            Loop until a check passes: while it fails, the failure goes back
          </label>
          {v.loop && (
            <div className="grid grid-cols-[1fr_auto] gap-2 ps-11">
              <Labelled label="Check (runs in each agent's worktree; exit 0 means done)">
                <Input size="sm" className="font-mono" value={v.check} onChange={(e) => set({ check: e.target.value })} />
              </Labelled>
              <Labelled label="Rounds">
                <NumberField className="w-28" size="sm" value={v.rounds} min={1} max={20} onValueChange={(n) => n != null && set({ rounds: n })}>
                  <NumberFieldGroup>
                    <NumberFieldDecrement />
                    <NumberFieldInput className="text-center tabular-nums" />
                    <NumberFieldIncrement />
                  </NumberFieldGroup>
                </NumberField>
              </Labelled>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}

function TargetRow({ entry, expanded, onExpand, text, edited, missing, onEdit }: { entry: SessionEntry; expanded: boolean; onExpand(): void; text: string; edited: boolean; missing: string[]; onEdit(text?: string): void }) {
  const { title, short, detail } = useTargetLabel(entry.box, entry.session.name);
  return (
    <div className="border-b last:border-b-0">
      <button type="button" aria-expanded={expanded} onClick={onExpand} className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50">
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <AgentIcon agent={entry.session.agent} className="size-3.5" />
        <span className="min-w-0 truncate text-desc">{title}</span>
        <span className="min-w-0 shrink truncate text-muted-foreground text-meta">{detail.replace(new RegExp(` · ${entry.box}$`), "")}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {missing.length > 0 && (
            <Tip label="Not known for this agent; left out of its prompt">
              <span className="font-mono text-tag text-warning-foreground">no {missing.map((m) => `{{${m}}}`).join(" ")}</span>
            </Tip>
          )}
          {edited && <span className="text-tag text-info-foreground">edited</span>}
          <StateGlyph state={entry.state} className="size-3" />
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1 px-3 pb-2.5 pl-9">
          <Textarea rows={4} className="text-desc" value={text} onChange={(e) => onEdit(e.target.value)} aria-label={`Prompt for ${short}`} />
          {edited && (
            <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => onEdit(undefined)}>
              Use the prompt above again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
