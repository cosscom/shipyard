import { useEffect, useRef } from "react";

import { useActiveTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

// CommandLog shows a running command's output as a terminal would, in the
// theme's terminal colors, keeping the newest line in view.
export function CommandLog({ lines, error, done, className }: { lines: string[]; error?: string; done?: boolean; className?: string }) {
  const t = useActiveTheme().terminal;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length, error, done]);
  return (
    <div className={cn("max-h-64 overflow-y-auto rounded-lg border px-3 py-2.5 font-mono text-mono", className)} style={{ background: t.background, color: t.foreground }}>
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap opacity-85 [overflow-wrap:anywhere]">
          {l || " "}
        </div>
      ))}
      {!done && !error && <span className="mt-0.5 inline-block h-3 w-1.5 animate-pulse align-middle" style={{ background: t.cursor }} />}
      {error && (
        <div className="mt-1 whitespace-pre-wrap" style={{ color: t.red }}>
          ✕ {error}
        </div>
      )}
      {done && !error && (
        <div className="mt-1" style={{ color: t.green }}>
          ✓ Done
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
