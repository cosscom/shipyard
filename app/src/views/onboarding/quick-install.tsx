import { ArrowRightIcon, ChevronRightIcon, KeyRoundIcon, RotateCwIcon, ServerIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { type AgentChoice, type GuidedInstallRequest, laptopApi } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CommandLine, type InstallRun, type InstallTarget, InstallTerminal, type StepRow, StepIcon, useInstallRun } from "@/views/onboarding/guided-install";
import { FailurePanel } from "@/views/onboarding/ssh-setup";

// QuickInstall is adding a box the usual way: no plan to read, no Enter to
// press. Once the person has said where (and which agents), berth add ssh
// runs quietly and this compact dialog shows a short checklist. Only a step
// that truly needs the person opens the terminal, inline, for just that
// step: sudo asking for the password (git missing, or lingering the box
// won't allow without root), whether to keep berthd running after logout
// when that alone needs the password (it can be skipped), or a question
// the box can't answer for them. Team setup's add a box is the guided
// install instead (guided-install.tsx): the whole plan, full screen.

export function QuickInstall({ target, onClose, onReady, readyLabel }: { target?: InstallTarget & { agents: string[] }; onClose(): void; onReady(box: string): void; readyLabel?: string }) {
  const run = useInstallRun();
  const busy = run.state === "running";
  const host = target?.host ?? "";
  const where = host.split("@").pop() ?? host;
  const user = host.includes("@") ? host.slice(0, host.lastIndexOf("@")) : "your user";
  const [identity, setIdentity] = useState(target?.identity ?? "");
  const [output, setOutput] = useState(false);
  const ready = run.state === "done" && !!run.box;
  const failed = run.steps.find((s) => s.state === "fail");
  const go = useRef<HTMLButtonElement>(null);

  const request = (more: Partial<GuidedInstallRequest> = {}) => ({ ...target!, identity: identity || target!.identity, knownHostKeys: target!.knownHostKeys, ...more }) as GuidedInstallRequest;
  useEffect(() => {
    if (!target) {
      run.reset();
      setOutput(false);
      return;
    }
    run.start(request());
    // A new target starts again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.host]);
  useEffect(() => {
    if (ready) go.current?.focus();
  }, [ready]);

  // The step the person is needed for, if any: the terminal shows for it.
  const needed = run.steps.find((s) => s.state === "running" && (s.needs === "password" || run.waiting === "password"));
  const asking = run.steps.find((s) => s.state === "running" && s.needs === "ask");
  const question = !needed && !asking && run.waiting === "enter";
  const showTerminal = busy && (!!needed || question);

  const title = ready ? `${run.box} is ready` : run.state === "failed" ? `${where} isn't set up yet` : `Setting up ${where}`;
  const sub = ready
    ? "Paired with this computer. Shipyard no longer needs SSH for it."
    : needed
      ? `sudo needs ${user}'s password on ${where} for this step.`
      : asking
        ? "One question before Shipyard goes on."
        : run.state === "failed"
          ? "It stopped at the step below. The steps before it are kept."
          : "Shipyard installs what the box needs. It only stops if sudo needs your password.";

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogPopup data-testid="quick-install" data-state={ready ? "ready" : run.state} data-needs={needed ? "password" : asking ? "ask" : question ? "answer" : ""} className={cn("transition-[max-width]", showTerminal || output ? "sm:max-w-2xl" : "sm:max-w-md")} showCloseButton={!busy}>
        <DialogHeader className="pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
              <ServerIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-base leading-tight">{title}</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">{sub}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel className="pt-1">
          <ol data-testid="quick-steps" className="-mx-2 space-y-0.5">
            {run.steps.map((s) => (
              <QuickRow key={s.id} step={s} run={run} host={where} user={user} busy={busy} agents={target?.agents ?? []} needed={needed?.id === s.id} onRetry={() => run.start(request(), s.id === "connect" ? undefined : s.id)} />
            ))}
          </ol>
          {question && (
            <div data-testid="quick-question" className="mt-3 rounded-lg border bg-info/6 px-3 py-2 text-xs leading-relaxed">
              <span className="font-medium">{where} needs an answer.</span> Answer in the terminal below and press <Kbd>↵</Kbd>.
            </div>
          )}
          {showTerminal && (
            <div className="mt-2 flex h-44 flex-col overflow-hidden rounded-lg border" data-testid="quick-terminal">
              <InstallTerminal run={run} fontSize={11.5} />
            </div>
          )}
          {run.failure && run.state === "failed" && <FailurePanel failure={run.failure} identity={identity} setIdentity={setIdentity} onRetry={(trust) => run.start(request({ trust_host_key: trust ?? target?.trust_host_key }))} />}
          {run.state === "failed" && !showTerminal && (
            <div className="mt-3">
              <button type="button" className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground" aria-expanded={output} onClick={() => setOutput((o) => !o)}>
                <ChevronRightIcon className={cn("size-3.5 transition-transform", output && "rotate-90")} /> {output ? "Hide" : "Show"} what the box printed
              </button>
              {output && (
                <div className="mt-2 flex h-44 flex-col overflow-hidden rounded-lg border" data-testid="quick-output">
                  <InstallTerminal run={run} fontSize={11.5} />
                </div>
              )}
            </div>
          )}
          {run.state === "failed" && !failed && !run.failure && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => run.start(request())}>
              <RotateCwIcon /> Start again
            </Button>
          )}
        </DialogPanel>
        <DialogFooter>
          {busy ? (
            <Button variant="ghost" data-testid="quick-stop" onClick={run.stop}>
              Stop
            </Button>
          ) : ready ? (
            <Button ref={go} data-testid="quick-continue" onClick={() => run.box && onReady(run.box)}>
              {readyLabel ?? `Go to ${run.box}`} <ArrowRightIcon />
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// What each step does, in a few words, beside its title.
function hint(s: StepRow, agents: string[]): string | undefined {
  switch (s.id) {
    case "berthd":
      return "as your own user service";
    case "linger":
      return "so berthd runs after you log out";
    case "tools":
      return s.sudo ? "git, with sudo" : "Shipyard's own tmux, no sudo";
    case "agents":
      return agents.length === 1 ? "into ~/.local/bin, no sudo" : `${agents.length} agents, no sudo`;
    case "integrations":
      return "hooks and skills";
    case "pair":
      return "keys pinned both ways";
  }
  return undefined;
}

function QuickRow({ step: s, run, host, user, busy, agents, needed, onRetry }: { step: StepRow; run: InstallRun; host: string; user: string; busy: boolean; agents: string[]; needed: boolean; onRetry(): void }) {
  // What it did, where that says more than the hint: who it connected as,
  // lingering on without sudo, or why a step was skipped.
  const message = s.state === "skip" ? s.message?.replace(/^skipped: /, "") : (s.id === "connect" || s.id === "linger") && s.state === "done" ? s.message : undefined;
  return (
    <li data-testid={`quick-step-${s.id}`} data-state={s.state} data-needs={s.needs ?? ""} className={cn("rounded-lg px-2 py-1.5", (needed || s.needs === "ask") && "bg-warning/8", s.state === "fail" && "bg-destructive/6")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <StepIcon state={s.state} />
        <span className={cn("shrink-0 text-[13px]", (s.state === "todo" || s.state === "skip") && "text-muted-foreground", s.state === "running" && "font-medium")}>{s.id === "tools" ? "tmux and git" : s.title}</span>
        <span className="min-w-0 truncate text-muted-foreground text-xs">{message ?? hint(s, agents)}</span>
        {s.sudo && s.state !== "skip" && (
          <Badge variant="warning" size="sm" className="ms-auto shrink-0">
            <KeyRoundIcon /> sudo
          </Badge>
        )}
      </div>
      {needed && (
        <p data-testid="quick-password" className="mt-1 ml-7.5 text-xs leading-relaxed">
          Type it in the terminal below and press <Kbd>↵</Kbd>; nothing shows as you type. It goes to sudo on {host}: Shipyard never sees it or keeps it.
        </p>
      )}
      {s.needs === "ask" && s.state === "running" && <LingerChoice run={run} user={user} host={host} question={s.question} />}
      {s.state === "fail" && (
        <div className="mt-1.5 ml-7.5 space-y-2">
          {s.message && <p className="text-destructive-foreground text-xs leading-relaxed">{s.message}</p>}
          {s.command && <CommandLine command={s.command} />}
          {!busy && (
            <Button size="xs" data-testid={`quick-retry-${s.id}`} onClick={onRetry}>
              <RotateCwIcon /> Retry from here
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// LingerChoice: keeping berthd running after logout needs root on this box
// and nothing else does, so the person decides: type the password once, or
// skip it and know what that means.
function LingerChoice({ run, user, host }: { run: InstallRun; user: string; host: string; question?: string }) {
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => yes.current?.focus(), []);
  return (
    <div data-testid="quick-linger" className="mt-1.5 ml-7.5 space-y-2">
      <p className="text-xs leading-relaxed">
        {host} needs root to keep berthd running after you log out: sudo asks for {user}'s password, once. Without it, berthd stops when your last login there ends, and the box goes offline until you log in again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button ref={yes} size="xs" data-testid="quick-linger-yes" onClick={() => run.answer("linger", true)}>
          <SquareTerminalIcon /> Keep it running
        </Button>
        <Button size="xs" variant="ghost" data-testid="quick-linger-skip" onClick={() => run.answer("linger", false)}>
          Skip
        </Button>
      </div>
    </div>
  );
}

// InlineAgents is the agents choice beside the SSH field: Claude Code ticked
// the first time, the choice remembered for the next box.
export function InlineAgents({ value, onChange, disabled }: { value: string[]; onChange(ids: string[]): void; disabled?: boolean }) {
  const offered = useAgentCatalog().filter((a) => a.offered);
  if (!offered.length) return <div className="mt-2 h-4" />;
  return (
    <div data-testid="inline-agents" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="text-muted-foreground">Agents</span>
      {offered.map((a) => {
        const on = value.includes(a.id);
        return (
          <label key={a.id} data-testid={`inline-agent-${a.id}`} data-checked={on || undefined} className="flex cursor-pointer items-center gap-1.5">
            <Checkbox checked={on} disabled={disabled} aria-label={a.name} onCheckedChange={(c) => onChange(c ? [...value.filter((v) => v !== a.id), a.id].sort((x, y) => order(x) - order(y)) : value.filter((v) => v !== a.id))} />
            {a.name}
          </label>
        );
      })}
      {busyHint(value)}
    </div>
  );
}

const ORDER = ["claude", "codex", "cursor", "opencode", "grok", "gemini"];
const order = (id: string) => (ORDER.indexOf(id) + 1 || 99) as number;
const busyHint = (v: string[]) => (v.length === 0 ? <span className="text-muted-foreground">none: add them later in Settings</span> : null);

// The agent CLIs Shipyard can install, as the laptop agent lists them; asked
// once per window.
let catalog: Promise<AgentChoice[]> | undefined;
function useAgentCatalog(): AgentChoice[] {
  const client = useStore((s) => s.client);
  const [list, setList] = useState<AgentChoice[]>([]);
  useEffect(() => {
    if (!client) return;
    let live = true;
    catalog ??= laptopApi.installPlan(client, "me@box", []).then(
      (p) => p.agents,
      () => {
        catalog = undefined;
        return [];
      },
    );
    void catalog.then((a) => live && setList(a));
    return () => {
      live = false;
    };
  }, [client]);
  return list;
}
