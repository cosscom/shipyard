import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronRightIcon, EllipsisIcon, MinusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { PickOne } from "@/components/pick-one";
import { SimpleSelect } from "@/components/simple-select";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import type { AgentPreset } from "@/lib/api";
import type { Step, StepRun, StepWhen } from "@/lib/flows";
import { cn } from "@/lib/utils";
import { type Variable, kindMeta } from "@/views/automations/flows/model";
import { TemplateField } from "@/views/automations/flows/template-field";

const WHENS: { value: StepWhen; label: string }[] = [
  { value: "success", label: "On success" },
  { value: "failure", label: "On failure" },
  { value: "always", label: "Always" },
];

const WAIT_STATES = [
  { value: "finished", label: "Finished" },
  { value: "waiting", label: "Needs you" },
  { value: "idle", label: "Idle" },
];

// StepCard is one step on the canvas: what it does, its fields, when it
// runs relative to the step before it, and how it went in the last test.
export function StepCard({
  step,
  index,
  count,
  variables,
  agents,
  readOnly,
  result,
  onChange,
  onMove,
  onRemove,
}: {
  step: Step;
  index: number;
  count: number;
  variables: Variable[];
  agents: AgentPreset[];
  readOnly?: boolean;
  result?: StepRun;
  onChange(s: Step): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
}) {
  const meta = kindMeta(step.kind);
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch });
  const when = step.when ?? "success";

  return (
    <article className={cn("relative rounded-xl border bg-card shadow-xs/5", when === "failure" && "border-warning/30", result?.status === "failed" && "border-destructive/40")}>
      <header className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted", meta.tone)}>
          <meta.Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-meta text-muted-foreground tabular-nums">{index + 1}.</span>
            <h3 className="truncate text-section">{meta.label}</h3>
            {result && <ResultBadge result={result} />}
          </div>
          <p className="truncate text-desc text-muted-foreground">{meta.hint}</p>
        </div>
        {!readOnly && (
          <Menu>
            <MenuTrigger render={<button type="button" aria-label="Step options" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />}>
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={index === 0} onClick={() => onMove(-1)}>
                <ArrowUpIcon />
                Move up
              </MenuItem>
              <MenuItem disabled={index === count - 1} onClick={() => onMove(1)}>
                <ArrowDownIcon />
                Move down
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={onRemove} disabled={count === 1}>
                <Trash2Icon />
                Remove step
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </header>

      <div className="space-y-3 px-3.5 py-3">
        <Fields step={step} set={set} variables={variables} agents={agents} readOnly={readOnly} />
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/30 px-3.5 py-2">
        <span className="text-muted-foreground text-meta">Runs</span>
        {index === 0 ? (
          <span className="text-muted-foreground text-meta">first, when the trigger fires</span>
        ) : readOnly ? (
          <span className="text-meta">{WHENS.find((w) => w.value === when)?.label}</span>
        ) : (
          <PickOne<StepWhen>
            label="Runs when"
            value={when}
            onChange={(w) => set({ when: w === "success" ? undefined : w })}
            // Running only after a failure is the unusual case; it says so.
            options={WHENS.map((w) => ({ ...w, className: w.value === "failure" ? "data-pressed:bg-warning/15 data-pressed:text-warning dark:data-pressed:bg-warning/15" : undefined }))}
          />
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-muted-foreground text-meta">Name</span>
          <Input
            value={step.id ?? ""}
            readOnly={readOnly}
            onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") || undefined })}
            placeholder="optional"
            size="sm"
            className="w-28 font-mono text-mono"
            aria-label="Step name, for {{steps.NAME.output}}"
          />
        </span>
      </footer>

      {result && (result.output || result.error) && <ResultOutput result={result} />}
    </article>
  );
}

function Fields({ step, set, variables, agents, readOnly }: { step: Step; set(p: Partial<Step>): void; variables: Variable[]; agents: AgentPreset[]; readOnly?: boolean }) {
  const timeout = (placeholder: string) => (
    <label className="block w-32">
      <span className="mb-1 block text-label text-muted-foreground">Timeout</span>
      <Input value={step.timeout ?? ""} readOnly={readOnly} onChange={(e) => set({ timeout: e.target.value || undefined })} placeholder={placeholder} className="font-mono text-mono" />
    </label>
  );
  switch (step.kind) {
    case "run":
      return (
        <>
          <TemplateField label="Command" mono value={step.command ?? ""} onChange={(command) => set({ command })} variables={variables} placeholder="pnpm test" readOnly={readOnly} />
          <p className="text-desc text-muted-foreground">Variables reach the command as quoted environment variables ($BERTH_FLOW_…), so a PR comment or branch name is always text, never run.</p>
          {timeout("10m")}
        </>
      );
    case "prompt":
      return (
        <>
          <TemplateField label="Prompt" multiline value={step.text ?? ""} onChange={(text) => set({ text })} variables={variables} placeholder="The tests failed: {{prev.output}} — fix them." readOnly={readOnly} />
          <label className="block">
            <span className="mb-1 block text-label text-muted-foreground">Session</span>
            <Input value={step.session ?? ""} readOnly={readOnly} onChange={(e) => set({ session: e.target.value || undefined })} placeholder="The agent that triggered this flow" className="font-mono text-mono" />
          </label>
        </>
      );
    case "wait":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className="mb-1 block text-label text-muted-foreground">Until the agent is</span>
            <div className="flex items-center gap-1">
              {WAIT_STATES.map((s) => {
                const on = (step.for ?? ["finished", "waiting"]).includes(s.value);
                return (
                  <button
                    key={s.value}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={on}
                    onClick={() => {
                      const cur = step.for ?? ["finished", "waiting"];
                      const next = on ? cur.filter((x) => x !== s.value) : [...cur, s.value];
                      set({ for: next.length ? next : undefined });
                    }}
                    className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-meta", on ? "border-ring/40 bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {on ? <CheckIcon className="size-3" /> : <MinusIcon className="size-3 opacity-40" />}
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
          {timeout("30m")}
        </div>
      );
    case "start_agent":
      return (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-48">
              <span className="mb-1 block text-label text-muted-foreground">Agent</span>
              <SimpleSelect
                value={step.agent ?? ""}
                disabled={readOnly}
                onChange={(agent) => set({ agent })}
                options={(agents.length ? agents : [{ id: "claude", name: "Claude Code", command: "claude" }, { id: "codex", name: "Codex", command: "codex" }]).map((a) => ({ value: a.id, label: a.name }))}
              />
            </div>
            <label className="flex h-8 items-center gap-2 text-body">
              <Switch checked={!!step.new_worktree} disabled={readOnly} onCheckedChange={(v) => set({ new_worktree: v || undefined })} />
              In a new worktree
            </label>
            {step.new_worktree && (
              <label className="block w-44">
                <span className="mb-1 block text-label text-muted-foreground">Worktree name</span>
                <Input value={step.name ?? ""} readOnly={readOnly} onChange={(e) => set({ name: e.target.value || undefined })} placeholder="{{worktree.name}}-review" className="font-mono text-mono" />
              </label>
            )}
          </div>
          <TemplateField label="Its first prompt" multiline value={step.text ?? ""} onChange={(text) => set({ text })} variables={variables} placeholder="Review the changes in {{worktree.path}}." readOnly={readOnly} />
          <div className="flex items-center gap-1.5 text-muted-foreground text-meta">
            <AgentIcon agent={step.agent} />
            Starts beside the agent that triggered this, in {step.new_worktree ? "a fresh worktree" : "the same worktree"}.
          </div>
        </>
      );
    case "notify":
      return (
        <>
          <TemplateField label="Title" value={step.title ?? ""} onChange={(title) => set({ title })} variables={variables} placeholder="{{worktree.name}} needs you" readOnly={readOnly} />
          <TemplateField label="Body" value={step.text ?? ""} onChange={(text) => set({ text: text || undefined })} variables={variables} placeholder="optional" readOnly={readOnly} />
        </>
      );
    case "webhook":
      return (
        <>
          <TemplateField label="URL" mono value={step.url ?? ""} onChange={(url) => set({ url })} variables={variables} placeholder="https://hooks.slack.com/services/…" readOnly={readOnly} />
          <TemplateField label="JSON body" mono multiline value={step.text ?? ""} onChange={(text) => set({ text: text || undefined })} variables={variables} placeholder="Empty sends the run's context" readOnly={readOnly} />
          <p className="text-desc text-muted-foreground">Public addresses only; private ones must be allowed in ~/.berth/network.json on the box.</p>
        </>
      );
  }
}

function ResultBadge({ result }: { result: StepRun }) {
  const tone = result.status === "succeeded" ? "bg-success/12 text-success" : result.status === "failed" ? "bg-destructive/12 text-destructive-foreground" : "bg-muted text-muted-foreground";
  const Icon = result.status === "succeeded" ? CheckIcon : result.status === "failed" ? XIcon : MinusIcon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-tag", tone)}>
      <Icon className="size-3" />
      {result.status === "skipped" ? "skipped" : result.duration || result.status}
      {result.kind === "run" && result.status !== "skipped" && <span className="opacity-70">· exit {result.exit_code}</span>}
    </span>
  );
}

function ResultOutput({ result }: { result: StepRun }) {
  const [open, setOpen] = useState(result.status === "failed");
  return (
    <div className="border-t">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-muted-foreground text-meta hover:text-foreground">
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        {result.error ? "Error" : "Output"}
      </button>
      {open && (
        <pre className="mx-3.5 mb-3 max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-mono text-muted-foreground">
          {[result.error, result.output].filter(Boolean).join("\n")}
        </pre>
      )}
    </div>
  );
}
