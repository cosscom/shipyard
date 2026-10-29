import type { SessionState } from "./derive.ts";

// The agent part of the app's state model (app/src/lib/state-model.ts),
// shared with the phone app: the same words everywhere.

export type AgentStatus = "working" | "needs-you" | "done" | "idle" | "ended";

// agentStatus is a session's state in the model's words; a plain shell has
// none.
export function agentStatus(s: SessionState): AgentStatus | undefined {
  switch (s) {
    case "running":
      return "working";
    case "waiting":
      return "needs-you";
    case "finished":
      return "done";
    case "ready":
      return "idle";
    case "exited":
      return "ended";
    default:
      return undefined;
  }
}

export const AGENT_WORDS: Record<AgentStatus, { word: string; lower: string; hint: string }> = {
  working: { word: "Working", lower: "working", hint: "Busy on its task" },
  "needs-you": { word: "Needs you", lower: "needs you", hint: "Waiting for your answer or permission" },
  done: { word: "Done", lower: "done", hint: "Finished its turn; look at what it did" },
  idle: { word: "Idle", lower: "idle", hint: "Open with nothing to do; give it a task" },
  ended: { word: "Ended", lower: "ended", hint: "Its program closed; start it again to carry on" },
};

// sessionWord is the one word for a session's state: "Working", "Needs
// you"…, or "Shell" for a plain shell.
export function sessionWord(s: SessionState, lower = false): string {
  const a = agentStatus(s);
  if (!a) return lower ? "shell" : "Shell";
  return lower ? AGENT_WORDS[a].lower : AGENT_WORDS[a].word;
}
