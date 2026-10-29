import { useEffect, useRef, useState } from "react";

import { boxApi } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { ErrorText } from "@/components/error-note";

interface Props {
  box: string;
  location: string;
  worktree: string;
  service: string;
  visible: boolean;
}

// LogView tails a worktree service's log: read-only, refreshed every two
// seconds while shown, and kept at the bottom unless scrolled up.
export function LogView({ box, location, worktree, service, visible }: Props) {
  const client = useStore((s) => s.client);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (!client || !visible) return;
    let stopped = false;
    const load = async () => {
      try {
        const t = await boxApi.serviceLog(client, box, location, worktree, service);
        if (stopped) return;
        setText(t);
        setError(undefined);
      } catch (err) {
        if (!stopped) setError(plainError(err));
      }
    };
    void load();
    const timer = window.setInterval(() => !document.hidden && void load(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [client, visible, box, location, worktree, service]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-pane">
      {error && <ErrorText className="border-b px-3 py-1.5 text-destructive text-meta" text={error} />}
      <pre
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-mono text-foreground/90 select-text"
      >
        {text || <span className="text-muted-foreground">Nothing logged yet.</span>}
      </pre>
    </div>
  );
}
