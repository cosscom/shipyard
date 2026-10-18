import { FileIcon, HistoryIcon, SlashIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { type AgentCommand, commandIn, KIND_LABEL, rankCommands, searchFiles, useCommandCatalog } from "@/lib/commands";
import { agentLabel } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// useComposerMenu gives a composer what the agent's own prompt has: "/" at
// the start lists its commands, skills and custom commands, fuzzy-matched,
// with what each is; "@" lists the worktree's files. ↑↓ move, Enter or Tab
// puts the pick in the text (sending stays the composer's), Esc closes. A
// prompt starting "!" or "#", or naming one of the agent's own commands,
// gets a chip saying what the agent does with it. What is typed is sent to
// the agent as typed.
//
// The composer wires it in: onKeyDown first (it says whether it took the
// key), onSelect for the caret, and places menu (over or under it) and chip.

export interface ComposerMenu {
  onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  onSelect(e: React.SyntheticEvent<HTMLTextAreaElement>): void;
  menu: ReactNode;
  chip: ReactNode;
  // The agent's own command the text starts with, when it is one.
  command?: AgentCommand;
}

type Trigger = { kind: "command"; query: string; start: number; end: number } | { kind: "file"; query: string; start: number; end: number };

// triggerAt is what the text asks for at the caret: a command ("/mo" at the
// very start, before any space) or a file ("@chec" after a space or at the
// start).
export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const tokenEnd = caret + (text.slice(caret).match(/^\S*/)?.[0].length ?? 0);
  const cmd = before.match(/^\/([^\s/]*)$/);
  if (cmd) return { kind: "command", query: cmd[1], start: 0, end: tokenEnd };
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) return { kind: "file", query: at[1], start: caret - at[1].length - 1, end: tokenEnd };
  return undefined;
}

export function useComposerMenu({ box, session, agent, text, setText, side = "top" }: { box?: string; session?: string; agent?: string; text: string; setText(t: string): void; side?: "top" | "bottom" }): ComposerMenu {
  const cat = useCommandCatalog(box, session);
  const client = useStore((s) => s.client);
  const el = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  // Closed with Esc: stays closed until the token changes.
  const [closed, setClosed] = useState<string>();
  const [files, setFiles] = useState<{ q: string; list: string[] }>();
  const pendingCaret = useRef<number | undefined>(undefined);

  const trigger = useMemo(() => {
    const t = triggerAt(text, Math.min(caret, text.length));
    if (!t || (t.kind === "command" && !cat)) return undefined;
    return t;
  }, [text, caret, cat]);
  const tkey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : undefined;
  const open = !!trigger && closed !== tkey;

  const commands = useMemo(() => (trigger?.kind === "command" && cat ? rankCommands(cat.commands, trigger.query) : []), [trigger, cat]);

  // Files are asked of the box as the query changes, a moment after typing.
  const fileQuery = open && trigger?.kind === "file" && box && session ? trigger.query : undefined;
  useEffect(() => {
    if (fileQuery === undefined || !box || !session) return;
    let alive = true;
    const t = window.setTimeout(() => {
      searchFiles(client, box, session, fileQuery)
        .then((list) => alive && setFiles({ q: fileQuery, list }))
        .catch(() => alive && setFiles({ q: fileQuery, list: [] }));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [fileQuery, client, box, session]);
  const fileList = trigger?.kind === "file" ? (files?.list ?? []) : [];
  const loadingFiles = trigger?.kind === "file" && files?.q !== trigger.query;
  const count = trigger?.kind === "command" ? commands.length : fileList.length;

  useEffect(() => setHi(0), [tkey]);
  // The caret after an insert, once the text is in.
  useEffect(() => {
    if (pendingCaret.current === undefined || !el.current) return;
    const at = pendingCaret.current;
    pendingCaret.current = undefined;
    el.current.focus();
    el.current.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);

  const insert = (value: string) => {
    if (!trigger) return;
    const next = `${text.slice(0, trigger.start)}${value} ${text.slice(trigger.end).replace(/^ /, "")}`;
    pendingCaret.current = trigger.start + value.length + 1;
    setText(next);
  };
  const pick = (i: number) => {
    if (trigger?.kind === "command" && commands[i]) insert(commands[i].name);
    else if (trigger?.kind === "file" && fileList[i]) insert(`@${fileList[i]}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    el.current = e.currentTarget;
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setClosed(tkey);
      return true;
    }
    if (!count) return false;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setHi((h) => (h + 1) % count);
      return true;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setHi((h) => (h - 1 + count) % count);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      // A command typed out in full goes as it is: Enter sends it.
      if (e.key === "Enter" && trigger?.kind === "command" && commands[hi]?.name === `/${trigger.query}`) return false;
      e.preventDefault();
      pick(hi);
      return true;
    }
    return false;
  };
  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    el.current = e.currentTarget;
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  const who = agent ? agentLabel(agent) : "The agent";
  const command = commandIn(cat, text);
  const menu = open ? (
    <MenuPanel side={side}>
      {trigger?.kind === "command" ? (
        commands.length ? (
          <OptionList count={commands.length} hi={hi} onHover={setHi} onPick={pick} label={`${who}'s commands`}>
            {(i) => <CommandRow c={commands[i]} active={i === hi} />}
          </OptionList>
        ) : (
          <MenuEmpty>No command matches /{trigger.query}. It is sent as typed.</MenuEmpty>
        )
      ) : fileList.length ? (
        <OptionList count={fileList.length} hi={hi} onHover={setHi} onPick={pick} label="Files in this worktree">
          {(i) => <FileRow path={fileList[i]} />}
        </OptionList>
      ) : loadingFiles ? (
        <MenuEmpty>
          <Spinner className="size-3.5" /> Looking through the worktree…
        </MenuEmpty>
      ) : (
        <MenuEmpty>No file matches @{trigger?.query}.</MenuEmpty>
      )}
      <MenuFooter kind={trigger?.kind ?? "command"} />
    </MenuPanel>
  ) : null;

  const chip = !open ? <PromptChip text={text} command={command} prefixes={cat?.prefixes} who={who} side={side} /> : null;
  return { onKeyDown, onSelect, menu, chip, command };
}

function MenuPanel({ side, children }: { side: "top" | "bottom"; children: ReactNode }) {
  return (
    <div
      // The composer keeps the keyboard: a click picks without taking it.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "absolute inset-x-0 z-30 flex max-h-[min(22rem,48vh)] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        side === "top" ? "bottom-full mb-2" : "top-full mt-2",
      )}
    >
      {children}
    </div>
  );
}

function OptionList({ count, hi, onHover, onPick, label, children }: { count: number; hi: number; onHover(i: number): void; onPick(i: number): void; label: string; children(i: number): ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  return (
    <div ref={list} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-1">
      <div className="px-2 pt-1 pb-1.5 text-muted-foreground text-label">{label}</div>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="option"
          aria-selected={i === hi}
          data-index={i}
          data-highlighted={i === hi ? "" : undefined}
          onMouseMove={() => i !== hi && onHover(i)}
          onClick={() => onPick(i)}
          className="flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1 text-body outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
        >
          {children(i)}
        </div>
      ))}
    </div>
  );
}

const KIND_BADGE: Record<AgentCommand["kind"], "outline" | "info" | "success" | "warning" | "secondary"> = { builtin: "outline", custom: "info", skill: "success", plugin: "warning", mcp: "secondary" };

function CommandRow({ c, active }: { c: AgentCommand; active: boolean }) {
  const alias = c.aliases?.length ? c.aliases.join(", ") : undefined;
  return (
    <>
      <span className="flex min-w-0 shrink-0 items-baseline gap-1.5 font-mono text-mono">
        <span className="font-medium">{c.name}</span>
        {c.args && <span className="text-muted-foreground">{c.args}</span>}
      </span>
      {/* The highlighted one reads in full, with where it comes from. */}
      <span className={cn("min-w-0 flex-1 text-muted-foreground text-meta", active ? "line-clamp-2" : "truncate")}>
        {c.description}
        {alias && <span className="text-muted-foreground/72"> · {alias}</span>}
        {active && c.source && <span className="text-muted-foreground/72"> · from {c.source}</span>}
      </span>
      <Badge variant={KIND_BADGE[c.kind]} size="sm" className="shrink-0">
        {KIND_LABEL[c.kind]}
      </Badge>
    </>
  );
}

function FileRow({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <>
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-mono">
        {cut >= 0 && <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>}
        <span className="font-medium">{path.slice(cut + 1)}</span>
      </span>
    </>
  );
}

function MenuEmpty({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-body">{children}</div>;
}

function MenuFooter({ kind }: { kind: "command" | "file" }) {
  return (
    <div className="flex items-center gap-3 border-t px-3 py-1.5 text-muted-foreground text-meta">
      <span className="flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> to move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↵</Kbd>
        <Kbd>Tab</Kbd> to insert
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Esc</Kbd> to close
      </span>
      <span className="ml-auto">{kind === "command" ? "Sent to the agent as typed" : "Mentioned by path"}</span>
    </div>
  );
}

// PromptChip says what the agent does with what is typed, when it is more
// than a prompt: a shell command, a "#" line, or one of its own commands.
// It floats (over the composer's top edge, or in its corner) and never
// moves or resizes the field.
function PromptChip({ text, command, prefixes, who, side }: { text: string; command?: AgentCommand; prefixes?: Record<string, string>; who: string; side: "top" | "bottom" }) {
  const t = text.trimStart();
  let icon = <SlashIcon />;
  let words: string | undefined;
  if (t.startsWith("!") && t.length > 1) {
    icon = <TerminalIcon />;
    words = prefixes?.["!"] ?? "Runs in the shell";
  } else if (t.startsWith("#") && t.length > 1) {
    words = prefixes?.["#"] ?? "Saves to memory";
    icon = <span className="font-mono text-tag">#</span>;
  } else if (command) {
    if (command.app) {
      icon = <HistoryIcon />;
      words = `${command.name} opens a list of ${who}'s past conversations to carry on here`;
    } else if (command.screen) {
      icon = <SquareTerminalIcon />;
      words = `${command.name} opens ${who}'s own screen: answer it in the terminal that opens below`;
    } else if (command.local) words = `${command.name} runs in ${who} itself: its output shows here`;
    else words = command.kind === "builtin" ? `${command.name}: ${command.description ?? "one of the agent's commands"}` : `${KIND_LABEL[command.kind]}${command.source ? ` from ${command.source}` : ""}: ${command.description ?? command.name}`;
  }
  if (!words) return null;
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-none absolute z-20 flex h-5 min-w-0 max-w-[min(72%,32rem)] items-center gap-1 rounded-full border bg-background px-2 text-tag text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0",
        // On the field's top edge, over its own padding and the gap above.
        side === "top" ? "top-0 right-3 -translate-y-1/2" : "right-2 bottom-2",
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate" title={words}>
        {words}
      </span>
    </div>
  );
}
