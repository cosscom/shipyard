import { reconnectDelay, STREAM_SILENCE_MS } from "@berth/core/net.ts";

import type { Box, PhoneEvent } from "./types";

// Following a box's events (GET /phone/v1/events): NDJSON, one event a
// line, a blank line every 25 seconds while nothing happens. The stream
// lives while the app is open; push covers the rest.

// LineReader splits what arrives into lines, holding a line cut between
// chunks until its end comes.
export class LineReader {
  private rest = "";

  push(chunk: string): PhoneEvent[] {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    const out: PhoneEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as PhoneEvent;
        if (e && typeof e.type === "string") out.push(e);
      } catch {
        // A damaged line is skipped; the next refresh catches up.
      }
    }
    return out;
  }
}

export interface Follow {
  stop(): void;
}

export interface FollowHooks {
  since: () => number | undefined;
  onEvent: (e: PhoneEvent) => void;
  // Connected (after which whatever was missed should be read again), or
  // not, with why.
  onState: (connected: boolean, error?: string) => void;
}

// follow keeps a stream open to one box, reconnecting with backoff, and
// starting over when the box goes quiet past STREAM_SILENCE_MS (a dropped
// connection that never said so).
export function follow(box: Box, hooks: FollowHooks, fetchImpl: typeof fetch = fetch): Follow {
  let stopped = false;
  let ctrl: AbortController | undefined;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    if (stopped) return;
    ctrl = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl?.abort(), STREAM_SILENCE_MS);
    };
    try {
      const since = hooks.since();
      quiet();
      const res = await fetchImpl(`${box.url}/phone/v1/events${since !== undefined ? `?since=${since}` : ""}`, {
        headers: { Authorization: `Bearer ${box.token}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(res.status === 401 ? "This phone isn't paired any more" : `The box answered ${res.status}`);
      attempt = 0;
      hooks.onState(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const lines = new LineReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        quiet();
        for (const e of lines.push(decoder.decode(value, { stream: true }))) hooks.onEvent(e);
      }
      throw new Error("The box closed the stream");
    } catch (err) {
      clearTimeout(watchdog);
      if (stopped) return;
      hooks.onState(false, (err as Error).message);
      retry = setTimeout(run, reconnectDelay(attempt++));
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      ctrl?.abort();
    },
  };
}

// What an event says to read again.
export interface Refresh {
  sessions: boolean;
  runs: boolean;
  // A session whose conversation (or state) changed.
  session?: string;
}

export function refreshFor(e: PhoneEvent): Refresh {
  const d = e.data ?? {};
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  if (e.type === "transcript.changed") return { sessions: false, runs: false, session: str("session") };
  if (e.type.startsWith("agent.")) return { sessions: true, runs: false, session: str("session") };
  if (e.type.startsWith("session.")) return { sessions: true, runs: false, session: e.type === "session.sent" ? str("name") : undefined };
  if (e.type.startsWith("run.")) return { sessions: false, runs: true };
  return { sessions: false, runs: false };
}
