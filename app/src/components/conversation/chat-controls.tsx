import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  EyeIcon,
  FilePenLineIcon,
  HandIcon,
  Minimize2Icon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { ArtBoardChip, useSessionArt } from "@/components/art/board-buttons";
import { ArtifactsChip, useArtifacts } from "@/components/conversation/artifacts";
import { CrewCard } from "@/components/conversation/crew-card";
import { teammatesOf } from "@/lib/agent-messages";
import { NoticeCard } from "@/components/conversation/notice-card";
import { TodoCard } from "@/components/conversation/todo-card";
import { toastError } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { agentPresets } from "@/lib/actions";
import {
  type ChatJob,
  type ChatSignals,
  CLAUDE_MODES,
  contextWindow,
  effortLabel,
  interrupt,
  jobDetail,
  kTokens,
  modeLabel,
  modelLabel,
  type NoticeItem,
  sendCommand,
  switchMode,
  useChatSignals,
  useScreenControls,
} from "@/lib/chat-controls";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { useEventLog } from "@/lib/events";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import type { ToolDetail, TranscriptItem } from "@/lib/transcript";
import { memoryNote } from "@/lib/processes";
import { cn } from "@/lib/utils";

// ChatControls is everything around the reply box that lets the chat stand
// in for the agent's terminal: Stop (and Esc in the reply box) while it
// works, its permission mode and model, how full its context is, the work
// it left running in the background, its task list and crew docked above,
// and the notices only its state or screen knows (a turn that ended in an
// error, an agent that exited, a limit shown on screen). The reply box is
// its child.

export interface ChatControlsProps {
  box: string;
  session: string;
  agent?: string;
  // The session's state: running, waiting, finished, idle, exited…
  state?: string;
  stateSince?: string;
  dir?: string;
  who: string;
  visible: boolean;
  ended: boolean;
  onShowTerminal(): void;
  onStartAgain(): void;
  // Types text for the agent, as the reply box does (for "Try again").
  onSend(text: string): Promise<void>;
  children: ReactNode;
}

export function ChatControls({ box, session, agent, state, stateSince, dir, who, visible, ended, onShowTerminal, onStartAgain, onSend, children }: ChatControlsProps) {
  const mock = isMock();
  const supported = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("controls")) || mock;
  const sig = useChatSignals(box, session);
  const { controls, refresh } = useScreenControls(box, session, visible && !ended && (agent === "claude" || agent === "codex"), stateSince);
  const working = state === "running";
  const [stopping, setStopping] = useState(false);
  const items = useConversations((s) => s.items[keyOf(box, session)]);
  // The helpers it sent out (Labs), docked with its task list.
  const labs = usePrefs((p) => p.labs);
  const crew = useConversations((s) => s.crew[keyOf(box, session)]);
  const scope = { who, send: onSend, showTerminal: onShowTerminal, startAgain: onStartAgain };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const r = await interrupt(box, session);
      if (!r.stopped) toastManager.add({ type: "info", title: `${who} hasn't stopped yet`, description: "Esc reached it, but its screen still shows it working. Look at its terminal, or press Stop again." });
    } catch (err) {
      toastError(err, { title: `Couldn't stop ${who}`, box });
    } finally {
      setStopping(false);
    }
  };

  // Esc in the reply box stops the agent, as it does at its terminal. A
  // menu open in the box (commands, files) takes Esc first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || !working || !supported) return;
    if (!(e.target instanceof HTMLTextAreaElement)) return;
    e.preventDefault();
    void stop();
  };

  // Teammates who wrote to the agent join its crew.
  const teammates = useMemo(() => teammatesOf(items), [items]);
  const usage = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session)?.usage);
  const docked = useDockedNotices({ box, session, dir, state, ended, items, screenLimit: controls?.limit, memory: ended ? undefined : memoryNote(usage) });
  // The pages the agent published stay listed after it has ended.
  const pages = useArtifacts(box, session).length;
  const made = useSessionArt(box, session).length;
  const published = pages > 0 || made > 0;
  const chips = !ended && (agent === "claude" || agent === "codex");

  return (
    <div data-chat-controls>
      {docked.map((n) => (
        <div key={n.id} className="mb-2">
          <NoticeCard it={n} scope={scope} />
        </div>
      ))}
      {!ended && sig?.retrying && working && <Retrying r={sig.retrying} />}
      {!ended && labs && (!!crew?.length || teammates.length > 0) && <CrewCard key={keyOf(box, session)} crew={crew ?? []} teammates={teammates} chat={{ box, session }} />}
      {!ended && !!sig?.todos?.length && <TodoCard todos={sig.todos} session={keyOf(box, session)} working={working} />}
      <div onKeyDown={onKeyDown}>{children}</div>
      {(chips || published) && (
        <div className="mt-1.5 flex min-h-6 flex-wrap items-center gap-x-0.5 gap-y-1 px-0.5">
          {chips && agent && (
            <>
              <ModeChip box={box} session={session} agent={agent} sig={sig} screenMode={controls?.mode} onSwitched={refresh} waiting={state === "waiting"} supported={supported} who={who} />
              <ModelChip box={box} session={session} agent={agent} sig={sig} screenEffort={controls?.effort} busy={working || state === "waiting"} items={items} />
              <ContextChip box={box} session={session} sig={sig} busy={working || state === "waiting"} />
              <BackgroundChip box={box} session={session} jobs={sig?.background} who={who} />
            </>
          )}
          <span className="flex-1" />
          <ArtBoardChip box={box} session={session} className={chip} />
          <ArtifactsChip box={box} session={session} who={who} className={chip} />
          {chips && working && supported && (
            <Tip
              label={
                <span className="flex items-center gap-1.5">
                  Stop {who}, as Esc does at its terminal <Kbd>Esc</Kbd>
                </span>
              }
            >
              <Button size="xs" variant="outline" loading={stopping} onClick={() => void stop()} aria-label={`Stop ${who}`} className="gap-1.5">
                <SquareIcon className="size-2.5! fill-current" />
                Stop
                <Kbd className="-mr-0.5 h-4 min-w-0 px-1 text-[0.625rem]">Esc</Kbd>
              </Button>
            </Tip>
          )}
        </div>
      )}
    </div>
  );
}

// --- Notices only the session's state or screen knows ---

// useDockedNotices finds what the transcript can't say: a turn that ended
// in an error (Claude's StopFailure hook), an agent whose program ended
// while it worked, a usage limit on its screen. Each shows above the reply
// box until the conversation moves on.
function useDockedNotices({ box, session, dir, state, ended, items, screenLimit, memory }: { box: string; session: string; dir?: string; state?: string; ended: boolean; items?: { kind: string; id: string; notice?: string }[]; screenLimit?: string; memory?: string }): NoticeItem[] {
  // The last state seen while the pane was open, to tell an agent that
  // ended mid-work from one that was closed when it was done.
  const last = useRef<string | undefined>(undefined);
  const [diedWorking, setDiedWorking] = useState(false);
  useEffect(() => {
    if (state === "exited" && (last.current === "running" || last.current === "waiting")) setDiedWorking(true);
    if (state && state !== "exited") {
      last.current = state;
      setDiedWorking(false);
    }
  }, [state]);
  const failed = useEventLog((s) =>
    s.events.find((e) => e.box === box && e.type === "agent.finished" && (e.data?.session === session || e.data?.name === session || (!!dir && e.data?.path === dir))),
  );
  return useMemo(() => {
    const out: NoticeItem[] = [];
    const list = items ?? [];
    // What happened since the last prompt.
    let from = list.length;
    while (from > 0 && list[from - 1].kind !== "user") from--;
    const since = list.slice(from);
    const said = (kinds: string[]) => since.some((it) => it.kind === "notice" && kinds.includes(it.notice ?? ""));
    if (ended && diedWorking) out.push({ kind: "notice", id: "dock:exited", notice: "exited", level: "error", text: "Its program ended while it was working. Its terminal may show why." });
    else if (!ended && state === "finished" && failed?.data?.status === "error" && !said(["api_error", "limit", "rate_limit", "auth", "billing", "interrupted"]))
      out.push({ kind: "notice", id: "dock:stopfailure", notice: "stop_failure", level: "error", text: "Its turn stopped on an API error. Its terminal shows the details." });
    if (!ended && screenLimit && !said(["limit", "rate_limit"])) out.push({ kind: "notice", id: "dock:limit", notice: "limit", level: "warning", text: screenLimit });
    // Its processes near the box's per-session memory ceiling: the box
    // slows them down there; nothing is stopped.
    if (memory) out.push({ kind: "notice", id: "dock:memory", notice: "memory", level: "warning", text: `This session is ${memory}. Near it the box slows the session down rather than stopping anything. The limit is in Settings › Boxes.` });
    return out;
  }, [items, ended, diedWorking, state, failed, screenLimit, memory]);
}

function Retrying({ r }: { r: NonNullable<ChatSignals["retrying"]> }) {
  return (
    <div role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-1.5 text-[0.8125rem] dark:bg-warning/[0.08]">
      <Spinner className="size-3.5 text-warning-foreground" />
      <span className="min-w-0 flex-1 truncate">{r.message}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{r.attempt ? `Retrying · ${r.attempt}${r.max ? ` of ${r.max}` : ""}` : "Retrying"}</span>
    </div>
  );
}

// --- Chips ---

const chip =
  "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-60";

const MODE_ICON: Record<string, typeof HandIcon> = { default: HandIcon, acceptEdits: FilePenLineIcon, plan: ClipboardListIcon, auto: SparklesIcon, bypassPermissions: ShieldAlertIcon };

function ModeChip({ box, session, agent, sig, screenMode, onSwitched, waiting, supported, who }: { box: string; session: string; agent: string; sig?: ChatSignals; screenMode?: string; onSwitched(): void; waiting: boolean; supported: boolean; who: string }) {
  const [pending, setPending] = useState<string>();
  // The screen says the mode as it is now; the transcript, as of the last
  // prompt.
  const mode = pending ?? screenMode ?? sig?.mode;
  if (!mode) return null;
  const bypass = mode === "bypassPermissions";
  const Icon = MODE_ICON[mode] ?? HandIcon;
  const label = modeLabel(agent, mode);
  if (agent === "codex") {
    return (
      <Menu>
        <MenuTrigger render={<button type="button" className={chip} aria-label={`Approval mode: ${label}`} />}>
          <HandIcon className="size-3.5" />
          {label}
          <ChevronDownIcon className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="w-64">
          <MenuGroup>
            <MenuGroupLabel>Codex asks before running commands</MenuGroupLabel>
            <MenuItem disabled className="text-muted-foreground text-xs">
              Now: {label} ({mode})
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => void sendCommand(box, session, "/approvals", false).catch((err) => toastError(err, { title: "Couldn't open /approvals", box }))}>Change with /approvals…</MenuItem>
        </MenuPopup>
      </Menu>
    );
  }
  const pick = async (to: string) => {
    if (to === mode || pending) return;
    setPending(to);
    try {
      const got = await switchMode(box, session, to);
      if (got !== to) toastManager.add({ type: "warning", title: `${who} stayed in ${modeLabel(agent, got)}` });
      onSwitched();
      // The screen read after the switch takes over.
      window.setTimeout(() => setPending(undefined), 1200);
    } catch (err) {
      setPending(undefined);
      toastError(err, { title: `Couldn't switch to ${modeLabel(agent, to)}`, box });
    }
  };
  const look = cn(chip, bypass && "bg-destructive/10 text-destructive-foreground hover:bg-destructive/15 hover:text-destructive-foreground", mode === "plan" && "text-info-foreground", mode === "acceptEdits" && "text-foreground/80");
  const face = (
    <>
      {pending ? <Spinner className="size-3" /> : <Icon className="size-3.5" />}
      {label}
      <ChevronDownIcon className="size-3 opacity-60" />
    </>
  );
  // Blocked, it says why rather than opening: a menu whose trigger comes
  // and goes would lose its anchor.
  if (waiting || !supported)
    return (
      <Tip label={waiting ? `Answer ${who} first: Shift+Tab at its question would pick an option` : `${box} needs an update to switch modes from here`}>
        <button type="button" aria-disabled className={cn(look, "cursor-default opacity-70 hover:bg-transparent")} aria-label={`Permission mode: ${label}`}>
          {face}
        </button>
      </Tip>
    );
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={look} aria-label={`Permission mode: ${label}`} />}>{face}</MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Permission mode</MenuGroupLabel>
          <MenuRadioGroup value={mode} onValueChange={(v) => void pick(v as string)}>
            {CLAUDE_MODES.map((m) => {
              const I = MODE_ICON[m.id] ?? HandIcon;
              const danger = m.id === "bypassPermissions";
              return (
                <MenuRadioItem key={m.id} value={m.id} closeOnClick className={cn("items-start py-1.5", danger && "text-destructive-foreground")}>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 font-medium">
                      <I className="size-3.5" />
                      {m.label}
                    </span>
                    <span className={cn("text-xs", danger ? "text-destructive-foreground/80" : "text-muted-foreground")}>{m.hint}</span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function ModelChip({ box, session, agent, sig, screenEffort, busy, items }: { box: string; session: string; agent: string; sig?: ChatSignals; screenEffort?: string; busy: boolean; items?: TranscriptItem[] }) {
  const info = useStore((s) => s.boxes[box]?.info);
  const locations = useStore((s) => s.boxes[box]?.locations);
  const preset = useMemo(() => (info ? agentPresets(box).find((p) => p.id === agent) : undefined), [info, locations, box, agent]);
  // A switch shows at once; the model the transcript names takes over once
  // the agent next answers with a different one.
  // A switch is typed as /model or /effort. Claude Code may ask to confirm
  // it (on its own screen, shown inline), and says "Set model to …" once it
  // has: that is what the chip shows, until the agent answers with the new
  // model. Until then the chip says it is switching.
  const [pending, setPending] = useState<{ to: string; kind: "model" | "effort"; at: number; seen: number }>();
  const said = useMemo(() => lastSet(items ?? []), [items]);
  useEffect(() => {
    if (!pending) return;
    if (said[pending.kind] && said.at >= pending.seen) return setPending(undefined);
    const t = window.setTimeout(() => setPending(undefined), Math.max(0, 90_000 - (Date.now() - pending.at)));
    return () => window.clearTimeout(t);
  }, [pending, said]);
  const model = said.model ?? sig?.model;
  const effort = said.effort ?? sig?.effort ?? screenEffort;
  if (!model) return null;
  const models = preset?.models ?? (agent === "claude" ? ["opus", "sonnet", "haiku"] : []);
  const efforts = preset?.efforts ?? [];
  const current = models.find((m) => model.toLowerCase().includes(m));
  const send = async (text: string, next?: { to: string; kind: "model" | "effort" }) => {
    try {
      const r = await sendCommand(box, session, text, busy);
      if (next && !isMock()) setPending({ ...next, at: Date.now(), seen: items?.length ?? 0 });
      toastManager.add({ type: "success", title: r.queued ? `${text} is queued for when the agent finishes` : `Sent ${text}` });
    } catch (err) {
      toastError(err, { title: `Couldn't send ${text}`, box });
    }
  };
  const label = pending ? `Switching to ${pending.kind === "model" ? modelLabel(pending.to) : `${effortLabel(pending.to)} effort`}…` : [modelLabel(model), effort && effortLabel(effort)].filter(Boolean).join(" · ");
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={chip} aria-label={`Model: ${label}`} />}>
        {pending ? <Spinner className="size-3" /> : <BotIcon className="size-3.5" />}
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-60">
        {agent === "claude" && models.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Model{busy ? " · switches when it finishes" : ""}</MenuGroupLabel>
            <MenuRadioGroup value={current ?? ""} onValueChange={(v) => void send(`/model ${v}`, { to: v as string, kind: "model" })}>
              {models.map((m) => (
                <MenuRadioItem key={m} value={m} closeOnClick>
                  {modelLabel(m)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : (
          <MenuItem onClick={() => void send("/model")}>Change model…</MenuItem>
        )}
        {agent === "claude" && efforts.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Effort</MenuGroupLabel>
              <MenuRadioGroup value={effort ?? ""} onValueChange={(v) => void send(`/effort ${v}`, { to: v as string, kind: "effort" })}>
                {efforts.map((e) => (
                  <MenuRadioItem key={e} value={e} closeOnClick>
                    {effortLabel(e)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <MenuItem disabled className="flex-col items-start gap-0.5 text-muted-foreground text-xs">
          <span>Now: {model}</span>
          {agent === "claude" && <span>Claude Code also makes a switch its default for new sessions.</span>}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// lastSet reads the model and effort Claude Code last said it set ("Set
// model to Sonnet 4.5", "Kept model as Opus 5.5" when its confirmation was
// declined, "Set effort level to high") after the agent's last
// answer, which already names its model; at is where.
function lastSet(items: TranscriptItem[]): { model?: string; effort?: string; at: number } {
  const out: { model?: string; effort?: string; at: number } = { at: -1 };
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "text") break;
    if (it.kind !== "command" || !it.text) continue;
    const m = /(?:Set model to|Kept model as)\s+`?([^`\n]+?)`?(?:\s+and\b|\s*$|\n)/.exec(it.text);
    const e = /Set effort level to\s+(\w+)/.exec(it.text);
    if (m && !out.model) out.model = m[1].trim();
    if (e && !out.effort) out.effort = e[1].toLowerCase();
    if ((m || e) && out.at < 0) out.at = i;
  }
  if (out.at < 0) out.at = items.length;
  return out;
}

function ContextChip({ box, session, sig, busy }: { box: string; session: string; sig?: ChatSignals; busy: boolean }) {
  const [sending, setSending] = useState(false);
  const c = sig?.context;
  if (!c?.tokens) return null;
  const win = contextWindow(sig?.model, c.tokens, c.window);
  const pct = Math.min(100, Math.round((c.tokens / win) * 100));
  const high = pct >= 80;
  const full = pct >= 92;
  const compact = async () => {
    setSending(true);
    try {
      const r = await sendCommand(box, session, "/compact", busy);
      toastManager.add({ type: "success", title: r.queued ? "/compact is queued for when the agent finishes" : "Compacting the conversation" });
    } catch (err) {
      toastError(err, { title: "Couldn't send /compact", box });
    } finally {
      setSending(false);
    }
  };
  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" className={cn(chip, "tabular-nums", high && "text-warning-foreground hover:text-warning-foreground", full && "text-destructive-foreground hover:text-destructive-foreground")} aria-label={`${pct}% of context used`} />}
      >
        <Ring pct={pct} />
        {pct}%{high ? " · compact" : ""}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-72">
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{pct}% of context used</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {kTokens(c.tokens)} of {kTokens(win)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn("h-full rounded-full", full ? "bg-destructive" : high ? "bg-warning" : "bg-foreground/60")} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-muted-foreground text-xs">
            {high
              ? "It is filling up: the agent compacts on its own when it runs out, mid-task. Compacting now, between tasks, keeps what matters."
              : "What the agent holds of this conversation, as of its last answer. /compact summarises it to free room."}
          </p>
          <Button size="sm" variant={high ? "default" : "outline"} loading={sending} onClick={() => void compact()} className="self-start">
            <Minimize2Icon />
            {busy ? "Compact when it finishes" : "Compact now"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 5;
  const len = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(pct / 100) * len} ${len}`} strokeLinecap="round" />
    </svg>
  );
}

// --- Background work ---

const RECENT = 5 * 60_000;

function BackgroundChip({ box, session, jobs, who }: { box: string; session: string; jobs?: ChatJob[]; who: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const list = jobs ?? [];
  const running = list.filter((j) => j.state === "running" || j.state === "starting");
  const recent = list.filter((j) => j.until && now - j.until < RECENT);
  if (!running.length && !recent.length) return null;
  const shells = running.filter((j) => j.kind === "shell").length;
  const label = running.length
    ? `${running.length} ${shells === running.length ? (running.length === 1 ? "shell" : "shells") : running.length === 1 ? "task" : "tasks"} running`
    : `${recent.length} finished`;
  return (
    <Popover>
      <PopoverTrigger render={<button type="button" className={cn(chip, running.length && "text-foreground/85")} aria-label={`Background work: ${label}`} />}>
        <span className="relative flex size-2 items-center justify-center" aria-hidden>
          {running.length > 0 && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/50" />}
          <span className={cn("relative inline-flex size-1.5 rounded-full", running.length ? "bg-success" : "bg-muted-foreground/50")} />
        </span>
        {label}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[min(30rem,calc(100vw-2rem))]">
        <div className="flex flex-col gap-1">
          <div className="mb-1 text-muted-foreground text-xs">Left running in the background by {who}</div>
          {[...list].reverse().map((j) => (
            <JobRow key={j.tool} box={box} session={session} job={j} now={now} />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function JobRow({ box, session, job, now }: { box: string; session: string; job: ChatJob; now: number }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolDetail>();
  const [error, setError] = useState<string>();
  const live = job.state === "running" || job.state === "starting";
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const read = () =>
      jobDetail(box, session, job.tool)
        .then((d) => alive && (setDetail(d), setError(undefined)))
        .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    void read();
    const t = live ? window.setInterval(read, 2000) : 0;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open, box, session, job.tool, live]);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [detail?.output]);
  const Icon = job.kind === "monitor" ? EyeIcon : TerminalIcon;
  const took = fmtDur((job.until ?? now) - job.since);
  return (
    <div className="rounded-md">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem]">{job.label || job.command}</span>
          {job.label && <span className="block truncate font-mono text-[0.7188rem] text-muted-foreground">{job.command}</span>}
        </span>
        <State job={job} />
        <span className="w-12 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{took}</span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mx-1.5 mb-1.5">
          {error ? (
            <p className="px-1 py-2 text-destructive-foreground text-xs">{error}</p>
          ) : !detail ? (
            <div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-xs">
              <Spinner className="size-3" /> Reading its output…
            </div>
          ) : (
            <pre ref={pre} data-selectable className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[0.7188rem] leading-relaxed">
              {detail.truncated && <span className="text-muted-foreground">…{"\n"}</span>}
              {detail.output?.trim() || "(nothing printed yet)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function State({ job }: { job: ChatJob }) {
  switch (job.state) {
    case "running":
    case "starting":
      return <span className="shrink-0 rounded-full bg-success/12 px-1.5 py-px text-[0.6875rem] text-success-foreground">Running</span>;
    case "done":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <CheckIcon className="size-3 text-success" />
          Done
        </span>
      );
    case "failed":
      return <span className="shrink-0 text-[0.6875rem] text-destructive-foreground">Failed</span>;
    default:
      return <span className="shrink-0 text-[0.6875rem] text-muted-foreground">Stopped</span>;
  }
}

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
