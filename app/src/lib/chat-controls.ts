import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { isMock } from "@/hooks/use-berth-connection";
import { boxApi } from "@/lib/api";
import { useFedSignals } from "@/lib/chat-signals";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { useStore } from "@/lib/store";
import type { ToolDetail, TranscriptItem } from "@/lib/transcript";

// The chat's controls read what the agent's own record says about it, its
// signals: the permission mode, model, effort and context use, its task
// list, the work it left running in the background, and a request it is
// retrying (internal/transcript/signals.go). The box's screen says the
// mode as it is now (GET .../controls), since a mode switched at the
// terminal is only written with the next prompt.

export interface ChatTodo {
  id?: string;
  text: string;
  active?: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ChatJob {
  tool: string;
  task?: string;
  kind: "shell" | "monitor";
  command: string;
  label?: string;
  state: "starting" | "running" | "done" | "failed" | "stopped";
  since: number;
  until?: number;
}

export interface ChatSignals {
  mode?: string;
  model?: string;
  effort?: string;
  context?: { tokens: number; window?: number; at?: number };
  todos?: ChatTodo[];
  background?: ChatJob[];
  retrying?: { message: string; attempt?: number; max?: number; at: number };
}

export interface ScreenControls {
  agent: string;
  mode?: string;
  effort?: string;
  modes?: string[];
  limit?: string;
}

export type NoticeItem = Extract<TranscriptItem, { kind: "notice" }>;

const enc = encodeURIComponent;

export const hasControls = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("controls");

// useChatSignals is a session's signals while its chat shows. They come
// with each read of its transcript, which the chat's feed makes anyway (on
// open, every few seconds, and at once when something happens to it or
// the agent writes): the feed keeps them (lib/chat-signals), so they cost
// no read of their own.
export function useChatSignals(box: string, session: string): ChatSignals | undefined {
  const mock = isMock();
  const [sig, setSig] = useState<ChatSignals>();
  const fed = useFedSignals((s) => s.byKey[keyOf(box, session)]);
  useEffect(() => {
    if (!mock) return;
    setSig(mockSignals(session));
    return useMockSignals.subscribe(() => setSig(mockSignals(session)));
  }, [box, session, mock]);
  return mock ? sig : fed;
}

// useScreenControls reads the mode off the agent's screen when the chat
// opens, when its state changes, and when asked (after a switch).
export function useScreenControls(box: string, session: string, enabled: boolean, since?: string): { controls?: ScreenControls; refresh(): void } {
  const client = useStore((s) => s.client);
  const supported = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("controls"));
  const [controls, setControls] = useState<ScreenControls>();
  const [tick, setTick] = useState(0);
  useEffect(() => setControls(undefined), [box, session]);
  useEffect(() => {
    if (isMock() || !client || !enabled || !supported) return;
    let alive = true;
    client
      .box<ScreenControls>(box, "GET", `sessions/${enc(session)}/controls`)
      .then((c) => alive && setControls(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, box, session, enabled, supported, since, tick]);
  return { controls, refresh: () => setTick((n) => n + 1) };
}

// interrupt presses Esc for the agent and ends its turn; stopped says the
// box saw it stop.
export async function interrupt(box: string, session: string): Promise<{ stopped: boolean }> {
  if (isMock()) {
    mockInterrupt(box, session);
    return { stopped: true };
  }
  const client = useStore.getState().client;
  if (!client) throw new Error("Not connected");
  return client.box<{ stopped: boolean }>(box, "POST", `sessions/${enc(session)}/interrupt`);
}

// switchMode presses Shift+Tab until the agent's screen shows mode.
export async function switchMode(box: string, session: string, mode: string): Promise<string> {
  if (isMock()) {
    useMockSignals.setState((s) => ({ modes: { ...s.modes, [session]: mode } }));
    return mode;
  }
  const client = useStore.getState().client;
  if (!client) throw new Error("Not connected");
  const r = await client.box<{ mode: string }>(box, "POST", `sessions/${enc(session)}/mode`, { mode });
  return r.mode;
}

// sendCommand types one of the agent's own commands (/model opus,
// /compact): at once when it is idle, else when it finishes.
export async function sendCommand(box: string, session: string, text: string, busy: boolean): Promise<{ queued: boolean }> {
  if (isMock()) {
    const m = /^\/model\s+(\S+)/.exec(text);
    if (m) useMockSignals.setState((s) => ({ models: { ...s.models, [session]: m[1] } }));
    const e = /^\/effort\s+(\S+)/.exec(text);
    if (e) useMockSignals.setState((s) => ({ efforts: { ...s.efforts, [session]: e[1] } }));
    if (/^\/compact/.test(text)) useMockSignals.setState((s) => ({ compacted: { ...s.compacted, [session]: true } }));
    return { queued: false };
  }
  const client = useStore.getState().client;
  if (!client) throw new Error("Not connected");
  const r = await boxApi.send(client, box, session, text, true, busy ? { when: "idle" } : { when: "now" });
  return { queued: !!r.queued };
}

// jobDetail is a background shell's command and its output so far.
export function jobDetail(box: string, session: string, tool: string): Promise<ToolDetail> {
  if (isMock()) return mockJobDetail(tool);
  const client = useStore.getState().client;
  if (!client) return Promise.reject(new Error("Not connected"));
  return boxApi.toolDetail(client, box, session, tool);
}

// --- Words ---

// The modes, as people say them. Claude Code's are cycled with Shift+Tab;
// Codex's approval policy is set with /approvals.
export const CLAUDE_MODES: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Ask before edits", hint: "Asks before each edit and command" },
  { id: "acceptEdits", label: "Accept edits", hint: "Edits files without asking; asks before commands" },
  { id: "plan", label: "Plan", hint: "Reads and plans; changes nothing until you approve" },
  { id: "auto", label: "Auto", hint: "Decides what's safe to run without asking" },
  { id: "bypassPermissions", label: "Bypass permissions", hint: "Runs anything without asking" },
];

const CODEX_MODES: Record<string, string> = { never: "Never ask", "on-request": "Ask on request", "on-failure": "Ask on failure", untrusted: "Ask for untrusted" };

export function modeLabel(agent: string | undefined, mode: string | undefined): string {
  if (!mode) return "Mode";
  if (agent === "codex") return CODEX_MODES[mode] ?? mode;
  return CLAUDE_MODES.find((m) => m.id === mode)?.label ?? mode;
}

// modelLabel turns a model ID into its name: "claude-opus-5-5" → "Opus 5.5",
// "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "opus" → "Opus".
export function modelLabel(model: string | undefined): string {
  if (!model) return "Model";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  if (/^[a-z]+$/.test(model)) return model[0].toUpperCase() + model.slice(1);
  return model;
}

export const effortLabel = (e: string) => (e === "xhigh" ? "Extra high" : e[0].toUpperCase() + e.slice(1));

// contextWindow is a model's context window in tokens. Codex says its own;
// Claude's is known by family, and a conversation past 200k is on the
// 1M-token window.
export function contextWindow(model: string | undefined, tokens: number, said?: number): number {
  if (said) return said;
  const m = model ?? "";
  let w = 200_000;
  if (/\[1m\]/.test(m) || /^claude-(opus|fable)-5/.test(m)) w = 1_000_000;
  else if (/^gpt-5/.test(m)) w = 272_000;
  else if (/^(o3|o4|gpt-4\.1)/.test(m)) w = 200_000;
  if (tokens > w) w = tokens > 1_000_000 ? tokens : 1_000_000;
  return w;
}

export const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// --- The demo ---

const useMockSignals = create<{ modes: Record<string, string>; models: Record<string, string>; efforts: Record<string, string>; compacted: Record<string, boolean>; stopped: Record<string, boolean> }>(() => ({
  modes: {},
  models: {},
  efforts: {},
  compacted: {},
  stopped: {},
}));

// The demo's signals: neutral, and the same for a session every time.
function mockSignals(session: string): ChatSignals {
  const st = useMockSignals.getState();
  const codex = session.includes("codex");
  const t = Date.now();
  const busy = /checkout-fix|judge|qa-deck/.test(session);
  return {
    mode: st.modes[session] ?? (codex ? "on-request" : session.includes("judge") ? "plan" : "default"),
    model: st.models[session] ?? (codex ? "gpt-5-codex" : "claude-sonnet-4-5"),
    effort: st.efforts[session] ?? (codex ? "medium" : "high"),
    context: { tokens: st.compacted[session] ? 18_400 : codex ? 96_000 : session.includes("checkout") ? 168_000 : 124_000, window: codex ? 272_000 : undefined },
    todos: codex
      ? [
          { text: "Outline the deck", status: "completed" },
          { text: "Draft the release notes slide", active: "Drafting the release notes slide", status: "in_progress" },
          { text: "Add the QA checklist", status: "pending" },
        ]
      : [
          { id: "1", text: "Read the failing checkout test", status: "completed" },
          { id: "2", text: "Make webhook retries idempotent", active: "Making webhook retries idempotent", status: busy ? "in_progress" : "completed" },
          { id: "3", text: "Run the payment tests", active: "Running the payment tests", status: busy ? "pending" : "completed" },
        ],
    background:
      busy && !st.stopped[session]
        ? [
            { tool: "mock-bg-1", task: "b7k2", kind: "shell", command: "pnpm dev --port 3000", label: "Start the dev server", state: "running", since: t - 7 * 60_000 },
            { tool: "mock-bg-2", task: "b7k3", kind: "shell", command: "pnpm test --watch payments", label: "Watch the payment tests", state: "done", since: t - 4 * 60_000, until: t - 60_000 },
          ]
        : [],
  };
}

function mockInterrupt(box: string, session: string) {
  useMockSignals.setState((s) => ({ stopped: { ...s.stopped, [session]: true } }));
  void import("@/lib/mock").then((m) => m.mockDemo.setAgent(box, session, "finished"));
  const key = keyOf(box, session);
  const st = useConversations.getState();
  for (const it of st.items[key] ?? []) if (it.kind === "thinking") st.remove(key, it.id);
  st.push(key, { kind: "notice", id: `stop-${Date.now()}`, notice: "interrupted", level: "info", text: "Interrupted" });
}

async function mockJobDetail(tool: string): Promise<ToolDetail> {
  await new Promise((r) => setTimeout(r, 200));
  if (tool === "mock-bg-1")
    return { id: tool, name: "Bash", command: "pnpm dev --port 3000", output: "> shop@0.1.0 dev\n> next dev --port 3000\n\n  ▲ Next.js 15.2.0\n  - Local:        http://localhost:3000\n\n ✓ Ready in 1.8s\n ○ Compiling /checkout ...\n ✓ Compiled /checkout in 912ms", live: true };
  return { id: tool, name: "Bash", command: "pnpm test --watch payments", output: " ✓ webhook › creates an order (12 ms)\n ✓ webhook › returns the same order for a repeated event (9 ms)\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)" };
}

// mockNotice is a notice the demo shows in a finished conversation, so the
// cards can be seen: one session hits its usage limit.
export function mockNotice(session: string): NoticeItem | undefined {
  if (session !== "ci-flake-claude") return undefined;
  const resets = new Date();
  resets.setHours(resets.getHours() + 2, 0, 0, 0);
  return { kind: "notice", id: "mock-notice-limit", notice: "limit", level: "warning", text: "You've hit your usage limit.", resets: resets.getTime() };
}

// usePrevious is the value from the last render.
export function usePrevious<T>(v: T): T | undefined {
  const r = useRef<T>(undefined);
  useEffect(() => {
    r.current = v;
  }, [v]);
  return r.current;
}
