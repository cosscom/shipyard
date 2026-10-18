import { ArrowUpRightIcon, BellIcon, BotIcon, CheckIcon, ChevronDownIcon, CircleXIcon, CogIcon, CornerDownLeftIcon, CrownIcon, FileTextIcon, InfoIcon, type LucideIcon, MegaphoneIcon, MessageCircleQuestionIcon, OctagonPauseIcon, ReplyIcon, SquareTerminalIcon } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";

import { Markdown } from "@/components/conversation/markdown";
import { PromptActionsContext } from "@/components/conversation/prompt-actions";
import { openHelper } from "@/components/conversation/subagent-view";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { toastManager } from "@/components/ui/toast";
import { lineCount, type MessageItem, needsYou, overScreen, type PingItem, SENDER_WORD, senderColor } from "@/lib/agent-messages";
import { quoted, quoteInto } from "@/lib/chat-quote";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { PaneContext } from "@/lib/pane-context";
import { useStore } from "@/lib/store";
import type { AgentMessage, MessageSender } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { openSession } from "@/lib/workspaces";
import "@/components/conversation/agent-message.css";

// A message to the agent from someone other than the person: a helper's
// hand-back, a teammate, another session, the lead, or Claude Code's own
// ping about a background task (internal/transcript/peer.go). Each is a
// card beside Shipyard's report cards (report-card): who sent it and what kind
// it is in the head, its gist under it, and the whole report a click away,
// drawn as the agent wrote it. Left-aligned and bordered, so nobody takes
// it for something they typed. Pings are one line.

const Dot = () => (
  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
    ·
  </span>
);

function initials(name: string) {
  const w = name.replace(/[^\p{L}\p{N} _-]/gu, "").split(/[\s_-]+/).filter(Boolean);
  return ((w[0]?.[0] ?? "?") + (w[1]?.[0] ?? "")).toUpperCase();
}

// Avatar is a sender's mark in its colour: a bot for a helper, initials for
// a teammate, a crown for the lead, a terminal for another session, a cog
// for Claude Code.
export function Avatar({ from, color, className }: { from: MessageSender; color: string; className?: string }) {
  const Icon = from.kind === "lead" ? CrownIcon : from.kind === "session" ? SquareTerminalIcon : from.kind === "harness" ? CogIcon : BotIcon;
  return (
    <span aria-hidden data-avatar={color} className={cn(`am-c-${color} am-avatar inline-flex size-5 shrink-0 items-center justify-center rounded-md font-semibold text-tag`, className)}>
      {from.kind === "teammate" ? initials(from.name) : <Icon className="size-3" />}
    </span>
  );
}

// BerthAvatar is Shipyard's own mark, for its reports.
export function BerthAvatar() {
  return (
    <span aria-hidden className="am-c-slate am-avatar inline-flex size-5 shrink-0 items-center justify-center rounded-md">
      <svg viewBox="0 0 512 512" className="size-3">
        <path d="M88 96H424Q410 300 256 350Q102 300 88 96Z" fill="none" stroke="currentColor" strokeWidth="60" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="138" y="404" width="58" height="44" rx="9" fill="currentColor" />
        <rect x="227" y="404" width="58" height="44" rx="9" fill="currentColor" />
        <rect x="316" y="404" width="58" height="44" rx="9" fill="currentColor" />
        <circle cx="256" cy="190" r="30" fill="#f5a524" />
      </svg>
    </span>
  );
}

export type ChipTone = "plain" | "ask" | "bad" | "lead" | "good";
export interface Chip {
  word: string;
  Icon: LucideIcon;
  tone: ChipTone;
}

export function chipOf(m: AgentMessage): Chip {
  if (m.status === "failed") return { word: "Failed", Icon: CircleXIcon, tone: "bad" };
  if (m.status === "stopped") return { word: "Stopped", Icon: OctagonPauseIcon, tone: "bad" };
  switch (m.intent) {
    case "question":
      return { word: "Question", Icon: MessageCircleQuestionIcon, tone: "ask" };
    case "instruction":
      return { word: "Instruction", Icon: MegaphoneIcon, tone: "lead" };
    case "update":
      return { word: "Update", Icon: InfoIcon, tone: "plain" };
    default:
      return { word: "Report", Icon: FileTextIcon, tone: "plain" };
  }
}

export function KindChip({ chip, className }: { chip: Chip; className?: string }) {
  return (
    <span
      data-chip={chip.word}
      className={cn(
        "inline-flex h-[1.125rem] shrink-0 items-center gap-1 rounded-[0.3125rem] border px-1.5 font-medium text-tag leading-none",
        chip.tone === "plain" && "border-border bg-muted/60 text-muted-foreground",
        chip.tone === "good" && "border-success/30 bg-success/8 text-success-foreground",
        chip.tone === "ask" && "border-warning/35 bg-warning/10 text-warning-foreground",
        chip.tone === "bad" && "border-destructive/30 bg-destructive/8 text-destructive-foreground",
        chip.tone === "lead" && "am-c-orange am-chip-tint",
        className,
      )}
    >
      <chip.Icon className="size-3" aria-hidden />
      {chip.word}
    </span>
  );
}

// CardHead is the head every card to the agent shares, Shipyard's reports
// included: avatar, name, what kind of sender, a kind chip, what else it
// says (a diff, a count), the time it took, "to Claude" and Open.
export function CardHead({ avatar, name, kind, chip, extra, took, tip, open }: { avatar: ReactNode; name: string; kind?: string; chip: Chip; extra?: ReactNode; took?: string; tip: string; open?: ReactNode }) {
  const ctx = useContext(PromptActionsContext);
  const who = ctx?.who && ctx.who !== "The agent" ? ctx.who : "Claude";
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-1.5 py-1 pr-1 pl-2">
      {avatar}
      <span className="ml-0.5 min-w-0 shrink truncate font-medium" data-card-name>
        {name}
      </span>
      {kind && <span className="hidden shrink-0 text-muted-foreground text-meta @[420px]:inline">{kind}</span>}
      <KindChip chip={chip} className="ml-1" />
      {extra}
      {took && (
        <span className="hidden shrink-0 items-center gap-1.5 text-muted-foreground text-meta tabular-nums @[520px]:inline-flex">
          <Dot />
          {took}
        </span>
      )}
      <Tip label={tip}>
        <span data-to-agent className="ml-auto inline-flex shrink-0 items-center gap-1 pl-2 text-meta text-muted-foreground">
          <CornerDownLeftIcon className="size-3" aria-hidden />
          <span className="hidden @[360px]:inline">to {who}</span>
        </span>
      </Tip>
      {open}
    </div>
  );
}

// useSender is what the chat knows about a sender: its colour, how long it
// took (a helper, from the crew), and how to open it: a helper's
// conversation in a tab, or a session Shipyard runs.
function useSender(from: MessageSender) {
  const ctx = useContext(PromptActionsContext);
  const pane = useContext(PaneContext);
  const crew = useConversations((st) => (ctx ? st.crew[keyOf(ctx.box, ctx.session)] : undefined));
  const session = useStore((s) => (ctx && from.kind === "session" ? s.boxes[ctx.box]?.sessions?.find((x) => x.name === from.id) : undefined));
  const at = crew?.findIndex((c) => c.id === from.helper) ?? -1;
  const member = at >= 0 ? crew![at] : undefined;
  const took = member?.until ? elapsed(member.until - member.since) : undefined;
  const fromPane = pane && { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane };
  let open: ((e: React.MouseEvent) => void) | undefined;
  let openTip: string | undefined;
  if (ctx?.claude && from.helper) {
    open = (e) => openHelper(ctx.box, ctx.session, from.helper!, { from: fromPane, title: from.name, event: e });
    openTip = `Open ${from.name}'s conversation in a tab · ⌘-click beside the chat · ⌥-click to peek`;
  } else if (ctx && session) {
    open = () => openSession(ctx.box, session);
    openTip = `Open ${session.title || session.name}`;
  }
  return { color: senderColor(from, at), took, open, openTip, name: from.kind === "session" && session?.title ? session.title : from.name, key: ctx ? keyOf(ctx.box, ctx.session) : "" };
}

const elapsed = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function OpenButton({ open, tip, label = "Open", className }: { open?: (e: React.MouseEvent) => void; tip?: string; label?: string; className?: string }) {
  if (!open) return null;
  return (
    <Tip label={tip}>
      <Button size="xs" variant="ghost" data-am-open className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)} onClick={open}>
        {label}
        <ArrowUpRightIcon />
      </Button>
    </Tip>
  );
}

const notYours = (name: string, from: MessageSender, who: string) => `${name} (${SENDER_WORD[from.kind].toLowerCase()}) sent this to ${who}. You didn't type it.`;

// AgentMessageCard is one message as a card.
export function AgentMessageCard({ it }: { it: MessageItem }) {
  const m = it.msg;
  const ctx = useContext(PromptActionsContext);
  const s = useSender(m.from);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const chip = chipOf(m);
  const body = m.body ?? "";
  const report = m.intent === "report";
  // A short message reads whole; a report (or a long message) shows its
  // gist and unfolds in place.
  const long = report || body.length > 600 || lineCount(body) > 8;
  const gist = m.summary || body.split("\n").find((l) => l.trim()) || "";
  const asks = needsYou(m);
  const big = overScreen(body);
  const who = ctx?.who && ctx.who !== "The agent" ? ctx.who : "Claude";
  const reply = () => {
    if (!quoteInto(s.key, { text: `${quoted(body || gist)}\n\nReply to ${s.name}: ` })) toastManager.add({ type: "info", title: "There's no reply box here", description: `Open ${who}'s chat to answer ${s.name}.` });
  };
  return (
    <div
      data-am-card={m.intent ?? "report"}
      data-needs-you={asks ? "" : undefined}
      role="group"
      aria-label={`${s.name}: ${chip.word.toLowerCase()}`}
      className={cn(
        "cv-in flex w-[min(100%,40rem)] min-w-0 flex-col self-start overflow-hidden rounded-lg border bg-card text-desc shadow-xs/5 @container",
        (chip.tone === "ask" && asks) && "border-warning/50",
        chip.tone === "bad" && "border-destructive/35",
        chip.tone === "lead" && "am-c-orange am-border-tint",
      )}
    >
      <CardHead
        avatar={<Avatar from={m.from} color={s.color} />}
        name={s.name}
        kind={SENDER_WORD[m.from.kind] !== s.name ? SENDER_WORD[m.from.kind] : undefined}
        chip={chip}
        extra={
          <>
            {asks && (
              <span data-needs-you-mark className="inline-flex shrink-0 items-center gap-1 text-warning-foreground text-meta">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                needs you
              </span>
            )}
            {m.intent === "question" && m.answered && (
              <Tip label={`${who} answered it, or you wrote since`}>
                <span data-answered className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-meta">
                  <CheckIcon className="size-3" aria-hidden />
                  answered
                </span>
              </Tip>
            )}
            {(m.repeat ?? 0) > 1 && (
              <Tip label={`Sent ${m.repeat} times`}>
                <span className="shrink-0 rounded bg-muted px-1 text-tag text-muted-foreground tabular-nums">×{m.repeat}</span>
              </Tip>
            )}
          </>
        }
        took={s.took}
        tip={notYours(s.name, m.from, who)}
        open={<OpenButton open={s.open} tip={s.openTip} />}
      />
      <div className="border-t px-2.5 pt-1.5 pb-2">
        {!open && (
          <>
            {m.title && report && <div className="mb-0.5 font-medium text-foreground">{m.title}</div>}
            {long ? (
              <p data-selectable data-am-gist className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground leading-snug">
                {gist}
              </p>
            ) : (
              <div data-selectable data-am-body className="am-short text-foreground/90">
                <Markdown text={body} copy={false} />
              </div>
            )}
          </>
        )}
        {open && (
          <div data-am-full className={cn("am-report -mx-0.5 mt-1 text-desc", big && "am-screen")}>
            <Markdown text={body} copy={false} />
          </div>
        )}
        {open && m.saved && (
          <p className="mt-2 text-muted-foreground text-meta">
            This is the start of it: the whole report was too long for the record, and Claude Code saved it to <code className="am-code">{m.saved}</code>.
          </p>
        )}
        {(long || m.intent === "question") && (
          <div className="-mb-1 mt-1 flex flex-wrap items-center gap-1">
            {long && (
              <Button size="xs" variant="ghost" data-am-read aria-expanded={open} className="-ml-1.5 text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
                <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
                {open ? (report ? "Fold report" : "Fold") : report ? "Read report" : "Read all"}
              </Button>
            )}
            {long && !open && <span className="text-muted-foreground text-meta tabular-nums">{lineCount(body)} lines</span>}
            {open && big && (s.open && m.from.helper ? (
              <OpenButton open={s.open} tip={s.openTip} label="Open in tab" className="-ml-0.5" />
            ) : (
              <Button size="xs" variant="ghost" data-am-sheet className="text-muted-foreground hover:text-foreground" onClick={() => setSheet(true)}>
                <FileTextIcon />
                Open full report
              </Button>
            ))}
            {m.intent === "question" && s.key && (
              <Tip label={`Put a reply to ${s.name} in the reply box, quoting its question. ${who} passes it on.`}>
                <Button size="xs" variant={asks ? "outline" : "ghost"} data-am-reply className={cn(!long && "-ml-1.5", !asks && "text-muted-foreground hover:text-foreground")} onClick={reply}>
                  <ReplyIcon />
                  Reply
                </Button>
              </Tip>
            )}
          </div>
        )}
      </div>
      {sheet && <ReportSheet it={it} name={s.name} color={s.color} onClose={() => setSheet(false)} />}
    </div>
  );
}

// ReportSheet is a long report whole, beside the chat, when it has no
// helper's tab to open.
function ReportSheet({ it, name, color, onClose }: { it: MessageItem; name: string; color: string; onClose(): void }) {
  const m = it.msg;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetPopup side="right" className="w-[min(680px,calc(100vw-48px))] max-w-none" aria-label={`${name}: report`}>
        <div className="flex flex-col gap-2 border-b px-6 pt-5 pb-4">
          <div className="flex items-center gap-2.5 pr-10">
            <Avatar from={m.from} color={color} />
            <SheetTitle className="min-w-0 flex-1 truncate text-heading">{m.title ?? name}</SheetTitle>
          </div>
          <SheetDescription render={<div />} className="flex flex-wrap items-center gap-2 text-meta">
            <KindChip chip={chipOf(m)} />
            <span>
              From {SENDER_WORD[m.from.kind].toLowerCase()} {name}, to the agent. You didn't type it.
            </span>
          </SheetDescription>
        </div>
        <div data-am-sheet-body className="am-report min-h-0 flex-1 overflow-y-auto px-6 py-4 text-body">
          <Markdown text={m.body ?? ""} />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

function pingGlyph(m: AgentMessage): { Icon: LucideIcon; className: string } {
  switch (m.status) {
    case "done":
      return { Icon: CheckIcon, className: "text-success" };
    case "failed":
      return { Icon: CircleXIcon, className: "text-destructive-foreground" };
    case "stopped":
      return { Icon: OctagonPauseIcon, className: "text-destructive-foreground" };
    default:
      return { Icon: m.from.kind === "harness" ? BellIcon : InfoIcon, className: "text-muted-foreground/70" };
  }
}

// PingLine is a status folded to a line: "✓ Run the billing tests
// completed", "✕ Fix retry tests failed · ×2 · Open".
export function PingLine({ it, inGroup }: { it: PingItem; inGroup?: boolean }) {
  const m = it.msg;
  const s = useSender(m.from);
  const ctx = useContext(PromptActionsContext);
  const who = ctx?.who && ctx.who !== "The agent" ? ctx.who : "Claude";
  const bad = m.status === "failed" || m.status === "stopped";
  const g = pingGlyph(m);
  return (
    <div data-ping={m.status} className={cn("flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground", !inGroup && "cv-in -my-1")}>
      <g.Icon className={cn("size-3.5 shrink-0", g.className)} aria-hidden />
      <Tip label={m.from.kind === "harness" ? `Claude Code told ${who} this. You didn't type it.` : notYours(s.name, m.from, who)}>
        <span className={cn("min-w-0 truncate", bad && "text-destructive-foreground/90")}>{m.summary}</span>
      </Tip>
      {s.took && (
        <>
          <Dot />
          <span className="shrink-0 tabular-nums">{s.took}</span>
        </>
      )}
      {(m.repeat ?? 0) > 1 && (
        <Tip label={`Claude Code said this ${m.repeat} times`}>
          <span data-ping-repeat className="shrink-0 rounded bg-muted px-1 text-tag tabular-nums">
            ×{m.repeat}
          </span>
        </Tip>
      )}
      <OpenButton open={s.open} tip={s.openTip} className="-my-1 h-5" />
    </div>
  );
}

// PingGroup is successes that came close together, folded to one line:
// "✓ 3 finished", open to each.
export function PingGroup({ items }: { items: PingItem[] }) {
  const [open, setOpen] = useState(false);
  const names = items.map((p) => p.msg.summary?.replace(/\s+(finished|completed).*$/i, "")).filter(Boolean);
  return (
    <div data-ping-group={items.length} className="cv-in -my-1 flex min-w-0 flex-col gap-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-ml-1 inline-flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />
        <span className="shrink-0">{items.length} finished</span>
        {!open && (
          <>
            <Dot />
            <span className="min-w-0 truncate text-muted-foreground/80">{names.join(", ")}</span>
          </>
        )}
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-l pl-3">
          {items.map((p) => (
            <div key={p.id} data-item-id={p.id} data-testid="chat-item" data-kind="ping" className="contents">
              <PingLine it={p} inGroup />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// MidTurnMark is the line under a message the person sent while the agent
// worked.
export function MidTurnMark({ who }: { who: string }) {
  return (
    <span data-mid-turn className="pe-1 text-muted-foreground text-meta">
      Sent while {who === "The agent" ? "the agent" : who} was working
    </span>
  );
}
