import { RotateCwIcon, ServerIcon } from "lucide-react";

import { Scene } from "@/components/art/scenes";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { resumeConversation, resumeSession, startSession } from "@/lib/actions";
import { agentLabel, conversationOf, restartCommand } from "@/lib/derive";
import { retryLine } from "@/lib/net";
import { tryNow, useAway } from "@/lib/reconnect";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";
import { useTitleAt } from "@/lib/worktree-names";

// The states a terminal pane shows when there is nothing to attach to: the
// session ended, or its box is out of reach. Each is a small drawing, one
// line saying what happened, one saying where, and what to do next.

function PaneState({ art, title, detail, children, panel }: { art: React.ReactNode; title: React.ReactNode; detail?: React.ReactNode; children?: React.ReactNode; panel?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className={cn("flex max-w-sm flex-col items-center text-center", panel && "rounded-xl border bg-popover/95 px-8 pt-6 pb-5 shadow-lg/5")}>
        <div className="mb-4 text-muted-foreground/80">{art}</div>
        {title}
        {detail && <div className="mt-1 max-w-full text-desc text-muted-foreground">{detail}</div>}
        {children && <div className="mt-4 flex gap-2">{children}</div>}
      </div>
    </div>
  );
}

// SessionEnded says what stopped and where, and offers to start the same
// thing again in the same worktree, in this pane.
export function SessionEnded({ box, session, agent, command, wsKey, tab, pane, onClose }: { box: string; session: string; agent?: string; command?: string; wsKey: string; tab: string; pane: string; onClose(): void }) {
  const ref = useWorkspaces((s) => s.spaces[wsKey]?.ref);
  const label = agent ? agentLabel(agent) : "Shell";
  const named = useTitleAt(ref?.box, ref?.path);
  // A structured agent's conversation carries on, rather than a new one:
  // in its session, or, with the session gone (a reboot), from what the box
  // keeps of it. Its command is never run again: it isn't one to type.
  const listed = useStore((st) => st.boxes[box]?.sessions?.find((x) => x.name === session));
  const resumable = !!listed?.switch;
  const conv = conversationOf(command);
  // Started again, it exited as it started: why, in its own words.
  const failed = listed?.failed;
  const where = ref ? (named ?? (ref.main ? ref.location : ref.worktree)) : undefined;
  return (
    <PaneState
      art={<Scene name="ended" width={144} />}
      title={
        // Named as its tab named it; the session's id is for the curious.
        <Tip label={`${session} on ${box}`}>
          <p className="text-row">{failed ? `${label} couldn't start` : agent ? `${label} has ended` : "The shell has ended"}</p>
        </Tip>
      }
      detail={
        <>
          <p className="flex min-w-0 items-center justify-center gap-1.5">
            <span className="shrink-0">{where ? `${where} on ${box}` : `on ${box}`}</span>
            {command && !conv && (
              <>
                <span className="text-muted-foreground/48">·</span>
                <code className="min-w-0 truncate font-mono text-meta text-foreground/72">{command}</code>
              </>
            )}
          </p>
          {failed && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-left font-mono text-meta text-foreground/80">
              {failed.error || `It exited with code ${failed.code}.`}
            </pre>
          )}
        </>
      }
    >
      {resumable ? (
        <Button size="sm" onClick={() => void resumeSession(box, session)}>
          <RotateCwIcon />
          Resume the conversation
        </Button>
      ) : conv ? (
        <Button size="sm" onClick={() => void resumeConversation(box, { id: conv, agent: agent ?? "claude" }, wsKey, { kind: "replace", tab, pane })}>
          <RotateCwIcon />
          Resume the conversation
        </Button>
      ) : (
        <Button size="sm" onClick={() => void startSession(restartCommand(command) ?? "", { kind: "replace", tab, pane }, label)}>
          <RotateCwIcon />
          Start {agent ? label : "a shell"} again
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close pane
      </Button>
    </PaneState>
  );
}

// RetryLine counts down to the agent's next try of a box that is away
// ("Next try in 6s · away 1m 5s"), from the agent's status.
export function RetryLine({ box, className }: { box: string; className?: string }) {
  const line = retryLine(useAway(box));
  if (!line) return null;
  return (
    <span data-testid="retry-line" aria-live="polite" className={cn("mb-1 block font-medium text-foreground/72 tabular-nums", className)}>
      {line}
    </span>
  );
}

// BoxOffline sits over the dimmed screen: the session is still running on
// the box, and Shipyard reattaches on its own when the box is back.
export function BoxOffline({ box, state, onRetry }: { box: string; state?: string; onRetry(): void }) {
  const title = state === "connecting" ? `Connecting to ${box}…` : state === "untrusted" ? `${box} is unreachable` : `Reconnecting to ${box}…`;
  const detail =
    state === "untrusted"
      ? "It answered with a different identity than when it was paired, so Shipyard won't talk to it. Pair it again if it was rebuilt."
      : "The session keeps running there, and this terminal comes back as it was.";
  return (
    <PaneState
      panel
      art={<Scene name="offline" width={128} />}
      title={<p className="text-row">{title}</p>}
      detail={
        <>
          {state !== "untrusted" && <RetryLine box={box} />}
          <p className="max-w-xs">{detail}</p>
        </>
      }
    >
      <Button
        size="sm"
        onClick={() => {
          void tryNow(box);
          onRetry();
        }}
      >
        <RotateCwIcon />
        Try now
      </Button>
      <Button size="sm" variant="outline" onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })}>
        <ServerIcon />
        Boxes
      </Button>
    </PaneState>
  );
}
