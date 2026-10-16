import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  KeyRoundIcon,
  LaptopIcon,
  MinusIcon,
  RotateCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useActiveTheme } from "@/hooks/use-theme";
import { useMediaQuery } from "@/hooks/use-media-query";
import { type AgentChoice, boxApi, type GuidedInstallRequest, type InstallEvent, type InstallPlan, type InstallPlanStep, laptopApi, type SshFailure, type TerminalConnection } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { openUrl } from "@/lib/open-url";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { createTerminal, type TermHandle } from "@/lib/terminal";
import { putRun, runFor, type TeamAfterInstall, type TeamStatus, useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";
import { TerminalView } from "@/components/workspace/terminal-view";
import { FailurePanel } from "@/views/onboarding/ssh-setup";

export type { TeamAfterInstall };

// The guided install: adding a box over SSH as one flow the person can see
// through. First the plan, in words, with the exact commands a click away
// and the steps that need sudo marked, and the agent CLIs to put on the
// box. Then berth add ssh runs in a terminal here, full screen, beside a
// checklist its step markers keep up to date: the person presses Enter to
// start and types their password when sudo asks for it on the box. The
// bytes go straight to the box; Shipyard never reads, keeps or logs them. A
// failed step offers Retry from it. It ends with Ready.

export interface InstallTarget {
  host: string;
  name?: string;
  network?: string;
  identity?: string;
  trust_host_key?: string;
  // Host key fingerprints the tailnet vouches for: trusted without asking.
  knownHostKeys?: string[];
}

type Stage = "plan" | "run";

export function GuidedInstall({ target, onClose, onReady, readyLabel, team }: { target: InstallTarget | undefined; onClose(): void; onReady(box: string): void; readyLabel?: string; team?: TeamAfterInstall }) {
  const [stage, setStage] = useState<Stage>("plan");
  const [agents, setAgents] = useAgentChoice();
  const run = useInstallRun();
  const busy = run.state === "running";

  useEffect(() => {
    if (!target) {
      setStage("plan");
      run.reset();
    }
    // A new target starts again at the plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.host]);

  const start = () => {
    if (!target) return;
    setStage("run");
    run.start({ ...target, agents, guided: true });
  };

  return (
    <DialogPrimitive.Root
      open={!!target}
      onOpenChange={(open) => {
        // While steps run, closing would cut the box off mid-step: Stop first.
        if (!open && !busy) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background" />
        <DialogPrimitive.Popup aria-label={`Set up ${target?.host ?? "a box"}`} data-testid="guided-install" data-stage={stage} className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none">
          {target && stage === "plan" && <PlanStage target={target} agents={agents} onAgents={setAgents} onStart={start} onClose={onClose} team={team} />}
          {target && stage === "run" && (
            <RunStage
              target={target}
              run={run}
              agents={agents}
              onClose={onClose}
              onReady={onReady}
              readyLabel={readyLabel}
              team={team}
              onBack={() => {
                run.reset();
                setStage("plan");
              }}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// useAgentChoice is the agents to install, remembered for the next box.
export function useAgentChoice(): [string[], (ids: string[]) => void] {
  const saved = usePrefs((p) => p.installAgents);
  const agents = saved ?? ["claude"];
  return [agents, (ids) => setPrefs({ installAgents: ids })];
}

function useInstallPlan(host: string, agents: string[]) {
  const client = useStore((s) => s.client);
  const [plan, setPlan] = useState<InstallPlan>();
  const [error, setError] = useState<string>();
  const key = agents.join(",");
  useEffect(() => {
    if (!client) return;
    let live = true;
    laptopApi.installPlan(client, host, agents).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setError(undefined);
      },
      (err) => live && setError(plainError(err)),
    );
    return () => {
      live = false;
    };
    // agents by value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, host, key]);
  return { plan, error };
}

function Header({ icon, title, sub, right }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5" data-tauri-drag-region>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-semibold text-[15px] leading-tight">{title}</h1>
        {sub && <p className="truncate text-muted-foreground text-xs">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

function CloseButton({ onClick, disabled, label = "Close" }: { onClick(): void; disabled?: boolean; label?: string }) {
  return (
    <Tip label={disabled ? "Stop the install first" : label}>
      <Button size="icon-sm" variant="ghost" aria-label={label} disabled={disabled} onClick={onClick}>
        <XIcon />
      </Button>
    </Tip>
  );
}

// ---------------------------------------------------------------- the plan

function PlanStage({ target, agents, onAgents, onStart, onClose, team }: { target: InstallTarget; agents: string[]; onAgents(ids: string[]): void; onStart(): void; onClose(): void; team?: TeamAfterInstall }) {
  const { plan, error } = useInstallPlan(target.host, agents);
  const sudo = [...(plan?.steps.filter((s) => s.sudo) ?? []), ...(team?.steps.filter((s) => s.sudo) ?? [])];
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (plan) primary.current?.focus();
  }, [plan]);
  return (
    <>
      <Header
        icon={<ServerIcon className="size-4" />}
        title={team ? `Set up ${target.host} for ${team.name}` : `Set up ${target.host}`}
        sub={team ? `Shipyard installs what the box needs, then runs ${team.name}'s setup on it, in a terminal here. Nothing runs until you start it.` : "Shipyard installs what this box needs, in a terminal here. Nothing runs until you start it."}
        right={<CloseButton onClick={onClose} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl gap-x-10 gap-y-8 px-6 pt-7 pb-10 min-[1100px]:grid-cols-[340px_1fr]">
          <section aria-labelledby="agents-heading" data-testid="install-agents">
            <h2 id="agents-heading" className="font-medium text-sm">
              Agents
            </h2>
            <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">Installed on the box without sudo. You sign in to each the first time it starts.</p>
            <AgentPicker choices={plan?.agents ?? []} value={agents} onChange={onAgents} />
          </section>

          <section aria-labelledby="plan-heading">
            <div className="flex items-baseline gap-2">
              <h2 id="plan-heading" className="font-medium text-sm">
                What will run
              </h2>
              {plan && <span className="text-muted-foreground text-xs">{plan.steps.length} steps · each is skipped if the box already has it</span>}
            </div>
            {error && <p className="mt-2 text-destructive-foreground text-sm">{error}</p>}
            {!plan && !error && (
              <p className="mt-3 flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-3.5" /> Reading the plan…
              </p>
            )}
            {plan && (
              <ol data-testid="install-plan" className="mt-3 divide-y overflow-hidden rounded-xl border bg-card">
                {plan.steps.map((s, i) => (
                  <PlanRow key={s.id} step={s} n={i + 1} bundledTmux={plan.tmux.bundled} />
                ))}
              </ol>
            )}
            {plan && team && (
              <>
                <div className="mt-6 flex items-baseline gap-2">
                  <h2 className="font-medium text-sm">Then {team.name}'s setup</h2>
                  <span className="text-muted-foreground text-xs">
                    on the box, in its own terminal · then {team.repos === 1 ? "1 repo" : `${team.repos} repos`}
                  </span>
                </div>
                <ol data-testid="install-plan-team" className="mt-3 divide-y overflow-hidden rounded-xl border bg-card">
                  {team.steps.map((s, i) => (
                    <PlanRow key={s.id} step={{ id: `team-${s.id}`, title: s.title, detail: s.detail, sudo: s.sudo, where: "box", commands: s.commands }} n={plan.steps.length + i + 1} bundledTmux={false} />
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
      </div>
      <footer className="shrink-0 border-t bg-background/95">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-6 py-3">
          <p className="flex min-w-0 flex-1 basis-80 items-start gap-2 text-muted-foreground text-xs leading-relaxed">
            <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {sudo.length > 0 ? (
                <>
                  <span className="text-foreground">{sudo.length === 1 ? "One step" : `${sudo.length} steps`} may ask for your password.</span> sudo asks on the box, in the terminal; Shipyard never sees it or keeps it.
                  {team ? ` It may ask again for ${team.name}'s steps: they run in berthd's own terminal on the box.` : ""}
                </>
              ) : (
                "Nothing here needs your password."
              )}
            </span>
          </p>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button ref={primary} data-testid="install-start" disabled={!plan} onClick={onStart}>
            <SquareTerminalIcon /> Open the terminal and install
          </Button>
        </div>
      </footer>
    </>
  );
}

function AgentPicker({ choices, value, onChange, installed = [] }: { choices: AgentChoice[]; value: string[]; onChange(ids: string[]): void; installed?: string[] }) {
  if (!choices.length) return <div className="mt-3 h-[200px]" />;
  const offered = choices.filter((a) => a.offered || installed.includes(a.id));
  const left = choices.filter((a) => !a.offered && !installed.includes(a.id));
  return (
    <>
      <div className="mt-3 overflow-hidden rounded-xl border bg-card">
        {offered.map((a) => {
          const done = installed.includes(a.id);
          const on = done || value.includes(a.id);
          return (
            <label
              key={a.id}
              data-testid={`agent-${a.id}`}
              data-checked={on || undefined}
              className={cn("flex cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-accent/40", on && "bg-accent/30", done && "cursor-default hover:bg-transparent")}
            >
              <Checkbox
                className="mt-0.5"
                checked={on}
                disabled={done}
                onCheckedChange={(c) => onChange(c ? [...value.filter((v) => v !== a.id), a.id].sort((x, y) => order(x) - order(y)) : value.filter((v) => v !== a.id))}
                aria-label={a.name}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px]">
                  {a.name}
                  {a.default && (
                    <Badge variant="secondary" size="sm">
                      recommended
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-muted-foreground text-xs leading-snug">{done ? "Installed on this box" : a.verified}</span>
              </span>
            </label>
          );
        })}
      </div>
      {left.map((a) => (
        <p key={a.id} data-testid={`agent-${a.id}`} className="mt-2.5 text-muted-foreground text-xs leading-relaxed">
          <span className="text-foreground">{a.name}</span> isn't installed by Shipyard: {a.why}. <code className="font-mono text-[11.5px]">{a.install}</code>
        </p>
      ))}
    </>
  );
}

const ORDER = ["claude", "codex", "cursor", "opencode", "grok", "gemini"];
const order = (id: string) => (ORDER.indexOf(id) + 1 || 99) as number;

function PlanRow({ step, n, bundledTmux }: { step: InstallPlanStep; n: number; bundledTmux: boolean }) {
  const [open, setOpen] = useState(false);
  const detail = step.id === "tools" && bundledTmux ? `${step.detail} Shipyard brings its own tmux, so tmux needs no sudo.` : step.detail;
  return (
    <li data-testid={`plan-${step.id}`} className="group">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-accent/30 focus-visible:bg-accent/40">
        <span aria-hidden className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] text-muted-foreground">
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-[13px]">{step.title}</span>
            {step.sudo && (
              <Badge variant="warning" size="sm" data-testid="sudo-badge">
                <KeyRoundIcon /> sudo
              </Badge>
            )}
            {step.sudo && step.when && <span className="text-muted-foreground text-xs">{step.when}</span>}
          </span>
          {detail && <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">{detail}</span>}
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            {step.where === "laptop" ? <LaptopIcon className="size-3" /> : <ServerIcon className="size-3" />}
            {step.where === "laptop" ? "this computer" : "the box"}
          </span>
          <ChevronRightIcon aria-label={open ? "Hide the commands" : "Show the commands"} className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </span>
      </button>
      {open && (
        <pre data-testid={`plan-commands-${step.id}`} className="mx-4 mb-3 ml-12 overflow-x-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[12px] leading-relaxed dark:bg-input/24">
          {step.commands.join("\n")}
        </pre>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- the run

export type StepState = "todo" | "running" | "done" | "skip" | "fail";
export interface StepRow {
  id: string;
  title: string;
  sudo?: boolean;
  state: StepState;
  message?: string;
  command?: string;
  // What the step waits on the person for: sudo's password in the
  // terminal, or an answer to question (yes or no).
  needs?: "password" | "ask";
  question?: string;
}

export const TITLES: Record<string, string> = {
  connect: "Connect",
  berthd: "Install berthd",
  linger: "Keep berthd running",
  tools: "tmux and git",
  agents: "Agent CLIs",
  integrations: "Agent integrations",
  pair: "Pair with this computer",
};
export const ORDER_STEPS = ["connect", "berthd", "linger", "tools", "agents", "integrations", "pair"];

export interface InstallRun {
  state: "idle" | "running" | "done" | "failed";
  steps: StepRow[];
  failure?: SshFailure;
  // The box's name, once paired.
  box?: string;
  // What the terminal is waiting for: Enter to start, or sudo's password.
  waiting?: "enter" | "password";
  // Lines for the terminal, when it is not there yet.
  term: React.RefObject<TermHandle | null>;
  conn: React.RefObject<TerminalConnection | null>;
  req?: GuidedInstallRequest;
  start(req: GuidedInstallRequest, from?: string): void;
  stop(): void;
  reset(): void;
  // answer answers a step's question on the terminal's input.
  answer(step: string, yes: boolean): void;
}

const SUDO = /\[sudo\] password for [^:\r\n]*:\s*$|^Password:\s*$/m;
const ENTER = /(Press Enter to start, or Ctrl-C to stop\.|and start\? \[Y\/n\])\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

export function useInstallRun(): InstallRun {
  const client = useStore((s) => s.client);
  const [state, setState] = useState<InstallRun["state"]>("idle");
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [failure, setFailure] = useState<SshFailure>();
  const [box, setBox] = useState<string>();
  const [waiting, setWaiting] = useState<InstallRun["waiting"]>();
  const [req, setReq] = useState<GuidedInstallRequest>();
  const term = useRef<TermHandle | null>(null);
  const conn = useRef<TerminalConnection | null>(null);
  const pending = useRef<(string | Uint8Array)[]>([]);
  const tail = useRef("");
  const decoder = useRef(new TextDecoder());
  const autoTrust = useRef<{ known?: string[]; tried?: boolean }>({});

  const write = (d: string | Uint8Array) => {
    if (term.current) term.current.write(d);
    else pending.current.push(d);
  };

  // update changes a step's row; a step the list didn't have yet (the
  // quick install shows lingering only once it matters) goes in its place.
  const update = (id: string, patch: Partial<StepRow>) =>
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) {
        const at = ORDER_STEPS.indexOf(id);
        if (at < 0) return prev;
        const row: StepRow = { id, title: TITLES[id] ?? id, state: "todo", ...patch };
        const before = prev.findIndex((s) => ORDER_STEPS.indexOf(s.id) > at);
        return before < 0 ? [...prev, row] : [...prev.slice(0, before), row, ...prev.slice(before)];
      }
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });

  const start = useCallback(
    (r: GuidedInstallRequest & { knownHostKeys?: string[] }, from?: string) => {
      if (!client) return;
      conn.current?.close();
      const request: GuidedInstallRequest = { host: r.host, name: r.name, network: r.network, identity: r.identity, trust_host_key: r.trust_host_key, agents: r.agents, from, guided: r.guided };
      if (r.knownHostKeys) autoTrust.current = { known: r.knownHostKeys };
      setReq(request);
      setState("running");
      setFailure(undefined);
      setWaiting(undefined);
      tail.current = "";
      // Steps before from keep what they were; the rest start again.
      const fromIdx = from ? ORDER_STEPS.indexOf(from) : 0;
      setSteps((prev) => {
        // Quiet, lingering shows only once it matters, and no step is
        // marked for sudo until it asks.
        const ids = ORDER_STEPS.filter((id) => (id !== "agents" || r.agents.length > 0) && (r.guided || id !== "linger" || prev.some((s) => s.id === id)));
        return ids.map((id) => {
          const was = prev.find((s) => s.id === id);
          if (was && ORDER_STEPS.indexOf(id) < fromIdx && id !== "connect") return was;
          return { id, title: was?.title ?? (id === "agents" ? agentNames(r.agents) : TITLES[id]), sudo: was?.sudo ?? (r.guided ? id === "linger" || id === "tools" : false), state: "todo" as StepState };
        });
      });
      if (from) write(`\r\n\x1b[2m— Retrying from ${TITLES[from] ?? from} —\x1b[0m\r\n`);
      const cols = term.current?.cols ?? 100;
      const rows = term.current?.rows ?? 30;
      const onEvent = (e: InstallEvent) => {
        if (e.type === "step") {
          if (e.state === "start") update(e.step, { state: "running", message: undefined, command: undefined, needs: undefined });
          else if (e.state === "done") {
            update(e.step, { state: "done", message: e.message, needs: undefined });
            if (e.step === "pair" && e.message) setBox(e.message);
          } else if (e.state === "skip") update(e.step, { state: "skip", message: e.message, needs: undefined });
          else if (e.state === "fail") update(e.step, { state: "fail", message: e.message, needs: undefined });
          else if (e.state === "sudo") update(e.step, { state: "running", sudo: true, needs: "password" });
          else if (e.state === "ask") update(e.step, { state: "running", needs: "ask", question: e.message });
          else if (e.state === "cmd") update(e.step, { command: e.message });
          else if (e.state === "open" && e.message) void openUrl(e.message);
        } else if (e.type === "failure") {
          setFailure(e.ssh);
        } else if (e.type === "exit") {
          setWaiting(undefined);
          conn.current = null;
          setState(e.code === 0 ? "done" : "failed");
        }
      };
      conn.current = client.installTerminal(request, cols, rows, {
        onOpen() {},
        onData(d) {
          write(d);
          const text = (typeof d === "string" ? d : decoder.current.decode(d, { stream: true })).replace(ANSI, "");
          tail.current = (tail.current + text).slice(-400);
          setWaiting(SUDO.test(tail.current) ? "password" : ENTER.test(tail.current) ? "enter" : undefined);
        },
        onClose() {
          setState((s) => (s === "running" ? "failed" : s));
        },
        onEvent,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );

  // A host key the tailnet vouches for is trusted without asking, once.
  useEffect(() => {
    const fp = failure?.kind === "host-key-unknown" ? failure.fingerprint : undefined;
    const at = autoTrust.current;
    if (state !== "failed" || !fp || !req || at.tried || !at.known?.includes(fp)) return;
    at.tried = true;
    write("\r\n\x1b[2mIts host key is the one your tailnet reports for it, so Shipyard trusts it.\x1b[0m\r\n");
    start({ ...req, trust_host_key: fp });
  }, [state, failure, req, start]);

  useEffect(() => () => conn.current?.close(), []);

  return {
    state,
    steps,
    failure,
    box,
    waiting,
    term,
    conn,
    req,
    start: (r, from) => start(r, from),
    stop: () => {
      conn.current?.close();
      conn.current = null;
      setWaiting(undefined);
      setState("failed");
      setSteps((prev) => prev.map((s) => (s.state === "running" ? { ...s, state: "fail", message: "Stopped" } : s)));
    },
    answer: (step, yes) => {
      conn.current?.send(yes ? "y\r" : "n\r");
      setSteps((prev) => prev.map((s) => (s.id === step ? { ...s, needs: yes ? "password" : undefined, sudo: yes || s.sudo } : s)));
    },
    reset: () => {
      conn.current?.close();
      conn.current = null;
      pending.current = [];
      setState("idle");
      setSteps([]);
      setFailure(undefined);
      setBox(undefined);
      setWaiting(undefined);
      term.current?.reset();
    },
    // flush is internal: the terminal takes what came before it existed.
    ...{ pendingRef: pending },
  } as InstallRun & { pendingRef: typeof pending };
}

function RunStage({
  target,
  run,
  agents,
  onClose,
  onReady,
  onBack,
  readyLabel,
  team,
}: {
  target: InstallTarget;
  run: InstallRun;
  agents: string[];
  onClose(): void;
  onReady(box: string): void;
  onBack(): void;
  readyLabel?: string;
  team?: TeamAfterInstall;
}) {
  const narrow = useMediaQuery("(max-width: 1000px)");
  const [identity, setIdentity] = useState(target.identity ?? "");
  const busy = run.state === "running";
  const failed = run.steps.find((s) => s.state === "fail");
  const ready = run.state === "done" && !!run.box;
  const retry = (from?: string, trust?: string) => run.start({ ...target, identity: identity || target.identity, trust_host_key: trust ?? target.trust_host_key, agents, knownHostKeys: target.knownHostKeys, guided: true } as GuidedInstallRequest, from);

  useEffect(() => {
    if (run.state === "idle") run.start({ ...target, agents, knownHostKeys: target.knownHostKeys, guided: true } as GuidedInstallRequest);
    // Once, when the run stage opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // From Team setup, the box being ready starts the team's setup on it, in
  // this same screen: its steps under the install's, its terminal here.
  const [teamStart, setTeamStart] = useState<{ state: "no" | "starting" | "started" | "error"; error?: string }>({ state: "no" });
  const teamRun = useTeam((s) => (team && run.box && teamStart.state === "started" ? runFor(s, team.org, run.box) : undefined));
  const startTeam = async () => {
    if (!team || !run.box) return;
    setTeamStart({ state: "starting" });
    try {
      putRun(await team.start(run.box));
      setTeamStart({ state: "started" });
    } catch (err) {
      setTeamStart({ state: "error", error: plainError(err) });
    }
  };
  useEffect(() => {
    if (ready && team && teamStart.state === "no") void startTeam();
    // Once, when the box is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  if (team && ready) {
    return (
      <TeamPhase
        team={team}
        box={run.box!}
        run={run}
        teamRun={teamRun}
        start={teamStart}
        onStart={() => void startTeam()}
        onClose={onClose}
        onReady={() => onReady(run.box!)}
        readyLabel={readyLabel}
        narrow={narrow}
      />
    );
  }

  const status = ready ? (
    <Badge variant="success" size="lg" data-testid="install-status">
      <CheckIcon /> Ready
    </Badge>
  ) : busy ? (
    <span data-testid="install-status" className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Spinner className="size-3" /> Installing
    </span>
  ) : run.state === "failed" ? (
    <Badge variant="error" size="lg" data-testid="install-status">
      Stopped
    </Badge>
  ) : null;

  return (
    <>
      <Header
        icon={<SquareTerminalIcon className="size-4" />}
        title={ready ? `${run.box} is ready` : `Setting up ${target.host}`}
        sub={ready ? `Paired with this computer. Shipyard no longer needs SSH for it.` : "You type in the terminal: press Enter to start, and your password when sudo asks."}
        right={
          <div className="flex items-center gap-2">
            {status}
            {busy && (
              <Button size="sm" variant="outline" onClick={run.stop}>
                Stop
              </Button>
            )}
            <CloseButton onClick={onClose} disabled={busy} />
          </div>
        }
      />
      <div className={cn("flex min-h-0 flex-1", narrow ? "flex-col" : "flex-row")}>
        <aside className={cn("shrink-0 overflow-y-auto", narrow ? "max-h-[38%] border-b" : "w-[320px] border-r")}>
          <StepList steps={run.steps} narrow={narrow} onRetry={(from) => retry(from)} busy={busy} waiting={run.waiting} />
          {run.failure && run.state === "failed" && (
            <div className="px-4 pb-4">
              <FailurePanel failure={run.failure} identity={identity} setIdentity={setIdentity} onRetry={(trust) => retry(undefined, trust)} />
            </div>
          )}
          {!narrow && (
            <p className="mx-4 mt-2 mb-4 flex items-start gap-1.5 border-t pt-3 text-muted-foreground text-xs leading-relaxed">
              <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>What you type goes to {target.host.split("@").pop()} through this terminal, and nowhere else. Shipyard doesn't keep it.</span>
            </p>
          )}
          {run.state === "failed" && !failed && !run.failure && (
            <div className="px-4 pb-4">
              <Button size="sm" variant="outline" onClick={() => retry()}>
                <RotateCwIcon /> Start again
              </Button>
            </div>
          )}
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Banner run={run} ready={ready} readyLabel={readyLabel} onReady={() => run.box && onReady(run.box)} onBack={onBack} agents={agents} />
          <InstallTerminal run={run} />
        </section>
      </div>
    </>
  );
}

// TeamPhase is the second phase of adding a box from Team setup: the
// install is done, and the team's setup runs on the box in berthd's own
// terminal, shown here, with its steps under the install's.
function TeamPhase({
  team,
  box,
  run,
  teamRun,
  start,
  onStart,
  onClose,
  onReady,
  readyLabel,
  narrow,
}: {
  team: TeamAfterInstall;
  box: string;
  run: InstallRun;
  teamRun?: TeamStatus;
  start: { state: "no" | "starting" | "started" | "error"; error?: string };
  onStart(): void;
  onClose(): void;
  onReady(): void;
  readyLabel?: string;
  narrow: boolean;
}) {
  const steps = teamRun?.steps ?? [];
  const boxDone = !!teamRun && (teamRun.phase === "projects" || teamRun.phase === "done");
  const failed = steps.find((s) => s.state === "failed");
  const waiting = steps.find((s) => s.state === "waiting");
  const current = steps.findIndex((s) => s.state === "running" || s.state === "waiting");
  const busy = !boxDone && !failed && start.state !== "error";
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (boxDone) go.current?.focus();
  }, [boxDone]);
  const retry = async (from: string) => {
    try {
      putRun(await team.retry(box, from));
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't retry", description: plainError(err) });
    }
  };
  const rows: StepRow[] = steps.map((s) => ({
    id: s.id,
    title: s.title,
    sudo: s.sudo,
    state: s.state === "running" || s.state === "waiting" ? "running" : s.state === "skipped" ? "skip" : s.state === "failed" ? "fail" : s.state === "done" ? "done" : "todo",
    message: s.state === "skipped" ? "already done" : s.state === "failed" ? s.error : undefined,
  }));

  let tone = "";
  let text: ReactNode;
  let action: ReactNode = null;
  if (start.state === "error") {
    tone = "bg-destructive/6";
    text = <>Couldn't start {team.name}'s setup: {start.error}</>;
    action = (
      <Button size="sm" variant="outline" onClick={onStart}>
        <RotateCwIcon /> Try again
      </Button>
    );
  } else if (!teamRun) {
    text = (
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" /> Starting {team.name}'s setup on {box}…
      </span>
    );
  } else if (boxDone) {
    tone = "bg-success/6";
    const repos = teamRun.projects.filter((p) => p.state !== "skipped").length;
    text = (
      <>
        <span className="font-medium">{box} is set up for {team.name}.</span> {repos ? `${repos === 1 ? "The repo is" : `${repos} repos are`} cloning and setting up; Team setup shows how far.` : ""}
      </>
    );
    action = (
      <Button ref={go} size="sm" data-testid="install-continue" onClick={onReady}>
        {readyLabel ?? "Back to Team setup"} <ArrowRightIcon />
      </Button>
    );
  } else if (failed) {
    tone = "bg-destructive/6";
    text = <>Stopped at {failed.title}. The terminal says why; fix it on {box}, then retry from it. The steps before it are kept.</>;
    action = (
      <Button size="sm" data-testid="team-phase-retry" onClick={() => void retry(failed.id)}>
        <RotateCwIcon /> Retry from {failed.title.replace(/ (with|in|and|on) .*/, "")}
      </Button>
    );
  } else if (waiting?.id === "github" && waiting.code) {
    tone = "bg-info/8";
    text = (
      <>
        <span className="font-medium">The box signs in to GitHub on its own.</span> Enter <span className="font-mono font-semibold tracking-wider">{waiting.code}</span> at github.com/login/device.
      </>
    );
    action = (
      <Button size="sm" onClick={() => void openUrl(waiting.url ?? "https://github.com/login/device")}>
        Open github.com/login/device
      </Button>
    );
  } else if (waiting?.id === "1password") {
    tone = "bg-warning/8";
    text = <>op on {box} is asking you to sign in to 1Password. Answer it in the terminal: what you type stays on the box.</>;
  } else if (waiting) {
    tone = "bg-warning/8";
    text = (
      <>
        <span className="font-medium">sudo is asking for your password on {box}.</span> Type it in the terminal and press <Kbd>↵</Kbd>. Shipyard never sees it.
      </>
    );
  } else {
    text = (
      <>
        <span className="text-muted-foreground">
          {team.name}'s step {Math.max(1, current + 1)} of {steps.length}
        </span>{" "}
        · {steps[current]?.title ?? "starting"}
      </>
    );
  }

  return (
    <>
      <Header
        icon={<SquareTerminalIcon className="size-4" />}
        title={boxDone ? `${box} is set up for ${team.name}` : `Setting up ${box} for ${team.name}`}
        sub={boxDone ? "berthd, the agents and the team's tools are on the box. The repos come next." : `${box} is ready. Now ${team.name}'s steps, in berthd's own terminal on the box: it keeps going if you close this.`}
        right={
          <div className="flex items-center gap-2">
            {busy ? (
              <span data-testid="install-status" className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <Spinner className="size-3" /> {team.name}'s setup
              </span>
            ) : boxDone ? (
              <Badge variant="success" size="lg" data-testid="install-status">
                <CheckIcon /> Set up
              </Badge>
            ) : null}
            <CloseButton onClick={onClose} label={busy ? "Close: it keeps going on the box" : "Close"} />
          </div>
        }
      />
      <div data-testid="team-phase" data-phase={teamRun?.phase ?? start.state} className={cn("flex min-h-0 flex-1", narrow ? "flex-col" : "flex-row")}>
        <aside className={cn("shrink-0 overflow-y-auto", narrow ? "max-h-[38%] border-b" : "w-[320px] border-r")}>
          <StepList steps={run.steps} narrow={narrow} onRetry={() => {}} busy={false} />
          <h3 className="mx-4 mt-1 border-t pt-3 font-medium text-muted-foreground text-xs">{team.name}'s setup</h3>
          <ol data-testid="team-phase-steps" className={cn("px-2 py-2", narrow && "grid grid-cols-2 gap-x-2")}>
            {rows.map((s) => (
              <li key={s.id} data-testid={`team-step-${s.id}`} data-state={s.state} className={cn("rounded-lg px-2.5 py-2", s.state === "running" && "bg-accent/50", s.state === "fail" && "bg-destructive/6")}>
                <div className="flex items-center gap-2.5">
                  <StepIcon state={s.state} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", (s.state === "todo" || s.state === "skip") && "text-muted-foreground", s.state === "running" && "font-medium")}>{s.title}</span>
                  {s.sudo && s.state !== "skip" && <KeyRoundIcon aria-label="needs sudo" className="size-3 shrink-0 text-warning-foreground" />}
                </div>
                {s.message && !narrow && <p className={cn("mt-0.5 ml-7.5 text-xs leading-relaxed", s.state === "fail" ? "text-destructive-foreground" : "text-muted-foreground")}>{s.message}</p>}
              </li>
            ))}
          </ol>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div data-testid="team-phase-banner" aria-live="polite" className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5 text-sm", tone)}>
            <p className="min-w-0 flex-1 basis-72 leading-relaxed">{text}</p>
            {action}
          </div>
          {teamRun?.session ? (
            <div className="relative min-h-0 flex-1">
              <TerminalView box={box} session={teamRun.session} wsKey="" tab="" pane={`team:${teamRun.session}`} visible focused={!!waiting} onFocus={() => {}} onClose={() => {}} />
            </div>
          ) : (
            <InstallTerminal run={run} />
          )}
        </section>
      </div>
    </>
  );
}

export function StepIcon({ state }: { state: StepState }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border",
        state === "done" && "border-success bg-success text-white",
        state === "fail" && "border-destructive bg-destructive text-white",
        state === "running" && "border-foreground/40",
        state === "skip" && "border-dashed text-muted-foreground",
        state === "todo" && "text-muted-foreground/60",
      )}
    >
      {state === "done" ? (
        <CheckIcon className="size-3" strokeWidth={3} />
      ) : state === "fail" ? (
        <XIcon className="size-3" strokeWidth={3} />
      ) : state === "running" ? (
        <Spinner className="size-3" />
      ) : state === "skip" ? (
        <MinusIcon className="size-3" />
      ) : (
        <CircleIcon className="size-1.5 fill-current" />
      )}
    </span>
  );
}

function StepList({ steps, narrow, onRetry, busy, waiting }: { steps: StepRow[]; narrow: boolean; onRetry(from: string): void; busy: boolean; waiting?: InstallRun["waiting"] }) {
  return (
    <ol data-testid="install-steps" className={cn("px-2 py-3", narrow && "grid grid-cols-2 gap-x-2 py-2")}>
      {steps.map((s) => (
        <li key={s.id} data-testid={`step-${s.id}`} data-state={s.state} className={cn("rounded-lg px-2.5 py-2", s.state === "running" && "bg-accent/50", s.state === "fail" && "bg-destructive/6", narrow && "py-1.5")}>
          <div className="flex items-center gap-2.5">
            <StepIcon state={s.state} />
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", s.state === "todo" && "text-muted-foreground", s.state === "skip" && "text-muted-foreground", s.state === "running" && "font-medium")}>{s.title}</span>
            {s.sudo && s.state !== "skip" && (
              <Tip label="sudo asks for your password on the box, if it needs to">
                <KeyRoundIcon aria-label="needs sudo" className="size-3 shrink-0 text-warning-foreground" />
              </Tip>
            )}
          </div>
          {s.state === "running" && waiting === "password" ? (
            <p data-testid="step-waiting" className="mt-0.5 ml-7.5 flex items-center gap-1 text-warning-foreground text-xs">
              <KeyRoundIcon className="size-3" /> Waiting for your password
            </p>
          ) : (
            s.message && s.state !== "fail" && !narrow && <p className="mt-0.5 ml-7.5 truncate text-muted-foreground text-xs">{s.message}</p>
          )}
          {s.state === "fail" && (
            <div className={cn("mt-1.5 ml-7.5 space-y-2", narrow && "col-span-2")}>
              {s.message && <p className="text-destructive-foreground text-xs leading-relaxed">{s.message}</p>}
              {s.command && <CommandLine command={s.command} onRun={() => onRetry(s.id)} />}
              {!busy && (
                <Button size="xs" data-testid={`retry-${s.id}`} onClick={() => onRetry(s.id === "connect" ? "connect" : s.id)}>
                  <RotateCwIcon /> Retry from here
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// CommandLine is a command to run by hand: as typed, copyable, and run in
// the terminal here (the step again, where sudo can ask).
export function CommandLine({ command, onRun }: { command: string; onRun?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div data-testid="command-line" className="overflow-hidden rounded-md border bg-muted/40 dark:bg-input/16">
      <code className="block overflow-x-auto whitespace-pre px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">{command}</code>
      <div className="flex items-center gap-1 border-t px-1 py-1">
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() =>
            navigator.clipboard?.writeText(command).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => toastManager.add({ type: "error", title: "Could not copy", description: "Select the line and copy it instead." }),
            )
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
        </Button>
        {onRun && (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={onRun}>
            <SquareTerminalIcon /> Run in terminal
          </Button>
        )}
      </div>
    </div>
  );
}

function Banner({ run, ready, readyLabel, onReady, onBack, agents }: { run: InstallRun; ready: boolean; readyLabel?: string; onReady(): void; onBack(): void; agents: string[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ready) ref.current?.focus();
  }, [ready]);
  if (ready)
    return (
      <div data-testid="install-ready" className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-success/6 px-5 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
          <CheckIcon className="size-4" strokeWidth={3} />
        </span>
        <div className="min-w-0 flex-1 basis-72">
          <p className="font-medium text-sm">Ready</p>
          <p className="text-muted-foreground text-xs">
            {run.box} runs berthd{agents.length ? `, with ${agentNames(agents)}` : ""}.{agents.includes("claude") ? " Claude Code asks you to sign in the first time it starts, right in the chat." : agents.length ? " Each agent asks you to sign in the first time it starts." : ""}
          </p>
        </div>
        <Button ref={ref} data-testid="install-continue" onClick={onReady}>
          {readyLabel ?? `Go to ${run.box}`} <ArrowRightIcon />
        </Button>
      </div>
    );
  let icon: ReactNode = <Spinner className="size-3.5" />;
  let text: ReactNode = "Connecting…";
  let tone = "";
  if (run.waiting === "password") {
    icon = <KeyRoundIcon className="size-3.5" />;
    tone = "bg-warning/8 text-foreground";
    text = (
      <>
        <span className="font-medium">sudo is asking for your password on the box.</span> Type it in the terminal and press <Kbd>↵</Kbd>; nothing shows as you type. Shipyard never sees it.
      </>
    );
  } else if (run.waiting === "enter") {
    icon = <SquareTerminalIcon className="size-3.5" />;
    tone = "bg-info/8 text-foreground";
    text = (
      <>
        <span className="font-medium">Check the plan in the terminal, then press</span> <Kbd>↵</Kbd> <span className="font-medium">there to start.</span>
      </>
    );
  } else if (run.state === "failed") {
    icon = <XIcon className="size-3.5" />;
    tone = "bg-destructive/6";
    text = (
      <>
        Stopped. The terminal says why; fix it if it's on the box, then retry from the step that failed. The steps before it are kept.{" "}
        <button type="button" className="underline underline-offset-2 hover:no-underline" onClick={onBack}>
          Back to the plan
        </button>
      </>
    );
  } else {
    const i = run.steps.findIndex((s) => s.state === "running");
    if (i >= 0)
      text = (
        <>
          <span className="text-muted-foreground">
            Step {i + 1} of {run.steps.length}
          </span>{" "}
          · {run.steps[i].title}
        </>
      );
  }
  return (
    <div data-testid="install-banner" data-waiting={run.waiting ?? ""} aria-live="polite" className={cn("flex shrink-0 items-center gap-2.5 border-b px-5 py-2.5 text-sm", tone)}>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <p className="min-w-0 flex-1 leading-relaxed">{text}</p>
    </div>
  );
}

export function agentNames(ids: string[]) {
  const n = ids.map((id) => ({ claude: "Claude Code", codex: "Codex", cursor: "Cursor Agent", opencode: "OpenCode", grok: "Grok CLI" })[id] ?? id);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

// InstallTerminal is Shipyard's terminal (ghostty-web, or xterm.js) on the
// install's pseudo-terminal: what it shows comes from berth add ssh, and
// what is typed goes back to it. fontSize, when given, overrides the
// terminal's own: the quick install's compact dialog uses a smaller one.
export function InstallTerminal({ run, className, fontSize }: { run: InstallRun; className?: string; fontSize?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useActiveTheme();
  const prefs = usePrefs((p) => p.terminal);
  const [term, setTerm] = useState<TermHandle>();
  const pendingRef = (run as InstallRun & { pendingRef: React.RefObject<(string | Uint8Array)[]> }).pendingRef;

  useEffect(() => {
    let disposed = false;
    let t: TermHandle | undefined;
    const mount = document.createElement("div");
    mount.className = "h-full w-full";
    host.current!.appendChild(mount);
    void createTerminal(mount, theme.terminal, fontSize ? { ...prefs, fontSize } : prefs).then((made) => {
      if (disposed) {
        made.dispose();
        return;
      }
      t = made;
      run.term.current = made;
      made.onData((d) => run.conn.current?.send(d));
      made.onResize(({ cols, rows }) => run.conn.current?.resize(cols, rows));
      for (const d of pendingRef.current.splice(0)) made.write(d);
      setTerm(made);
    });
    return () => {
      disposed = true;
      if (run.term.current === t) run.term.current = null;
      t?.dispose();
      mount.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.renderer, prefs.fontFamily, prefs.fontSize, fontSize, theme.id]);

  useEffect(() => {
    if (!term || !host.current) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => term.fit());
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [term]);

  // The keyboard belongs to the terminal while the install waits on it.
  useEffect(() => {
    if (term && run.state === "running") term.focus();
  }, [term, run.state, run.waiting]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)} style={{ background: theme.terminal.background }} onMouseDown={() => term?.focus()}>
      <div ref={host} data-terminal data-testid="install-terminal" className={cn("absolute inset-0 overflow-hidden pt-3 pb-2 [&_canvas]:block", fontSize ? "px-3" : "px-4")} />
    </div>
  );
}

// useInstallTarget is the guided install's open state for a screen that
// starts it.
export function useInstallTarget() {
  const [target, setTarget] = useState<InstallTarget>();
  return useMemo(() => ({ target, open: setTarget, close: () => setTarget(undefined) }), [target]);
}

// ------------------------------------------------- adding agents later

// AddAgents puts more agent CLIs on a box that is already set up, from its
// settings: the same choice, then the same terminal and checklist. Nothing
// needs sudo, so the terminal only shows what the box prints.
export function AddAgents({ box, open, onClose }: { box: string; open: boolean; onClose(): void }) {
  const client = useStore((s) => s.client);
  const [have, setHave] = useState<(AgentChoice & { installed: boolean })[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [stage, setStage] = useState<"pick" | "run">("pick");
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [state, setState] = useState<"running" | "done" | "failed">("running");
  const [error, setError] = useState<string>();
  const term = useRef<TermHandle | null>(null);
  const pending = useRef<string[]>([]);
  const abort = useRef<AbortController>(null);

  useEffect(() => {
    if (!open || !client) return;
    setStage("pick");
    setError(undefined);
    boxApi.agentCLIs(client, box).then(
      (list) => {
        setHave(list);
        const remembered = usePrefs.getState().installAgents ?? ["claude"];
        setPicked(remembered.filter((id) => list.some((a) => a.id === id && a.offered && !a.installed)));
      },
      (err) => setError(plainError(err, { box })),
    );
  }, [open, client, box]);

  const write = (l: string) => {
    if (term.current) term.current.write(`${l}\r\n`);
    else pending.current.push(`${l}\r\n`);
  };
  const run = async () => {
    if (!client) return;
    setStage("run");
    setState("running");
    setSteps([...picked.map((id) => ({ id: `agent-${id}`, title: agentNames([id]), state: "todo" as StepState })), { id: "integrations", title: "Agent integrations", state: "todo" as StepState }]);
    const ctl = new AbortController();
    abort.current = ctl;
    const set = (id: string, patch: Partial<StepRow>) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    try {
      await boxApi.installAgents(
        client,
        box,
        picked,
        {
          line: write,
          step: (e) => set(e.step, { state: e.state === "start" ? "running" : e.state === "done" ? "done" : e.state === "skip" ? "skip" : e.state === "fail" ? "fail" : "running", message: e.state === "fail" ? e.message : undefined }),
        },
        ctl.signal,
      );
      setState("done");
      setPrefs({ installAgents: [...new Set([...(usePrefs.getState().installAgents ?? []), ...picked])] });
    } catch (err) {
      if (ctl.signal.aborted) return;
      setError(plainError(err, { box }));
      setSteps((prev) => prev.map((s) => (s.state === "running" ? { ...s, state: "fail" } : s)));
      setState("failed");
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && (stage !== "run" || state !== "running") && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background" />
        <DialogPrimitive.Popup data-testid="add-agents" data-stage={stage} className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none">
          {stage === "pick" ? (
            <>
              <Header icon={<ServerIcon className="size-4" />} title={`Add agents to ${box}`} sub="Into ~/.local/bin on the box, without sudo, with Shipyard's hooks and skills." right={<CloseButton onClick={onClose} />} />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-md px-6 pt-8 pb-10">
                  {error && <p className="text-destructive-foreground text-sm">{error}</p>}
                  {!have && !error && (
                    <p className="flex items-center gap-2 text-muted-foreground text-sm">
                      <Spinner className="size-3.5" /> Asking {box}…
                    </p>
                  )}
                  {have && (
                    <AgentPicker
                      choices={have.map((a) => (a.installed ? { ...a, offered: false, why: "" } : a))}
                      installed={have.filter((a) => a.installed).map((a) => a.id)}
                      value={picked}
                      onChange={setPicked}
                    />
                  )}
                </div>
              </div>
              <footer className="shrink-0 border-t">
                <div className="mx-auto flex w-full max-w-md items-center justify-end gap-3 px-6 py-3">
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button data-testid="add-agents-start" disabled={!picked.length} onClick={() => void run()}>
                    <SquareTerminalIcon /> Install {picked.length ? agentNames(picked) : "agents"}
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <>
              <Header
                icon={<SquareTerminalIcon className="size-4" />}
                title={state === "done" ? `${agentNames(picked)} on ${box}` : `Adding agents to ${box}`}
                sub={state === "done" ? "Each asks you to sign in the first time it starts." : "No password needed: nothing here uses sudo."}
                right={<CloseButton onClick={onClose} disabled={state === "running"} />}
              />
              <div className="flex min-h-0 flex-1">
                <aside className="w-[300px] shrink-0 overflow-y-auto border-r">
                  <StepList steps={steps} narrow={false} busy={state === "running"} onRetry={() => void run()} />
                  {error && <p className="px-4 text-destructive-foreground text-xs leading-relaxed">{error}</p>}
                  {state === "done" && (
                    <div className="px-4 pt-1">
                      <Button size="sm" data-testid="add-agents-done" onClick={onClose}>
                        <CheckIcon /> Done
                      </Button>
                    </div>
                  )}
                </aside>
                <OutputTerminal term={term} pending={pending} />
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function OutputTerminal({ term, pending }: { term: React.RefObject<TermHandle | null>; pending: React.RefObject<string[]> }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useActiveTheme();
  const prefs = usePrefs((p) => p.terminal);
  useEffect(() => {
    let t: TermHandle | undefined;
    let disposed = false;
    const mount = document.createElement("div");
    mount.className = "h-full w-full";
    host.current!.appendChild(mount);
    void createTerminal(mount, theme.terminal, prefs).then((made) => {
      if (disposed) return made.dispose();
      t = made;
      term.current = made;
      for (const l of pending.current.splice(0)) made.write(l);
      requestAnimationFrame(() => made.fit());
    });
    const ro = new ResizeObserver(() => t?.fit());
    ro.observe(host.current!);
    return () => {
      disposed = true;
      ro.disconnect();
      if (term.current === t) term.current = null;
      t?.dispose();
      mount.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.id]);
  return (
    <div className="relative min-h-0 min-w-0 flex-1" style={{ background: theme.terminal.background }}>
      <div ref={host} data-testid="add-agents-terminal" className="absolute inset-0 overflow-hidden px-4 pt-3 pb-2 [&_canvas]:block" />
    </div>
  );
}
