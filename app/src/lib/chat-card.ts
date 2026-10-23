import type { Ask } from "@/lib/api";
import type { Choice } from "@/lib/screen";
import type { TranscriptItem } from "@/lib/transcript";

// What a board card shows of an agent that runs in chat (structured): its
// pane holds only the host that runs it, never a screen of the agent's own,
// so the card reads the agent's ask and its conversation instead. Pure, so
// the card and its tests share it.

// A question's tools: answered in the agent's own form, not with Allow or
// Deny, so a card shows what they ask rather than a command.
export const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;

// chatCard is the card's box: what it asks while it waits, with the answers
// it offers; otherwise the last lines of its newest reply, or the step it
// took since. Undefined hides the box: nothing asked, nothing said yet.
export function chatCard(ask: Ask | undefined, waiting: boolean, items: TranscriptItem[] | undefined, count = 3): { tail: string[]; choices: Choice[] } | undefined {
  if (asksIn(ask, waiting)) return { tail: askLines(ask, count), choices: ask.choices ?? [] };
  const tail = latestLines(items ?? [], count);
  return tail.length ? { tail, choices: [] } : undefined;
}

// asksIn says the card shows the ask, and so needs nothing of its
// conversation.
export function asksIn(ask: Ask | undefined, waiting: boolean): ask is Ask {
  return waiting && !!ask && !!(ask.tool || ask.input || ask.message);
}

// openingPrompt is what a conversation was started with: its first prompt,
// or the command typed as one ("/ship ACME-12"). items are a page from
// its start; more says the start is before them, so it isn't there.
export function openingPrompt(items: TranscriptItem[] | undefined, more?: boolean): string | undefined {
  if (more) return undefined;
  const first = items?.find((it) => it.kind === "user" || it.kind === "command");
  const text = first?.kind === "user" ? first.text : first?.kind === "command" ? [first.command, first.args].filter(Boolean).join(" ") : "";
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
}

// The most of an opening prompt a card quotes: one line it truncates, and
// a pasted page's whole text is no use there.
const PROMPT_MAX = 200;

// mergeTail is a card's newest items after a read of what was added since
// the last: items read again (a tool group still open) replace their old
// selves, new ones go after, and only the last max are kept.
export function mergeTail(held: TranscriptItem[], read: TranscriptItem[], max: number): TranscriptItem[] {
  const again = new Map(read.map((it) => [it.id, it]));
  const have = new Set(held.map((it) => it.id));
  return [...held.map((it) => again.get(it.id) ?? it), ...read.filter((it) => !have.has(it.id))].slice(-max);
}

// askLines is a wait in words: a permission's reason and the command or
// file it is for; a question's first lines, or the message it showed.
function askLines({ tool, input, why, message }: Ask, count: number): string[] {
  if (!tool || QUESTION_TOOLS.test(tool)) return plainLines(input || message || (tool ? "Asks you a question" : "Waiting for you")).slice(0, count);
  const what = !input ? tool : tool === "Bash" ? `$ ${input}` : `${tool} ${input}`;
  const reason = why && plainLines(why)[0];
  return reason ? [reason, what] : [what];
}

// latestLines reads back from the newest item to the last thing the agent
// said or did in this turn. A prompt after it starts another turn, which
// has nothing to show yet.
function latestLines(items: TranscriptItem[], count: number): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    switch (it.kind) {
      case "user":
      case "report":
      case "agent-message":
        return [];
      case "text": {
        const lines = plainLines(it.text);
        if (lines.length) return lines.slice(-count);
        break;
      }
      case "tools":
        return it.items?.length ? it.items.slice(-count).map((c) => `${c.verb} ${c.target}`.trim()) : [it.verb];
      case "edit":
        return [`Edit ${it.file} +${it.added} −${it.removed}`];
      case "notice":
        return plainLines(it.text).slice(0, count);
    }
  }
  return [];
}

// plainLines is Markdown as a card's few lines: no blank lines, fences,
// table rules or emphasis marks.
function plainLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/\*\*|__/g, "")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .filter((l) => l && !/^(```|~~~)/.test(l) && !(l.includes("|") && /^[\s:|-]+$/.test(l)) && !/^([-*_])(\s*\1){2,}$/.test(l));
}

// shownPrompt is the prompt a card quotes, unless it only repeats the
// title (titles are a prompt's first words, cut with an ellipsis).
export function shownPrompt(prompt: string | undefined, title: string | undefined): string | undefined {
  const p = prompt?.replace(/\s+/g, " ").trim();
  if (!p || (title && p.startsWith(title.replace(/…$/, "")))) return undefined;
  return p;
}
