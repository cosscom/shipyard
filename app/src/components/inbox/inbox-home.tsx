import { useEffect, useRef } from "react";

import { DitherBand } from "@/components/art/dither-band";
import { HARBOUR, HARBOUR_MUTE, useHarbourLight } from "@/components/art/harbour-art";
import { TaskComposer } from "@/components/conversation/task-composer";
import { useInbox } from "@/components/inbox/inbox-state";
import { Kbd } from "@/components/ui/kbd";
import { TeamSuggestCards } from "@/views/home/team-suggest-card";

// InboxHome is what is beside the inbox with no worktree open: the
// composer, to start work (c or New task bring it here with the keyboard),
// and the inbox's keys, so they can be learned at a glance. The agents
// themselves are in the list, so Home's widgets would only say it twice.

const BAND = "clamp(180px, 40vh, 400px)";

const KEYS: [string, string][] = [
  ["j k", "move"],
  ["↵", "open"],
  ["e", "done"],
  ["z", "undo"],
  ["y n", "allow, deny"],
  ["c", "new task"],
  ["⌘J", "back to the list"],
  ["?", "all keys"],
];

export function InboxHome() {
  const light = useHarbourLight();
  const composeAsk = useInbox((s) => s.composeAsk);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!composeAsk) return;
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("textarea, [contenteditable=true]")?.focus());
    return () => cancelAnimationFrame(id);
  }, [composeAsk]);
  return (
    <div data-testid="inbox-home" className="absolute inset-0 overflow-y-auto bg-background">
      <div className="relative min-h-full">
        <div aria-hidden className="absolute inset-x-0 top-0" style={{ height: BAND }}>
          <DitherBand src={HARBOUR[light]} position={0.42} fade={0.45} mute={HARBOUR_MUTE[light]} className="size-full" />
        </div>
        <div ref={ref} className="relative mx-auto flex w-full max-w-[640px] flex-col items-center px-6 pb-10" style={{ paddingTop: `calc(${BAND} - 84px)` }}>
          <h1 className="mb-4 text-balance text-center font-heading font-semibold text-2xl tracking-tight [text-shadow:0_0_6px_var(--background),0_0_16px_var(--background)]">What should your agents work on?</h1>
          {/* Not focused on its own: the keyboard is the list's (j, k, ↵)
              until c or New task bring it here. */}
          <TaskComposer />
          <TeamSuggestCards />
          <ul aria-label="Inbox keys" className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12px] text-muted-foreground">
            {KEYS.map(([k, what]) => (
              <li key={k} className="flex items-center gap-1.5">
                <Kbd className="h-5 min-w-5 px-1 text-[11px]">{k}</Kbd>
                {what}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
