import { follow, LineReader, refreshFor } from "./events";
import type { Box, PhoneEvent } from "./types";

const box: Box = { id: "100.64.0.7_1379", name: "devl", url: "http://100.64.0.7:1379", token: "t".repeat(48) };

test("lines cut between chunks are read once whole, and keepalives skipped", () => {
  const r = new LineReader();
  const a = JSON.stringify({ seq: 1, type: "agent.waiting", data: { session: "acme" } });
  const b = JSON.stringify({ seq: 2, type: "run.gate", data: { run: "r_1" } });
  expect(r.push(a.slice(0, 10))).toEqual([]);
  expect(r.push(a.slice(10) + "\n\n" + b.slice(0, 5)).map((e) => e.seq)).toEqual([1]);
  expect(r.push(b.slice(5) + "\n")).toEqual([JSON.parse(b)]);
  expect(r.push("\n")).toEqual([]);
  expect(r.push("{not json\n" + JSON.stringify({ seq: 3 }) + "\n")).toEqual([]);
});

test("each event reads again only what it changed", () => {
  const e = (type: string, data: Record<string, unknown> = {}): PhoneEvent => ({ seq: 1, type, time: "", box: "devl", data });
  expect(refreshFor(e("transcript.changed", { session: "acme" }))).toEqual({ sessions: false, runs: false, session: "acme" });
  expect(refreshFor(e("agent.waiting", { session: "acme" }))).toEqual({ sessions: true, runs: false, session: "acme" });
  expect(refreshFor(e("session.sent", { name: "acme" }))).toEqual({ sessions: true, runs: false, session: "acme" });
  expect(refreshFor(e("session.started", { name: "acme" }))).toEqual({ sessions: true, runs: false, session: undefined });
  expect(refreshFor(e("run.step"))).toEqual({ sessions: false, runs: true });
  expect(refreshFor(e("phone.push.added"))).toEqual({ sessions: false, runs: false });
});

// A body that hands out chunks as the test says.
function stream() {
  const waiting: ((r: { done: boolean; value?: Uint8Array }) => void)[] = [];
  const queued: { done: boolean; value?: Uint8Array }[] = [];
  const give = (r: { done: boolean; value?: Uint8Array }) => (waiting.length ? waiting.shift()!(r) : queued.push(r));
  return {
    body: { getReader: () => ({ read: () => (queued.length ? Promise.resolve(queued.shift()!) : new Promise((res) => waiting.push(res))) }) },
    send: (text: string) => give({ done: false, value: new TextEncoder().encode(text) }),
    end: () => give({ done: true }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a stream asks from where it left off, and reconnects when the box closes it", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "queueMicrotask", "nextTick"] });
  const urls: string[] = [];
  const auth: string[] = [];
  const streams: ReturnType<typeof stream>[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    urls.push(url);
    auth.push((init.headers as Record<string, string>).Authorization);
    const s = stream();
    streams.push(s);
    return { ok: true, status: 200, body: s.body } as unknown as Response;
  }) as unknown as typeof fetch;
  let seq: number | undefined;
  const seen: PhoneEvent[] = [];
  const states: boolean[] = [];
  const f = follow(box, { since: () => seq, onEvent: (e) => (seen.push(e), (seq = e.seq)), onState: (live) => states.push(live) }, fake);
  await jest.advanceTimersByTimeAsync(0);
  expect(urls).toEqual(["http://100.64.0.7:1379/phone/v1/events"]);
  expect(auth[0]).toBe(`Bearer ${box.token}`);
  streams[0].send(JSON.stringify({ seq: 41, type: "agent.started" }) + "\n");
  await jest.advanceTimersByTimeAsync(0);
  expect(seen.map((e) => e.seq)).toEqual([41]);
  streams[0].end();
  await jest.advanceTimersByTimeAsync(5000);
  expect(urls[1]).toBe("http://100.64.0.7:1379/phone/v1/events?since=41");
  expect(states).toEqual([true, false, true]);
  f.stop();
  jest.useRealTimers();
  await flush();
});
