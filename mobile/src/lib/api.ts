import { isDemo, mockCall } from "./mock";
import type { Box, PhoneInfo, PhoneSession, PhoneTranscript, Run } from "./types";

// Talking to a box's phone API: its token as the bearer, a time limit on
// every request, and the box's own words when it says no.

export class BoxError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const enc = encodeURIComponent;

export async function call<T>(box: Box, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  if (isDemo(box)) return (await mockCall(box, method, path)) as T;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(box.url + path, {
      method,
      headers: { Authorization: `Bearer ${box.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new BoxError(ctrl.signal.aborted ? `${box.name} didn't answer in time` : `Can't reach ${box.name}. Is Tailscale on?`, 0);
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const msg = data?.error || `${res.status} ${res.statusText}`;
    throw new BoxError(res.status === 401 ? `${box.name} doesn't know this phone any more. Pair it again from Shipyard's settings.` : msg, res.status);
  }
  return data;
}

export const phone = {
  info: (b: Box) => call<PhoneInfo>(b, "GET", "/phone/v1/info"),
  sessions: (b: Box) => call<PhoneSession[]>(b, "GET", "/phone/v1/sessions"),
  screen: (b: Box, s: string, history = 0) => call<{ screen: string }>(b, "GET", `/phone/v1/sessions/${enc(s)}/screen${history ? `?history=${history}` : ""}`),
  transcript: (b: Box, s: string, since: number, gen?: string) =>
    call<PhoneTranscript>(b, "GET", `/phone/v1/sessions/${enc(s)}/transcript?since=${since}${gen ? `&gen=${enc(gen)}` : ""}`),
  send: (b: Box, s: string, text: string, enter = true) => call<{ sent: boolean }>(b, "POST", `/phone/v1/sessions/${enc(s)}/send`, { text, enter }),
  key: (b: Box, s: string, key: string) => call<{ sent: boolean }>(b, "POST", `/phone/v1/sessions/${enc(s)}/keys`, { key }),
  interrupt: (b: Box, s: string) => call<{ sent: boolean; stopped: boolean }>(b, "POST", `/phone/v1/sessions/${enc(s)}/interrupt`),
  runs: (b: Box) => call<Run[]>(b, "GET", "/phone/v1/runs"),
  run: (b: Box, id: string) => call<Run>(b, "GET", `/phone/v1/runs/${enc(id)}`),
  decide: (b: Box, id: string, approve: boolean, pick?: number) =>
    call<unknown>(b, "POST", `/phone/v1/runs/${enc(id)}/gates/current/decide`, pick === undefined ? { approve } : { approve, pick }),
  cancel: (b: Box, id: string) => call<unknown>(b, "POST", `/phone/v1/runs/${enc(id)}/cancel`),
  register: (b: Box, r: { id: string; name: string; platform: "ios" | "android"; key: string; on?: string[] }) =>
    call<{ registered: boolean }>(b, "POST", "/phone/v1/push", r),
  unregister: (b: Box, id: string) => call<{ removed: boolean }>(b, "DELETE", `/phone/v1/push/${enc(id)}`),
};

export const can = (info: PhoneInfo | undefined, capability: string) => (info?.version ?? 1) >= 2 && !!info?.capabilities?.includes(capability);
