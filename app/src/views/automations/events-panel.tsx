import { ActivityIcon, PanelRightCloseIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { FilterChip } from "@/components/filter-chip";
import { Button } from "@/components/ui/button";
import type { BerthEvent } from "@/lib/api";
import { useEventLog } from "@/lib/events";
import { cn } from "@/lib/utils";

const PREFIXES = ["agent", "worktree", "session", "task", "box", "hooks"];

// EventsPanel shows events as they arrive, which is what writing a hook
// needs: the exact type and the data it carries.
export function EventsPanel({ onClose, onNewHook }: { onClose(): void; onNewHook(e: BerthEvent): void }) {
  const events = useEventLog((s) => s.events);
  // Types to narrow to; none on means every event.
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const shown = prefixes.length ? events.filter((e) => prefixes.some((p) => e.type.startsWith(`${p}.`))) : events;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l bg-sidebar/40">
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <ActivityIcon className="size-3.5 text-muted-foreground" />
        <h2 className="text-section">Live events</h2>
        <span className="text-meta text-muted-foreground tabular-nums">{events.length}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Hide events" onClick={onClose}>
          <PanelRightCloseIcon />
        </Button>
      </header>
      {/* Wraps rather than scrolls: a hidden scrollbar read as chips cut off. */}
      <div className="flex flex-wrap gap-1 px-3 pb-2" role="group" aria-label="Show only">
        {PREFIXES.map((p) => (
          <FilterChip key={p} className="font-mono text-tag" pressed={prefixes.includes(p)} onPressedChange={(on) => setPrefixes((ps) => (on ? [...ps, p] : ps.filter((x) => x !== p)))}>
            {p}.*
          </FilterChip>
        ))}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto border-t">
        {shown.length === 0 ? (
          <li className="px-3 py-4 text-meta text-muted-foreground">Nothing yet. Events from this laptop and every box appear here as they happen.</li>
        ) : (
          shown.map((e, i) => <EventRow key={`${e.time}-${e.type}-${i}`} e={e} onNewHook={() => onNewHook(e)} />)
        )}
      </ol>
    </aside>
  );
}

function EventRow({ e, onNewHook }: { e: BerthEvent; onNewHook(): void }) {
  const [open, setOpen] = useState(false);
  const data = e.data && Object.keys(e.data).length > 0 ? e.data : undefined;
  return (
    <li className="border-b border-border/60">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent/40">
        <span className="shrink-0 font-mono text-tag text-muted-foreground tabular-nums">{new Date(e.time).toLocaleTimeString([], { hour12: false })}</span>
        <span className={cn("min-w-0 flex-1 truncate font-mono text-meta", e.error && "text-destructive-foreground")}>{e.type}</span>
        <span className="shrink-0 truncate text-meta text-muted-foreground">{[e.box, e.origin && e.origin !== "berth" && `via ${e.origin}`].filter(Boolean).join(" · ")}</span>
      </button>
      {open && (
        <div className="mx-3 mb-2 space-y-1.5">
          <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-mono text-muted-foreground">{JSON.stringify({ type: e.type, box: e.box, origin: e.origin, error: e.error, data }, null, 2)}</pre>
          <Button size="xs" variant="outline" onClick={onNewHook}>
            <PlusIcon />
            New hook for this event
          </Button>
        </div>
      )}
    </li>
  );
}

// EventsRail is the panel collapsed: still there, with a live count.
export function EventsRail({ onOpen }: { onOpen(): void }) {
  const count = useEventLog((s) => s.events.length);
  return (
    <button type="button" onClick={onOpen} aria-label="Show live events" className="flex w-9 shrink-0 flex-col items-center gap-1.5 border-l bg-sidebar/40 pt-3 text-muted-foreground hover:text-foreground">
      <ActivityIcon className="size-4" />
      <span className="font-mono text-tag tabular-nums">{count}</span>
    </button>
  );
}
