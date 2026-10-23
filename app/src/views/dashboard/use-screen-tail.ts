import { useEffect, useRef, useState } from "react";

import { boxApi, type Client, type Session } from "@/lib/api";
import { useEventLog } from "@/lib/events";
import { askIn, type Choice, meaningfulTail } from "@/lib/screen";
import { useStore } from "@/lib/store";

export { type Choice, meaningfulTail };

// useCardRead runs a card's read of a session: when the session's state
// changes or an event about it arrives (at most every 250ms), and every
// 20s while the agent works, since its output changes between events; it
// never polls harder than that. One read at a time, in one loop that
// events only prompt: one asked for meanwhile runs once it is in, so a
// busy agent's events never throw a read away. Disabled, it reads nothing.
export function useCardRead(box: string, session: Session, working: boolean, enabled: boolean, read: (client: Client, alive: () => boolean) => Promise<void>) {
  const client = useStore((s) => s.client);
  const reader = useRef(read);
  reader.current = read;
  const kick = useRef(() => {});
  const latest = useEventLog((s) => {
    if (!enabled) return undefined;
    const e = s.events.find((x) => x.box === box && (x.data?.path === session.dir || x.data?.name === session.name || x.data?.session === session.name));
    return e?.time;
  });

  useEffect(() => {
    if (!client || !enabled) return;
    let alive = true;
    let busy = false;
    let again = false;
    let soon = 0;
    const run = () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      void reader
        .current(client, () => alive)
        .catch(() => {})
        .finally(() => {
          busy = false;
          if (again) {
            again = false;
            run();
          }
        });
    };
    kick.current = () => {
      if (!soon)
        soon = window.setTimeout(() => {
          soon = 0;
          run();
        }, 250);
    };
    const every = working ? window.setInterval(run, 20_000) : 0;
    return () => {
      alive = false;
      kick.current = () => {};
      window.clearTimeout(soon);
      window.clearInterval(every);
    };
  }, [client, box, session.name, working, enabled]);

  // A change to the session, or an event about it: read, in the loop.
  useEffect(() => kick.current(), [client, box, session.name, session.agent_state, session.state_since, latest, working, enabled]);
}

// useScreenTail is the last few meaningful lines of a session's screen.
export function useScreenTail(box: string, session: Session, count = 3, working = false, enabled = true): { tail?: string[]; choices: Choice[] } {
  const [tail, setTail] = useState<string[]>();
  const [choices, setChoices] = useState<Choice[]>([]);
  useCardRead(box, session, working, enabled, (client, alive) =>
    boxApi.screen(client, box, session.name).then((r) => {
      if (!alive()) return;
      setTail(meaningfulTail(r.screen ?? "", count));
      // Options its own menu shows, never a list in its last message.
      setChoices(askIn(r.screen ?? "").choices);
    }),
  );
  return { tail, choices };
}
