import { invoke } from "@tauri-apps/api/core";
import { CheckIcon, CopyIcon, ExternalLinkIcon, PackageIcon, RefreshCwIcon, SquareTerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { isMock } from "@/hooks/use-berth-connection";
import { ApiError, isTauri } from "@/lib/api";
import { useIsLocalBox } from "@/lib/local-box";
import { openUrl } from "@/lib/open-url";
import { parseRequirements, type Requirements, type RequirementsCard as CardKind, requirementsCard, requirementsCopy } from "@/lib/requirements";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { thisComputer } from "@/lib/platform";

// The card that says what a box is missing before an agent can start on it
// (lib/requirements.ts says why), with the command to install it, typed out
// to copy and never run by Shipyard, and Check again. One answer per box,
// shared by onboarding and the composer, so either shows the other's.

interface Entry {
  req?: Requirements;
  // The box answered (or is too old to): unknown requirements go ahead.
  known: boolean;
  checking?: boolean;
  at?: number;
}

const useRequirements = create<{ boxes: Record<string, Entry> }>()(() => ({ boxes: {} }));

const entryOf = (box: string): Entry => useRequirements.getState().boxes[box] ?? { known: false };
const patch = (box: string, p: Partial<Entry>) => useRequirements.setState((s) => ({ boxes: { ...s.boxes, [box]: { ...entryOf(box), ...p } } }));

// An answer this fresh is used as it is; Check again always asks.
const FRESH_FOR = 60_000;
const inflight = new Map<string, Promise<Requirements | undefined>>();

// fetchRequirements asks the box. An older box (404, or an answer that
// isn't one) and an unreachable box are both "unknown": nothing is blocked.
export function fetchRequirements(box: string, force = false): Promise<Requirements | undefined> {
  const e = entryOf(box);
  if (!force && e.known && e.at && Date.now() - e.at < FRESH_FOR) return Promise.resolve(e.req);
  const running = inflight.get(box);
  if (running) return running;
  const client = useStore.getState().client;
  if (!client) return Promise.resolve(undefined);
  patch(box, { checking: true });
  // The agents the composer offers come from the box's info: freshen them
  // too, so an agent CLI just installed is offered.
  if (force) void useStore.getState().refreshBox(box, ["info"]);
  const p = client
    .box<unknown>(box, "GET", "requirements")
    .then(
      (v) => {
        const req = parseRequirements(v);
        patch(box, { req, known: true, checking: false, at: Date.now() });
        return req;
      },
      (err) => {
        // 404: a box from before requirements. Anything else: try again later.
        const old = err instanceof ApiError && (err.status === 404 || err.code === "not_found" || err.code === "unsupported");
        patch(box, { req: old ? undefined : entryOf(box).req, known: old || entryOf(box).known, checking: false, at: old ? Date.now() : entryOf(box).at });
        return entryOf(box).req;
      },
    )
    .finally(() => inflight.delete(box));
  inflight.set(box, p);
  return p;
}

// noteTmuxMissing is for a start the box refused because tmux is missing
// (code tmux_missing): ask again, so the card shows what to do.
export function noteTmuxMissing(box: string) {
  void fetchRequirements(box, true);
}

// tmuxMissing says, from what the box last said, whether starting an agent
// there can only fail.
export const tmuxMissing = (box: string) => entryOf(box).req?.tmux.found === false;

// useBoxRequirements keeps a box's answer current while a card might show.
export function useBoxRequirements(box: string | undefined, enabled = true): Entry {
  const entry = useRequirements((s) => (box ? s.boxes[box] : undefined));
  const online = useStore((s) => !!box && s.status?.boxes.find((b) => b.name === box)?.state === "online");
  useEffect(() => {
    if (box && enabled && online) void fetchRequirements(box);
  }, [box, enabled, online]);
  return entry ?? { known: false };
}

// useRequirementsCard is the card for starting agent on box, and whether it
// stops Start.
export function useRequirementsCard(box: string | undefined, o: { agent?: string; noAgent?: boolean; enabled?: boolean } = {}): CardKind {
  const e = useBoxRequirements(box, o.enabled ?? true);
  return requirementsCard(e.req, { agent: o.agent, noAgent: o.noAgent });
}

// openTerminalApp brings up Terminal on this Mac (the app only).
async function openTerminalApp(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke("open_terminal");
    return true;
  } catch {
    return false;
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// RequirementsCard says what box is missing and how to install it. agent
// is the agent about to start; label names the box (thisComputer("this Mac")).
// team is the Team setup page's: its steps run in tmux, so only tmux counts.
export function RequirementsCard({ box, agent, noAgent, team, className }: { box: string; agent?: string; noAgent?: boolean; team?: boolean; className?: string }) {
  const local = useIsLocalBox(box);
  const entry = useBoxRequirements(box);
  const card = team ? (entry.req?.tmux.found === false ? "tmux" : "hidden") : requirementsCard(entry.req, { agent, noAgent });
  const [opened, setOpened] = useState(false);
  const [checked, setChecked] = useState(false);
  // A new box or a new kind of card starts the steps over.
  useEffect(() => {
    setOpened(false);
    setChecked(false);
  }, [box, card]);
  const copyText = requirementsCopy(card, entry.req, local ? "this Mac" : box, { local, agent, team });
  if (card === "hidden" || !copyText) return null;
  const mac = entry.req?.os === "darwin";
  // The app can bring up Terminal; mock mode acts as the app does.
  const canOpen = local && mac && (isTauri() || isMock());
  // The line the main button copies: Homebrew's installer first, when it
  // comes first (brew is only on PATH in a new shell once it has run).
  const line = copyText.first ?? copyText.command;

  const openIt = async () => {
    if (line) await copy(line);
    await openTerminalApp();
    setOpened(true);
  };
  const checkAgain = async () => {
    await fetchRequirements(box, true);
    setChecked(true);
  };
  const two = !!copyText.first && !!copyText.command;
  const howTo =
    opened && canOpen
      ? two
        ? "Copied step 1. Paste it in Terminal (⌘V), read it, and press Enter. When Homebrew is done, run step 2 there, then check again."
        : "Copied. Paste it in Terminal (⌘V), read it, and press Enter. When it's done, check again."
      : line
        ? `Run ${two ? "them" : "it"} in ${copyText.where}, then check again. Shipyard never runs ${two ? "them" : "it"} for you.`
        : `Install it on ${box}, then check again.`;

  return (
    <div role="status" data-requirements-card={card} className={cn("flex gap-3 rounded-lg border border-warning/32 bg-warning/4 px-3.5 py-3 text-body", className)}>
      <PackageIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">{copyText.title}</p>
          <p className="text-muted-foreground text-meta">{copyText.body}</p>
        </div>
        {copyText.first && (
          <Command
            step={1}
            label={
              <>
                Install Homebrew
                {copyText.help && (
                  <>
                    {" · "}
                    <button type="button" className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline" onClick={() => void openUrl(copyText.help!.url)}>
                      {copyText.help.label}
                      <ExternalLinkIcon className="size-3" />
                    </button>
                  </>
                )}
              </>
            }
            text={copyText.first}
          />
        )}
        {copyText.command && <Command step={two ? 2 : undefined} label={two ? "Then tmux" : undefined} text={copyText.command} />}
        <p className="text-muted-foreground text-meta">{howTo}</p>
        <div className="flex flex-wrap items-center gap-2">
          {canOpen && line && (
            <Button size="sm" variant={opened ? "outline" : "default"} onClick={() => void openIt()}>
              <SquareTerminalIcon />
              {two ? "Copy step 1 and open Terminal" : opened ? "Copy and open Terminal again" : "Copy and open Terminal"}
            </Button>
          )}
          <Button size="sm" variant={canOpen && line && !opened ? "outline" : "default"} loading={entry.checking} onClick={() => void checkAgain()}>
            <RefreshCwIcon />
            Check again
          </Button>
          {checked && !entry.checking && <span className="text-muted-foreground text-meta">Still missing on {local ? thisComputer("this Mac") : box}.</span>}
        </div>
      </div>
    </div>
  );
}

// Command shows exactly what to run, with a copy button.
function Command({ text, step, label }: { text: string; step?: number; label?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <span className="text-muted-foreground text-tag">
          {step ? `${step}.\u00a0` : ""}
          {label}
        </span>
      )}
      <div className="flex items-start gap-2 rounded-md border bg-background/70 px-2.5 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-tag">{text}</code>
        <button
          type="button"
          aria-label="Copy the command"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void copy(text).then((ok) => ok && setCopied(true))}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
