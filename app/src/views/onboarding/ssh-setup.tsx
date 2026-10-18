import { KeyRoundIcon, MonitorIcon, ServerIcon, ShieldAlertIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { laptopApi, type SshFailure, type SshPlan } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { GuidedInstall, type TeamAfterInstall, useAgentChoice, useInstallTarget } from "@/views/onboarding/guided-install";
import { InlineAgents, QuickInstall } from "@/views/onboarding/quick-install";
import { InstallCommand } from "@/views/onboarding/install-command";

type Suggestion = { value: string; label: string; detail: string; os?: string; network?: string };
export type Failure = SshFailure | { kind: "plain"; message: string };

// SshSetup is the other way to add a box: Shipyard connects over SSH once from
// this computer, with the person's own keys and agent, uploads berthd, runs
// the same `berthd install` the install command does, and pairs. One field
// takes user@host; Tab completes from ~/.ssh/config and the tailnet.
export function SshSetup({
  network,
  retry,
  onRunning,
  onPaired,
  onSignIn: _onSignIn,
  readyLabel,
  team,
}: {
  network?: string;
  // Changing retry runs the setup again: after signing in to a tailnet.
  retry: number;
  onRunning(running: boolean): void;
  onPaired(box: string): void;
  onSignIn(): void;
  // The install's last button ("Continue", "Back to Team setup").
  readyLabel?: string;
  // From Team setup: the guided install, with the team's steps after it.
  // Otherwise adding a box is quiet: the compact dialog.
  team?: TeamAfterInstall;
}) {
  const [agents, setAgents] = useAgentChoice();
  const [host, setHost] = useState("");
  const [name, setName] = useState("");
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Setting up opens the quick install's dialog (or, from Team setup, the
  // guided install, full screen).
  const install = useInstallTarget();
  const state = install.target ? "running" : "ready";
  useEffect(() => onRunning(!!install.target), [install.target, onRunning]);

  const suggestions = useSuggestions(network);
  const plan = useSshPlan(host.trim(), network);
  const typed = host.trim().toLowerCase();
  const matches = useMemo(
    () => suggestions.filter((s) => !typed || (s.value.toLowerCase().includes(typed) && s.value.toLowerCase() !== typed)).slice(0, 5),
    [suggestions, typed],
  );

  const run = (opts: { trust?: string; target?: string } = {}) => {
    const target = (opts.target ?? host).trim();
    if (!target) return;
    if (opts.target) setHost(opts.target);
    // A refused key is asked about in the guided install, which can retry
    // with a key file.
    install.open({ host: target, name: name.trim() || undefined, network, trust_host_key: opts.trust });
  };

  const tried = useRef(retry);
  useEffect(() => {
    if (retry === tried.current) return;
    tried.current = retry;
    if (host.trim()) run();
    // Only a new retry runs again; run reads the latest field and network.
  }, [retry]);

  const pick = (s: Suggestion, go: boolean) => {
    setHost(s.value);
    setActive(-1);
    if (go) run({ target: s.value });
    else field.current?.focus();
  };

  const running = state === "running";
  const showSuggestions = state === "ready" && focused && matches.length > 0;

  return (
    <div>
      <form
        className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background ps-3 pe-1 shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32"
        onSubmit={(e) => {
          e.preventDefault();
          if (active >= 0 && matches[active]) pick(matches[active], true);
          else run();
        }}
      >
        <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={field}
          value={host}
          disabled={running}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="SSH host, like me@my-box"
          placeholder="me@my-box, or a host from ~/.ssh/config"
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onChange={(e) => {
            setHost(e.target.value);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && matches.length) {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === "ArrowUp" && matches.length) {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, -1));
            } else if (e.key === "Tab" && !e.shiftKey && showSuggestions) {
              // Tab completes, as in a shell.
              e.preventDefault();
              pick(matches[Math.max(active, 0)], false);
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-desc outline-none placeholder:font-sans placeholder:text-muted-foreground/72 placeholder:text-body disabled:opacity-64"
        />
        <Button type="submit" size="xs" variant="outline" className="shrink-0" disabled={running || (!host.trim() && active < 0)} data-testid="ssh-set-up">
          Set up
        </Button>
      </form>

      {/* What Shipyard will use, before it connects: a wrong agent is obvious here. */}
      <div aria-live="polite" className="mt-2 flex min-h-5 min-w-0 items-center gap-1.5 text-muted-foreground text-meta">
        {host.trim() ? (
          plan === "loading" ? (
            <>
              <Spinner className="size-3" /> Reading your SSH setup…
            </>
          ) : plan ? (
            <>
              <KeyRoundIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {plan.summary}
                {plan.hostname ? (
                  <>
                    {" · "}
                    <span className="font-mono">
                      {plan.user ? `${plan.user}@` : ""}
                      {plan.hostname}
                      {plan.port && plan.port !== "22" ? `:${plan.port}` : ""}
                    </span>
                  </>
                ) : null}
                {network ? ` · through the ${network} tailnet` : ""}
              </span>
              <span className="ms-auto flex shrink-0 items-center gap-1">
                named
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="after its hostname"
                  aria-label="Name in Shipyard"
                  spellCheck={false}
                  disabled={running}
                  className="h-5 w-32 border-input border-b bg-transparent px-0.5 text-foreground outline-none placeholder:text-muted-foreground/72 focus:border-ring"
                />
              </span>
            </>
          ) : null
        ) : (
          <span>Uses your SSH keys and agent (1Password and the like) once, to install. After that Shipyard never needs SSH for this box.</span>
        )}
      </div>

      {!team && <InlineAgents value={agents} onChange={setAgents} disabled={running} />}

      {showSuggestions && (
        <ul role="listbox" aria-label="Hosts" className="mt-1 overflow-hidden rounded-lg border bg-popover p-1">
          {matches.map((s, i) => (
            <li key={`${s.network ?? ""}${s.value}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s, true)}
                className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left", i === active && "bg-accent")}
              >
                {s.os && s.os !== "linux" ? <MonitorIcon className="size-3.5 text-muted-foreground" /> : <ServerIcon className="size-3.5 text-muted-foreground" />}
                <span className="font-mono text-mono">{s.label}</span>
                <span className="ms-auto truncate text-muted-foreground text-meta">{s.detail}</span>
              </button>
            </li>
          ))}
          <li className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-tag text-muted-foreground">
            <Kbd>⇥</Kbd> complete <Kbd className="ms-1">↵</Kbd> set up
          </li>
        </ul>
      )}

      {team ? (
        <GuidedInstall
          target={install.target}
          readyLabel={readyLabel}
          team={team}
          onClose={install.close}
          onReady={(box) => {
            install.close();
            onPaired(box);
          }}
        />
      ) : (
        <QuickInstall
          target={install.target && { ...install.target, agents }}
          readyLabel={readyLabel}
          onClose={install.close}
          onReady={(box) => {
            install.close();
            onPaired(box);
          }}
        />
      )}
    </div>
  );
}

// FailurePanel says what went wrong once, in plain words, and offers the
// one thing to do about it.
export function FailurePanel({
  failure,
  identity,
  setIdentity,
  onRetry,
  onSignIn,
}: {
  failure: Failure;
  identity: string;
  setIdentity(v: string): void;
  onRetry(trust?: string): void;
  onSignIn?(): void;
}) {
  let action: ReactNode = null;
  switch (failure.kind) {
    case "refused":
    case "timeout":
    case "unreachable":
    case "resolve":
      action = (
        <>
          <InstallCommand />
          {onSignIn && (
            <p className="text-muted-foreground text-meta">
              Or, if the box is on a tailnet this computer isn't signed in to,{" "}
              <button type="button" className="text-foreground underline underline-offset-2 hover:no-underline" onClick={onSignIn}>
                sign in to that tailnet
              </button>{" "}
              and Shipyard tries again.
            </p>
          )}
        </>
      );
      break;
    case "auth":
    case "password":
      action = (
        <>
          {failure.kind === "auth" && failure.tried && failure.tried.length > 0 && (
            <p className="text-muted-foreground text-meta">
              Tried: <span className="font-mono">{failure.tried.join(", ")}</span>
            </p>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onRetry();
            }}
          >
            <Input size="sm" className="max-w-72 font-mono" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="~/.ssh/id_ed25519" aria-label="Identity file" spellCheck={false} />
            <Button size="sm" type="submit" variant="outline">
              {identity.trim() ? "Try with this key" : "Try again"}
            </Button>
          </form>
        </>
      );
      break;
    case "host-key-unknown":
      action = (
        <>
          {failure.fingerprint && (
            <p className="rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-mono [overflow-wrap:anywhere]">{failure.fingerprint}</p>
          )}
          <p className="text-muted-foreground text-meta">Trust it only if it matches the box's own key: on the box, run ssh-keygen -lf on its host key in /etc/ssh.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!failure.fingerprint} onClick={() => onRetry(failure.fingerprint)}>
              Trust and connect
            </Button>
          </div>
        </>
      );
      break;
    case "host-key-changed":
      break;
    default:
      action = (
        <Button size="sm" variant="outline" className="self-start" onClick={() => onRetry()}>
          Try again
        </Button>
      );
  }
  return (
    <div role="alert" className="mt-2 flex flex-col gap-2.5 rounded-lg border p-3">
      <p className="flex items-start gap-2 text-body">
        {failure.kind === "host-key-changed" || failure.kind === "host-key-unknown" ? (
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
        ) : null}
        <span className={cn(failure.kind === "host-key-changed" && "text-destructive-foreground")}>{failure.message}</span>
      </p>
      {action}
    </div>
  );
}

// useSuggestions lists hosts to complete from: ~/.ssh/config's, then the
// tailnet's machines that are online and not boxes yet.
function useSuggestions(network?: string): Suggestion[] {
  const client = useStore((s) => s.client);
  const [config, setConfig] = useState<string[]>([]);
  const [tailnet, setTailnet] = useState<Suggestion[]>([]);
  useEffect(() => {
    if (!client) return;
    laptopApi.sshHosts(client).then(setConfig, () => setConfig([]));
  }, [client]);
  useEffect(() => {
    if (!client) return;
    let live = true;
    laptopApi.discover(client, network).then(
      (d) => {
        if (!live) return;
        const user = d.user ? `${d.user}@` : "";
        setTailnet(
          d.machines
            .filter((m) => m.online && !m.box)
            .sort((a, b) => Number(a.os !== "linux") - Number(b.os !== "linux") || a.name.localeCompare(b.name))
            .map((m) => ({ value: `${user}${m.dns_name?.replace(/\.$/, "") || m.ip}`, label: m.name, detail: `${network ? `${network} tailnet` : "tailnet"} · ${m.os || "unknown"}`, os: m.os, network })),
        );
      },
      () => live && setTailnet([]),
    );
    return () => {
      live = false;
    };
  }, [client, network]);
  return useMemo(() => [...config.map((h) => ({ value: h, label: h, detail: "~/.ssh/config" })), ...tailnet], [config, tailnet]);
}

// useSshPlan asks the agent what ssh would use for a host: user, address,
// agent and keys. It reads config only; it never connects.
export function useSshPlan(host: string, network?: string): SshPlan | "loading" | undefined {
  const client = useStore((s) => s.client);
  const [plan, setPlan] = useState<SshPlan | "loading">();
  useEffect(() => {
    if (!client || !host || /\s/.test(host)) {
      setPlan(undefined);
      return;
    }
    let live = true;
    setPlan((p) => p ?? "loading");
    const t = setTimeout(() => {
      laptopApi.sshPlan(client, host, network).then(
        (p) => live && setPlan(p),
        () => live && setPlan(undefined),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, host, network]);
  return plan;
}
