import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the laptop agent's HTTP API, for tests of what the mock
// fixtures can't act out: the app's own reading of a box (the transcript
// feed, its timing, its failures). It serves one online box, "devl", with
// one project ("shop") whose worktree "fix" has a Claude session in it, and
// answers anything else with a 404 the app takes as "not on this agent".
// Tests open the app with app.open({ agent }) and steer the box's answers
// with transcript(), and send events with event().
//
// It listens on a free loopback port, never the agent's 1377-1379.

export const BOX = "devl";
export const SESSION = "fix-claude";
export const DIR = "/w/shop-fix";

export interface Answer {
  status?: number;
  body: unknown;
  // How long the box takes to answer (ms).
  delay?: number;
}

export interface FakeAgent {
  url: string;
  token: string;
  // The box's answer to GET sessions/fix-claude/transcript?…; the query
  // is given. Default: two items, from a fresh reading.
  transcript: (query: URLSearchParams) => Answer | Promise<Answer>;
  // The box's answer to GET sessions/fix-claude/draft (boxes with "draft"
  // in capabilities): the reply its screen shows being written.
  draft: () => Answer;
  // What the box says it can do (info). Default: transcript and turns.
  capabilities: string[];
  // Fields laid over the session as the box lists it (its state, command…).
  session: Record<string, unknown>;
  // The session's screen (GET sessions/fix-claude/screen). Default: blank.
  screen: () => string;
  // Every request, as "METHOD path?query".
  calls: string[];
  // The box as the agent's status shows it: online, or away with when the
  // agent tries it next. Away, the box's API answers 503 as the agent does.
  away?: { state: "offline" | "connecting"; retryAt?: string; attempts?: number; since?: string };
  // Fields laid over the box's status while it is online: its latency and
  // link (slow, why, how Tailscale reaches it).
  online: Record<string, unknown>;
  // The bodies of POST sessions/fix-claude/send, in order, and how the box
  // answers each: "drop" ends the connection without an answer (the link
  // dropped once the box had it).
  sends: Record<string, unknown>[];
  send: (body: Record<string, unknown>) => Answer | "drop";
  // The bodies of POST sessions/fix-claude/answer (a form of questions
  // filled in, boxes with "answer"), in order.
  answers: Record<string, unknown>[];
  // Ends every event stream, as an agent restarting does.
  dropStreams(): void;
  // Sends an event to the app's stream.
  event(e: { type: string; data?: Record<string, unknown> }): void;
  close(): Promise<void>;
}

const now = () => new Date().toISOString();

export const ITEMS = [
  { kind: "user", id: "u1", text: "Fix the flaky checkout test", off: 10 },
  { kind: "text", id: "t1", text: "The retry loop never backs off; fixed it.", off: 200 },
];

export async function fakeAgent(): Promise<FakeAgent> {
  const streams = new Set<ServerResponse>();
  let seq = 0;
  const agent: FakeAgent = {
    url: "",
    token: "e2e-token",
    calls: [],
    online: {},
    sends: [],
    send: () => ({ body: { sent: true, turn: `${SESSION}#2`, seq: 9, at: now() } }),
    answers: [],
    dropStreams() {
      for (const s of streams) s.destroy();
      streams.clear();
    },
    transcript: () => ({ body: { source: "claude", items: ITEMS, next: 2, crew: [], gen: "1.0", start: 10, file: "abc" } }),
    draft: () => ({ body: { agent: "claude" } }),
    capabilities: ["transcript", "turns"],
    session: {},
    screen: () => "",
    event(e) {
      const ev = { seq: ++seq, time: now(), box: BOX, origin: "claude", ...e };
      for (const s of streams) s.write(`data: ${JSON.stringify(ev)}\n\n`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of streams) s.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const created = new Date(Date.now() - 10 * 60_000).toISOString();
  const status = () => ({
    boxes: [
      agent.away
        ? { name: BOX, address: "devl:7444", fingerprint: "e2e", state: agent.away.state, since: agent.away.since ?? created, retry_at: agent.away.retryAt, attempts: agent.away.attempts, error: "dial tcp 100.64.0.4:7444: i/o timeout" }
        : { name: BOX, address: "devl:7444", fingerprint: "e2e", state: "online", since: created, latency_ms: 3, ...agent.online },
    ],
    forwards: [],
    routes: [],
    proxy: { port: 1377, url_port: 1377 },
  });
  const box: Record<string, () => unknown> = {
    info: () => ({ name: BOX, version: "0.3.7", build: "e2e", tools: ["claude"], capabilities: agent.capabilities, agents: [{ id: "claude", name: "Claude Code", command: "claude" }] }),
    locations: () => [
      {
        name: "shop",
        path: "/w/shop",
        repo: true,
        worktrees: [
          { name: "shop", path: "/w/shop", branch: "main", main: true },
          { name: "fix", path: DIR, branch: "me/fix" },
        ],
      },
    ],
    sessions: () => [
      { name: SESSION, title: "Fix the flaky checkout test", location: "shop/fix", dir: DIR, command: "claude", created, attached: 0, exited: false, agent: "claude", agent_state: "running", state_since: now(), ...agent.session },
    ],
    stats: () => ({}),
    services: () => [],
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const json = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://fake");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    agent.calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers.authorization !== `Bearer ${agent.token}`) return send(res, 401, { error: "missing or wrong token" });
    const p = u.pathname;
    if (p === "/v1/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": hello\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "GET" && p === "/v1/status") return send(res, 200, status());
    if (req.method === "POST" && p === "/v1/refresh") return send(res, 200, status());
    if (agent.away && p.startsWith(`/v1/boxes/${BOX}/api/`)) return send(res, 503, { error: `${BOX} is offline; Shipyard is reconnecting`, code: "box_unreachable" });
    if (req.method === "POST" && p === `/v1/boxes/${BOX}/api/sessions/${SESSION}/send`) {
      const body = await json(req);
      agent.sends.push(body);
      const a = agent.send(body);
      if (a === "drop") return void res.destroy();
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
      return send(res, a.status ?? 200, a.body);
    }
    if (req.method === "POST" && p === `/v1/boxes/${BOX}/api/sessions/${SESSION}/answer`) {
      agent.answers.push(await json(req));
      return send(res, 200, { answered: [] });
    }
    if (req.method === "GET" && (p === "/v1/themes" || p === "/v1/templates" || p === "/v1/plugins")) return send(res, 200, []);
    const m = /^\/v1\/boxes\/([^/]+)\/api\/(.*)$/.exec(p);
    if (m && m[1] === BOX && req.method === "GET") {
      const rest = m[2];
      if (rest === `sessions/${SESSION}/transcript`) {
        const a = await agent.transcript(u.searchParams);
        if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
        if (res.destroyed) return;
        return send(res, a.status ?? 200, a.body);
      }
      if (rest === `sessions/${SESSION}/screen`) return send(res, 200, { screen: agent.screen() });
      if (rest === `sessions/${SESSION}/draft`) {
        const a = agent.draft();
        return send(res, a.status ?? 200, a.body);
      }
      if (box[rest]) return send(res, 200, box[rest]());
    }
    send(res, 404, { error: "not on this agent", code: "not_found" });
  };
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return agent;
}
