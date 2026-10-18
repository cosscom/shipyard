import { CheckIcon, CircleCheckIcon, CopyIcon, RefreshCwIcon, ShieldAlertIcon, ShieldOffIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { boxApi, type Session } from "@/lib/api";
import { boxHasBrowserHealth, browserHealth, checkBrowser, setBrowserNoSandbox } from "@/lib/agent-browser";
import { type BrowserHealth, canFixWithSudo, SANDBOX_FIX, type SandboxCardState, sandboxCardState, sandboxCopy, type SandboxPhase, TRADE_OFF } from "@/lib/browser-sandbox";
import { useEventLog } from "@/lib/events";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { currentSpace, focusSession, refOf, type WorktreeRef } from "@/lib/workspaces";

// The guided fix for an agent's browser that Chromium's sandbox stops
// (lib/browser-sandbox.ts says why). One flow per box, shared by the card in
// the agent's view and the one in Settings → Boxes, so either shows where
// the other left off.

interface Flow {
  health?: BrowserHealth;
  phase: SandboxPhase;
  // This flow saw the box blocked, so its fixing is news.
  sawBlocked: boolean;
  // The terminal the fix was typed into.
  session?: string;
  // Starting Chromium once to see that the fix took.
  verifying?: boolean;
  verifyError?: string;
}

const useSandbox = create<{ boxes: Record<string, Flow> }>()(() => ({ boxes: {} }));

const flowOf = (box: string): Flow => useSandbox.getState().boxes[box] ?? { phase: "idle", sawBlocked: false };

function patch(box: string, p: Partial<Flow>) {
  useSandbox.setState((s) => ({ boxes: { ...s.boxes, [box]: { ...flowOf(box), ...p } } }));
}

// How long Shipyard watches for the fix after typing it, and how often.
const WATCH_FOR = 120_000;
const WATCH_EVERY = 2_500;
// How long "Fixed" stays before the card goes.
const FIXED_FOR = 10_000;

const watching = new Map<string, number>();
const clearing = new Map<string, number>();

// setHealth records the box's answer and moves the flow on: blocked marks
// it, and the first answer after a block that says ok starts Chromium once
// to be sure.
function setHealth(box: string, h: BrowserHealth) {
  const was = flowOf(box);
  // Past the block, the person's steps are done with.
  patch(box, { health: h, sawBlocked: was.sawBlocked || h.state === "sandbox", ...(h.state !== "sandbox" && { phase: "idle" as const }) });
  if (h.state !== "sandbox") stopWatching(box);
  if (h.state === "ok" && was.health?.state === "sandbox" && was.sawBlocked && !h.no_sandbox) void verify(box);
  if (h.state === "ok" && was.sawBlocked) scheduleClear(box);
}

// scheduleClear lets "Fixed" stand a few seconds, then the card goes.
function scheduleClear(box: string) {
  if (clearing.has(box)) return;
  clearing.set(
    box,
    window.setTimeout(() => {
      clearing.delete(box);
      const f = flowOf(box);
      if (f.verifying) return scheduleClear(box);
      if (f.health?.state === "ok") patch(box, { sawBlocked: false, phase: "idle", session: undefined, verifyError: undefined });
    }, FIXED_FOR),
  );
}

async function verify(box: string) {
  patch(box, { verifying: true, verifyError: undefined });
  try {
    const h = await checkBrowser(box);
    patch(box, { verifying: false, verifyError: h.state === "error" ? h.error : undefined });
    if (h.state === "sandbox") patch(box, { phase: "checked" });
    setHealth(box, h);
  } catch (err) {
    patch(box, { verifying: false, verifyError: errorMessage(err) });
  }
}

export async function refreshSandbox(box: string): Promise<BrowserHealth | undefined> {
  if (!boxHasBrowserHealth(box)) return undefined;
  try {
    const h = await browserHealth(box);
    setHealth(box, h);
    return h;
  } catch {
    return undefined;
  }
}

function stopWatching(box: string) {
  const t = watching.get(box);
  if (t) window.clearInterval(t);
  watching.delete(box);
}

// watchForFix checks the box every few seconds while the person runs the
// fix; after two minutes it stops and says it is still blocked.
function watchForFix(box: string) {
  stopWatching(box);
  const until = Date.now() + WATCH_FOR;
  watching.set(
    box,
    window.setInterval(() => {
      if (Date.now() > until) {
        stopWatching(box);
        if (flowOf(box).health?.state === "sandbox") patch(box, { phase: "checked" });
        return;
      }
      void refreshSandbox(box);
    }, WATCH_EVERY),
  );
}

// checkAgain asks the box now; still blocked says so.
async function checkAgain(box: string) {
  const h = await refreshSandbox(box);
  if (h?.state === "sandbox") {
    stopWatching(box);
    patch(box, { phase: "checked" });
  }
}

// fixTarget is a worktree on the box to open the terminal in: the one
// given, the one showing, or the box's first.
function fixTarget(box: string, prefer?: WorktreeRef): WorktreeRef | undefined {
  if (prefer?.box === box) return prefer;
  const here = currentSpace()?.ref;
  if (here?.box === box) return here;
  for (const loc of useStore.getState().boxes[box]?.locations ?? []) {
    const wt = loc.worktrees?.find((w) => w.main) ?? loc.worktrees?.[0];
    if (wt) return refOf(box, loc, wt);
  }
  return undefined;
}

export const canOpenFix = (box: string, prefer?: WorktreeRef) => !!fixTarget(box, prefer);

// openSandboxFix opens a terminal on the box with the fix typed and not
// run: the person reads it and presses Enter, and sudo asks for their
// password there. Shipyard never sees it.
export async function openSandboxFix(box: string, prefer?: WorktreeRef): Promise<boolean> {
  const client = useStore.getState().client;
  if (!client) return false;
  // Again: the same terminal, its line cleared (^C also ends a sudo prompt
  // left waiting), rather than another tab.
  const again = flowOf(box).session;
  const alive = again && useStore.getState().boxes[box]?.sessions?.some((x) => x.name === again && !x.exited);
  let name: string;
  if (alive) {
    name = again;
    await client.box(box, "POST", `sessions/${encodeURIComponent(name)}/keys`, { keys: ["interrupt"] }).catch(() => {});
    await new Promise((r) => window.setTimeout(r, 300));
  } else {
    const ref = fixTarget(box, prefer);
    if (!ref) return false;
    let s: Session;
    try {
      s = await boxApi.startSession(client, box, { location: ref.main ? ref.location : `${ref.location}/${ref.worktree}`, title: "Allow Chromium's sandbox" });
    } catch (err) {
      toastManager.add({ type: "error", title: `Couldn't open a terminal on ${box}`, description: errorMessage(err) });
      return false;
    }
    name = s.name;
    // Typed once the shell has drawn its prompt, so the line it edits is ours.
    for (let i = 0; i < 15; i++) {
      const screen = await boxApi.screen(client, box, name).then(
        (r) => r.screen,
        () => "",
      );
      if (screen.trim()) break;
      await new Promise((r) => window.setTimeout(r, 200));
    }
  }
  try {
    await boxApi.send(client, box, name, SANDBOX_FIX, false);
  } catch (err) {
    toastManager.add({ type: "error", title: "Couldn't type the command", description: errorMessage(err) });
  }
  patch(box, { phase: "fixing", session: name, sawBlocked: true });
  watchForFix(box);
  await focusSession(box, name);
  return true;
}

// useSandboxFlow is the box's flow, kept current: fetched when a card
// shows, and again when the box says its browser failed or its setting
// changed.
export function useSandboxFlow(box: string, enabled = true): Flow {
  const flow = useSandbox((s) => s.boxes[box]);
  const capable = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("browser.health"));
  const nudge = useEventLog((s) => s.events.find((e) => e.box === box && (e.type === "browser.failed" || e.type === "browser.opened" || (e.type === "config.changed" && "browser_no_sandbox" in (e.data ?? {}))))?.time);
  useEffect(() => {
    if (enabled && capable) void refreshSandbox(box);
  }, [box, enabled, capable, nudge]);
  return flow ?? { phase: "idle", sawBlocked: false };
}

// seedSandbox takes the health a worktree's browser status carried, so
// the agent's view needs no second call. A status without one means it can
// start, or that a browser runs: ask the box, if it was blocked.
export function seedSandbox(box: string, h: BrowserHealth | undefined) {
  if (h) {
    if (JSON.stringify(h) !== JSON.stringify(flowOf(box).health)) setHealth(box, h);
  } else if (flowOf(box).health?.state === "sandbox") {
    void refreshSandbox(box);
  }
}

export function useSandboxCardState(box: string, full = false): SandboxCardState {
  const flow = useSandbox((s) => s.boxes[box]);
  return sandboxCardState(flow?.health, flow?.phase ?? "idle", flow?.sawBlocked ?? false, full);
}

const tone: Record<Exclude<SandboxCardState, "hidden">, string> = {
  blocked: "border-warning/32 bg-warning/4",
  fixing: "border-warning/32 bg-warning/4",
  "still-blocked": "border-warning/32 bg-warning/4",
  fixed: "border-success/32 bg-success/4",
  "no-sandbox": "border-border bg-muted/40",
};

// BrowserSandboxCard says what happened in plain words and offers the two
// ways out. full: Settings → Boxes, which also keeps the no-sandbox switch
// while it is on.
export function BrowserSandboxCard({ box, worktree, full = false, className }: { box: string; worktree?: WorktreeRef; full?: boolean; className?: string }) {
  const flow = useSandboxFlow(box);
  const h = flow.health;
  const state = sandboxCardState(h, flow.phase, flow.sawBlocked, full);
  const [busy, setBusy] = useState<"fix" | "off" | "on" | "check">();
  if (state === "hidden") return null;
  const copy = sandboxCopy(state, box, h);
  const sudo = canFixWithSudo(h);
  const openable = canOpenFix(box, worktree);
  const run = async (what: typeof busy, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toastManager.add({ type: "error", title: "That didn't work", description: errorMessage(err) });
    } finally {
      setBusy(undefined);
    }
  };
  const noSandbox = (on: boolean) =>
    run(on ? "on" : "off", async () => {
      const next = await setBrowserNoSandbox(box, on);
      patch(box, { phase: "idle" });
      setHealth(box, next);
    });
  const Icon = state === "fixed" ? CircleCheckIcon : state === "no-sandbox" ? ShieldOffIcon : ShieldAlertIcon;
  const blocked = state === "blocked" || state === "still-blocked";

  return (
    <div role="status" data-sandbox-card={state} className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-body", tone[state], className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", state === "fixed" ? "text-success" : state === "no-sandbox" ? "text-muted-foreground" : "text-warning")} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">{copy.title}</p>
          <p className="text-muted-foreground text-meta">{copy.body}</p>
        </div>
        {state === "fixed" && (flow.verifying || flow.verifyError) && (
          <p className="flex items-center gap-1.5 text-muted-foreground text-meta">
            {flow.verifying ? (
              <>
                <Spinner className="size-3" /> Starting Chromium on {box} to make sure…
              </>
            ) : (
              <>The setting is fixed, but Chromium still didn't start: {flow.verifyError}</>
            )}
          </p>
        )}
        {(state === "fixing" || (state === "still-blocked" && sudo)) && <FixCommand />}
        {blocked && (
          <div className="flex flex-wrap items-center gap-2">
            {sudo && openable && (
              <Button size="sm" loading={busy === "fix"} onClick={() => void run("fix", () => openSandboxFix(box, worktree))}>
                <SquareTerminalIcon />
                {state === "still-blocked" ? "Try the command again" : `Fix it on ${box} (needs your password)`}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={h?.no_sandbox_from === "env"} loading={busy === "on"} onClick={() => void noSandbox(true)}>
              <ShieldOffIcon />
              Run without Chromium's sandbox
            </Button>
          </div>
        )}
        {blocked && <p className="text-muted-foreground text-meta">{TRADE_OFF}</p>}
        {state === "fixing" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" loading={busy === "check"} onClick={() => void run("check", () => checkAgain(box))}>
              <RefreshCwIcon />
              Check again
            </Button>
            {flow.session && (
              <Button size="sm" variant="ghost" onClick={() => void focusSession(box, flow.session!)}>
                <SquareTerminalIcon />
                Show the terminal
              </Button>
            )}
            <span className="flex items-center gap-1.5 text-muted-foreground text-meta">
              <Spinner className="size-3" /> Watching {box} for the change
            </span>
          </div>
        )}
        {state === "no-sandbox" && (
          <label className="flex items-center gap-2 text-meta">
            <Switch
              checked={!!h?.no_sandbox}
              disabled={h?.no_sandbox_from === "env" || !!busy}
              onCheckedChange={(on) => void noSandbox(on)}
              aria-label="Run without Chromium's sandbox"
            />
            <span>Run without Chromium's sandbox</span>
            {!full && <span className="text-muted-foreground">· also in Settings → Boxes</span>}
          </label>
        )}
      </div>
    </div>
  );
}

// FixCommand shows exactly what was typed, so the person can read it
// before pressing Enter, and copy it to run elsewhere.
function FixCommand() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-background/70 px-2.5 py-2">
      <code className="min-w-0 flex-1 break-words font-mono text-tag">{SANDBOX_FIX}</code>
      <button
        type="button"
        aria-label="Copy the command"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => navigator.clipboard.writeText(SANDBOX_FIX).then(() => setCopied(true), () => {})}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}
