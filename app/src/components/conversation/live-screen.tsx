import { ChevronDownIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/components/workspace/terminal-view";
import { boxApi } from "@/lib/api";
import { agentLabel } from "@/lib/derive";
import { screenAt } from "@/lib/screen";
import { useStore } from "@/lib/store";

// When an agent's screen shows something the chat can't draw (/model's
// picker, /config, /resume, a login or trust dialog: anything its own
// program asks with keys rather than a question its hooks describe), the
// chat opens its live terminal right there, attached to the same session,
// so the person answers it in place. It folds back into the conversation
// once the agent is at its prompt again.
//
// useLiveScreen reads the screen while the pane is shown and the agent has
// no question its hooks describe: every 2.5s, every second for a while after a command was
// sent (nudge) and while the terminal is open. A screen counts as its own
// once its foot has key hints or numbered options and no prompt
// (lib/screen screenAt), or shows no prompt twice in a row; the prompt seen
// twice in a row folds it away.

export function useLiveScreen({ box, session, agent, enabled, running, nudge }: { box: string; session: string; agent?: string; enabled: boolean; running: boolean; nudge: number }): { show: boolean; hide(): void } {
  const client = useStore((s) => s.client);
  const [show, setShow] = useState(false);
  // Hidden by the person: stays hidden until the agent is at its prompt.
  const [hidden, setHidden] = useState(false);
  const showing = useRef(false);
  showing.current = show && !hidden;
  const nudgedAt = useRef(0);
  const busy = useRef(running);
  busy.current = running;
  useEffect(() => {
    if (nudge) nudgedAt.current = Date.now();
  }, [nudge]);

  useEffect(() => {
    if (!client || !enabled) {
      setShow(false);
      return;
    }
    let alive = true;
    let timer = 0;
    let atPrompt = 0;
    let unsure = 0;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await boxApi.screen(client, box, session);
          if (!alive) return;
          const at = screenAt(agent, r.screen ?? "");
          // An agent at rest always shows its prompt: a screen without it,
          // read twice, is one of its own too (a tall dialog whose key hints
          // are scrolled off, such as /usage).
          // Mid-turn the screen moves on its own: only key hints or options
          // count then (a startup prompt the box takes for work).
          if (at === "interactive" || (at === "unknown" && !busy.current && ++unsure >= 2)) {
            atPrompt = 0;
            setShow(true);
          } else if (at === "prompt") {
            unsure = 0;
            if (++atPrompt >= 2) {
              setShow(false);
              setHidden(false);
            }
          }
        } catch {
          // The pane says when the box is away; nothing to add here.
        }
      }
      if (!alive) return;
      const quick = showing.current || Date.now() - nudgedAt.current < 15_000;
      timer = window.setTimeout(() => void tick(), quick ? 1000 : 2500);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [client, enabled, box, session, agent, nudge]);

  return { show: show && !hidden && enabled, hide: () => setHidden(true) };
}

// LiveScreen is that terminal: a compact pane under the conversation with
// what it is for, a way to fold it, and the full terminal one click away.
// It attaches while shown and detaches when it folds, so there is at most
// one per pane and none while hidden.
export function LiveScreen({ box, session, agent, onHide, onShowTerminal }: { box: string; session: string; agent?: string; onHide(): void; onShowTerminal(): void }) {
  const who = agent ? agentLabel(agent) : "The agent";
  const host = useRef<HTMLDivElement>(null);
  // It is there to be answered: the keyboard goes to it, not the reply box.
  useEffect(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && !host.current?.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) a.blur();
  }, []);
  return (
    <section ref={host} aria-label={`${who}'s own screen`} className="cv-in mb-2 overflow-hidden rounded-lg border bg-card shadow-lg/5">
      <header className="flex min-w-0 items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
        <AgentIcon agent={agent} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-desc">{who} is showing its own screen — answer it here</span>
        <Tip label="Open its terminal">
          <Button size="icon-xs" variant="ghost" aria-label="Open its terminal" onClick={onShowTerminal}>
            <SquareTerminalIcon />
          </Button>
        </Tip>
        <Tip label="Fold it away">
          <Button size="icon-xs" variant="ghost" aria-label="Fold it away" onClick={onHide}>
            <ChevronDownIcon />
          </Button>
        </Tip>
      </header>
      <div className="flex h-[min(440px,54vh)] min-h-[240px] flex-col">
        <TerminalView box={box} session={session} agent={agent} wsKey="" tab="" pane={`live:${session}`} visible focused onFocus={() => {}} onClose={onHide} />
      </div>
      <footer className="truncate border-t px-3 py-1.5 text-muted-foreground text-meta">Keys go straight to {who} (Esc backs out). This folds away once it is at its prompt.</footer>
    </section>
  );
}
