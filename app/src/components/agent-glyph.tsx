import { AsteriskIcon, CheckIcon, HexagonIcon, SparkleIcon, SquareTerminalIcon, TerminalIcon, ZapIcon } from "lucide-react";

import { Tip } from "@/components/tip";
import type { SessionState } from "@/lib/derive";
import { useOutdated } from "@/lib/outdated";
import { BOX_WORDS, type BoxState, boxState, boxWhy, sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// AgentIcon marks which agent a session runs, in the agent's own colour.
export function AgentIcon({ agent, className }: { agent?: string; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (agent) {
    case "claude":
      return <AsteriskIcon className={cn(cls, "text-[#d97757]")} strokeWidth={2.75} />;
    case "codex":
      return <HexagonIcon className={cn(cls, "text-foreground/80")} strokeWidth={2.25} />;
    case "gemini":
      return <SparkleIcon className={cn(cls, "text-[#6f9bff]")} strokeWidth={2.25} />;
    case "pi":
      return <span className={cn("shrink-0 font-semibold text-[#a78bfa] text-xs leading-none", className)}>π</span>;
    case "opencode":
      return <SquareTerminalIcon className={cn(cls, "text-foreground/80")} />;
    case "grok":
      return <ZapIcon className={cn(cls, "text-foreground/80")} strokeWidth={2.25} />;
    default:
      return <TerminalIcon className={cn(cls, "text-muted-foreground")} />;
  }
}

const stateLabel = (s: SessionState) => sessionWord(s);

// stateText is a session's state in the model's words (lib/state-model.ts):
// Working, Needs you, Done, Idle, Ended, or Shell.
export function stateText(state: SessionState) {
  return stateLabel(state);
}

// StateGlyph is a session's state at a glance: a blue spinner while working,
// an amber dot when it needs you (amber means that and nothing else), a check
// when done, a grey ring when idle, a grey dot once it has ended. Under
// reduced motion the spinner stands still as a broken ring and the dot does
// not ping. The sidebar, the rail, tabs, panes, zen, the dashboard and the
// palette all draw states with it, so they agree. It is named for screen
// readers; the row or card around it says it in words.
export function StateGlyph({ state, className }: { state: SessionState; className?: string }) {
  const box = cn("inline-flex size-3.5 shrink-0 items-center justify-center", className);
  switch (state) {
    case "running":
      return (
        <span className={box} role="img" aria-label={stateLabel(state)}>
          <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-info border-t-transparent motion-reduce:animate-none" />
        </span>
      );
    case "waiting":
      return (
        <span className={box} role="img" aria-label={stateLabel(state)}>
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-warning" />
          </span>
        </span>
      );
    case "finished":
      return (
        <span className={box} role="img" aria-label={stateLabel(state)}>
          <CheckIcon className="size-3 text-success" strokeWidth={3} />
        </span>
      );
    case "ready":
      return (
        <span className={box} role="img" aria-label={stateLabel(state)}>
          <span className="size-2 rounded-full border-[1.5px] border-muted-foreground/70" />
        </span>
      );
    case "exited":
      return (
        <span className={box} role="img" aria-label={stateLabel(state)}>
          <span className="size-2 rounded-full bg-muted-foreground/40" />
        </span>
      );
    default:
      return null;
  }
}

// StatusDot is a box's state (lib/state-model.ts): green online, faded
// green when its link is slow, green with
// a blue ring when outdated, red when unreachable, a grey ring while
// connecting, grey when offline. Agent states (amber included) never use it.
export function StatusDot({ state, className }: { state?: BoxState | "untrusted"; className?: string }) {
  const s: BoxState = state === "untrusted" ? "unreachable" : (state ?? "offline");
  const color = {
    online: "bg-success",
    // Still online: green, quieter.
    slow: "bg-success/45",
    outdated: "bg-success ring-[1.5px] ring-info ring-offset-1 ring-offset-background",
    unreachable: "bg-destructive",
    connecting: "border border-muted-foreground/70 animate-pulse motion-reduce:animate-none",
    offline: "bg-muted-foreground/40",
  }[s];
  return <span role="img" aria-label={BOX_WORDS[s].word} className={cn("inline-block size-1.5 shrink-0 rounded-full", color, className)} />;
}

// useBoxState is a box's state in the model, from everything the app knows.
export function useBoxState(box: string): BoxState {
  const status = useStore((s) => s.status?.boxes.find((b) => b.name === box));
  const data = useStore((s) => s.boxes[box]);
  const outdated = useOutdated((s) => !!s.boxes[box]?.outdated);
  return boxState(status, data, outdated);
}

// BoxStateDot is useBoxState as a dot, with why in a tooltip.
export function BoxStateDot({ box, className }: { box: string; className?: string }) {
  const state = useBoxState(box);
  const status = useStore((s) => s.status?.boxes.find((b) => b.name === box));
  return (
    <Tip label={boxWhy(box, status, state)}>
      <StatusDot state={state} className={className} />
    </Tip>
  );
}
