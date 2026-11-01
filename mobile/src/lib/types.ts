import type { Session } from "@berth/plugin";

import type { TranscriptItem } from "@berth/core/transcript.ts";

// What a box's phone API answers (docs/reference/phone-api.mdx).

// A box this phone is paired with. id is its address, made safe for keys
// and routes ("100.64.0.7_1379").
export interface Box {
  id: string;
  name: string;
  url: string;
  token: string;
}

export interface PhoneInfo {
  box: string;
  version: number;
  capabilities?: string[];
}

export type PhoneSession = Session & { worktree_title?: string };

export interface PhoneEvent {
  seq: number;
  type: string;
  time: string;
  box: string;
  data?: Record<string, unknown>;
}

export interface PhoneTranscript {
  source: string;
  items: TranscriptItem[];
  next: number;
  gen?: string;
  reset?: boolean;
  start?: number;
  truncated?: boolean;
  last?: number;
  reason?: string;
  record?: string;
}

export interface RunGate {
  path: string;
  title: string;
  text?: string;
  pick?: boolean;
  default?: number;
}

export interface RunCandidate {
  index: number;
  agent: string;
  diff: { added: number; removed: number };
  verify: { passed: boolean };
  judge?: { rank: number };
}

export interface RunStep {
  id: string;
  kind?: string;
  status?: string;
  output?: string;
  error?: string;
  children?: RunStep[];
}

export type RunStatus = "queued" | "running" | "waiting_gate" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface Run {
  id: string;
  template: string;
  title?: string;
  status: RunStatus | string;
  created: string;
  cursor?: string;
  gate?: RunGate;
  candidates?: RunCandidate[];
  steps?: RunStep[];
  error?: string;
}

export const runDone = (r: Pick<Run, "status">) => ["succeeded", "failed", "cancelled", "interrupted"].includes(r.status);
