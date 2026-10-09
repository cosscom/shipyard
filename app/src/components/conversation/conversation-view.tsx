import { CheckIcon, ChevronRightIcon, ClockIcon, CornerDownRightIcon, FileTextIcon, GitCompareArrowsIcon, PencilLineIcon, RotateCwIcon, SearchIcon, SendHorizontalIcon, TerminalIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { PixelGrid, PixelLoader } from "@/components/pixel-loader";
import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { QueuedPrompt, SessionDiff } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import type { LineComments } from "@/lib/git/diff-view";
import { type ToolCall, type ToolDetail, toolSummary, type TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/conversation/markdown";
import { HARBOUR_WORDS } from "@/lib/screen-status";
import { NoticeCard } from "@/components/conversation/notice-card";
import { ReportCard, reportName, reportWord } from "@/components/conversation/report-card";
import { AgentMessageCard, MidTurnMark, PingGroup, PingLine } from "@/components/conversation/agent-message";
import { foldPings, messageText, type PingItem, withoutReminders } from "@/lib/agent-messages";
import { CommandItem } from "@/components/conversation/command-item";
import { ChatList } from "@/components/conversation/chat-list";
import { ChatSearch, plainMarkdown, type SearchEntry } from "@/components/conversation/chat-search";
import { EditChange, EditPanel } from "@/components/conversation/edit-diff";
import { ArtifactCard, ArtifactJumper } from "@/components/conversation/artifacts";
import { QuestionCard } from "@/components/conversation/question-form";
import { SelectionActions } from "@/components/conversation/selection-actions";
import { PromptActions, PromptActionsContext, type PromptContext } from "@/components/conversation/prompt-actions";
import { HelperSheetHost, openHelper } from "@/components/conversation/subagent-view";
import { PaneContext } from "@/lib/pane-context";
import { isMock } from "@/hooks/use-berth-connection";
import { keyOf } from "@/lib/conversation-store";
import { rowKeyOf } from "@/lib/draft-text";
import { applyCut, dropOlder, loadOlder, meta, restoreOlder, setCut, useHasHistory, useHistory, useOlder } from "@/lib/history";
import "@/components/conversation/conversation.css";
import "@/components/conversation/history.css";
import { TurnSync } from "@/components/workspace/compare-sync";
import { platformKeys } from "@/lib/platform";

// ConversationView draws an agent's turn as a calm transcript rather than a
// terminal: what was asked, what the agent says, its tool calls folded into
// groups ("Read 5 files"), edits, the helpers it sent out, and questions for
// the person with their answers as buttons. It only draws items; where they
// come from and what an answer does is the caller's.

export interface ConversationViewProps {
  items: TranscriptItem[];
  // An answer to an ask: one of its choices' keys, or "yes" or "no".
  onAnswer(id: string, key: string): void;
  // Edits open to their file's diff when the caller can read one.
  edits?: EditActions;
  // The agent's short name, for "Claude wants to run".
  who?: string;
  // Drawn after the transcript: prompts held for the agent.
  tail?: ReactNode;
  tailSize?: number;
  className?: string;
  // The session this is the chat of: older turns load as it scrolls up,
  // ⌘F finds in it, and prompts can be edited, forked and rewound (idle:
  // the agent rests, so a rewind can drive it).
  // A chat hidden for a minute (another tab, another worktree) lets its
  // older turns go too.
  chat?: { box: string; session: string; agent?: string; idle?: boolean; visible?: boolean };
}

// EditActions read an edited file's current diff, keep comments on its
// lines, and open it in Review.
export interface EditActions {
  load(file: string): Promise<SessionDiff>;
  // One tool call opened up: its full command and output, or exact change.
  tool?(id: string): Promise<ToolDetail>;
  comments(file: string): LineComments | undefined;
  review(file: string): void;
}

export function ConversationView({ items: live, onAnswer, edits, who = "The agent", tail, tailSize = 0, className, chat }: ConversationViewProps) {
  const key = chat ? keyOf(chat.box, chat.session) : "";
  const history = useHasHistory(chat?.box ?? "") && !!chat;
  const older = useOlder(key);
  const cut = useHistory((st) => (key ? st.cut[key] : undefined));
  // A closed chat lets its older turns go, so memory stays bounded.
  useEffect(() => () => void (key && dropOlder(key)), [key]);
  useEffect(() => {
    if (!key || chat?.visible !== false) return;
    const t = window.setTimeout(() => dropOlder(key, true), 60_000);
    return () => window.clearTimeout(t);
  }, [key, chat?.visible]);
  // The demo's long chat (?long=5000), for measuring.
  useEffect(() => {
    if (chat && isMock()) void import("@/lib/mock-history").then((m) => m.seedLongChat(chat.box, chat.session));
  }, [chat?.box, chat?.session]);
  // A rewound prompt stays hidden until the agent's record no longer has it.
  useEffect(() => {
    if (chat && cut && !live.some((it) => meta(it).uuid === cut)) setCut(chat.box, chat.session, undefined);
  }, [chat, cut, live]);
  // Older turns end where the live ones begin: one read afresh may reach
  // back over some of them. Worked out again only when the older turns or
  // where the live ones start change, not as the live ones grow.
  const from = live.find((it) => meta(it).off !== undefined);
  const at = from ? meta(from).off! : Infinity;
  const olderAll = useMemo(() => (history ? older.items.filter((it) => (meta(it).off ?? 0) < at) : []), [history, older.items, at]);
  const before = useMemo(() => {
    if (!olderAll.length) return olderAll;
    // An item can't be both (a live one starts at or after at), but a
    // window read afresh may give one without its place.
    const loose = live.filter((it) => meta(it).off === undefined);
    if (!loose.length) return olderAll;
    const ids = new Set(loose.map((it) => it.id));
    return olderAll.filter((it) => !ids.has(it.id));
  }, [olderAll, live]);
  const items = useMemo(() => (history ? [...before, ...applyCut(live, cut)] : live), [history, before, live, cut]);
  // Rows keep their objects while their items do (foldTurns), so as a
  // draft streams only its own row draws again.
  const folds = useRef<FoldCache>(null);
  folds.current ??= newFoldCache();
  const blocks = useMemo(() => foldTurns(items, folds.current!), [items]);
  const last = items[items.length - 1];
  const grew = last?.kind === "text" ? last.text.length : last?.kind === "tools" ? (last.items?.length ?? 0) : 0;
  // A prompt or command sent brings the view back to the foot.
  const sent = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user" || items[i].kind === "command") return items[i].id;
  }, [items]);
  const oldest = items.length ? meta(items[0]).off : undefined;
  const nearTop = history && oldest ? () => void loadOlder(chat!.box, chat!.session, oldest) : undefined;
  // Shown again after its older turns went: they come back as they were.
  useEffect(() => {
    if (history && chat && chat.visible !== false && older.depth !== undefined) restoreOlder(chat.box, chat.session, oldest);
  }, [history, chat?.box, chat?.session, chat?.visible, older.depth, older.loading, oldest]);
  const [reveal, setReveal] = useState<string[]>([]);
  const revealed = useMemo(() => new Set(reveal), [reveal]);
  // What ⌘F looks through, worked out only while it is open.
  const entries = useCallback(() => searchEntries(blocks), [blocks]);
  const itemsNow = useRef(items);
  itemsNow.current = items;
  const ctx = useMemo<PromptContext | null>(
    () => (chat ? { box: chat.box, session: chat.session, claude: history && chat.agent === "claude", idle: chat.idle ?? true, who, items: () => itemsNow.current } : null),
    [chat?.box, chat?.session, chat?.agent, chat?.idle, history, who],
  );
  // One function for every row, so a row draws again only when it changes.
  const answerTo = useRef(onAnswer);
  answerTo.current = onAnswer;
  const answer = useCallback((id: string, key: string) => answerTo.current(id, key), []);
  const renderBlock = useCallback(
    (b: Block) =>
      b.kind === "fold" ? <WorkFold id={b.id} steps={b.steps} live={b.live} onAnswer={answer} edits={edits} who={who} /> : b.kind === "pings" ? <PingGroup items={b.items} /> : <Item it={b.it} onAnswer={answer} edits={edits} who={who} />,
    [answer, edits, who],
  );
  const header =
    history && oldest && (older.loading || older.error || older.items.length || !older.more || live.length >= 250) ? (
      <OlderHeader older={older} onLoad={() => nearTop?.()} />
    ) : undefined;

  return (
    <RevealContext.Provider value={revealed}>
      <PromptActionsContext.Provider value={ctx}>
        <ChatList
          className={cn("mx-auto w-full max-w-(--berth-chat-w) text-[0.875rem] text-foreground leading-relaxed", className)}
          rows={blocks}
          rowKey={blockKey}
          estimate={estimateBlock}
          render={renderBlock}
          header={header}
          tail={tail}
          grew={`${grew}:${tailSize}`}
          repin={sent}
          onNearTop={nearTop}
        >
          {chat
            ? (api) => (
                <>
                  <ChatSearch api={api} entries={entries} onReveal={setReveal} />
                  <ArtifactJumper api={api} chat={key} rows={blocks} older={history ? older : undefined} onLoadOlder={nearTop} />
                  <TurnSync api={api} rows={blocks} isTurn={isTurn} />
                  <SelectionActions api={api} chat={key} who={who} />
                </>
              )
            : undefined}
        </ChatList>
        {chat && <HelperSheetHost />}
      </PromptActionsContext.Provider>
    </RevealContext.Provider>
  );
}

// What search opens to show a match: folds and tool groups, by id.
const RevealContext = createContext<Set<string>>(new Set());

// A message that replaced a draft keeps the draft's row (lib/draft-text).
const blockKey = (b: Block) => (b.kind === "item" ? rowKeyOf(b.it.id) : b.id);
// A turn starts where something was asked (a Compare tab's chats line up on it).
const isTurn = (b: Block) => b.kind === "item" && b.it.kind === "user";

// A row's height before it is drawn: near enough that the scroll bar
// doesn't jump much once it is. Worked out once per row: a long chat has
// thousands, and the list asks again whenever rows come or go.
const estimates = new WeakMap<Block, number>();
function estimateBlock(b: Block): number {
  let h = estimates.get(b);
  if (h === undefined) estimates.set(b, (h = guessHeight(b)));
  return h;
}

function guessHeight(b: Block): number {
  if (b.kind === "fold") return 28;
  if (b.kind === "pings") return 22;
  const it = b.it;
  const lines = (t: string, per: number) => t.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0);
  switch (it.kind) {
    case "user":
      return 22 * Math.min(lines(it.text, 60), 40) + 20;
    case "text":
      return 23 * Math.min(lines(it.text, 84), 400) + 8;
    case "ask":
      return 150;
    case "command":
      return 64;
    case "notice":
      return 84;
    case "artifact":
      return it.local ? (it.updated ? 40 : 112) : 54;
    case "question":
      return it.done ? 40 : 360;
    case "report":
      return it.report.answer || it.report.needs ? 78 : 40;
    case "agent-message":
      return it.msg.intent === "report" ? 104 : 40 + 22 * Math.min(lines(it.msg.body ?? "", 84), 12);
    case "ping":
      return 22;
    default:
      return 32;
  }
}

// searchEntries are the words search looks through, row by row, with the
// folds that hide each item.
function searchEntries(blocks: Block[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  blocks.forEach((b, row) => {
    const add = (it: TranscriptItem, open: string[]) => {
      const text = searchable(it);
      if (text) out.push({ row, item: it.id, text, open: it.kind === "tools" ? [...open, it.id] : open });
    };
    if (b.kind === "fold") for (const it of b.steps) add(it, [b.id]);
    else if (b.kind === "pings") for (const it of b.items) add(it, []);
    else add(b.it, []);
  });
  return out;
}

// An item's words, once per item: it is the same object until it changes.
const words = new WeakMap<TranscriptItem, string>();
function searchable(it: TranscriptItem): string {
  let w = words.get(it);
  if (w === undefined) words.set(it, (w = wordsOf(it)));
  return w;
}

function wordsOf(it: TranscriptItem): string {
  switch (it.kind) {
    case "user":
      return withoutReminders(it.text);
    case "text":
      return plainMarkdown(it.text);
    case "tools":
      return [toolSummary(it), ...(it.items ?? []).map((c) => `${c.verb}\n${c.target}`)].join("\n");
    case "edit":
      return `Edited ${it.file}`;
    case "crew":
      return it.names.join("\n");
    case "command":
      return [it.command, it.args, it.text].filter(Boolean).join("\n");
    case "notice":
      return it.text;
    case "ask":
      return it.detail;
    case "artifact":
      return [it.text, it.description].filter(Boolean).join("\n");
    case "question":
      return it.questions.map((q, i) => [q.question, it.answers?.[i]].filter(Boolean).join("\n")).join("\n");
    case "report":
      return [`${reportName(it.report)} ${reportWord(it.report)}`, it.report.answer, it.report.needs].filter(Boolean).join("\n");
    case "agent-message":
      return messageText(it.msg);
    case "ping":
      return it.msg.summary ?? "";
  }
  return "";
}

// OlderHeader is the top of a long chat: earlier turns loading, a way to
// load them, or where the conversation began.
function OlderHeader({ older, onLoad }: { older: { loading: boolean; error?: string; more: boolean }; onLoad(): void }) {
  return (
    <div className="flex h-10 items-center justify-center pb-4 text-muted-foreground text-xs">
      {older.loading ? (
        <PixelLoader label="Loading earlier messages…" />
      ) : older.error ? (
        <span className="flex items-center gap-2">
          <span className="text-destructive-foreground">Couldn't load earlier messages.</span>
          <Button size="xs" variant="ghost" onClick={onLoad}>
            <RotateCwIcon />
            Retry
          </Button>
        </span>
      ) : older.more ? (
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={onLoad}>
          <ClockIcon />
          Load earlier messages
        </Button>
      ) : (
        <span className="flex w-full items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          Start of the conversation
          <span className="h-px flex-1 bg-border" />
        </span>
      )}
    </div>
  );
}

// A turn reads like a chat: what was asked, what the agent changed, and its
// answer. The steps in between (its narration and tool calls) fold into one
// line, "Worked · ran 3 commands, read 5 files", opened on demand. While it
// works, the line says so and its latest words stay in view.
// Successes from Claude Code that came close together fold into one line
// (pings).
type Block = { kind: "item"; it: TranscriptItem } | { kind: "fold"; id: string; steps: TranscriptItem[]; live: boolean } | { kind: "pings"; id: string; items: PingItem[] };

// FoldCache keeps the rows already made, so folding a chat again (a draft
// grew, a step finished) makes new rows only for what changed: a row
// whose items are the same is the same object, and the list draws it
// again only when it isn't. Each turn's rows are kept by its first item,
// with the items they were made from; a turn whose items are all the
// same objects is not folded again.
interface FoldCache {
  turns: WeakMap<TranscriptItem, { items: TranscriptItem[]; working: boolean; blocks: Block[] }>;
  items: WeakMap<TranscriptItem, Block>;
  folds: WeakMap<TranscriptItem, Extract<Block, { kind: "fold" }>>;
  pings: WeakMap<PingItem, Extract<Block, { kind: "pings" }>>;
}

const newFoldCache = (): FoldCache => ({ turns: new WeakMap(), items: new WeakMap(), folds: new WeakMap(), pings: new WeakMap() });

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function itemBlock(it: TranscriptItem, c: FoldCache): Block {
  let b = c.items.get(it);
  if (!b) c.items.set(it, (b = { kind: "item", it }));
  return b;
}

// foldTurn folds one turn's items: its steps into one row, then what it
// shows.
function foldTurn(turn: TranscriptItem[], working: boolean, c: FoldCache): Block[] {
  // The answer: the turn's last words, once it has finished; while it
  // works, its latest words. When it says several things after its last
  // step, the answer starts at the longest of them: a reply and a note
  // after it both show, a "now I'll write it up" before it stays folded.
  let answer = -1;
  for (let i = turn.length - 1; i >= 0; i--)
    if (turn[i].kind === "text") {
      answer = i;
      const len = (j: number) => {
        const t = turn[j];
        return t.kind === "text" ? t.text.length : 0;
      };
      for (let j = i - 1; j >= 0 && (turn[j].kind === "text" || turn[j].kind === "edit"); j--) if (len(j) > len(answer)) answer = j;
      break;
    }
  const steps: TranscriptItem[] = [];
  const shown: TranscriptItem[] = [];
  turn.forEach((it, i) => {
    if ((answer >= 0 && i >= answer && it.kind === "text") || it.kind === "edit" || it.kind === "artifact" || it.kind === "question" || it.kind === "ask" || it.kind === "thinking" || it.kind === "notice") shown.push(it);
    else steps.push(it);
  });
  const out: Block[] = [];
  if (steps.length) {
    const was = c.folds.get(steps[0]);
    const fold = was && was.live === working && sameList(was.steps, steps) ? was : { kind: "fold" as const, id: `fold-${steps[0].id}`, steps, live: working };
    c.folds.set(steps[0], fold);
    out.push(fold);
  }
  for (const it of shown) out.push(itemBlock(it, c));
  return out;
}

function foldTurns(items: TranscriptItem[], c: FoldCache = newFoldCache()): Block[] {
  const last = items[items.length - 1];
  const live = !!last && (last.kind === "thinking" || (last.kind === "ask" && !last.decided) || (last.kind === "question" && !last.done));
  const out: Block[] = [];
  let start = -1;
  const flush = (end: number, isLast: boolean) => {
    if (start < 0) return;
    const working = isLast && live;
    const first = items[start];
    const was = c.turns.get(first);
    let blocks: Block[];
    if (was && was.working === working && was.items.length === end - start && was.items.every((x, i) => x === items[start + i])) blocks = was.blocks;
    else {
      const turn = items.slice(start, end);
      blocks = foldTurn(turn, working, c);
      c.turns.set(first, { items: turn, working, blocks });
    }
    for (const b of blocks) out.push(b);
    start = -1;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // A command typed to the agent is the person's, like a prompt; a report
    // from Shipyard starts a turn too, as does a message from another agent or
    // Claude Code: each is something the agent answers.
    if (it.kind === "user" || it.kind === "command" || it.kind === "report" || it.kind === "agent-message" || it.kind === "ping") {
      flush(i, false);
      out.push(itemBlock(it, c));
    } else if (start < 0) start = i;
  }
  flush(items.length, true);
  return foldPings<Block>(
    out,
    (b) => (b.kind === "item" && b.it.kind === "ping" ? b.it : undefined),
    (run) => {
      const was = c.pings.get(run[0]);
      const group = was && sameList(was.items, run) ? was : { kind: "pings" as const, id: `pings-${run[0].id}`, items: run };
      c.pings.set(run[0], group);
      return group;
    },
  );
}

function workSummary(steps: TranscriptItem[]): string {
  let run = 0, read = 0, search = 0, other = 0, helpers = 0;
  for (const s of steps) {
    if (s.kind === "tools") {
      const n = s.items?.length ?? 0;
      if (s.verb === "Run") run += n;
      else if (s.verb === "Read") read += n;
      else if (s.verb === "Search") search += n;
      else other += n;
    } else if (s.kind === "crew") helpers += s.names?.length ?? 1;
  }
  const n = (k: number, one: string, many: string) => (k ? [`${k === 1 ? one.replace("#", "1") : many.replace("#", String(k))}`] : []);
  const parts = [...n(run, "ran # command", "ran # commands"), ...n(read, "read # file", "read # files"), ...n(search, "searched # time", "searched # times"), ...n(helpers, "started # helper", "started # helpers"), ...n(other, "used # tool", "used # tools")];
  return parts.join(", ");
}

function WorkFold({ id, steps, live, onAnswer, edits, who }: { id: string; steps: TranscriptItem[]; live: boolean; onAnswer(id: string, key: string): void; edits?: EditActions; who: string }) {
  const [opened, setOpen] = useState(false);
  // Search opens it to a match inside.
  const forced = useContext(RevealContext).has(id);
  const open = opened || forced;
  // Its steps are drawn once it has opened: a long chat has hundreds of
  // folds, most never opened.
  const [drawn, setDrawn] = useState(open);
  if (open && !drawn) setDrawn(true);
  const summary = workSummary(steps);
  return (
    <div className="cv-in -my-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-muted-foreground text-[0.8125rem] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
        {live ? <span className="cv-shimmer">Working</span> : "Worked"}
        {summary && <span>· {summary}</span>}
      </button>
      <div className="cv-fold" data-closed={open ? undefined : ""}>
        <div>
          <div className="mt-2 flex flex-col gap-3 border-l pl-4 text-[0.8438rem]">
            {drawn && steps.map((it) => <Item key={it.id} it={it} onAnswer={onAnswer} edits={edits} who={who} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// Item is one item, marked with its id for search.
function Item(props: { it: TranscriptItem; onAnswer(id: string, key: string): void; edits?: EditActions; who: string }) {
  return (
    <div data-item-id={props.it.id} data-testid="chat-item" data-kind={props.it.kind} data-draft={props.it.kind === "text" && props.it.live ? "" : undefined} className="contents">
      <ItemBody {...props} />
    </div>
  );
}

function ItemBody({ it, onAnswer, edits, who }: { it: TranscriptItem; onAnswer(id: string, key: string): void; edits?: EditActions; who: string }) {
  switch (it.kind) {
    case "user": {
      const text = withoutReminders(it.text);
      if (!text) return null;
      return (
        <div className="hs-prompt flex w-full flex-col items-end gap-1">
          <div className="flex w-full items-end justify-end gap-1.5">
            {!it.pending && <PromptActions it={it} />}
            <div data-selectable className={cn("cv-in min-w-0 max-w-[80%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2", it.pending && "opacity-70")}>
              {/* Who speaks, for screen readers; never copied with the words. */}
              <span className="sr-only select-none">You: </span>
              {text}
            </div>
          </div>
          {/* Sent mid-turn: the agent takes it at its next step, as its own
              terminal shows a queued message. */}
          {it.pending && <span className="pe-1 text-muted-foreground text-xs">Sent · {who} reads it at its next step</span>}
          {it.midTurn && !it.pending && <MidTurnMark who={who} />}
        </div>
      );
    }
    case "text":
      // A draft (the reply as the agent's screen shows it) draws as the
      // message will, so the message replaces it in place.
      return (
        <>
          <span className="sr-only select-none">{who}: </span>
          <Markdown text={it.text} draft={it.live} clipped={it.clipped} />
        </>
      );
    case "thinking":
      return <Thinking since={it.since} label={it.label} elapsed={it.elapsed} meta={it.meta} step={it.step} />;
    case "tools":
      return <Tools it={it} edits={edits} />;
    case "edit":
      return <Edit it={it} edits={edits} />;
    case "notice":
      return <NoticeCard it={it} />;
    case "crew":
      return (
        <div className="cv-in flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="mr-0.5">
            Sent out {it.names.length} helper{it.names.length === 1 ? "" : "s"}
          </span>
          {it.names.map((n) => (
            <HelperChip key={n} name={n} tool={it.names.length === 1 ? meta(it).tool : undefined} />
          ))}
        </div>
      );
    case "command":
      return <CommandItem it={it} who={who} />;
    case "artifact":
      return <ArtifactCard it={it} />;
    case "question":
      return <QuestionCard it={it} who={who} />;
    case "report":
      return <ReportCard it={it} />;
    case "agent-message":
      return <AgentMessageCard it={it} />;
    case "ping":
      return <PingLine it={it} />;
    case "ask":
      return it.structured ? <Permission it={it} onAnswer={onAnswer} who={who} /> : <Ask it={it} onAnswer={onAnswer} />;
  }
}

// HelperChip is a helper the agent sent out; where its own conversation can
// be read, a click opens it as the crew's rows do (a tab, ⌘ a split, ⌥ a
// peek).
function HelperChip({ name, tool }: { name: string; tool?: string }) {
  const ctx = useContext(PromptActionsContext);
  const pane = useContext(PaneContext);
  const label = name.replace(/^Explore:\s*/, "");
  if (!ctx?.claude) return <Badge variant="secondary">{label}</Badge>;
  const from = pane && { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane };
  return (
    <Tip label={<span className="flex flex-col"><span>Open its conversation in a tab</span><span className="text-muted-foreground">{platformKeys("⌘-click beside the chat · ⌥-click to peek")}</span></span>}>
      <Badge variant="secondary" render={<button type="button" data-helper-chip={label} onClick={(e) => openHelper(ctx.box, ctx.session, tool ?? label, { from, title: label, event: e })} />} className="cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        <ChevronRightIcon className="-mr-0.5 size-3 opacity-60" />
      </Badge>
    </Tip>
  );
}

// What the agent would do, in words: "wants to run", "wants to edit".
export function permissionVerb(tool: string): { verb: string; what?: string; mono: boolean } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { verb: "wants to use", what: `${mcp[2].replaceAll("_", " ")} (${mcp[1]})`, mono: false };
  switch (tool) {
    case "Bash":
      return { verb: "wants to run", mono: true };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "wants to edit", mono: true };
    case "Write":
      return { verb: "wants to write", mono: true };
    case "Read":
      return { verb: "wants to read", mono: true };
    case "WebFetch":
      return { verb: "wants to fetch", mono: true };
    case "WebSearch":
      return { verb: "wants to search the web for", mono: false };
    case "AskUserQuestion":
      return { verb: "asks you", mono: false };
    case "ExitPlanMode":
      return { verb: "has a plan ready for your approval", mono: false };
  }
  return { verb: "wants to use", what: tool, mono: false };
}

// Permission is an approval the agent's hooks described: the tool and what
// it would run or touch, matched to the options on its screen.
function Permission({ it, onAnswer, who }: { it: Extract<TranscriptItem, { kind: "ask" }>; onAnswer(id: string, key: string): void; who: string }) {
  const { verb, what, mono } = permissionVerb(it.tool);
  const choices = it.choices ?? [];
  if (it.decided) {
    // What was picked, in its own words unless it was a plain allow or
    // deny: "Tell Claude what to change" didn't allow anything.
    const label = choices.find((x) => x.key === it.decided)?.label ?? "";
    const no = /^(deny|no)\b/i.test(label);
    const yes = /^(allow|always allow|yes)\b/i.test(label);
    return (
      <div className="cv-in flex min-w-0 items-center gap-2 text-muted-foreground">
        {no ? <XIcon className="size-3.5 shrink-0" /> : yes ? <CheckIcon className="size-3.5 shrink-0 text-success" /> : <CornerDownRightIcon className="size-3.5 shrink-0" />}
        <span className="shrink-0">{no ? "Denied" : label === "Always allow" ? "Always allowed" : label === "Allow" ? "Allowed" : label || "Answered"}</span>
        <span className={cn("truncate text-foreground/80", mono && "font-mono text-[0.7812rem]")}>{it.detail || what}</span>
      </div>
    );
  }
  return (
    <Card className="cv-in border-warning/60">
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 font-medium">
          <span className="size-2 rounded-full bg-warning" aria-hidden />
          <span>
            {who} {verb}
            {what && <span className="font-normal"> {what}</span>}
          </span>
        </div>
        {it.detail && (mono ? <code className="whitespace-pre-wrap break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-[0.7812rem]">{it.detail}</code> : <p data-selectable className="whitespace-pre-wrap">{it.detail}</p>)}
        {it.why && <p className="text-muted-foreground text-[0.8125rem]">{it.why}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {choices.map((c, i) => (
          <Tip key={c.key} label={c.title ? `${c.key}. ${c.title}` : undefined}>
            {/* A plan's first option starts it working on its own: no option is the obvious one there. */}
            <Button size="sm" variant={i === 0 && it.tool !== "ExitPlanMode" ? "default" : "outline"} className="max-w-full" onClick={() => onAnswer(it.id, c.key)}>
              {c.label}
            </Button>
          </Tip>
        ))}
        {!choices.length && (
          <span className="flex items-center gap-2 text-muted-foreground text-sm">
            {it.reading ? (
              <>
                <Spinner className="size-3.5" />
                Reading its options…
              </>
            ) : (
              "Its options aren't on its screen: answer it in the terminal."
            )}
          </span>
        )}
        <span className="ml-auto text-muted-foreground text-xs">{who} waits for you</span>
      </div>
    </Card>
  );
}

function Ask({ it, onAnswer }: { it: Extract<TranscriptItem, { kind: "ask" }>; onAnswer(id: string, key: string): void }) {
  const question = it.tool === "Question";
  const choices = it.choices?.length ? it.choices : question ? [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }] : [{ key: "yes", label: "Allow" }, { key: "no", label: "Deny" }];
  if (it.decided) {
    const c = choices.find((x) => x.key === it.decided);
    const no = it.decided === "no";
    return (
      <div className="cv-in flex min-w-0 items-center gap-2 text-muted-foreground">
        {no ? <XIcon className="size-3.5 shrink-0" /> : <CheckIcon className="size-3.5 shrink-0 text-success" />}
        <span className="shrink-0">{c?.label ?? it.decided}</span>
        <span className={cn("truncate text-foreground/80", !question && "font-mono text-[0.7812rem]")}>{it.detail}</span>
      </div>
    );
  }
  return (
    <Card className="cv-in border-warning/60">
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 font-medium">
          <span className="size-2 rounded-full bg-warning" aria-hidden />
          {question ? "Needs your answer" : "Wants to run a command"}
        </div>
        {it.detail && (question ? <p data-selectable className="whitespace-pre-wrap">{it.detail}</p> : <code className="rounded-lg bg-muted/40 px-3 py-2 font-mono text-[0.7812rem]">{it.detail}</code>)}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {choices.map((c, i) => (
          <Button key={c.key} size="sm" variant={i === 0 ? "default" : "outline"} className="max-w-full" onClick={() => onAnswer(it.id, c.key)}>
            {it.choices?.length ? <span className="font-mono opacity-60">{c.key}</span> : null}
            <span className="truncate">{c.label}</span>
          </Button>
        ))}
        <span className="ml-auto text-muted-foreground text-xs">{it.choices?.length ? "The agent waits for your pick" : question ? "Or reply below" : "The agent waits for you"}</span>
      </div>
    </Card>
  );
}

// Edit is one file the agent changed. With edits, it opens (folded by
// default) to the agent's exact change and the file's current uncommitted
// diff, where lines take comments and Review is a click away
// (conversation/edit-diff).
function Edit({ it, edits }: { it: Extract<TranscriptItem, { kind: "edit" }>; edits?: EditActions }) {
  const [open, setOpen] = useState(false);
  const cut = it.file.lastIndexOf("/");
  const label = (
    <>
      <PencilLineIcon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">Edited</span>
      <span className="min-w-0 truncate font-mono text-[0.7812rem]">
        <span className="text-muted-foreground">{it.file.slice(0, cut + 1)}</span>
        {it.file.slice(cut + 1)}
      </span>
      {!!it.added && <span className="font-medium font-mono text-[0.75rem] text-success-foreground tabular-nums">+{it.added}</span>}
      {!!it.removed && <span className="font-medium font-mono text-[0.75rem] text-destructive-foreground tabular-nums">−{it.removed}</span>}
    </>
  );
  if (!edits) return <div className="cv-in flex min-w-0 items-center gap-2 self-start rounded-lg bg-muted/40 px-2.5 py-1.5 text-[0.8125rem]">{label}</div>;
  return (
    <div className={cn("cv-in flex min-w-0 flex-col", open ? "self-stretch" : "self-start")}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-left text-[0.8125rem] outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
          {label}
        </button>
        {open && (
          <Button size="xs" variant="ghost" className="ml-auto shrink-0 text-muted-foreground" onClick={() => edits.review(it.file)}>
            <GitCompareArrowsIcon />
            Open in Review
          </Button>
        )}
      </div>
      {open && <EditPanel file={it.file} tool={it.tool} estimate={it.added + it.removed + 6} loadDiff={edits.load} loadTool={edits.tool} comments={edits.comments(it.file)} />}
    </div>
  );
}

// QueuedBubble is a prompt the box holds until the agent finishes: what it
// says, and the two things to do about it.
export function QueuedBubble({ q, who, onSendNow, onCancel }: { q: QueuedPrompt; who: string; onSendNow(): Promise<void>; onCancel(): Promise<void> }) {
  const [busy, setBusy] = useState<"send" | "cancel">();
  const run = (what: "send" | "cancel", fn: () => Promise<void>) => {
    setBusy(what);
    fn().finally(() => setBusy(undefined));
  };
  return (
    <div data-testid="queued-reply" className="cv-in flex max-w-[80%] flex-col items-end gap-1 self-end">
      <div className="whitespace-pre-wrap rounded-2xl border border-dashed bg-background px-3.5 py-2 text-foreground/80">
        {q.preview}
        {q.length > q.preview.length && <span className="text-muted-foreground"> ({q.length.toLocaleString()} characters in all)</span>}
      </div>
      <div className="flex items-center gap-1 text-muted-foreground text-xs">
        <ClockIcon className="size-3" aria-hidden />
        <span className="mr-1">Queued: sends when {who} finishes</span>
        <Button size="xs" variant="ghost" loading={busy === "send"} disabled={!!busy} onClick={() => run("send", onSendNow)}>
          <SendHorizontalIcon />
          Send now
        </Button>
        <Button size="xs" variant="ghost" loading={busy === "cancel"} disabled={!!busy} onClick={() => run("cancel", onCancel)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// A file's mark: its extension, in the colour editors give it.
const EXT: Record<string, string> = { ts: "#3178c6", tsx: "#3178c6", js: "#b8860b", rs: "#d0573a", go: "#00a7d0", md: "#6b7280", json: "#8b5cf6", css: "#2965f1", py: "#3a75b0" };

function Tools({ it, edits }: { it: Extract<TranscriptItem, { kind: "tools" }>; edits?: EditActions }) {
  const [opened, setOpen] = useState(!it.done);
  const forced = useContext(RevealContext).has(it.id);
  const open = opened || forced;
  // A group that finishes while in view folds to its summary after a
  // moment; one drawn finished (scrolled back to) stays as it is opened.
  const working = useRef(!it.done);
  useEffect(() => {
    if (!it.done || !working.current) return;
    working.current = false;
    const t = window.setTimeout(() => setOpen(false), 1600);
    return () => window.clearTimeout(t);
  }, [it.done]);
  const Icon = it.verb === "Search" ? SearchIcon : it.verb === "Run" ? TerminalIcon : FileTextIcon;
  const doing = it.verb === "Read" ? "Reading" : it.verb === "Search" ? "Searching" : "Running";
  return (
    <div className="cv-in -my-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
        {it.done ? toolSummary(it) : <span className="cv-shimmer">{doing}…</span>}
      </button>
      <div className="cv-fold" data-closed={open ? undefined : ""}>
        <div>
          <ul className="pt-1 pl-[7px]">
            {(it.items ?? []).map((c, i, all) => (
              <ToolRow key={c.id ?? i} c={c} last={i === all.length - 1} Icon={Icon} edits={edits} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ToolRow is one call in a group: its verb and target, and opened, what the
// agent's terminal shows for it.
function ToolRow({ c, last, Icon, edits }: { c: ToolCall; last: boolean; Icon: typeof FileTextIcon; edits?: EditActions }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ state: "loading" } | { state: "ready"; d: ToolDetail } | { state: "error"; message: string }>();
  const can = !!(c.id && edits?.tool);
  const ext = c.file ? (c.target.split(".").pop() ?? "") : "";
  const toggle = () => {
    if (!can) return;
    if (!open && detail?.state !== "ready") {
      setDetail({ state: "loading" });
      edits!.tool!(c.id!).then(
        (d) => setDetail({ state: "ready", d }),
        (err) => setDetail({ state: "error", message: errorMessage(err) }),
      );
    }
    setOpen((o) => !o);
  };
  return (
    <li className="cv-in relative pl-5 text-muted-foreground">
      {/* The tree: a stem down from the summary, an elbow into each row. */}
      <span aria-hidden className={cn("absolute top-0 left-0 w-3 border-l", last ? "h-4 rounded-bl-md border-b" : "h-full")} />
      {!last && <span aria-hidden className="absolute top-4 left-0 w-3 border-t" />}
      <button
        type="button"
        onClick={toggle}
        disabled={!can}
        aria-expanded={can ? open : undefined}
        className={cn("flex h-8 max-w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", can && "hover:text-foreground")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span>{c.verb}</span>
        <Badge variant="outline" className={cn("min-w-0 gap-1.5 font-normal", !c.file && "font-mono")}>
          {c.file && (
            <span className="flex size-3 items-center justify-center rounded-[3px] font-bold font-mono text-[0.4062rem] text-white uppercase" style={{ background: EXT[ext] ?? "#64748b" }}>
              {ext.slice(0, 2)}
            </span>
          )}
          <span className="truncate">{c.target}</span>
        </Badge>
        {can && <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />}
      </button>
      {open && (
        <div className="mt-1 mb-2 overflow-hidden rounded-lg border bg-card text-foreground">
          {detail?.state === "loading" && (
            <div className="flex h-12 items-center justify-center text-muted-foreground text-sm">
              <Spinner className="mr-2 size-4" />
              Reading…
            </div>
          )}
          {detail?.state === "error" && <p className="px-3 py-2.5 text-destructive-foreground text-sm">Couldn't open this step: {detail.message}</p>}
          {detail?.state === "ready" && <ToolDetailView d={detail.d} />}
        </div>
      )}
    </li>
  );
}

// ToolDetailView draws a call the way the terminal does: a command and its
// output, a search and its matches, an edit's change, a new file.
export function ToolDetailView({ d }: { d: ToolDetail }) {
  const edit = d.old != null || (d.new != null && !d.command);
  return (
    <div data-selectable className="font-mono text-[0.75rem] leading-5 [font-variant-ligatures:none]">
      {(d.command || d.pattern || d.file) && !edit && (
        <div className="flex gap-2 border-b bg-muted/30 px-3 py-1.5">
          <span className="shrink-0 text-muted-foreground">{d.command ? "$" : d.pattern ? "?" : "·"}</span>
          <span className="min-w-0 whitespace-pre-wrap break-all">{d.command || [d.pattern, d.file].filter(Boolean).join("  in  ")}</span>
        </div>
      )}
      {edit && <EditChange d={d} />}
      {!edit && (d.output ? (
        <pre className={cn("max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 py-2", d.error && "text-destructive-foreground")}>{plain(d.output)}</pre>
      ) : (
        <p className="px-3 py-2 font-sans text-muted-foreground text-xs">{d.pending ? "Still running…" : "No output."}</p>
      ))}
      {d.truncated && <p className="border-t px-3 py-1 font-sans text-muted-foreground text-xs">The middle of a long output is left out, as in the terminal.</p>}
    </div>
  );
}

// plain drops terminal escape codes (colours, cursor moves) that tools
// write for a terminal; boxes strip them too, this covers older ones.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape codes is the point.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;
const plain = (s: string) => s.replace(ANSI, "");

// Thinking is the agent at work, as its own status line says it
// ("Seasoning… · 9m 11s · 7.1k tokens"), or the step it is running
// ("Running yarn vitest · 6m 47s"), or, with neither to read, a calm word
// of our own that changes now and then.
function Thinking({ since, label, elapsed, meta, step }: { since: number; label?: string; elapsed?: string; meta?: string; step?: { verb: string; target: string } }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  const took = elapsed && !step ? elapsed : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  const doing = step ? (step.verb === "Read" ? "Reading" : step.verb === "Search" ? "Searching" : step.verb === "Edit" ? "Editing" : "Running") : undefined;
  const word = label ?? `${HARBOUR_WORDS[Math.floor(now / 4000) % HARBOUR_WORDS.length]}…`;
  return (
    <div className="cv-in flex min-w-0 items-center gap-2">
      <PixelGrid className="text-muted-foreground" />
      {step ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="cv-shimmer shrink-0">{doing}</span>
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-px font-mono text-[0.7812rem]">{step.target}</code>
        </span>
      ) : (
        <span className="cv-shimmer shrink-0">{word}</span>
      )}
      {(s >= 1 || elapsed) && <span className="shrink-0 text-muted-foreground tabular-nums">· {took}</span>}
      {meta && <span className="shrink-0 text-muted-foreground tabular-nums">· {meta}</span>}
    </div>
  );
}
