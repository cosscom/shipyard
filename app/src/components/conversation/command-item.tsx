import { ChevronDownIcon, CornerDownRightIcon, SlashIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { Markdown } from "@/components/conversation/markdown";
import { Button } from "@/components/ui/button";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// CommandItem is a command typed to the agent, as the chat shows it: what
// the person typed, and what the agent's program answered. A one-line
// answer reads as a system line ("/model → Set model to Opus 5.5"); a
// longer one (/context, a shell command's output) as a card; a command with
// no answer (a skill, a custom command) as what the person asked, like any
// prompt. /clear marks where a fresh conversation begins.

type Command = Extract<TranscriptItem, { kind: "command" }>;

const LONG = 14;

export function CommandItem({ it, who = "The agent" }: { it: Command; who?: string }) {
  const typed = it.command === "!" ? `!${it.args ?? ""}` : `${it.command}${it.args ? ` ${it.args}` : ""}`;
  const text = it.text?.trim() ?? "";

  if (it.command === "/clear" && !text) {
    return (
      <div className="cv-in flex items-center gap-3 py-1 text-muted-foreground text-meta">
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5">
          <span className="font-mono">/clear</span> · {who} started a fresh conversation
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // Asked of the agent, with nothing printed: the person's request.
  if (!text && it.command !== "!") {
    return (
      <div data-selectable className="cv-in max-w-[80%] self-end whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2">
        <span className="font-medium font-mono text-mono">{it.command}</span>
        {it.args ? ` ${it.args}` : ""}
      </div>
    );
  }

  // A short answer: one line under what was typed.
  if (!it.markdown && it.command !== "!" && !text.includes("\n") && text.length <= 140) {
    return (
      <div data-selectable className="cv-in flex min-w-0 items-baseline gap-2 text-muted-foreground text-desc">
        <SlashIcon className="size-3.5 shrink-0 translate-y-0.5" />
        <span className="shrink-0 font-mono text-foreground">{typed}</span>
        <CornerDownRightIcon className="size-3.5 shrink-0 translate-y-0.5 opacity-60" />
        <span className={cn("min-w-0", it.error && "text-destructive-foreground")}>{inlineCode(text)}</span>
      </div>
    );
  }

  return <OutputCard typed={typed} shell={it.command === "!"} text={text} markdown={it.markdown} error={it.error} />;
}

function OutputCard({ typed, shell, text, markdown, error }: { typed: string; shell: boolean; text: string; markdown?: boolean; error?: boolean }) {
  const lines = text ? text.split("\n").length : 0;
  const [open, setOpen] = useState(lines <= LONG);
  return (
    <div className="cv-in overflow-hidden rounded-lg border bg-muted/32">
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/48 px-3 py-1.5 text-meta">
        {shell ? <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <SlashIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span data-selectable className="min-w-0 truncate font-medium font-mono text-mono">
          {typed}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">{shell ? "Ran in the shell" : "The agent's own command"}</span>
      </div>
      <div className={cn("relative", !open && "max-h-56 overflow-hidden")}>
        {!text ? (
          <p className="px-3 py-2 text-muted-foreground text-meta">No output.</p>
        ) : markdown ? (
          <div data-selectable className="px-3.5 py-2.5 text-desc">
            <Markdown text={text} copy={false} />
          </div>
        ) : (
          <pre data-selectable className={cn("overflow-x-auto px-3 py-2 font-mono text-mono", error && "text-destructive-foreground")}>
            {text}
          </pre>
        )}
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background/90 to-transparent" />}
      </div>
      {!open && (
        <div className="border-t px-1.5 py-1">
          <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
            <ChevronDownIcon />
            Show all {lines} lines
          </Button>
        </div>
      )}
    </div>
  );
}

// inlineCode draws `quoted` words as code, as the agent's terminal does.
function inlineCode(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never move
      <code key={i} className="rounded bg-muted px-1 py-px font-mono text-mono text-foreground">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
