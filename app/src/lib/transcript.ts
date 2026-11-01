import type { Question } from "@/lib/questions";

// A session's work as a calm transcript rather than a terminal: what Shore
// mode draws. The agent still runs in its terminal on the box; berthd reads
// the agent's own record of the conversation (Claude's transcript, Codex's
// session file, ACP for the rest) and streams it as these items. Nothing is
// kept by Shipyard.

export type TranscriptItem =
  // pending: sent from here, and the agent hasn't read it yet. midTurn:
  // typed while the agent worked, which it read at its next step.
  | { kind: "user"; id: string; text: string; pending?: boolean; midTurn?: boolean }
  // live: words read from the agent's screen that its record doesn't
  // have yet (a draft, lib/draft-text), replaced by the record's own once
  // it catches up. clipped: the draft's start is above the agent's screen.
  | { kind: "text"; id: string; text: string; live?: boolean; clipped?: boolean }
  | { kind: "tools"; id: string; verb: string; items?: ToolCall[]; done?: boolean }
  | { kind: "edit"; id: string; file: string; added: number; removed: number; tool?: string }
  // A question for the person. choices are the agent's own numbered options
  // when it shows some; without them it is yes or no (Allow or Deny for a
  // command). decided is what was answered.
  // A permission the agent's hooks described (structured) names the tool,
  // what it would run or touch (detail) and why, rather than a screen line.
  // reply: with no options to pick, a reply answers it (a structured
  // agent, which has no screen of its own).
  | { kind: "ask"; id: string; tool: string; detail: string; choices?: { key: string; label: string; title?: string }[]; decided?: string; why?: string; structured?: boolean; reading?: boolean; reply?: boolean }
  // The agent at work: the step it is running (timed from the call), or
  // its own word for what it does (label, from its status line) with what
  // else that line says (meta: tokens); since is when it began.
  | { kind: "thinking"; id: string; since: number; label?: string; elapsed?: string; meta?: string; step?: { verb: string; target: string } }
  // Its turn ended while its work runs on (derive's onItsWork): not at work
  // itself, so no spinner and no timer.
  | { kind: "on-its-work"; id: string }
  // A command typed to the agent rather than a prompt: one of its own
  // ("/model", with what followed it) or a shell command ("!"), and the
  // output its program printed (Markdown when it wrote it so).
  | { kind: "command"; id: string; command: string; args?: string; text?: string; markdown?: boolean; error?: boolean }
  | { kind: "crew"; id: string; names: string[] }
  // Something the person should know, with one next step: an API error, a
  // usage or rate limit (resets: when, in ms), a hook that failed, a turn
  // they interrupted, an agent that ended (components/conversation/notice-card).
  | { kind: "notice"; id: string; notice: NoticeKind; level?: "error" | "warning" | "info"; text: string; resets?: number }
  // A page the agent published on claude.ai (Claude Code's Artifact tool):
  // text is its title, url its link once the result says it, file what was
  // published. Not done yet: still publishing. error: the publish failed.
  // updated: it was published before.
  // local: an artifact kept on the box instead (`berthd artifact add`,
  // components/art), by id, and version the version the command made.
  | { kind: "artifact"; id: string; tool?: string; text: string; url?: string; description?: string; file?: string; done?: boolean; error?: boolean; updated?: boolean; local?: string; version?: number }
  // Questions the agent asked with a form of its own (Claude Code's
  // AskUserQuestion, Codex's request_user_input; lib/questions). Once done,
  // answers holds what was answered, one per question; error: it wasn't.
  | { kind: "question"; id: string; tool?: string; questions: Question[]; answers?: string[]; done?: boolean; error?: boolean }
  // Work this agent started that Shipyard reported back on (a
  // <berth-notification> typed into its session): a prompt from Shipyard, not
  // the person (components/conversation/report-card).
  | { kind: "report"; id: string; report: BerthReport }
  // A message to the agent from another agent (a helper's hand-back, a
  // teammate, another session, the lead), or a status from Claude Code
  // itself (ping: a background task done or failed). Never the person's
  // (internal/transcript/peer.go, components/conversation/agent-message).
  | { kind: "agent-message"; id: string; msg: AgentMessage }
  | { kind: "ping"; id: string; msg: AgentMessage };

// Who a message to the agent is from. helper is the crew member's id when
// it is one of this agent's helpers, so its conversation can open.
export interface MessageSender {
  id: string;
  name: string;
  // harness: Claude Code itself.
  kind: "helper" | "teammate" | "session" | "lead" | "harness";
  // A teammate's own colour (blue, green, yellow…).
  color?: string;
  helper?: string;
}

export interface AgentMessage {
  from: MessageSender;
  // An agent-message's: report, question, update or instruction.
  intent?: "report" | "question" | "update" | "instruction";
  // finished, failed or stopped on a message; done, failed, stopped or
  // info on a ping.
  status?: string;
  // A report's first heading and its gist in a line.
  title?: string;
  summary?: string;
  body?: string;
  // Where Claude Code saved a report too long for its record (body is its
  // preview then).
  saved?: string;
  task?: string;
  // How many times it was said, once more than once.
  repeat?: number;
  // When it arrived (ms).
  at?: number;
  // A question the agent answered since, or the person wrote after.
  answered?: boolean;
}

// One piece of work a <berth-notification> reports on
// (internal/transcript/report.go).
export interface BerthReport {
  kind: "task" | "turn" | "run";
  session?: string;
  run?: string;
  template?: string;
  title?: string;
  worktree?: string;
  branch?: string;
  // finished, failed, exited, lost or waiting; a run's own status.
  status: string;
  duration?: string;
  files?: number;
  added?: number;
  removed?: number;
  summary?: string;
  answer?: string;
  needs?: string;
}

export type NoticeKind = "api_error" | "limit" | "rate_limit" | "auth" | "billing" | "hook" | "interrupted" | "stop_failure" | "exited" | "memory";

export interface ToolCall {
  verb: string;
  // When the agent made the call (ms).
  at?: number;
  target: string;
  // Names the call for its details (the full command and output).
  id?: string;
  // A file the call read or wrote, for its chip.
  file?: boolean;
}

// One helper working beside the agent: a subagent it started, or another
// agent on the same work (an attempt, a reviewer, a loop).
export interface CrewMember {
  id: string;
  name: string;
  kind: "subagent" | "attempt" | "reviewer" | "loop";
  agent: string;
  state: "running" | "waiting" | "finished";
  doing: string;
  since: number;
  // When it came back, so its time stops.
  until?: number;
}

// One page the agent published, as the conversation lists them: the latest
// publish of each, newest last (internal/transcript/artifacts.go). tool is
// the call that last published it; at, when (ms).
export interface Artifact {
  url: string;
  title: string;
  description?: string;
  file?: string;
  at: number;
  tool: string;
  updated?: boolean;
}

// The summary line a finished group of tool calls folds to: "Read 5 files",
// "Searched 2 times".
export function toolSummary(t: Extract<TranscriptItem, { kind: "tools" }>): string {
  const n = t.items?.length ?? 0;
  if (t.verb === "Read") return `Read ${n} file${n === 1 ? "" : "s"}`;
  if (t.verb === "Search") return `Searched ${n} time${n === 1 ? "" : "s"}`;
  if (t.verb === "Run") return `Ran ${n} command${n === 1 ? "" : "s"}`;
  if (t.verb === "Skill") return n === 1 && t.items?.[0] ? `Used the ${t.items[0].target} skill` : `Used ${n} skills`;
  return `${t.verb} ${n}`;
}

// EditHunk is one piece of a change, as a unified diff has it: its lines
// are led by " ", "-" or "+".
export interface EditHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// ToolDetail is one tool call opened up, as the agent's terminal shows it:
// the full command and its output, an edit's exact change, a new file.
// Fetched only when someone expands the call.
export interface ToolDetail {
  id: string;
  name: string;
  command?: string;
  file?: string;
  pattern?: string;
  old?: string;
  new?: string;
  // The change numbered by the file's own lines (Claude Code's record of
  // it), when the box has it; otherwise old and new number from 1.
  hunks?: EditHunk[];
  output?: string;
  truncated?: boolean;
  error?: boolean;
  pending?: boolean;
  // A background shell whose output is still growing.
  live?: boolean;
  // The pictures the call returned that the box serves, fetched one by one
  // once the call is opened. Output keeps an "[image]" line for each.
  images?: ToolImageRef[];
}

// ToolImageRef is a picture in a call's result: n counts the result's
// images, the ones not served too; line is where it stands in the output
// (its "[image]" line, or the "… more lines …" line where it was cut).
export interface ToolImageRef {
  n: number;
  line: number;
  mediaType: string;
}
