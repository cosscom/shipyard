import { CornerDownLeftIcon } from "lucide-react";
import { memo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { boxApi } from "@/lib/api";
import { agentLabel } from "@/lib/derive";
import type { InboxItem } from "@/lib/inbox";
import { permissionChoices } from "@/lib/screen";
import { sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { useAsk } from "@/lib/transcript-feed";
import { cn } from "@/lib/utils";
import { QUESTION_TOOLS, useLiveStep } from "@/views/home/widgets/agents";
import { shortAgo } from "@/views/home/widgets/parts";

// One row of the inbox: the agent (its icon in a ring of its state, as the
// rail draws it), what the work is called and how long it has been so,
// where it is (the box only when its project is on more than one), and one
// calm line of what it asks or is doing. A waiting agent's Allow and Deny
// are on the row; the rest opens the worktree.

export interface RowProps {
  it: InboxItem;
  cursor: boolean;
  open: boolean;
  done: boolean;
  live: boolean;
  onOpen(it: InboxItem): void;
  onDone(it: InboxItem): void;
  onFocus(it: InboxItem): void;
}

function Ring({ state }: { state: InboxItem["state"] }) {
  const base = "pointer-events-none absolute -inset-[3px] rounded-full";
  if (state === "running") return <span aria-hidden className={cn(base, "animate-spin border-2 border-info border-t-transparent border-r-transparent [animation-duration:1.4s] motion-reduce:animate-none")} />;
  if (state === "waiting") return <span aria-hidden className={cn(base, "border-2 border-warning")} />;
  if (state === "finished") return <span aria-hidden className={cn(base, "border-[1.5px] border-success/75")} />;
  return <span aria-hidden className={cn(base, "border-[1.5px] border-muted-foreground/45")} />;
}

// Where it is: the project, and the worktree unless the title is already
// it; a main checkout says so rather than repeat the project's name.
// A key a button answers to, small and quiet on it.
const Key = ({ children }: { children: string }) => <span className="-mr-0.5 rounded-[3px] bg-current/12 px-1 font-mono text-[10px] leading-3.5 opacity-70">{children}</span>;

const place = (it: InboxItem) => {
  if (it.main) return it.title === it.project ? "main checkout" : `${it.project} › main`;
  return it.worktree && it.worktree !== it.title ? `${it.project} › ${it.worktree}` : it.project;
};

// short is a one-line row's place: the worktree alone, or the project.
const short = (it: InboxItem) => (it.main ? (it.title === it.project ? "main" : `${it.project} › main`) : it.worktree && it.worktree !== it.title ? it.worktree : it.project);

export const InboxRow = memo(function InboxRow({ it, cursor, open, done, live, onOpen, onDone, onFocus }: RowProps) {
  const s = it.session;
  const waiting = it.state === "waiting";
  const tool = s.ask?.tool;
  const question = !tool || QUESTION_TOOLS.test(tool);
  // A waiting agent's options are on its screen; a working one's step too.
  const ask = useAsk(it.box, s.name, live && waiting && !question, s.state_since);
  const step = useLiveStep(it.box, s.name, it.agent, live && it.state === "running");
  const client = useStore((st) => st.client);
  const choices = ask && !ask.form ? permissionChoices(ask.choices) : undefined;
  const allow = choices?.find((c) => c.label === "Allow");
  const deny = choices?.find((c) => c.label === "Deny");
  const [sent, setSent] = useState<{ at?: string; label: string }>();
  const answered = sent && sent.at === s.state_since ? sent.label : undefined;

  const answer = (key: string, label: string) => {
    if (!client) return;
    setSent({ at: s.state_since, label });
    boxApi.send(client, it.box, s.name, key, false, { when: "now", force: true }).catch((err) => {
      setSent(undefined);
      toastError(err, { title: "Couldn't answer", box: it.box });
    });
  };

  // The one calm line: what it asks, what it is doing, or nothing.
  let line: string | undefined;
  let mono = false;
  if (waiting) {
    if (tool && !question) {
      line = [tool === "Bash" ? "" : tool, s.ask?.input].filter(Boolean).join(" ") || "Wants permission";
      mono = true;
    } else line = s.ask?.message || ask?.detail || (question ? "Asks you a question" : "Waiting for you");
  }
  // A working agent's step shares the place's line, so the row stays two.
  const doing = it.state === "running" ? step?.now : undefined;
  // A command with Allow beside it is never cut short: three lines on any
  // row, all of it under the cursor. Nothing is allowed unread.
  const full = cursor && waiting && mono;
  const wrap = waiting && mono;
  const compact = it.section === "recent";

  const when = it.state === "running" && step?.elapsed ? step.elapsed : shortAgo(it.since);
  const words = `${agentLabel(it.agent)} in ${place(it)}${it.boxMatters ? ` on ${it.box}` : ""}: ${it.title}. ${sessionWord(it.state)}${line ? `. ${line}` : ""}${doing ? `. ${doing}` : ""}`;

  return (
    <li
      className={cn(
        "group/row relative rounded-lg transition-colors hover:bg-sidebar-accent/50",
        // Open: filled, with the bar. Cursor: an outline, while the list has
        // the keyboard. They never look alike.
        open && "bg-sidebar-accent hover:bg-sidebar-accent",
        cursor && "focus-within:shadow-[inset_0_0_0_1.5px_var(--ring)]",
        done && "opacity-55",
      )}
      data-testid="inbox-row" data-id={it.id} data-state={it.state} data-cursor={cursor || undefined} data-open={open || undefined}>
      {/* The worktree on screen: a bar at the list's edge. */}
      {open && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-r-full bg-primary" />}
      <button
        type="button"
        data-inbox-row={it.id}
        tabIndex={cursor ? 0 : -1}
        aria-label={words}
        aria-current={open || undefined}
        onFocus={() => onFocus(it)}
        onClick={() => onOpen(it)}
        onKeyDown={(e) => {
          // y and n answer the ask under the cursor, as its buttons say.
          if (e.metaKey || e.ctrlKey || e.altKey || answered || !allow || !deny) return;
          if (e.key === "y" || e.key === "n") {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "y") answer(allow.key, "Allow");
            else answer(deny.key, "Deny");
          }
        }}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 text-left outline-none",
          compact ? "gap-[17px] py-1 pl-[12px]" : "py-1.5",
        )}
      >
        {compact ? (
          // Recent: one line each, so many fit (title, place, age).
          <>
            <span className="relative mt-[3px] inline-flex size-4 shrink-0 items-center justify-center">
              <AgentIcon agent={it.agent} className="size-2.5" />
              <Ring state={it.state} />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
              <span className={cn("min-w-0 shrink truncate", open ? "font-medium text-foreground" : "text-foreground/85")}>{it.title}</span>
              <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground @max-[330px]/side:hidden">{short(it)}</span>
              <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">{when}</span>
            </span>
          </>
        ) : (
          <>
            <span className={cn("relative mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent", waiting && "bg-warning/12", open && "bg-background/70")}>
              <AgentIcon agent={it.agent} className="size-3" />
              <Ring state={it.state} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground leading-5">{it.title}</span>
                <span className={cn("shrink-0 text-[11px] tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0", waiting ? "text-warning-foreground" : "text-muted-foreground")}>{when}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground leading-4">
                <span className={cn("min-w-0", doing ? "max-w-[55%] shrink-0 truncate" : "truncate")}>{place(it)}</span>
                {it.boxMatters && <span className="shrink-0 rounded-[4px] bg-muted px-1 font-mono text-[10px] text-muted-foreground leading-4">{it.box}</span>}
                {doing && <span className="min-w-0 flex-1 truncate font-mono text-[11px]">· {doing}</span>}
              </span>
              {line && (
                <span className={cn("min-w-0 leading-4", full ? "whitespace-pre-wrap break-all" : wrap ? "line-clamp-3 break-all" : "truncate", mono ? "font-mono text-[11px]" : "text-[12px]", waiting ? "text-foreground/80" : "text-muted-foreground")}>{line}</span>
              )}
            </span>
          </>
        )}
      </button>

      {/* Hover and cursor: clear it away (e), or bring it back. */}
      <span className={cn("absolute right-1.5 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100", compact ? "top-1" : "top-1.5")}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={done ? `Back to the inbox: ${it.title}` : `Clear: ${it.title}`}
          onClick={() => onDone(it)}
          className="inline-flex h-5 items-center gap-1 rounded-md border border-sidebar-border bg-sidebar px-1.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
        >
          {done ? "Back" : "Clear"}
          <Key>e</Key>
        </button>
      </span>
      {waiting && (answered || (allow && deny) || cursor) && (
        <span className="-mt-1 flex items-center justify-end gap-1 pr-2 pb-2 pl-[42px]">
          {answered ? (
            <span className="text-[11px] text-muted-foreground">{answered === "Deny" ? "Denied" : "Allowed"} · resuming</span>
          ) : allow && deny ? (
            <>
              <Button size="xs" variant="outline" className="h-6 rounded-md px-2 text-[11px]" onClick={() => answer(deny.key, "Deny")} aria-label={`Deny: ${it.title}`} aria-keyshortcuts={cursor ? "n" : undefined}>
                Deny
                {cursor && <Key>n</Key>}
              </Button>
              <Button size="xs" className="h-6 rounded-md px-2 text-[11px]" onClick={() => answer(allow.key, "Allow")} aria-label={`Allow once: ${it.title}`} aria-keyshortcuts={cursor ? "y" : undefined}>
                Allow once
                {cursor && <Key>y</Key>}
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" className="h-6 rounded-md px-2 text-[11px]" onClick={() => onOpen(it)} aria-label={`Answer: ${it.title}`}>
              Answer
              <CornerDownLeftIcon className="size-3" />
            </Button>
          )}
        </span>
      )}
    </li>
  );
});
