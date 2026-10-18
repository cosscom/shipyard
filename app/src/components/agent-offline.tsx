import { CheckIcon, CopyIcon, PlayIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { type AgentBinary, findAgentBinary, retryConnection, startAgent } from "@/lib/agent-start";
import { plainError } from "@/lib/errors";
import { thisComputer } from "@/lib/platform";

// Any berth command starts the agent when it is not running.
const START = "berth status";

// How long to wait for a started agent to answer before saying so.
const ANSWER_TIMEOUT = 15_000;

// Connecting is shown until the laptop agent answers. When it is not
// running, the app offers to start it (asking before it installs anything
// that starts at login); without a berth command to run, it says how to
// start it from a terminal. Either way this window connects by itself once
// the agent is up.
export function Connecting({ state, error }: { state: string; error?: string }) {
  if (state === "connecting") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <Scene name="lighthouse" />
            </EmptyMedia>
            <EmptyTitle>Finding the Shipyard agent…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return <AgentOffline error={error} />;
}

type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "waiting" } | { kind: "failed"; message: string };

function AgentOffline({ error }: { error?: string }) {
  // undefined while looking, null when there is no berth command to run.
  const [binary, setBinary] = useState<AgentBinary | null>();
  const [atLogin, setAtLogin] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    findAgentBinary().then(setBinary, () => setBinary(null));
  }, []);

  // This screen goes away once the agent answers; still here means it did not.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const t = window.setTimeout(
      () => setPhase({ kind: "failed", message: "The agent started, but Shipyard can't reach it on 127.0.0.1:1378. Its log, agent.log in Shipyard's state folder, says why." }),
      ANSWER_TIMEOUT,
    );
    return () => window.clearTimeout(t);
  }, [phase.kind]);

  const start = async () => {
    setPhase({ kind: "starting" });
    try {
      await startAgent(atLogin);
      setPhase({ kind: "waiting" });
      retryConnection();
    } catch (err) {
      setPhase({ kind: "failed", message: plainError(err) });
    }
  };

  const busy = phase.kind === "starting" || phase.kind === "waiting";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia>
            <Scene name="offline" />
          </EmptyMedia>
          <EmptyTitle>The Shipyard agent isn't running</EmptyTitle>
          <EmptyDescription>
            {binary === null
              ? "It keeps your boxes connected while this window is closed. Run this in a terminal to start it; Shipyard connects as soon as it is up."
              : "It keeps your boxes connected while this window is closed, and keeps running after you quit Shipyard."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {binary === null && <TerminalCommand />}
          {binary && (
            <div className="flex w-full flex-col items-center gap-3">
              <Button className="w-full" disabled={busy} onClick={() => void start()}>
                {busy ? <Spinner /> : <PlayIcon />}
                {phase.kind === "starting" ? "Starting the Shipyard agent…" : phase.kind === "waiting" ? "Connecting…" : "Start the Shipyard agent"}
              </Button>
              <label className="flex w-full items-start gap-2.5 text-left text-body">
                <Checkbox className="mt-0.5" checked={atLogin} disabled={busy} onCheckedChange={(v) => setAtLogin(!!v)} />
                <span>
                  Start at login
                  <span className="block text-muted-foreground text-meta">{thisComputer("Also starts it whenever you log in to this Mac, and restarts it if it stops.")}</span>
                </span>
              </label>
              {phase.kind === "failed" && (
                <p role="alert" className="w-full text-left text-destructive-foreground text-body">
                  {phase.message}
                </p>
              )}
              <details className="w-full text-left text-muted-foreground text-meta">
                <summary className="cursor-default select-none hover:text-foreground">Start it from a terminal instead</summary>
                <div className="mt-2">
                  <TerminalCommand />
                </div>
              </details>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => location.reload()}>
            <RotateCwIcon />
            Retry now
          </Button>
          {error && (
            <details className="w-full text-left text-muted-foreground text-meta">
              <summary className="cursor-default select-none hover:text-foreground">Details</summary>
              <pre className="mt-2 rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">{error}</pre>
              {binary && <p className="mt-2">Shipyard starts it with {binary.path}</p>}
            </details>
          )}
        </EmptyContent>
      </Empty>
    </div>
  );
}

function TerminalCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex w-full items-center gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 text-left">
      <code className="flex-1 font-mono text-foreground text-mono">{START}</code>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          await navigator.clipboard?.writeText(START);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
