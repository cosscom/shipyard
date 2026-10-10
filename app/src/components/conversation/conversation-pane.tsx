import { ArrowUpIcon, ListPlusIcon, MessageSquareTextIcon, MessagesSquareIcon, RefreshCwIcon, SendIcon, SquareTerminalIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { DitherBand } from "@/components/art/dither-band";
import { TaskComposer } from "@/components/conversation/task-composer";
import { AttachmentChips, useAttachments } from "@/components/conversation/attachments";
import { HARBOUR, HARBOUR_MUTE, useHarbourLight } from "@/components/art/harbour-art";
import { Scene, type SceneName } from "@/components/art/scenes";
import { ChatBackground } from "@/components/conversation/chat-background";
import { ChatControls } from "@/components/conversation/chat-controls";
import { ConversationView, type EditActions, QueuedBubble } from "@/components/conversation/conversation-view";
import { ChatScope } from "@/components/conversation/notice-card";
import { PixelLoader } from "@/components/pixel-loader";
import { useComposerMenu } from "@/components/conversation/command-menu";
import { LiveScreen, useLiveScreen } from "@/components/conversation/live-screen";
import { QuestionsContext } from "@/components/conversation/question-form";
import { toastError } from "@/components/error-note";
import { UpgradeBox } from "@/components/upgrade-box";
import { RetryLine } from "@/components/workspace/pane-state";
import { SessionWorktreeSections } from "@/components/workspace/worktree-sections";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { startSession } from "@/lib/actions";
import { ApiError, boxApi, type QueuedPrompt } from "@/lib/api";
import { tryNow } from "@/lib/reconnect";
import { type AttachTarget, withAttachments } from "@/lib/attachments";
import { joinDraft, listenForQuotes, type QuoteFill } from "@/lib/chat-quote";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { agentLabel, agentOf, firstPrompt, guessAgent, sessionState, worktreeOf } from "@/lib/derive";
import type { NextStep } from "@/lib/errors";
import { errorMessage } from "@/lib/format";
import { useNotifications } from "@/lib/notifications";
import { updateBoxes } from "@/lib/outdated";
import { addComment, type LineComment, pending, removeComment, sendComments, useComments } from "@/lib/review-comments";
import { answerQuestions, type QuestionAnswer } from "@/lib/questions";
import { permissionChoices } from "@/lib/screen";
import { NONE, useStore } from "@/lib/store";
import type { TranscriptItem } from "@/lib/transcript";
import { noteSent, usePromptRecall } from "@/lib/history";
import { plainWords, useScreenStatus } from "@/lib/screen-status";
import { useDraft } from "@/lib/draft";
import { withDraft } from "@/lib/draft-text";
import { FIRST_READ_TIMEOUT, useAsk, useQueued, useTranscriptFeed } from "@/lib/transcript-feed";
import { ConfirmDialog } from "@/views/settings/confirm";
import { cn } from "@/lib/utils";
import { useReview } from "@/views/review/review-store";

// The mock's scripted conversations (?mock), loaded only in mock mode.
const mockConversation = () => import("@/lib/mock-conversation");

// ConversationPane shows an agent's pane as a conversation: the transcript,
// and a reply box docked at its foot. On a box that streams transcripts it
// reads the agent's own; "Thinking…" and the question come from the
// session's live state and its screen. The demo plays a scripted turn
// instead. Without either it says so and offers the terminal back.

//
// It never claims more than it knows. Until the box lists its sessions it
// reads; a session the box no longer lists, or whose program closed, has
// ended (and never offers a reply); a box that is away says so and the pane
// comes back by itself when it returns; a conversation that can't be read
// says why, with a way to try again.
export function ConversationPane({ box, session, agent: remembered, visible, onShowTerminal, onStartAgain }: { box: string; session: string; agent?: string; visible: boolean; onShowTerminal(): void; onStartAgain?(): void }) {
  const key = keyOf(box, session);
  const items = useConversations((s) => s.items[key]) ?? (NONE as TranscriptItem[]);
  const listed = useStore((st) => st.boxes[box]?.sessions);
  const s = listed?.find((x) => x.name === session);
  const stats = useStore((st) => st.boxes[box]?.stats);
  const locations = useStore((st) => st.boxes[box]?.locations);
  const client = useStore((st) => st.client);
  const boxStatus = useStore((st) => st.status?.boxes.find((b) => b.name === box));
  const mock = isMock();
  const away = !!boxStatus && boxStatus.state !== "online";
  // Gone: the box lists its sessions and this one isn't among them.
  const gone = !away && !!listed && !s;
  const state = gone ? "exited" : s ? sessionState(s, stats) : undefined;
  const [attempt, setAttempt] = useState(0);
  const feed = useTranscriptFeed(box, session, s?.dir, visible && !mock && !away, attempt);
  const ask = useAsk(box, session, !mock && state === "waiting", s?.state_since);
  const [answered, setAnswered] = useState<{ at?: string; key: string }>();
  // A form of questions the agent asks (Claude Code's AskUserQuestion),
  // from its record: the chat draws it whole and the box fills it in. stuck
  // is why the box couldn't, for this wait: its own screen opens instead.
  const canAnswer = useStore((st) => !!st.boxes[box]?.info?.capabilities?.includes("answer"));
  const openQ = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "question") return it.done ? undefined : it;
      if (it.kind === "user") return undefined;
    }
  }, [items]);
  const formAsk = state === "waiting" && !!openQ;
  // Prompts sent from here that the transcript doesn't show yet.
  // Each remembers the prompts like it the transcript already held, by ID:
  // the transcript is a sliding window, so a position in it doesn't last.
  const [sent, setSent] = useState<{ text: string; at: number; seen: Set<string> }[]>([]);
  // Once the transcript has a prompt, it is no longer "just sent".
  useEffect(() => {
    setSent((l) => {
      const left = l.filter((p, i) => !taken(items, p, i + 1));
      return left.length === l.length ? l : left;
    });
  }, [items]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!sent.length) return;
    // Look again when a prompt has waited long enough to be worth a word.
    const t = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(t);
  }, [sent.length]);
  // Given a prompt: the box names a session from its first prompt, and
  // starts a turn for it.
  const prompted = !!s && (!!s.turn || !!s.title || !!s.queued);
  const queue = useQueued(box, session, s?.queued, visible);
  const [confirm, setConfirm] = useState<QueuedPrompt>();
  const canDiff = useStore((st) => !!st.boxes[box]?.info?.capabilities?.includes("diff"));
  // A session the box no longer lists is named from what the pane remembers.
  const agent = (s ? agentOf(s) : undefined) ?? remembered ?? guessAgent(session);
  // While it works: the reply it is writing and its status line, from its
  // screen (lib/draft); a box without drafts gives its latest words.
  const drafts = useDraft({ box, session, agent, enabled: visible && !away && state === "running", mock });
  const onScreen = useScreenStatus(box, session, agent, visible && !mock && !away && state === "running" && !drafts.supported);
  const last = useConversations((st) => st.last[key]);
  const who = agent === "claude" ? "Claude" : agent ? agentLabel(agent) : "The agent";
  const [stuck, setStuck] = useState<{ at?: string; why: string }>();
  const stuckNow = stuck && stuck.at === s?.state_since ? stuck.why : undefined;
  const answerable = formAsk && canAnswer && agent === "claude" && !stuckNow;
  // Comments on the diff are kept per worktree, as Review keys them.
  const wt = s ? worktreeOf(locations, s) : undefined;
  const reviewKey = wt ? `${box}|${wt.worktree.path}` : undefined;
  const comments = useComments((st) => (reviewKey ? st.byKey[reviewKey] : undefined)) ?? NO_COMMENTS;

  // The demo makes up a conversation for an agent opened mid-way.
  useEffect(() => {
    if (!mock || !s || useConversations.getState().items[key]) return;
    const wt = worktreeOf(locations, s);
    const state = sessionState(s, stats);
    void mockConversation().then((m) => {
      if (!useConversations.getState().items[key]) m.seedTranscript(box, session, state, wt ? (wt.worktree.main ? wt.location.name : wt.worktree.name) : session);
    });
  }, [mock, s, key, box, session, stats, locations]);

  // The prompt it was started with (a long one, its start).
  const command = s?.command;
  const preset = s?.preset;
  const startedWith = useMemo(() => {
    const p = firstPrompt({ command, preset });
    return p && p.length > 4000 ? `${p.slice(0, 4000)}…` : p;
  }, [command, preset]);

  // What the box does not send, from the session's state: thinking while it
  // works, its question while it waits.
  const shown = useMemo(() => {
    if (mock) return withDraft(items, drafts.draft).items;
    const sentNow: TranscriptItem[] = [];
    // Started with a prompt it hasn't read yet, as it waits at a question
    // of its own (whether to trust its folder): the prompt shows as sent.
    // Its record takes its place once it reads it.
    if (startedWith && state === "waiting" && !items.some((it) => it.kind === "user")) sentNow.push({ kind: "user", id: "sent:first", text: startedWith, pending: true });
    // What was just sent shows at once, until the agent's own record of it
    // arrives (a moment later) and takes its place.
    for (const [i, p] of sent.entries()) if (!taken(items, p, i + 1)) sentNow.push({ kind: "user", id: `sent:${p.at}`, text: p.text, pending: state === "running" });
    // The reply being written, as its screen shows it, until its record has
    // the words; the record's message then takes the draft's row. Kept a
    // moment after the turn ends, as the two land in either order.
    const { items: out } = withDraft([...items, ...sentNow], drafts.draft);
    if (state === "running") {
      // Its words on screen that its record doesn't have yet (Claude Code
      // writes them after the step it is running), until the record does.
      if (onScreen?.said && !drafts.supported) {
        const said = plainWords(onScreen.said).slice(0, 80);
        if (said.length > 8 && !items.slice(-12).some((it) => it.kind === "text" && plainWords(it.text).includes(said))) out.push({ kind: "text", id: "live:said", text: onScreen.said, live: true });
      }
      // The step it runs, timed from the call; else its own word for what
      // it does, timed from its last words (a new agent: from its start).
      const began = Date.parse(s?.state_since ?? s?.created ?? "") || Date.now();
      const end = items[items.length - 1];
      const call = end?.kind === "tools" && !end.done ? end.items?.[end.items.length - 1] : undefined;
      const status = drafts.supported ? drafts.status : onScreen?.status;
      // It stays under a draft too, so the message replacing it moves
      // nothing.
      if (call) out.push({ kind: "thinking", id: "live:thinking", since: call.at ?? began, step: { verb: call.verb, target: call.target }, meta: status?.tokens });
      else out.push({ kind: "thinking", id: "live:thinking", since: Math.max(last ?? 0, began), label: status?.word, elapsed: status?.elapsed, meta: status?.tokens });
    }
    // Started with a prompt, it is about to work, not waiting for a first
    // task: say so until its own record arrives.
    else if (prompted && !items.length && (state === "ready" || state === "idle")) out.push({ kind: "thinking", id: "live:starting", since: Date.parse(s?.created ?? "") || Date.now() });
    const decided = answered && answered.at === s?.state_since ? answered.key : undefined;
    // A form of questions draws itself (its question item); one the chat
    // can't read from the record (an older box) only its screen answers.
    const form = formAsk || !!ask?.form;
    if (state === "waiting" && s?.ask?.tool && !form) {
      // The agent's hooks said what it asks: show that, with its screen's
      // options matched to Allow, Always allow and Deny.
      const choices = ask ? (permissionChoices(ask.choices) ?? ask.choices) : [];
      out.push({ kind: "ask", id: "live:ask", tool: s.ask.tool, detail: s.ask.input ?? "", why: s.ask.why, structured: true, choices, reading: !ask, decided });
    } else if (state === "waiting" && ask && !form && (ask.choices.length || s?.ask?.message || ask.detail)) {
      // A question needs words or options to answer: a screen without
      // either is not one (never a bare Yes / No).
      out.push({ kind: "ask", id: "live:ask", tool: "Question", detail: s?.ask?.message || ask.detail, choices: ask.choices, decided });
    }
    return out;
  }, [mock, items, state, s?.state_since, s?.ask, s?.created, startedWith, ask, answered, sent, prompted, onScreen, last, formAsk, drafts.draft, drafts.status, drafts.supported]);

  const edits = useMemo<EditActions | undefined>(() => {
    if (!client || (!canDiff && !mock)) return undefined;
    return {
      load: (file) => boxApi.diff(client, box, session, file),
      tool: (id) => (mock ? mockConversation().then((m) => m.mockToolDetail(id)) : boxApi.toolDetail(client, box, session, id)),
      comments: (file) =>
        reviewKey
          ? {
              list: comments.filter((c) => c.file === file),
              onAdd: (line, side, text) => addComment(reviewKey, { file, line, side, text }),
              onRemove: (id) => removeComment(reviewKey, id),
            }
          : undefined,
      review: (file) => {
        if (!reviewKey) return;
        useComments.setState({ focus: { key: reviewKey, file } });
        useNotifications.setState({ reviewFocus: reviewKey });
        useStore.getState().setView({ kind: "review" });
        if (!useReview.getState().entries.some((e) => e.key === reviewKey))
          toastManager.add({ type: "info", title: "Not in Review yet", description: `Review lists this worktree once ${who} finishes its turn.` });
      },
    };
  }, [client, canDiff, mock, box, session, reviewKey, comments, who]);

  // The agent's own screen (/model's picker, a dialog) opens as a live
  // terminal under the conversation; a question its hooks describe doesn't.
  const [nudge, setNudge] = useState(0);
  // A reply's idempotency key, kept until the box confirms it: sent again
  // after an error (the link dropped once the box had it), the same words
  // carry the same key, and the box types them once.
  const idem = useRef<{ text: string; key: string }>(undefined);
  // What the chat answers itself: a form of questions it can fill in, a
  // permission or menu whose options it read. Anything else (options it
  // can't read, a form it can't fill in, an answer that didn't take)
  // opens the agent's own screen.
  const pickedLabel = answered && answered.at === s?.state_since ? ask?.choices.find((c) => c.key === answered.key)?.label : undefined;
  const forWords = state === "waiting" && !!pickedLabel && /^(tell \S+ what|type something)/i.test(pickedLabel);
  const [stale, setStale] = useState<string>();
  useEffect(() => {
    // Answered, and still waiting a while later: it asks something else.
    if (!answered || answered.at !== s?.state_since || state !== "waiting" || forWords) return;
    const t = window.setTimeout(() => setStale(answered.at), 4000);
    return () => window.clearTimeout(t);
  }, [answered, s?.state_since, state, forWords]);
  const staleNow = !!stale && stale === s?.state_since;
  const recognised = state === "waiting" && !staleNow && (answerable || (!formAsk && !ask?.form && (ask ? !!ask.choices.length : !!s?.ask?.tool)));
  const live = useLiveScreen({ box, session, agent, enabled: visible && !mock && !away && !!s && state !== "exited" && !recognised, running: state === "running", nudge });

  // Claude Code and Codex write their conversation once they start: until
  // then a new agent has nothing to read yet, which is not a dead end.
  const readable = agent === "claude" || agent === "codex";
  const ended = state === "exited";
  // In its own pane when the pane says how; otherwise a new tab.
  const again = () => (onStartAgain ? onStartAgain() : void startSession(agent ?? "claude", { kind: "tab" }, agent ? agentLabel(agent) : "Agent"));
  // "Reading the conversation…" never stays: the box not having listed its
  // sessions or said what it can do (or a read not settling) a few seconds
  // on is an error with Retry, which asks the box again.
  // Counted only while the pane shows: a hidden chat doesn't read.
  const reading = visible && !mock && !away && (!listed || (feed === "loading" && !items.length && !ended));
  const stalled = useStalled(reading, FIRST_READ_TIMEOUT + 2_000, `${key}:${attempt}`);
  // The reply box and the controls around it take functions that stay the
  // same, calling this render's: a draft streaming in (a read every 600ms)
  // draws the chat again, not them (ChatFoot).
  const latest = useRef<FootActions>(undefined);
  const actions = useMemo<FootActions>(
    () => ({
      reply: (text) => latest.current!.reply(text),
      fail: (err) => latest.current!.fail(err),
      again: () => latest.current!.again(),
      showTerminal: () => latest.current!.showTerminal(),
      hideLive: () => latest.current!.hideLive(),
      sendComments: () => latest.current!.sendComments(),
    }),
    [],
  );
  const retry = () => {
    setAttempt((n) => n + 1);
    void useStore.getState().refreshBox(box);
  };

  // The box is away: what it last said may be stale, so say only that.
  if (away && !mock) {
    return (
      <PaneEmpty
        scene="offline"
        title={boxStatus?.state === "connecting" ? `Connecting to ${box}…` : boxStatus?.state === "untrusted" ? `${box} is ${boxWord(boxStatus?.state)}` : `Reconnecting to ${box}…`}
        description={
          <>
            {boxStatus?.state !== "untrusted" && <RetryLine box={box} className="mb-1.5" />}
            {`${agent ? agentLabel(agent) : "The agent"} ${s?.exited ? "had ended before then" : "keeps running there"}. This comes back by itself when ${box} is reachable again.`}
          </>
        }
      >
        <Button variant="outline" onClick={() => void tryNow(box)}>
          <RefreshCwIcon />
          Try now
        </Button>
      </PaneEmpty>
    );
  }
  // Not known yet: the box hasn't listed its sessions.
  if (!mock && !listed && !stalled) return <Reading />;

  if (!mock && (feed === "error" || stalled) && !items.length && !ended) {
    return (
      <PaneEmpty scene="storm" title="Couldn't read the conversation" description={`${box} didn't answer with it. The agent is unaffected; its terminal shows the same work.`}>
        <Button onClick={retry}>
          <RefreshCwIcon />
          Retry
        </Button>
        <Button variant="outline" onClick={onShowTerminal}>
          <SquareTerminalIcon />
          Show terminal
        </Button>
      </PaneEmpty>
    );
  }
  if (!mock && !ended && (feed === "unsupported" || (feed === "none" && !readable))) {
    return (
      <PaneEmpty
        title={feed === "none" ? `${agent ? agentLabel(agent) : "This agent"} works in its terminal` : `${box} needs an update for this`}
        description={
          feed === "none"
            ? "Shipyard can show Claude Code's and Codex's conversations here. This agent's work is in its terminal."
            : `${box} runs an older berthd that doesn't stream agents' conversations. Updating keeps your agents running.`
        }
      >
        {feed === "unsupported" && <UpgradeBox box={box} />}
        <Button variant="outline" onClick={onShowTerminal}>
          <SquareTerminalIcon />
          Show terminal
        </Button>
      </PaneEmpty>
    );
  }
  const onStep = (step: NextStep) => (step === "start-again" ? again() : step === "show-terminal" ? onShowTerminal() : step === "update-box" ? void updateBoxes([box]) : undefined);
  const fail = (err: unknown) => toastError(err, { title: "Couldn't send it", box, onStep });

  const answer = (id: string, choice: string) => {
    if (mock) {
      useConversations.getState().update(key, id, { decided: choice });
      void mockConversation().then((m) => m.finishTurn(box, session));
      return;
    }
    if (!client) return;
    setAnswered({ at: s?.state_since, key: choice });
    // The person is answering, so the box may type into a waiting agent:
    // a numbered option is its digit; a plain question, the word.
    const numbered = ask?.choices.some((c) => c.key === choice);
    boxApi.send(client, box, session, choice, !numbered, { when: "now", force: true }).catch((err) => {
      setAnswered(undefined);
      toastError(err, { title: "Couldn't answer", box, onStep });
    });
  };

  // The whole form's answers, filled in on the box; when they don't take,
  // the agent's own screen opens to finish there, saying why.
  const submitQuestions = async (tool: string, answers: QuestionAnswer[]) => {
    if (!client) throw new Error("Not connected");
    try {
      await answerQuestions(client, box, session, { tool, answers });
    } catch (err) {
      setStuck({ at: s?.state_since, why: errorMessage(err) });
      setNudge((n) => n + 1);
      throw err;
    }
  };

  const reply = async (text: string) => {
    if (mock && state !== "running") {
      useConversations.getState().push(key, { kind: "user", id: `u${Date.now()}`, text });
      void mockConversation().then((m) => m.finishTurn(box, session));
      return;
    }
    if (!client) return;
    // Typed for the person, at once when the agent waits for them, else
    // held until it is idle; the transcript shows it once the agent reads it.
    if (idem.current?.text !== text) idem.current = { text, key: `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
    const r = await boxApi.send(client, box, session, text, true, { ...(state === "waiting" ? { when: "now", force: true } : { when: "idle" }), idem_key: idem.current.key });
    idem.current = undefined;
    if (r.queued) queue.refresh();
    // A command ("/model", "!ls") shows as itself once the agent runs it;
    // one that opens a screen of its own is looked for at once.
    else if (/^[/!]/.test(text.trim())) setNudge((n) => n + 1);
    else setSent((l) => [...l, { text, at: Date.now(), seen: new Set(items.filter((it) => it.kind === "user").map((it) => it.id)) }]);
  };

  // A held prompt typed now. At a question it would be read as the answer,
  // so that asks first (force).
  const sendNow = async (q: QueuedPrompt, force = false) => {
    if (!client) return;
    if (state === "waiting" && !force) {
      setConfirm(q);
      return;
    }
    try {
      await boxApi.sendQueued(client, box, session, q.turn, force);
      if (mock) useConversations.getState().push(key, { kind: "user", id: `u${Date.now()}`, text: q.preview });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConfirm(q);
      else toastError(err, { title: "Couldn't send it now", box, onStep });
    } finally {
      queue.refresh();
    }
  };
  const cancel = async (q: QueuedPrompt) => {
    if (!client) return;
    try {
      await boxApi.unqueue(client, box, session, q.turn);
    } catch (err) {
      toastError(err, { title: "Couldn't cancel it", box, onStep });
    } finally {
      queue.refresh();
    }
  };
  // A prompt typed into an agent that hasn't taken it: its screen is
  // likely showing something else (a dialog of its own), which only its
  // terminal can answer.
  const untaken = !mock && state !== "running" && sent.some((p, i) => now - p.at > 8000 && !taken(items, p, i + 1));
  const tail = (
    <>
      {queue.items.map((q) => (
        <QueuedBubble key={q.turn} q={q} who={who} onSendNow={() => sendNow(q)} onCancel={() => cancel(q)} />
      ))}
      {untaken && (
        <div className="cv-in flex items-center gap-2 self-end text-muted-foreground text-xs">
          <span>{who} hasn't taken this yet: its terminal may be asking something.</span>
          <Button size="xs" variant="outline" onClick={onShowTerminal}>
            <SquareTerminalIcon />
            Show terminal
          </Button>
        </div>
      )}
    </>
  );
  // Why its own screen is open, when the chat knows.
  const liveWhy = stuckNow
    ? `${stuckNow} above`
    : formAsk && agent !== "claude"
      ? `${who}'s questions are answered in its own screen: answer them above`
      : formAsk && !canAnswer
        ? `${box} needs an update to answer ${who}'s questions here: answer them above`
        : ask?.form
          ? `${who}'s questions need its own screen here: answer them above`
          : staleNow
            ? `${who} is still asking: answer it in its screen above`
            : state === "waiting" && s?.ask?.tool && ask && !ask.choices.length
              ? `${who}'s options can't be read here: answer it in its screen above`
              : undefined;
  const toSend = pending(comments);
  // An agent at a menu (a permission, or numbered options) takes its answer
  // from the buttons above: Enter in the reply box would pick for it.
  const open = [...shown].reverse().find((it) => it.kind === "ask");
  // An option that asks for words ("Tell Claude what to change" on a plan)
  // leaves the agent at a text field once picked: the reply box types them.
  const wantsWords = forWords;
  const atMenu = !wantsWords && (formAsk || !!ask?.form || !!ask?.choices.length || !!s?.ask?.tool || (open?.kind === "ask" && !open.decided && (!!open.choices?.length || !!open.structured)));
  latest.current = { reply, fail, again, showTerminal: onShowTerminal, hideLive: live.hide, sendComments: () => sendComments(box, session, reviewKey!) };

  if (ended && !shown.length) {
    return (
      <PaneEmpty
        scene="ended"
        title={`${agent ? agentLabel(agent) : "This agent"} has ended`}
        description={gone ? `Its session is no longer on ${box}, so it can't take a reply. Start a new one in this worktree.` : "Its program closed, so it can't take a reply. Start a new one in this worktree, or look at what it left in its terminal."}
      >
        <Button onClick={again}>
          <AgentIcon agent={agent} className="size-3.5" />
          Start {agent ? agentLabel(agent) : "an agent"} again
        </Button>
        {!gone && (
          <Button variant="outline" onClick={onShowTerminal}>
            <SquareTerminalIcon />
            Show terminal
          </Button>
        )}
      </PaneEmpty>
    );
  }

  // Nothing said yet, by an agent that is open and at rest: the same
  // harbour, header and framed composer as an empty worktree, so starting an
  // agent looks the same either way. Never for one still reading, or one
  // that is working or waiting (those show what they are doing).
  // Given a prompt, but with nothing to show once it is done: its record
  // can't be read, which is not an agent waiting for a first task.
  if (!mock && prompted && !shown.length && (feed === "ready" || feed === "none") && state === "finished") {
    return (
      <PaneEmpty title={`${agent ? agentLabel(agent) : "The agent"} finished`} description="Its conversation can't be read here yet. Its terminal shows the work.">
        <Button onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCwIcon />
          Retry
        </Button>
        <Button variant="outline" onClick={onShowTerminal}>
          <SquareTerminalIcon />
          Show terminal
        </Button>
      </PaneEmpty>
    );
  }
  if (!shown.length && (mock || feed === "ready" || feed === "none") && state !== "running" && state !== "waiting" && !live.show) {
    const wt = s ? worktreeOf(locations, s) : undefined;
    return <FirstPrompt box={box} session={session} agent={agent} name={wt ? (wt.worktree.main ? wt.location.name : wt.worktree.name) : session} branch={wt?.worktree.branch} onSend={reply} onFail={fail} />;
  }

  return (
    // The column steps left of the floating loops panel when there is room
    // (a pane 900px wide, as beside the Files panel); in a narrower one the
    // composer rises above the loops pill instead.
    <div data-testid="chat" className="@container relative isolate flex min-h-0 flex-1 flex-col bg-background">
      <ChatBackground />
      <div className="min-h-0 flex-1 overflow-y-auto pt-6 pr-6 pb-4 pl-6 @[900px]:pr-[max(24px,var(--berth-loops-w,0px))]">
        {!mock && feed === "loading" && !items.length ? (
          <div className="flex h-full items-center justify-center text-sm">
            <PixelLoader label="Reading the conversation…" />
          </div>
        ) : (
          <ChatScope value={{ who, send: reply, showTerminal: onShowTerminal, startAgain: again }}>
            <QuestionsContext value={{ live: formAsk ? openQ?.tool : undefined, canAnswer: canAnswer && agent === "claude", stuck: stuckNow, submit: submitQuestions }}>
              <ConversationView chat={{ box, session, agent, visible, idle: state !== "running" && state !== "waiting" }} items={shown} onAnswer={answer} edits={edits} who={who} tail={tail} tailSize={queue.items.length + (untaken ? 1 : 0)} />
            </QuestionsContext>
          </ChatScope>
        )}
      </div>
      <div className="pr-6 pb-4 pl-6 @max-[899px]:pb-[max(16px,calc(var(--berth-loops-h,0px)+4px))] @[900px]:pr-[max(24px,var(--berth-loops-w,0px))]">
        <div className="mx-auto w-full max-w-(--berth-chat-w)">
          <ChatFoot
            box={box}
            session={session}
            agent={agent}
            state={state}
            stateSince={s?.state_since}
            dir={s?.dir}
            who={who}
            visible={visible}
            ended={ended}
            comments={reviewKey ? toSend.length : 0}
            live={live.show}
            mode={state === "running" ? "queue" : state === "waiting" ? "answer" : "send"}
            blocked={(state === "waiting" && atMenu) || live.show}
            hint={live.show ? (liveWhy ?? `${who} is showing its own screen: answer it above`) : wantsWords ? `Tell ${who} what to change, then press Enter` : answerable ? `Answer ${who}'s ${openQ?.questions.length === 1 ? "question" : "questions"} above` : undefined}
            actions={actions}
          />
        </div>
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={s?.ask?.tool ? `${who} is waiting for your permission` : `${who} is waiting on a question`}
        description={
          s?.ask?.tool
            ? `Sending now types your message into its permission prompt, where a key can pick one of its options. Answer the prompt first, or leave this queued to send once ${who} finishes.`
            : `Sending now types your message into its question, where ${who} reads it as the answer. Leave it queued to send it once ${who} finishes.`
        }
        confirm={s?.ask?.tool ? "Send anyway" : "Send as the answer"}
        onConfirm={() => (confirm ? sendNow(confirm, true) : undefined)}
      />
    </div>
  );
}

const NO_COMMENTS: LineComment[] = [];

interface FootActions {
  reply(text: string): Promise<void>;
  fail(err: unknown): void;
  again(): void;
  showTerminal(): void;
  hideLive(): void;
  sendComments(): Promise<{ sent: number; left: number; queued: boolean }>;
}

// ChatFoot is everything under the transcript: the controls around the
// reply box (ChatControls), comments to send, the agent's own screen when
// it shows one, and the reply box. It draws again only when one of these
// props changes; actions stay the same object.
const ChatFoot = memo(function ChatFoot({
  box,
  session,
  agent,
  state,
  stateSince,
  dir,
  who,
  visible,
  ended,
  comments,
  live,
  mode,
  blocked,
  hint,
  actions,
}: {
  box: string;
  session: string;
  agent?: string;
  state?: string;
  stateSince?: string;
  dir?: string;
  who: string;
  visible: boolean;
  ended: boolean;
  comments: number;
  live: boolean;
  mode: "send" | "queue" | "answer";
  blocked: boolean;
  hint?: string;
  actions: FootActions;
}) {
  const attach = useMemo(() => ({ box, session }), [box, session]);
  return (
    <ChatControls box={box} session={session} agent={agent} state={state} stateSince={stateSince} dir={dir} who={who} visible={visible} ended={ended} onShowTerminal={actions.showTerminal} onStartAgain={actions.again} onSend={actions.reply}>
      {ended ? (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          <StateGlyph state="exited" />
          <span className="min-w-0 flex-1">{agent ? agentLabel(agent) : "This agent"} has ended, so it can't take a reply.</span>
          <Button size="sm" variant="outline" onClick={actions.again}>
            Start {agent ? agentLabel(agent) : "an agent"} again
          </Button>
        </div>
      ) : (
        <>
          {comments > 0 && <CommentsStrip count={comments} who={who} onSend={actions.sendComments} />}
          {live && <LiveScreen box={box} session={session} agent={agent} onHide={actions.hideLive} onShowTerminal={actions.showTerminal} />}
          <Reply attach={attach} agent={agent} onSend={actions.reply} onFail={actions.fail} who={who} mode={mode} blocked={blocked} hint={hint} />
        </>
      )}
    </ChatControls>
  );
});

// The transcript keeps what was typed, at most 4000 characters, but not
// always as typed: a paste's spacing changes, an older box keeps Claude
// Code's <pasted_content> tags, and an attached image's path can read as
// "[Image #1]". Those are folded away before comparing.
const flat = (s: string) =>
  s
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/\[Image #\d+\]/g, " ")
    .replace(/\S*\/\.berth\/attachments\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const same = (a: string, b: string) => {
  const x = flat(a);
  const y = flat(b);
  if (x === y) return true;
  const head = Math.min(x.length, y.length, 200);
  return head >= 20 && x.slice(0, head) === y.slice(0, head);
};

// A sent prompt is taken once the transcript holds a prompt it didn't hold
// when it was sent: one like it, or, when the agent recorded it in words of
// its own, as many new prompts as were sent up to and including it.
const taken = (items: TranscriptItem[], p: { text: string; seen: Set<string> }, nth: number) => {
  const fresh = items.filter((it) => it.kind === "user" && !p.seen.has(it.id));
  return fresh.some((it) => it.kind === "user" && same(it.text, p.text)) || fresh.length >= nth;
};

// CommentsStrip offers the comments left on this worktree's diff to its
// agent, as one short prompt held until it is idle.
function CommentsStrip({ count, who, onSend }: { count: number; who: string; onSend(): Promise<{ sent: number; left: number; queued: boolean }> }) {
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await onSend();
      toastManager.add({ type: "success", title: `Sent ${r.sent} comment${r.sent === 1 ? "" : "s"} to ${who}`, description: r.queued ? `Queued: ${who} gets them when it finishes.` : r.left ? `${r.left} more didn't fit; send again.` : undefined });
    } catch (err) {
      toastError(err, { title: "Couldn't send the comments" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3 text-sm">
      <MessageSquareTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {count} comment{count === 1 ? "" : "s"} on the diff
      </span>
      <Button size="xs" loading={busy} onClick={() => void send()}>
        <SendIcon />
        Send to {who}
      </Button>
    </div>
  );
}

// Reply is the box at the foot, and says what Enter does: send now, queue
// it until the agent finishes, or answer the agent's question. While the
// agent waits at a menu, Enter there would pick its highlighted option, so
// it waits for the answer above.
// Images and files pasted or dropped on it go up to the agent's worktree
// (components/conversation/attachments), and their paths go with the reply.
// "/" and "@" open the agent's commands and the worktree's files
// (command-menu).
function Reply({ onSend, onFail, who, mode, blocked, hint, attach, agent }: { onSend(text: string): Promise<void>; onFail(err: unknown): void; who: string; mode: "send" | "queue" | "answer"; blocked?: boolean; hint?: string; attach?: AttachTarget; agent?: string }) {
  const [text, setText] = useState("");
  const att = useAttachments(attach);
  const menu = useComposerMenu({ box: attach?.box, session: attach && "session" in attach ? attach.session : undefined, agent, text, setText });
  const ready = (!!text.trim() || att.paths.length > 0) && !att.blocker;
  // Up and Down recall the prompts sent before (lib/history).
  const input = useRef<HTMLTextAreaElement>(null);
  const to = attach && "session" in attach ? attach.session : undefined;
  const recall = usePromptRecall(attach?.box, to, text, setText, input);
  // Sends what is typed, or a draft put in from elsewhere (a quote).
  const go = (draft = text) => {
    const t = withAttachments(draft.trim(), att.paths);
    if (!(draft.trim() || att.paths.length) || att.blocker || blocked) return;
    if (attach?.box && to) noteSent(attach.box, to, draft.trim());
    const kept = draft;
    setText("");
    onSend(t).then(att.clear, (err: unknown) => {
      // What was typed comes back (and the attachments stay), so nothing is
      // lost.
      setText((now) => now || kept);
      onFail(err);
    });
  };
  // Words quoted from the chat above (selection-actions) come in after
  // what is typed; with a question, they go at once, as Enter would.
  const fill = useRef<(f: QuoteFill) => void>(undefined);
  fill.current = (f) => {
    const draft = joinDraft(text, f.text);
    if (f.send && !blocked && !att.blocker) return go(draft);
    setText(draft);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  };
  useEffect(() => (attach?.box && to ? listenForQuotes(keyOf(attach.box, to), (f) => fill.current?.(f)) : undefined), [attach?.box, to]);
  const queue = mode === "queue";
  // While a file uploads, the field says so, and that the reply can be
  // written meanwhile.
  const placeholder =
    hint ??
    (blocked
      ? "Pick an answer above first"
      : att.uploading
        ? `${att.blocker}… write your reply meanwhile`
        : att.failed
          ? att.blocker
          : queue
            ? `${who} is working: it reads this at its next step`
            : mode === "answer"
              ? `Answer ${who}, or ask for something else`
              : "Reply, or ask for something else");
  return (
    <div data-testid="composer" className="relative" {...att.dropProps}>
      {menu.chip}
      {menu.menu}
      {/* Attachments sit inside the frame, above what is typed; the field and
          Send share the row below them. */}
      <InputGroup className={cn("flex-wrap has-data-[align=block-start]:flex-row **:[textarea]:min-h-0! **:[textarea]:min-w-0 **:[textarea]:flex-1 **:[textarea]:basis-0 **:[textarea]:py-2.5! **:[textarea]:max-h-[min(40vh,16rem)] **:[textarea]:overflow-y-auto", att.dragging && "border-ring ring-[3px]")}>
        {att.items.length > 0 && (
          <InputGroupAddon align="block-start" className="pt-2.5 pb-0 [&_svg]:mx-0">
            <AttachmentChips items={att.items} onRemove={att.remove} onRetry={att.retry} className="w-full" />
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          ref={input}
          rows={1}
          onPaste={att.onPaste}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onSelect={menu.onSelect}
          onKeyDown={(e) => {
            if (menu.onKeyDown(e)) return;
            if (recall(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go();
            }
          }}
          aria-label="Reply"
          placeholder={placeholder}
        />
        <InputGroupAddon align="inline-end" className="me-0! self-end pr-1.5 pb-1.5">
          <Tip
            label={
              att.blocker ?? (
                <span className="flex items-center gap-1.5">
                  {queue ? `Queue it for when ${who} finishes` : "Send"} <Kbd>↵</Kbd>
                </span>
              )
            }
          >
            {/* A disabled button takes no pointer: the wrapper keeps the tip. */}
            <span className="inline-flex">
              <Button size="icon-sm" className="rounded-lg" variant={queue ? "outline" : "default"} aria-label={queue ? "Queue" : "Send"} disabled={!ready || blocked} onClick={() => go()}>
                {queue ? <ListPlusIcon /> : <ArrowUpIcon />}
              </Button>
            </span>
          </Tip>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

// PaneEmpty is one of the pane's quiet states: a scene, what happened, and
// what to do next.
function PaneEmpty({ scene, title, description, children }: { scene?: SceneName; title: string; description: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-background p-6">
      <Empty>
        <EmptyHeader>
          {scene ? (
            <div className="mb-2 text-muted-foreground/80">
              <Scene name={scene} width={136} />
            </div>
          ) : (
            <EmptyMedia variant="icon">
              <MessagesSquareIcon />
            </EmptyMedia>
          )}
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children && (
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">{children}</div>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

// useStalled is whether active has held for ms, counted afresh whenever
// active or reset changes.
function useStalled(active: boolean, ms: number, reset: string): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!active) return;
    const t = window.setTimeout(() => setStalled(true), ms);
    return () => window.clearTimeout(t);
  }, [active, ms, reset]);
  return active && stalled;
}

function Reading() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background text-sm">
      <PixelLoader label="Reading the conversation…" />
    </div>
  );
}

const boxWord = (state?: string) => (state === "untrusted" ? "unreachable" : (state ?? "offline"));

// FirstPrompt is an agent that hasn't been asked anything yet: the harbour
// band, the worktree, and the composer for its first task, as everywhere
// work starts.
function FirstPrompt({ box, session, agent, name, branch, onSend, onFail }: { box: string; session: string; agent?: string; name: string; branch?: string; onSend(text: string): Promise<void>; onFail(err: unknown): void }) {
  const light = useHarbourLight();
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <DitherBand src={HARBOUR[light]} position={0.45} fade={0.5} mute={HARBOUR_MUTE[light]} className="absolute inset-x-0 top-0 h-[clamp(160px,30vh,280px)]" />
      <div className="relative flex min-h-full items-start justify-center px-6 pt-[clamp(120px,24vh,230px)] pb-10">
        <div className="w-full max-w-[calc(var(--berth-chat-w)-120px)]">
          <header className="mb-4 px-2 [text-shadow:0_0_6px_var(--background),0_0_14px_var(--background)]">
            <h1 className="truncate font-semibold text-lg tracking-tight">{name}</h1>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
              {branch && <span className="min-w-0 truncate rounded bg-accent px-1.5 py-px font-mono text-[0.6875rem]">{branch}</span>}
              <span className="shrink-0 rounded bg-accent px-1.5 py-px font-mono text-[0.6875rem]">{box}</span>
            </div>
          </header>
          <TaskComposer to={{ box, session, agent }} onSend={onSend} onFail={onFail} autoFocus />
          {/* What runs in the worktree, and plugins' sections. */}
          <SessionWorktreeSections box={box} session={session} className="mt-6" />
        </div>
      </div>
    </div>
  );
}
