// node --experimental-strip-types --test test/relay.test.ts (pnpm test)
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Apns, http2Transport, payload, type ApnsRequest } from "../src/apns.ts";
import { Limiter } from "../src/ratelimit.ts";
import { relay, type Deps } from "../src/relay.ts";
import { checkNotice, checkRegistration, type Notice } from "../src/schema.ts";
import { open, seal, sealKeys } from "../src/seal.ts";

const TOPIC = "dev.berth.phone";
const TOKEN = "a1".repeat(32);
const keys = { k1: randomBytes(32), k0: randomBytes(32) };
const notice: Notice = { v: 1, kind: "session", state: "waiting", title: "Claude Code needs you", body: "acme/checkout on devbox", box: "devbox", session: "acme-fix", collapse: "devbox/acme-fix" };

test("a key opens to what it sealed, and nothing else opens", () => {
  const key = seal(keys, "k1", { token: TOKEN, env: "sandbox", bundle: TOPIC, iat: 1 });
  assert.match(key, /^v1\.k1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(open(keys, key), { token: TOKEN, env: "sandbox", bundle: TOPIC, iat: 1 });
  // A key sealed with the old kid still opens while SEAL_KEYS keeps it.
  assert.equal(open(keys, seal(keys, "k0", { token: TOKEN, env: "production", bundle: TOPIC, iat: 1 }))?.env, "production");
  const body = key.split(".")[2];
  const flipped = body.slice(0, 20) + (body[20] === "A" ? "B" : "A") + body.slice(21);
  for (const bad of [`v1.k1.${flipped}`, key.replace("v1.k1.", "v1.k0."), key.replace("v1.", "v2."), `v1.k9.${body}`, "v1.k1.", "", "nonsense"]) {
    assert.equal(open(keys, bad), undefined, bad);
  }
  assert.equal(open({ k1: randomBytes(32) }, key), undefined, "another relay's key");
});

test("SEAL_KEYS holds 32-byte keys by kid", () => {
  assert.equal(sealKeys(JSON.stringify({ k1: randomBytes(32).toString("base64") })).k1.length, 32);
  assert.throws(() => sealKeys(JSON.stringify({ k1: randomBytes(16).toString("base64") })));
  assert.throws(() => sealKeys(JSON.stringify({ "bad kid": randomBytes(32).toString("base64") })));
});

test("a notice is exactly the fields a box sends", () => {
  assert.deepEqual(checkNotice(notice), { ok: true, value: { ...notice, run: undefined } });
  const bad: unknown[] = [
    { ...notice, v: 2 },
    { ...notice, kind: "custom" },
    { ...notice, state: "urgent" },
    { ...notice, title: "x".repeat(81) },
    { ...notice, body: "line one\nline two" },
    { ...notice, body: "‮reversed" },
    { ...notice, box: "dev box" },
    { ...notice, session: "acme fix" },
    { ...notice, aps: { "content-available": 1 } },
    { ...notice, kind: "run" },
    [],
    "notice",
  ];
  for (const b of bad) assert.equal(checkNotice(b).ok, false, JSON.stringify(b));
  assert.equal(checkNotice({ ...notice, kind: "run", session: undefined, run: "r_1" }).ok, true);
});

test("a registration is for this app, with an APNs token", () => {
  assert.deepEqual(checkRegistration({ platform: "ios", token: TOKEN.toUpperCase(), env: "production", bundle: TOPIC }, TOPIC), {
    ok: true,
    value: { platform: "ios", token: TOKEN, env: "production", bundle: TOPIC },
  });
  for (const b of [
    { platform: "android", token: TOKEN, env: "production", bundle: TOPIC },
    { platform: "ios", token: "xyz", env: "production", bundle: TOPIC },
    { platform: "ios", token: TOKEN, env: "staging", bundle: TOPIC },
    { platform: "ios", token: TOKEN, env: "production", bundle: "com.example.other" },
    { platform: "ios", token: TOKEN, env: "production", bundle: TOPIC, extra: 1 },
  ]) {
    assert.equal(checkRegistration(b, TOPIC).ok, false, JSON.stringify(b));
  }
});

test("limits count per id, in every window", () => {
  let now = 0;
  const l = new Limiter([{ limit: 2, ms: 1000 }, { limit: 3, ms: 10_000 }], () => now);
  assert.ok(l.take("a") && l.take("a"));
  assert.equal(l.take("a"), false);
  assert.ok(l.take("b"), "another id has its own count");
  now = 1500;
  assert.ok(l.take("a"));
  now = 2600;
  assert.equal(l.take("a"), false, "the longer window still counts three");
  now = 11_000;
  assert.ok(l.take("a"));
});

const p8 = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

test("APNs gets a signed provider token and a notification the relay made", async () => {
  const { privateKey, publicKey } = p8();
  const sent: ApnsRequest[] = [];
  let now = 1_700_000_000_000;
  const apns = new Apns(
    { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, keyId: "KEY123", teamId: "TEAM456", topic: TOPIC },
    async (r) => (sent.push(r), { status: 200, body: "" }),
    () => now,
  );
  assert.deepEqual(await apns.send({ token: TOKEN, env: "sandbox" }, notice), { ok: true });
  const r = sent[0];
  assert.equal(r.host, "https://api.sandbox.push.apple.com");
  assert.equal(r.path, `/3/device/${TOKEN}`);
  assert.equal(r.headers["apns-topic"], TOPIC);
  assert.equal(r.headers["apns-priority"], "10");
  assert.match(r.headers["apns-collapse-id"], /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(r.body), payload(notice));
  assert.deepEqual(JSON.parse(r.body).berth, { v: 1, box: "devbox", kind: "session", session: "acme-fix" });

  const [head, claims, sig] = r.headers.authorization.replace("bearer ", "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAM456", iat: 1_700_000_000 });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));

  // The same token for 50 minutes, then a new one.
  now += 49 * 60_000;
  await apns.send({ token: TOKEN, env: "production" }, { ...notice, state: "finished" });
  assert.equal(sent[1].headers.authorization, r.headers.authorization);
  assert.equal(sent[1].headers["apns-priority"], "5");
  assert.equal(sent[1].host, "https://api.push.apple.com");
  now += 2 * 60_000;
  await apns.send({ token: TOKEN, env: "production" }, notice);
  assert.notEqual(sent[2].headers.authorization, r.headers.authorization);
});

test("APNs' answers become gone, a retry with a fresh token, or a failure", async () => {
  const { privateKey } = p8();
  const key = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const answers = (list: { status: number; body: string }[]) => {
    const calls: ApnsRequest[] = [];
    return { calls, apns: new Apns({ key, keyId: "K", teamId: "T", topic: TOPIC }, async (r) => (calls.push(r), list.shift()!)) };
  };
  let a = answers([{ status: 410, body: '{"reason":"Unregistered"}' }]);
  assert.deepEqual(await a.apns.send({ token: TOKEN, env: "production" }, notice), { ok: false, gone: true, reason: "Unregistered" });
  a = answers([{ status: 400, body: '{"reason":"BadDeviceToken"}' }]);
  assert.equal((await a.apns.send({ token: TOKEN, env: "production" }, notice)).ok, false);
  a = answers([
    { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
    { status: 200, body: "" },
  ]);
  assert.deepEqual(await a.apns.send({ token: TOKEN, env: "production" }, notice), { ok: true });
  assert.equal(a.calls.length, 2);
  a = answers([{ status: 500, body: '{"reason":"InternalServerError"}' }]);
  assert.deepEqual(await a.apns.send({ token: TOKEN, env: "production" }, notice), { ok: false, gone: false, status: 500, reason: "InternalServerError" });
});

test("the HTTP/2 transport posts and reads the answer", async () => {
  const server = createServer();
  const sessions: ServerHttp2Session[] = [];
  server.on("session", (s: ServerHttp2Session) => sessions.push(s));
  const seen: { path?: string; topic?: string; body: string } = { body: "" };
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    seen.path = String(headers[":path"]);
    seen.topic = String(headers["apns-topic"]);
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => (seen.body += d));
    stream.on("end", () => {
      stream.respond({ ":status": 410 });
      stream.end('{"reason":"Unregistered"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const send = http2Transport();
    const res = await send({ host: `http://127.0.0.1:${port}`, path: "/3/device/abc", headers: { "apns-topic": TOPIC }, body: "{}" });
    assert.deepEqual(res, { status: 410, body: '{"reason":"Unregistered"}' });
    assert.deepEqual(seen, { path: "/3/device/abc", topic: TOPIC, body: "{}" });
  } finally {
    for (const s of sessions) s.destroy();
    server.close();
  }
});

function relayFor(outcome: Awaited<ReturnType<Deps["send"]>> | Error = { ok: true }) {
  const sent: { device: { token: string; env: string }; n: Notice }[] = [];
  const logs: string[] = [];
  const handle = relay({
    keys,
    kid: "k1",
    topic: TOPIC,
    send: async (device, n) => {
      sent.push({ device, n });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    log: (l) => logs.push(l),
    now: () => 1_700_000_000_000,
  });
  return { handle, sent, logs };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://push.berthd.app${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("a phone registers, and a box notifies it with the key", async () => {
  const { handle, sent, logs } = relayFor();
  const reg = await handle(post("/v1/register", { platform: "ios", token: TOKEN, env: "sandbox", bundle: TOPIC }), "203.0.113.5");
  assert.equal(reg.status, 200);
  const { key } = (await reg.json()) as { key: string };
  const res = await handle(post("/v1/send", notice, { authorization: `Bearer ${key}` }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ device: { token: TOKEN, env: "sandbox", bundle: TOPIC, iat: 1_700_000_000 }, n: { ...notice, run: undefined } }]);
  // The logs never hold the token, the key or what was said.
  for (const l of logs) for (const secret of [TOKEN, key, "acme", "Claude"]) assert.ok(!l.includes(secret), l);
});

test("the relay refuses what isn't a box's notice with a key of its own", async () => {
  const { handle, sent } = relayFor();
  const key = seal(keys, "k1", { token: TOKEN, env: "production", bundle: TOPIC, iat: 1 });
  const otherApp = seal(keys, "k1", { token: TOKEN, env: "production", bundle: "com.example.other", iat: 1 });
  assert.equal((await handle(post("/v1/send", notice))).status, 401);
  assert.equal((await handle(post("/v1/send", notice, { authorization: "Bearer nonsense" }))).status, 401);
  assert.equal((await handle(post("/v1/send", notice, { authorization: `Bearer ${otherApp}` }))).status, 401);
  assert.equal((await handle(post("/v1/send", { ...notice, aps: {} }, { authorization: `Bearer ${key}` }))).status, 400);
  assert.equal((await handle(post("/v1/send", "{", { authorization: `Bearer ${key}` }))).status, 400);
  assert.equal((await handle(post("/v1/send", { ...notice, body: "x".repeat(3000) }, { authorization: `Bearer ${key}` }))).status, 413);
  assert.equal((await handle(new Request("https://push.berthd.app/v1/send"))).status, 405);
  assert.equal((await handle(new Request("https://push.berthd.app/admin"))).status, 404);
  assert.equal((await handle(new Request("https://push.berthd.app/v1/health"))).status, 200);
  assert.equal(sent.length, 0);
});

test("a phone that's gone answers 410, and Apple's trouble 502", async () => {
  const key = seal(keys, "k1", { token: TOKEN, env: "production", bundle: TOPIC, iat: 1 });
  const auth = { authorization: `Bearer ${key}` };
  assert.equal((await relayFor({ ok: false, gone: true, reason: "Unregistered" }).handle(post("/v1/send", notice, auth))).status, 410);
  assert.equal((await relayFor({ ok: false, gone: false, status: 500, reason: "InternalServerError" }).handle(post("/v1/send", notice, auth))).status, 502);
  assert.equal((await relayFor({ ok: false, gone: false, status: 429, reason: "TooManyRequests" }).handle(post("/v1/send", notice, auth))).status, 429);
  assert.equal((await relayFor(new Error("connect ECONNREFUSED")).handle(post("/v1/send", notice, auth))).status, 502);
});

test("one key or address can't send or register without end", async () => {
  const { handle } = relayFor();
  const key = seal(keys, "k1", { token: TOKEN, env: "production", bundle: TOPIC, iat: 1 });
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) codes.push((await handle(post("/v1/send", notice, { authorization: `Bearer ${key}` }))).status);
  assert.deepEqual(codes.slice(0, 30), Array(30).fill(200));
  assert.equal(codes[30], 429);
  const regs: number[] = [];
  for (let i = 0; i < 21; i++) regs.push((await handle(post("/v1/register", { platform: "ios", token: TOKEN, env: "production", bundle: TOPIC }), "203.0.113.9")).status);
  assert.equal(regs[20], 429);
  assert.equal((await handle(post("/v1/register", { platform: "ios", token: TOKEN, env: "production", bundle: TOPIC }), "203.0.113.10")).status, 200);
});
