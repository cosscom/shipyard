import { createHash } from "node:crypto";

import { Apns, type Outcome } from "./apns.ts";
import { Limiter } from "./ratelimit.ts";
import { checkNotice, checkRegistration, type Notice } from "./schema.ts";
import { open, seal, sealKeys, type SealKeys } from "./seal.ts";

// The relay's routes, on web Requests and Responses:
//
//   POST /v1/register  {platform, token, env, bundle} → {key}
//   POST /v1/send      Authorization: Bearer <key>, a notice → {sent}
//   GET  /v1/health    → {ok}
//
// It keeps nothing: a key carries its device token, sealed. Logs say what
// happened and to which key (a hash's first characters), never a body, a
// token or a key.

export interface Deps {
  keys: SealKeys;
  kid: string;
  topic: string;
  send: (device: { token: string; env: "production" | "sandbox" }, n: Notice) => Promise<Outcome>;
  log: (line: string) => void;
  now: () => number;
}

// MAX_BODY: a notice is a few hundred bytes.
export const MAX_BODY = 2048;

export function fromEnv(env: NodeJS.ProcessEnv): Deps {
  const missing = ["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "SEAL_KEYS", "SEAL_KID"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`the relay needs ${missing.join(", ")}`);
  const apns = new Apns({ key: env.APNS_KEY_P8!.replace(/\\n/g, "\n"), keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID!, topic: env.APNS_TOPIC! });
  const keys = sealKeys(env.SEAL_KEYS);
  if (!keys[env.SEAL_KID!]) throw new Error("SEAL_KID names no key in SEAL_KEYS");
  return { keys, kid: env.SEAL_KID!, topic: env.APNS_TOPIC!, send: (d, n) => apns.send(d, n), log: (l) => console.log(l), now: Date.now };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

const tag = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 10);

export function relay(deps: Deps): (req: Request, ip?: string) => Promise<Response> {
  // Per address: registering is rare (an install, a new token). Per key: a
  // box's notices about one phone.
  const registers = new Limiter([{ limit: 20, ms: 3600_000 }], deps.now);
  const sends = new Limiter([{ limit: 30, ms: 60_000 }, { limit: 300, ms: 86_400_000 }], deps.now);

  async function body(req: Request): Promise<unknown | Response> {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > MAX_BODY) return json(413, { error: "too large" });
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: "too large" });
    try {
      return JSON.parse(raw);
    } catch {
      return json(400, { error: "the body must be JSON" });
    }
  }

  return async (req, ip = "") => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/health" && req.method === "GET") return json(200, { ok: true });
    if (path !== "/v1/register" && path !== "/v1/send") return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });

    if (path === "/v1/register") {
      if (!registers.take(ip)) return json(429, { error: "too many registrations; try again later" });
      const b = await body(req);
      if (b instanceof Response) return b;
      const r = checkRegistration(b, deps.topic);
      if (!r.ok) return json(400, { error: r.error });
      const key = seal(deps.keys, deps.kid, { token: r.value.token, env: r.value.env, bundle: r.value.bundle, iat: Math.floor(deps.now() / 1000) });
      deps.log(`register ${r.value.env} key=${tag(key)}`);
      return json(200, { key });
    }

    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const device = key ? open(deps.keys, key) : undefined;
    if (!device || device.bundle !== deps.topic) return json(401, { error: "that isn't a key from this relay" });
    if (!sends.take(tag(key))) return json(429, { error: "too many notices for this phone; try again later" });
    const b = await body(req);
    if (b instanceof Response) return b;
    const n = checkNotice(b);
    if (!n.ok) return json(400, { error: n.error });
    let out: Outcome;
    try {
      out = await deps.send(device, n.value);
    } catch (err) {
      deps.log(`send key=${tag(key)} failed: ${(err as Error).message}`);
      return json(502, { error: "Apple's push service didn't answer" });
    }
    if (out.ok) {
      deps.log(`send key=${tag(key)} ${n.value.state} ok`);
      return json(200, { sent: true });
    }
    deps.log(`send key=${tag(key)} ${n.value.state} ${out.gone ? "gone" : out.status} ${out.reason}`);
    if (out.gone) return json(410, { error: "this phone no longer takes notifications" });
    if (out.status === 429) return json(429, { error: "Apple is limiting notices to this phone" });
    return json(502, { error: `Apple's push service said ${out.reason || out.status}` });
  };
}
