import { CircleAlertIcon, GaugeIcon, KeyRoundIcon, OctagonXIcon, PlayIcon, RotateCwIcon, SquareIcon, SquareTerminalIcon, TriangleAlertIcon, WebhookIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { NoticeKind, TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// A notice is something the person should know, with one next step: an API
// error (try again), a usage limit (when it resets), a hook that failed or
// an agent signed out (the terminal), an agent that ended (start it again).
// An interrupted turn is a quiet line. None of them is ever hidden.

export interface ChatActions {
  who: string;
  // Types text for the agent: a retry is "continue".
  send?(text: string): Promise<void> | void;
  showTerminal?(): void;
  startAgain?(): void;
}

const Scope = createContext<ChatActions | undefined>(undefined);

// ChatScope gives the notices in a conversation their next steps.
export function ChatScope({ value, children }: { value: ChatActions; children: ReactNode }) {
  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}

type Notice = Extract<TranscriptItem, { kind: "notice" }>;

const TITLES: Record<NoticeKind, (who: string) => string> = {
  api_error: (who) => `${who} hit an API error`,
  limit: () => "Usage limit reached",
  rate_limit: () => "Rate limited",
  auth: (who) => `${who} needs you to log in`,
  billing: () => "A billing problem stopped the turn",
  hook: () => "A hook failed",
  interrupted: () => "Interrupted",
  stop_failure: () => "The turn ended with an error",
  exited: (who) => `${who} exited unexpectedly`,
  memory: (who) => `${who} is near its memory limit`,
};

const ICONS: Record<NoticeKind, typeof CircleAlertIcon> = {
  api_error: CircleAlertIcon,
  limit: GaugeIcon,
  rate_limit: GaugeIcon,
  auth: KeyRoundIcon,
  billing: CircleAlertIcon,
  hook: WebhookIcon,
  interrupted: SquareIcon,
  stop_failure: TriangleAlertIcon,
  exited: OctagonXIcon,
  memory: GaugeIcon,
};

// The words under the title: the agent's own, without "API Error:".
const detail = (n: Notice) => n.text.replace(/^API Error:\s*/i, "").replace(/^Interrupted$/, "");

export function NoticeCard({ it, scope: given }: { it: Notice; scope?: ChatActions }) {
  const ctx = useContext(Scope);
  const scope = given ?? ctx;
  const who = scope?.who ?? "The agent";
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    if (!scope?.send) return;
    setBusy(true);
    try {
      await scope.send("continue");
    } finally {
      setBusy(false);
    }
  };

  if (it.notice === "interrupted") {
    return (
      <div data-notice="interrupted" className="cv-in flex items-center gap-2 text-muted-foreground text-desc">
        <span className="h-px w-4 bg-border" aria-hidden />
        <SquareIcon className="size-3 shrink-0 fill-current" aria-hidden />
        <span>Interrupted</span>
        <span className="text-muted-foreground/70">· {who} stopped and waits for what to do instead</span>
        {scope?.send && (
          <Button size="xs" variant="ghost" className="-my-1 ml-auto" loading={busy} onClick={() => void retry()}>
            <PlayIcon />
            Continue
          </Button>
        )}
      </div>
    );
  }

  const Icon = ICONS[it.notice] ?? CircleAlertIcon;
  const error = it.level === "error" || it.notice === "exited" || it.notice === "api_error" || it.notice === "stop_failure";
  const text = detail(it);
  const step = nextStep(it.notice, scope, retry, busy);
  return (
    <div
      role="status"
      data-notice={it.notice}
      className={cn(
        "cv-in flex items-start gap-3 rounded-lg border px-3.5 py-3",
        error ? "border-destructive/35 bg-destructive/[0.04] dark:bg-destructive/[0.08]" : "border-warning/45 bg-warning/[0.06] dark:bg-warning/[0.08]",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", error ? "text-destructive-foreground" : "text-warning-foreground")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-desc">{TITLES[it.notice]?.(who) ?? "Something went wrong"}</div>
        {text && text !== TITLES[it.notice]?.(who) && (
          <p data-selectable className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground text-desc">
            {text}
          </p>
        )}
        {it.resets ? <Resets at={it.resets} /> : null}
      </div>
      {step && <div className="shrink-0 self-center">{step}</div>}
    </div>
  );
}

function nextStep(kind: NoticeKind, scope: ChatActions | undefined, retry: () => Promise<void>, busy: boolean): ReactNode {
  switch (kind) {
    case "api_error":
    case "rate_limit":
    case "limit":
    case "stop_failure":
      return scope?.send ? (
        <Button size="sm" variant="outline" loading={busy} onClick={() => void retry()}>
          <RotateCwIcon />
          Try again
        </Button>
      ) : null;
    case "exited":
      // Starting again is offered just below, where the reply box was: the
      // card's step is finding out why.
      return scope?.showTerminal ? (
        <Button size="sm" variant="outline" onClick={scope.showTerminal}>
          <SquareTerminalIcon />
          See why
        </Button>
      ) : null;
    case "auth":
    case "billing":
    case "hook":
      return scope?.showTerminal ? (
        <Button size="sm" variant="outline" onClick={scope.showTerminal}>
          <SquareTerminalIcon />
          {kind === "auth" ? "Log in at the terminal" : "Show terminal"}
        </Button>
      ) : null;
  }
  return null;
}

// Resets says when a limit lifts: "Resets at 3:00 PM · in 1h 52m", ticking.
function Resets({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const left = at - now;
  const when = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(at).toDateString() !== new Date(now).toDateString() ? `${new Date(at).toLocaleDateString([], { weekday: "short" })} ` : "";
  if (left <= 0) return <p className="mt-1 text-meta text-muted-foreground">It has reset: try again.</p>;
  const h = Math.floor(left / 3_600_000);
  const m = Math.ceil((left % 3_600_000) / 60_000);
  return (
    <p className="mt-1 text-meta text-foreground/80">
      Resets at {day}
      {when} · in {h ? `${h}h ` : ""}
      {m}m
    </p>
  );
}
