import { CommandIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { waitingAgents } from "@/lib/command-nav";
import { refFor } from "@/lib/workspaces";

// The command layout's hints, so a window with no sidebar never feels
// empty or hidden: a card the first time that names the few keys there
// are, and the same keys again whenever ⌘ is held down a moment, as the
// iPad does. The card comes back from ⌘K ("Show the command layout's
// keys").

export const KEYS: { keys: string[]; what: string; how?: string }[] = [
  { keys: ["⌘K"], what: "Switch to anything", how: "agents, worktrees, views" },
  { keys: ["⌘E"], what: "Next agent that needs you" },
  { keys: ["⌘N"], what: "New task", how: "an agent in a new worktree" },
  { keys: ["⌘[", "⌘]"], what: "Back and forward" },
  { keys: ["⌘1–9"], what: "Pinned worktrees", how: "⌘↵ in the switcher pins" },
  { keys: ["⌘,"], what: "Settings" },
];

const useCoach = create<{ open: boolean }>()(() => ({ open: false }));
export const showCommandKeys = () => useCoach.setState({ open: true });

function KeyRow({ k }: { k: (typeof KEYS)[number] }) {
  return (
    <li className="flex items-center gap-3 py-1">
      <span className="flex w-16 shrink-0 items-center gap-1">
        {k.keys.map((x) => (
          <Kbd key={x}>{x}</Kbd>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground text-sm">{k.what}</span>
        {k.how && <span className="ml-1.5 text-muted-foreground text-xs">{k.how}</span>}
      </span>
    </li>
  );
}

// Coach is the first-run card: what the layout is, its keys, and the way
// back to the sidebar. It waits until the window is connected and quiet.
export function CommandCoach() {
  const seen = usePrefs((p) => p.commandCoachSeen);
  const asked = useCoach((s) => s.open);
  const connected = useStore((s) => !!s.client);
  const open = connected && (asked || !seen);
  if (!open) return null;
  const done = () => {
    useCoach.setState({ open: false });
    usePrefs.setState({ commandCoachSeen: true });
  };
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="command-coach-title"
      data-testid="command-coach"
      onKeyDown={(e) => e.key === "Escape" && done()}
      className="fixed top-12 left-3 z-40 w-[min(400px,calc(100vw-24px))] rounded-2xl border bg-popover p-4 text-popover-foreground shadow-lg/10"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
          <CommandIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="command-coach-title" className="font-medium text-sm">
            {asked ? "The command layout's keys" : "Everything is behind the line at the top"}
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
            {asked ? (
              <>
                Hold <Kbd className="h-4.5 text-[10px]">⌘</Kbd> any time to see them, with where each one goes.
              </>
            ) : (
              "No sidebar here. Click where you are, or press ⌘K, to go to any agent, worktree or view. The pill beside it counts who needs you; hover it for a look."
            )}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={done} className="-m-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      </div>
      {/* The first time, one key; the rest come as they're useful (the
          ⌘E tip when something needs you, the pin offer, holding ⌘). */}
      <ul className="mt-3 border-t pt-2">
        {(asked ? KEYS : KEYS.slice(0, 1)).map((k) => (
          <KeyRow key={k.what} k={k} />
        ))}
        {!asked && (
          <li className="flex items-center gap-3 py-1">
            <span className="flex w-16 shrink-0 items-center gap-1">
              <Kbd>⌘</Kbd>
              <span className="text-[10px] text-muted-foreground">hold</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">Every other key, when you want it</span>
          </li>
        )}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground text-xs">
          Prefer the sidebar? <span className="text-foreground">Labs › Layout</span>
        </span>
        <Button size="sm" variant="ghost" onClick={done}>
          Got it
        </Button>
        <Button
          size="sm"
          onClick={() => {
            done();
            useStore.getState().setPaletteOpen(true);
          }}
        >
          Try ⌘K
        </Button>
      </div>
    </section>
  );
}

// HeldKeys shows the keys while ⌘ alone is held down, after a moment so a
// shortcut pressed quickly never flashes it.
export function HeldKeys() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer = 0;
    const hide = () => {
      window.clearTimeout(timer);
      timer = 0;
      setShown(false);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta" && !e.repeat && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setShown(true), 650);
      } else hide();
    };
    const up = (e: KeyboardEvent) => e.key === "Meta" && hide();
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, { capture: true });
    return () => {
      hide();
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, { capture: true });
    };
  }, []);
  return (
    <div
      aria-hidden={!shown}
      data-testid="command-held-keys"
      data-shown={shown || undefined}
      className={cn(
        "pointer-events-none fixed top-12 left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border bg-popover/95 px-4 py-3 text-popover-foreground shadow-lg/10 backdrop-blur-sm transition-[opacity,translate] duration-150",
        shown ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
    >
      {shown && <LiveKeys />}
    </div>
  );
}

// LiveKeys are the keys with where each goes right now: the agent ⌘E
// would open, and each pinned worktree's number.
function LiveKeys() {
  const pins = usePrefs((p) => p.pins);
  const next = waitingAgents()[0];
  const target = next ? next.session.title?.trim() || next.session.name : undefined;
  return (
    <ul>
      {KEYS.map((k) => (
        <KeyRow key={k.what} k={k.keys[0] === "⌘E" && target ? { ...k, how: `→ ${target}` } : k} />
      ))}
      {pins.length > 0 && (
        <li className="mt-1 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2">
          {pins.map((key, i) => {
            const ref = refFor(key);
            return (
              <span key={key} className="flex min-w-0 items-center gap-1 text-xs">
                <Kbd>⌘{i + 1}</Kbd>
                <span className="truncate text-muted-foreground">{ref ? (ref.main ? ref.location : ref.worktree) : "away"}</span>
              </span>
            );
          })}
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Kbd>⌃1–9</Kbd> tabs
          </span>
        </li>
      )}
    </ul>
  );
}
