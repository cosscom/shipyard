// How the app behaves on a slow or dropping network: the pure parts, so
// they are easy to check (net.test.ts). The laptop agent holds the
// connection to every box; when a box is away it tries again on a backoff
// and says when (retry_at), and answers requests for it at once with 503
// rather than letting them wait out a dial. The app adds a time limit to
// reads, so nothing spins forever, follows the agent's event stream with a
// watchdog and jittered backoff, and never runs two full refreshes at once.

// A read gets this long before it fails as "didn't answer". Long polls
// (…/wait) carry their own timeout and are left alone, and so are writes,
// which can take long (a worktree's setup) and must not be cut off midway.
export const READ_TIMEOUT_MS = 30_000;

export function readTimeout(method: string, path: string): number | undefined {
  if (method !== "GET") return undefined;
  const p = path.split("?")[0];
  if (/\/wait$/.test(p) || p.endsWith("/v1/events")) return undefined;
  return READ_TIMEOUT_MS;
}

// reconnectDelay is the wait before the attempt-th reconnect of a stream
// (1 is the first): 500ms doubling to 10s, give or take 20%, so many
// windows (or apps) that lost the agent together don't come back as one.
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

// The agent writes to the event stream at least every 20s (a keepalive);
// a stream silent for longer than this is dead though not closed (the agent
// paused, a sleep), and is opened again.
export const STREAM_SILENCE_MS = 45_000;

// coalesce wraps an async job so calls while it runs don't start another:
// they get one more run once it ends, which sees everything they asked
// for. A reconnect, a focus, an event and the poll landing together cost
// one refresh, then at most one more.
export function coalesce(job: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (!running) {
      running = job().finally(() => {
        running = undefined;
      });
      return running;
    }
    if (!again) {
      // After it, however it ended: a failed refresh doesn't stop the next.
      again = running
        .catch(() => {})
        .then(() => {
          again = undefined;
          return run();
        });
    }
    return again;
  };
  return run;
}

// A box that is away, as the app shows it.
export interface Away {
  // Seconds to the agent's next try (0: trying now), when it said.
  next?: number;
  // Tries in a row that failed.
  attempts?: number;
  // How long the box has been away, in seconds.
  away?: number;
}

// awayFrom reads a box's status at a moment (ms).
export function awayFrom(st: { state?: string; retry_at?: string; attempts?: number; since?: string } | undefined, now: number): Away {
  if (!st || st.state === "online") return {};
  const at = st.retry_at ? Date.parse(st.retry_at) : NaN;
  const since = st.since ? Date.parse(st.since) : NaN;
  return {
    next: Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined,
    attempts: st.attempts,
    away: Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : undefined,
  };
}

// retryLine is the line under "Reconnecting to box…".
export function retryLine(a: Away): string {
  const parts: string[] = [];
  if (a.next !== undefined) parts.push(a.next > 0 ? `Next try in ${a.next}s` : "Trying now…");
  if (a.away !== undefined && a.away >= 5) parts.push(`away ${duration(a.away)}`);
  return parts.join(" · ");
}

function duration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
