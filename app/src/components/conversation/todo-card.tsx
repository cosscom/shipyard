import { CheckIcon, ChevronDownIcon, ListChecksIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { ChatTodo } from "@/lib/chat-controls";
import { cn } from "@/lib/utils";

// TodoCard is the agent's task list (Claude's TodoWrite and TaskCreate,
// Codex's plan) as a live checklist docked above the reply box: counts and
// what it is doing now when folded, every task when open. It updates in
// place as the agent ticks tasks off; a list all done can be put away until
// the agent starts another.

const seen = new Map<string, boolean>();

export function TodoCard({ todos, session, working }: { todos: ChatTodo[]; session: string; working: boolean }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const all = done === todos.length;
  // The list's identity: a new list (other tasks) shows again even after the
  // last one was put away.
  const sig = useMemo(() => `${session}|${todos.map((t) => t.text).join("\n")}`, [session, todos]);
  const [dismissed, setDismissed] = useState(() => seen.get(sig) ?? false);
  // Open while it works through the list; folded once it is all done.
  const [open, setOpen] = useState(!all);
  useEffect(() => {
    setDismissed(seen.get(sig) ?? false);
  }, [sig]);
  useEffect(() => {
    if (all) setOpen(false);
  }, [all]);
  if (!todos.length || dismissed) return null;
  const pct = Math.round((done / todos.length) * 100);
  return (
    <section role="group" aria-label="Tasks" data-todos className="mb-2 overflow-hidden rounded-lg border bg-card shadow-xs/5 vibrancy:bg-foreground/4 vibrancy:shadow-none">
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-my-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListChecksIcon className={cn("size-3.5 shrink-0", all ? "text-success" : "text-muted-foreground")} aria-hidden />
          <span className="shrink-0 font-medium text-desc">{all ? "All tasks done" : "Tasks"}</span>
          <span className="shrink-0 text-muted-foreground text-meta tabular-nums">
            {done} of {todos.length}
          </span>
          <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className={cn("block h-full rounded-full transition-[width] duration-500", all ? "bg-success" : "bg-foreground/70")} style={{ width: `${pct}%` }} />
          </span>
          {!open && active && (
            <span className={cn("min-w-0 truncate text-muted-foreground text-meta", working && "cv-shimmer")}>{active.active || active.text}</span>
          )}
          <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
        {all && (
          <button
            type="button"
            aria-label="Put the task list away"
            onClick={() => {
              seen.set(sig, true);
              setDismissed(true);
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="cv-fold" data-closed={open ? undefined : ""}>
        <div>
          <ol className="max-h-52 overflow-y-auto border-t px-3 py-2">
            {todos.map((t, i) => (
              <li key={t.id ?? i} className="flex items-start gap-2.5 py-1 text-desc">
                <Glyph status={t.status} working={working} />
                <span className={cn("min-w-0 flex-1", t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40", t.status === "in_progress" && "font-medium text-foreground", t.status === "pending" && "text-foreground")}>
                  {t.status === "in_progress" && t.active ? t.active : t.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function Glyph({ status, working }: { status: ChatTodo["status"]; working: boolean }) {
  if (status === "completed")
    return (
      <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success" role="img" aria-label="Done">
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="mt-px flex size-4 shrink-0 items-center justify-center" role="img" aria-label="In progress">
        {working ? <Spinner className="size-3.5" /> : <span className="size-2 rounded-full bg-foreground/70" />}
      </span>
    );
  return <span className="mt-px size-4 shrink-0 rounded-full border border-muted-foreground/40 border-dashed" role="img" aria-label="To do" />;
}
