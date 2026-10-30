import { CheckIcon, CircleAlertIcon, KeyRoundIcon, LockIcon, PlusIcon, RotateCwIcon, ServerIcon, SquareTerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RequirementsCard } from "@/components/requirements-card";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RetryLine } from "@/components/workspace/pane-state";
import { useStore } from "@/lib/store";
import { plural } from "@/lib/format";
import { type GitHubState, type TeamStatus, type TeamView } from "@/lib/team";
import { cn } from "@/lib/utils";
import { Avatar } from "@/views/team/team-parts";

// The page's right-hand side: before it runs, a three-line checklist
// (GitHub, the box, keys) that ends in the one button; while it runs, where
// it is and what to do next.

export type CheckState = "todo" | "active" | "done" | "warn";

function Check({ n, title, state, value, children, compact }: { n: number; title: string; state: CheckState; value?: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <div data-testid={`check-${title.toLowerCase()}`} data-state={state} className={cn("px-4 py-3", compact && "px-3 py-2.5")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-medium text-tag",
            state === "done" && "border-success bg-success text-white",
            state === "warn" && "border-warning bg-warning/15 text-warning-foreground",
            state === "active" && "border-foreground text-foreground",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {state === "done" ? <CheckIcon className="size-3" strokeWidth={3} /> : state === "warn" ? "!" : n}
        </span>
        <span className={cn("shrink-0 text-row", state === "todo" && "text-muted-foreground")}>{title}</span>
        {value && <span className="ml-auto flex min-w-0 items-center justify-end gap-1.5 truncate text-right text-meta">{value}</span>}
      </div>
      {children && <div className={cn("mt-2 ml-7.5", compact && "mt-1.5")}>{children}</div>}
    </div>
  );
}

export interface ChecklistProps {
  view: TeamView;
  github: GitHubState;
  boxes: { name: string; detail: string }[];
  box?: string;
  onBox(box: string): void;
  onAddBox(): void;
  keys: Record<string, string>;
  onKey(id: string, value: string): void;
  // How many of the picked repos will be set up.
  picked: number;
  sudo: number;
  // The button: its words, whether it can run, and why not.
  action: string;
  blocked?: string;
  busy?: boolean;
  onRun(): void;
  // At narrow widths, the same in less height, above the plan.
  compact?: boolean;
  // The box has no tmux, which the steps' terminal runs in.
  noTmux?: boolean;
  // The keys are 1Password references: Shipyard signs op in on the box.
  onePassword?: boolean;
  // 1Password skipped: the shared keys are typed here instead.
  skipOP?: boolean;
  onSkipOP?(skip: boolean): void;
}

export function Checklist(p: ChecklistProps) {
  const { view, github, compact } = p;
  // The shared keys that are 1Password references: read with op, or, with
  // 1Password skipped, typed here once (or left blank) like the asked ones.
  const opKeys = view.keys.onepassword ?? [];
  const opRequired = !!view.keys.onepassword_required;
  const own = view.keys.ask.filter((k) => !k.set);
  const asks = p.skipOP ? [...opKeys.filter((k) => !k.set).map((k) => ({ ...k, shared: true })), ...own.map((k) => ({ ...k, shared: false }))] : own.map((k) => ({ ...k, shared: false }));
  const keyCount = view.keys.shared + own.length;
  const missing = view.access.missing;
  const accessLine =
    view.state === "found" && view.access.total > 0 ? (
      missing.length === 0 ? (
        <p className="flex items-center gap-1.5 text-meta text-success-foreground">
          <CheckIcon className="size-3.5" /> You have access to {view.access.total === 1 ? "the repo" : `all ${view.access.total} repos`}
        </p>
      ) : (
        <p data-testid="access-partial" className="flex items-start gap-1.5 text-warning-foreground text-meta">
          <LockIcon className="mt-0.5 size-3 shrink-0" />
          <span>
            You can't read <span className="whitespace-nowrap font-mono">{missing.join(", ")}</span>: ask an admin{view.setup?.contact ? ` (${view.setup.contact})` : ""} · Set up the other {view.access.readable}
          </span>
        </p>
      )
    ) : null;
  const boxPick = (
    <div className="flex items-center gap-1.5">
      {p.boxes.length > 0 ? (
        <SimpleSelect
          size="sm"
          className="min-w-0 flex-1"
          aria-labelledby="team-box-label"
          options={p.boxes.map((b) => ({ value: b.name, label: `${b.name}${b.detail ? ` · ${b.detail}` : ""}` }))}
          value={p.box ?? ""}
          onChange={p.onBox}
          placeholder="Pick a box"
        />
      ) : (
        <Button size="sm" className="flex-1" onClick={p.onAddBox}>
          <PlusIcon /> Add your box
        </Button>
      )}
      {p.boxes.length > 0 && (
        <Tip label="Add a box">
          <Button size="icon-sm" variant="ghost" aria-label="Add a box" onClick={p.onAddBox}>
            <PlusIcon />
          </Button>
        </Tip>
      )}
    </div>
  );
  const opChoice = opKeys.length > 0 && p.onSkipOP && (
    <div className="mb-2">
      <div role="radiogroup" aria-label="1Password" className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-meta">
        {[
          { skip: false, label: "Use 1Password", id: "op-use" },
          { skip: true, label: "Skip 1Password", id: "op-skip" },
        ].map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={!!p.skipOP === o.skip}
            data-testid={o.id}
            disabled={o.skip && opRequired}
            onClick={() => p.onSkipOP?.(o.skip)}
            className={cn("rounded-md px-2.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", !!p.skipOP === o.skip ? "bg-background font-medium text-foreground shadow-xs/5" : "text-muted-foreground hover:text-foreground")}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p data-testid="op-note" className="mt-1.5 text-desc text-muted-foreground">
        {opRequired
          ? `${view.setup?.name ?? "The team"} requires 1Password for its ${plural(opKeys.length, "shared key")}: op signs in once, in ${p.box ?? "the box"}'s terminal.`
          : p.skipOP
            ? "Type each shared key once, or leave it blank: blank ones are listed as missing keys, to add in Project settings. op is never used; you can turn 1Password on later."
            : `${plural(opKeys.length, "shared key")} read on ${p.box ?? "the box"} with your 1Password: op signs in once, in its terminal.`}
      </p>
    </div>
  );
  const keyInputs = asks.length > 0 && (
    <div className="space-y-1.5">
      {asks.map((k) => {
        const id = `${k.project}/${k.key}`;
        return (
          <label key={id} className="block" data-testid={`key-input-${k.key}`}>
            {/* A long name pushes the note to its own line, whole. */}
            <span className="mb-1 flex flex-wrap items-baseline gap-x-1.5 text-meta">
              <span className="min-w-0 break-all font-mono">{k.key}</span>
              <span className="whitespace-nowrap text-muted-foreground">{k.shared ? "the team's, from 1Password" : "yours alone"}</span>
            </span>
            <Input size="sm" type="password" autoComplete="off" placeholder={p.skipOP ? "Paste it, or leave it blank" : "Paste it once"} className="font-mono [&_input::placeholder]:font-sans" value={p.keys[id] ?? ""} onChange={(e) => p.onKey(id, e.target.value)} />
          </label>
        );
      })}
    </div>
  );
  const entered = asks.filter((k) => p.keys[`${k.project}/${k.key}`]).length;
  const fromOP = p.skipOP ? view.keys.shared - opKeys.length : view.keys.shared;
  const keysValue = (
    <span data-testid="keys-line" className="text-muted-foreground">
      {[fromOP ? `${fromOP} ${p.skipOP ? "shared" : "from 1Password"}` : "", asks.length - entered ? `${asks.length - entered} to enter` : entered ? `${entered} entered` : ""].filter(Boolean).join(" · ")}
    </span>
  );

  const button = (
    <div className={cn("border-t bg-muted/30 p-4", compact && "flex flex-wrap items-center gap-x-4 gap-y-1.5 p-3")}>
      <Button data-testid="team-run" className={cn("w-full", compact && "w-auto shrink-0")} disabled={!!p.blocked || p.busy} onClick={p.onRun}>
        {p.busy && <Spinner className="size-3.5" />}
        {p.action}
      </Button>
      {p.blocked && <p className={cn("mt-2 text-center text-desc text-muted-foreground", compact && "mt-0 text-left")}>{p.blocked}</p>}
      <p className={cn("mt-2.5 flex items-start gap-1.5 text-desc text-muted-foreground", compact && "mt-0 min-w-0 flex-1")}>
        <KeyRoundIcon className="mt-0.5 size-3 shrink-0 text-warning-foreground" />
        {p.sudo > 0 ? (
          <span>
            {plural(p.sudo, "step")} {p.sudo === 1 ? "asks" : "ask"} for your password on {p.box ?? "the box"}. You type it; Shipyard doesn't keep it.
          </span>
        ) : (
          <span>Nothing here asks for your password.</span>
        )}
      </p>
    </div>
  );

  if (compact) {
    return (
      <div data-testid="team-checklist" data-compact className="overflow-hidden rounded-xl border bg-card shadow-xs/5">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] divide-x">
          <Check compact n={1} title="GitHub" state={missing.length ? "warn" : "done"} value={<GitHubWho github={github} />}>
            {accessLine}
          </Check>
          <div className="divide-y">
            <Check compact n={2} title="Box" state={p.noTmux ? "warn" : p.box ? "done" : "active"} value={<span id="team-box-label" className="sr-only">Box</span>}>
              {boxPick}
              {p.noTmux && p.box && (
                <p data-testid="box-no-tmux" className="mt-1.5 flex items-start gap-1.5 text-desc text-warning-foreground">
                  <CircleAlertIcon className="mt-0.5 size-3 shrink-0" /> tmux isn't installed on {p.box}: the steps run in it.
                </p>
              )}
            </Check>
            {keyCount > 0 && (
              <Check compact n={3} title="Keys" state={asks.length && asks.some((k) => !p.keys[`${k.project}/${k.key}`]) ? "active" : "done"} value={keysValue}>
                {opChoice}
                {keyInputs}
              </Check>
            )}
          </div>
        </div>
        {button}
      </div>
    );
  }

  return (
    <div data-testid="team-checklist" className="overflow-hidden rounded-xl border bg-card shadow-xs/5">
      <div className="divide-y">
        <Check n={1} title="GitHub" state={missing.length ? "warn" : "done"} value={<GitHubWho github={github} />}>
          {accessLine}
        </Check>
        <Check n={2} title="Box" state={p.noTmux ? "warn" : p.box ? "done" : "active"} value={<span id="team-box-label" className="sr-only">Box</span>}>
          {boxPick}
          {p.noTmux && p.box ? (
            <RequirementsCard box={p.box} team className="mt-2.5 -ml-7.5" />
          ) : (
            <p className="mt-1.5 text-desc text-muted-foreground">
              It signs in to GitHub itself{p.onePassword ? ", and to 1Password," : ""} in its own terminal: this computer's sign-in is never copied there.
            </p>
          )}
        </Check>
        {keyCount > 0 && (
          <Check n={3} title="Keys" state={asks.length && asks.some((k) => !p.keys[`${k.project}/${k.key}`]) ? "active" : "done"} value={keysValue}>
            {opChoice}
            {keyInputs}
            {asks.length > 0 && <p className="mt-1.5 text-desc text-muted-foreground">Kept on {p.box ?? "the box"} only, never in git. Leave one empty to skip it: it is listed as missing.</p>}
          </Check>
        )}
      </div>
      {button}
    </div>
  );
}

function GitHubWho({ github }: { github: GitHubState }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar src={github.avatar_url} name={github.login ?? "?"} size={16} />
      <span className="truncate">{github.login}</span>
    </span>
  );
}

// RunCard is the rail while the setup runs: where it is, how far, and the
// one thing to do now.
export function RunCard({ run, github, os, onOpenTerminal, onRetry, onBackground, compact }: { run: TeamStatus; github?: GitHubState; os?: string; onOpenTerminal(): void; onRetry(from: string): void; onBackground(): void; compact?: boolean }) {
  const summary = runSummary(run);
  const { tone, pct, retryFrom } = summary;
  // The box out of reach mid-run: what the card last heard may be stale, so
  // it says so, and when Shipyard tries next. The setup runs on in the box's
  // terminal; the card catches up from the box's events when it is back.
  const boxState = useStore((s) => s.status?.boxes.find((b) => b.name === run.box)?.state);
  const away = !!boxState && boxState !== "online" && run.phase !== "done";
  const title = away ? `Reconnecting to ${run.box}…` : summary.title;
  const detail = away ? (
    <>
      <RetryLine box={run.box} />
      {`It was at: ${summary.title}. The setup carries on there, and this catches up when ${run.box} is back.`}
    </>
  ) : (
    summary.detail
  );
  const icon = tone === "failed" ? <CircleAlertIcon className="size-4 shrink-0 text-destructive" /> : tone === "waiting" ? <KeyRoundIcon className="size-4 shrink-0 text-warning-foreground" /> : tone === "done" ? <CheckIcon className="size-4 shrink-0 text-success" /> : <Spinner className="size-4 shrink-0" />;
  const bar = (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone === "failed" ? "bg-destructive" : tone === "done" ? "bg-success" : "bg-foreground")} style={{ width: `${Math.max(4, pct * 100)}%` }} />
    </div>
  );
  const primary = retryFrom ? (
    <Button size="sm" className={compact ? undefined : "w-full"} onClick={() => onRetry(retryFrom.id)}>
      <RotateCwIcon /> Retry from {shortTitle(retryFrom.title)}
    </Button>
  ) : (
    <Button size="sm" variant="outline" className={compact ? undefined : "min-w-0 flex-1"} onClick={onOpenTerminal} disabled={!run.session && !run.projects.some((p) => p.session)}>
      <SquareTerminalIcon /> Open terminal
    </Button>
  );
  const background = (
    <Button size="sm" variant="ghost" className={compact ? undefined : "min-w-0 flex-1"} onClick={onBackground}>
      Run in background
    </Button>
  );
  if (compact) {
    // At narrow widths, one band above the plan: the plan stays in view.
    return (
      <div data-testid="team-runcard" data-phase={run.phase} data-compact className="overflow-hidden rounded-xl border bg-card px-4 py-3 shadow-xs/5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            <p className="flex items-center gap-2 text-row">
              {icon}
              {title}
            </p>
            <div className="mt-0.5 text-desc text-muted-foreground">{detail}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {primary}
            {background}
          </div>
        </div>
        <div className="mt-2.5">{bar}</div>
      </div>
    );
  }
  return (
    <div data-testid="team-runcard" data-phase={run.phase} className="overflow-hidden rounded-xl border bg-card shadow-xs/5">
      <div className="p-4">
        <p className="flex items-center gap-2 text-row">
          {icon}
          {title}
        </p>
        <div className="mt-1 text-desc text-muted-foreground">{detail}</div>
        <div className="mt-3">{bar}</div>
      </div>
      <div className="space-y-1.5 border-t px-4 py-3 text-meta">
        {github?.login && (
          <p className="flex items-center gap-2">
            <Avatar src={github.avatar_url} name={github.login} size={14} /> {github.login}
          </p>
        )}
        <p className="flex items-center gap-2">
          <ServerIcon className="size-3.5 text-muted-foreground" /> {run.box}
          {os ? <span className="text-muted-foreground">· {os}</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 border-t bg-muted/30 p-3">
        {primary}
        {background}
      </div>
    </div>
  );
}

// shortTitle is a step's name for a button: "Postgres 16 in Docker" → "Postgres 16".
export const shortTitle = (t: string) => t.replace(/ (with|in|and) .*/, "");

export function runSummary(run: TeamStatus): { title: string; detail: string; tone: "running" | "waiting" | "failed" | "done"; pct: number; retryFrom?: { id: string; title: string }; status: string } {
  const steps = run.steps;
  const doneSteps = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const repos = run.projects.filter((p) => p.state !== "skipped");
  const ready = repos.filter((p) => p.state === "ready").length;
  const total = steps.length + repos.length;
  const pct = total ? (doneSteps + ready) / total : 0;
  const failedStep = steps.find((s) => s.state === "failed");
  const failedRepo = run.projects.find((p) => p.state === "failed");
  const waiting = steps.find((s) => s.state === "waiting");
  const running = steps.findIndex((s) => s.state === "running" || s.state === "waiting");
  if (failedStep)
    return {
      title: `Stopped at ${failedStep.title}`,
      detail: `${doneSteps} of ${steps.length} box steps done. Fix it, then retry from that step; the ones done are kept.`,
      tone: "failed",
      pct,
      retryFrom: failedStep,
      status: `stopped at ${failedStep.title} · Retry`,
    };
  if (failedRepo)
    return { title: `${failedRepo.id} didn't set up`, detail: failedRepo.error ?? "See its row for why.", tone: "failed", pct, retryFrom: { id: failedRepo.id, title: failedRepo.id }, status: `${failedRepo.id} failed · Retry` };
  if (run.phase === "done") return { title: "Set up", detail: `${run.box} matches ${run.name}'s team setup.`, tone: "done", pct: 1, status: "done" };
  if (waiting?.id === "github")
    return { title: "Sign the box in to GitHub", detail: `Enter the code at github.com/login/device. Box step ${running + 1} of ${steps.length}, then ${plural(repos.length, "repo")}.`, tone: "waiting", pct, status: "waiting for GitHub's code" };
  if (waiting?.id === "1password")
    return { title: "Sign the box in to 1Password", detail: `op asks in ${run.box}'s terminal, once, so Shipyard can read the team's shared keys. Box step ${running + 1} of ${steps.length}, then ${plural(repos.length, "repo")}.`, tone: "waiting", pct, status: "waiting for 1Password" };
  if (waiting) return { title: "Waiting for your password", detail: `sudo asks in ${run.box}'s terminal. Box step ${running + 1} of ${steps.length}, then ${plural(repos.length, "repo")}.`, tone: "waiting", pct, status: "waiting for your password" };
  const asking = run.projects.find((p) => p.waiting && p.state === "setting-up");
  if (asking)
    return {
      title: `${asking.id} is asking something`,
      detail: `Its first-time setup waits for an answer in its terminal on ${run.box}${asking.line ? `: “${asking.line}”` : ""}. Open the terminal and answer; the rest carries on.`,
      tone: "waiting",
      pct,
      status: `${asking.id} waits for you`,
    };
  if (run.phase === "projects") {
    const busy = repos.filter((p) => p.state !== "ready").map((p) => p.id);
    return {
      title: ready ? `${ready} of ${repos.length} repos ready` : "Cloning repos",
      detail: busy.length ? `The box is ready. ${busy.join(" and ")} ${busy.length === 1 ? "is" : "are"} still setting up; start on what's ready.` : "Finishing up.",
      tone: "running",
      pct,
      status: `${ready} of ${repos.length} repos ready`,
    };
  }
  const cur = steps[running];
  return { title: cur ? cur.title : "Starting", detail: `Box step ${Math.max(1, running + 1)} of ${steps.length}, then ${plural(repos.length, "repo")}.`, tone: "running", pct, status: cur ? `${cur.title.toLowerCase()} (${running + 1} of ${steps.length})` : "starting" };
}
