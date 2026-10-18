import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CircleAlertIcon, HandIcon, RepeatIcon, CircleStopIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSessionName } from "@/hooks/use-session-name";
import { dismissLoop, isLive, type Loop, useLoops } from "@/lib/loops";
import { allRuns, type BoxRun, dismissRun, runs as runsApi, useRuns } from "@/lib/runs";
import { load, save } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";

const phases: Record<Loop["phase"], string> = {
  prompting: "Prompting",
  waiting: "Agent working",
  checking: "Running the check",
};

const outcomes: Record<NonNullable<Loop["outcome"]>, string> = {
  passed: "Passed",
  failed: "Gave up",
  "needs-you": "Needs you",
  exited: "Session ended",
  "timed-out": "Timed out",
  cancelled: "Stopped",
  error: "Stopped",
};

const rounds = (n: number) => `${n} round${n === 1 ? "" : "s"}`;

// What to say under the title. The CLI's messages are kept, worded for
// a panel: no "(s)", no trailing "…" on a finished loop.
function detail(l: Loop): string {
  if (l.outcome === "passed") return `Passed after ${rounds(l.round)}.`;
  if (l.outcome === "failed") return `The check still fails after ${rounds(l.max)}.`;
  if (l.outcome === "cancelled") return `Stopped in round ${l.round}.`;
  return l.message.replace(/ round\(s\)/, l.round === 1 ? " round" : " rounds");
}

// The panel docks above the status bar (26px) with a 12px gap, left of the
// Files panel when that is docked (--berth-dock-w); toasts stack above the
// panel by reading its height from --berth-loops-h.
const STATUS_BAR = 26;
const GAP = 12;

// LoopsPanel stacks running and finished loops in the corner: what each is
// doing, its round, and the last check's output on demand. Loops are the
// window's; an agent's crew is its conversation's (CrewCard, docked above
// its reply box). With no loops the panel is gone and reserves no room.
export function LoopsPanel() {
  const local = useLoops((s) => s.loops);
  const byBox = useRuns((s) => s.byBox);
  const dismissed = useRuns((s) => s.dismissed);
  // Loops that run on boxes, from the boxes' runs: started here, from the
  // CLI, a plugin, another device, or before the app last quit.
  const tracked = new Set(local.map((l) => l.runId).filter(Boolean));
  const fromRuns = allRuns(byBox)
    .filter((r) => r.template === "loop" && !tracked.has(r.id) && !dismissed.includes(`${r.box}/${r.id}`))
    .filter((r) => !r.finished || Date.now() - new Date(r.finished).getTime() < 30 * 60_000)
    .map(loopOfRun);
  const loops = [...local, ...fromRuns];
  const [folded, setFoldedState] = useState(() => load("berth.loops.folded", false));
  const setFolded = (f: boolean) => {
    setFoldedState(f);
    save("berth.loops.folded", f);
  };
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) {
      root.style.setProperty("--berth-loops-h", "0px");
      root.style.setProperty("--berth-loops-w", "0px");
      return;
    }
    // Its width too, so a centred column (a conversation) can step aside.
    const sync = () => {
      root.style.setProperty("--berth-loops-h", `${el.offsetHeight + GAP}px`);
      root.style.setProperty("--berth-loops-w", `${el.offsetWidth + GAP * 2}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--berth-loops-h", "0px");
      root.style.setProperty("--berth-loops-w", "0px");
    };
  }, [loops.length, folded]);

  if (!loops.length) return null;
  const live = loops.filter(isLive).length;
  const bottom = `calc(var(--berth-status-h, ${STATUS_BAR}px) + ${GAP}px)`;
  // Folded, the panel is one pill in the corner, so it never sits over a
  // page's own controls; it opens again on a click, or when a loop needs you.
  if (folded && !loops.some((l) => l.outcome === "needs-you")) {
    return (
      <div ref={ref} style={{ bottom, right: `calc(${GAP}px + var(--berth-dock-w, 0px))` }} className="fixed z-40" role="region" aria-label="Loops">
        <Button size="sm" variant="outline" className="rounded-full bg-popover shadow-lg/5" onClick={() => setFolded(false)} aria-expanded={false}>
          {live ? <Spinner className="size-3.5" /> : <RepeatIcon />}
          {`${loops.length} loop${loops.length === 1 ? "" : "s"}${live ? ` · ${live} running` : ""}`}
          <ChevronUpIcon />
        </Button>
      </div>
    );
  }
  return (
    <div ref={ref} style={{ bottom, right: `calc(${GAP}px + var(--berth-dock-w, 0px))` }} className="fixed z-40 flex max-h-[50vh] w-88 flex-col gap-2 overflow-y-auto" role="region" aria-label="Loops">
      {loops.map((l) => (
        <LoopCard key={l.id} loop={l} />
      ))}
      <Button size="xs" variant="ghost" className="self-end bg-popover/80 text-muted-foreground shadow-xs/5 backdrop-blur-sm" onClick={() => setFolded(true)} aria-expanded>
        <ChevronDownIcon />
        Fold
      </Button>
    </div>
  );
}

// loopOfRun shows a loop run as the panel shows a loop. Its round and
// phase come from where the run is (the loop template's step paths).
function loopOfRun(r: BoxRun): Loop {
  const cursor = r.cursor ?? "";
  const round = Number(/\.r(\d+)\./.exec(`${cursor}.`)?.[1] ?? 1);
  const phase: Loop["phase"] = /\.r\d+\.0$/.test(cursor) ? "checking" : /\.t\.1$/.test(cursor) ? "waiting" : "prompting";
  const err = r.error ?? "";
  const outcome: Loop["outcome"] =
    r.status === "succeeded"
      ? "passed"
      : r.status === "cancelled"
        ? "cancelled"
        : r.status === "failed" || r.status === "interrupted"
          ? /waiting for you/.test(err)
            ? "needs-you"
            : /still not done/.test(err)
              ? "failed"
              : /did not finish/.test(err)
                ? "timed-out"
                : /exited/.test(err)
                  ? "exited"
                  : "error"
          : undefined;
  return {
    id: `run:${r.box}:${r.id}`,
    box: r.box,
    session: r.session ?? "",
    check: /^Loop until (.*) passes$/.exec(r.title ?? "")?.[1] ?? r.title ?? "",
    round,
    max: 0,
    phase,
    outcome,
    message: outcome === "passed" ? `Passed after ${round} round(s).` : err || (r.gate ? `Waiting at a gate: ${r.gate.title}` : `Round ${round}`),
    started: new Date(r.created).getTime(),
    ended: r.finished ? new Date(r.finished).getTime() : undefined,
    runId: r.id,
    cancel: () => void runsApi.cancel(r.box, r.id),
  };
}

function LoopCard({ loop: l }: { loop: Loop }) {
  const [open, setOpen] = useState(false);
  const live = isLive(l);
  const name = useSessionName(l.box, l.session, true);
  // The runner's messages name the session by its id, as the CLI does; the
  // panel says what the app calls it.
  const agent = useSessionName(l.box, l.session);
  const said = detail(l).split(l.session).join(agent);
  return (
    <div
      className={cn(
        "rounded-xl border bg-popover p-3 text-body shadow-lg/5",
        l.outcome === "needs-you" && "border-warning/60",
        l.outcome === "passed" && "border-success/40",
        (l.outcome === "failed" || l.outcome === "error" || l.outcome === "exited" || l.outcome === "timed-out") && "border-destructive/40",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon loop={l} />
        <span className="font-medium">{live ? phases[l.phase] : outcomes[l.outcome!]}</span>
        <span className="text-muted-foreground text-meta tabular-nums">
          Round {l.round}
          {l.max > 0 && ` of ${l.max}`}
        </span>
        {l.runId && (
          <Tip label={`Runs on ${l.box} (${l.runId}): it keeps going if the app quits`}>
            <span className="rounded bg-muted px-1 text-tag text-muted-foreground">on {l.box}</span>
          </Tip>
        )}
        {!live && (
          <Tip label="Dismiss">
            <button type="button" className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Dismiss"
              onClick={() => {
                dismissLoop(l.id);
                if (l.runId) dismissRun(l.box, l.runId);
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <Tip label={`Session ${l.session} on ${l.box}`} align="start">
        <p className="mt-1 truncate text-muted-foreground text-meta">
          {name} · <span className="font-mono">{l.check}</span>
        </p>
      </Tip>
      <p className="mt-1 text-desc text-foreground/80">{said}</p>
      {l.output !== undefined && (
        <>
          <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-muted-foreground text-meta hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
            Last check exited {l.exitCode}
          </button>
          {open && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/72 p-2 font-mono text-tag">{l.output.trim() || "(no output)"}</pre>}
        </>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => void focusSession(l.box, l.session)}>
          Open session
        </Button>
        {live && (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => l.cancel()}>
            <CircleStopIcon />
            Stop loop
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ loop: l }: { loop: Loop }) {
  if (isLive(l)) return <Spinner className="size-3.5" />;
  if (l.outcome === "passed") return <CheckIcon className="size-3.5 text-success" />;
  if (l.outcome === "needs-you") return <HandIcon className="size-3.5 text-warning" />;
  if (l.outcome === "cancelled") return <RepeatIcon className="size-3.5 text-muted-foreground" />;
  return <CircleAlertIcon className="size-3.5 text-destructive" />;
}
