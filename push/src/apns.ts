import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

import type { Notice } from "./schema.ts";

// Apple's push service, with token-based auth: a JWT signed with the
// relay's .p8 key, good for an hour (Apple refuses one older, and one
// renewed more often than every 20 minutes), sent over HTTP/2.

export interface ApnsConfig {
  // The .p8 key's PEM, its id, and the team it belongs to.
  key: string;
  keyId: string;
  teamId: string;
  // The app's bundle id, which is APNs' topic.
  topic: string;
}

export type Outcome =
  | { ok: true }
  // The phone no longer takes notifications from this app: the box forgets it.
  | { ok: false; gone: true; reason: string }
  | { ok: false; gone: false; status: number; reason: string };

// One request to APNs, as Transport sends it; replaced in tests.
export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (req: ApnsRequest) => Promise<{ status: number; body: string }>;

export const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;

export class Apns {
  private signing?: KeyObject;
  private jwt?: { token: string; at: number };
  private config: ApnsConfig;
  private transport: Transport;
  private now: () => number;

  constructor(config: ApnsConfig, transport: Transport = http2Transport(), now: () => number = Date.now) {
    this.config = config;
    this.transport = transport;
    this.now = now;
  }

  // providerToken is the JWT, made afresh every 50 minutes.
  providerToken(fresh = false): string {
    const at = Math.floor(this.now() / 1000);
    if (!fresh && this.jwt && at - this.jwt.at < 50 * 60) return this.jwt.token;
    this.signing ??= createPrivateKey(this.config.key);
    const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: at })).toString("base64url");
    const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: this.signing, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { token: `${head}.${claims}.${sig}`, at };
    return this.jwt.token;
  }

  async send(device: { token: string; env: "production" | "sandbox" }, n: Notice): Promise<Outcome> {
    const req = (fresh: boolean): ApnsRequest => ({
      host: HOSTS[device.env],
      path: `/3/device/${device.token}`,
      headers: {
        authorization: `bearer ${this.providerToken(fresh)}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        // Someone waiting on you is now; a finished turn can wait for the
        // phone's own good time.
        "apns-priority": n.state === "waiting" ? "10" : "5",
        "apns-collapse-id": createHash("sha256").update(n.collapse).digest("hex").slice(0, 32),
        // Worth delivering for a day, not after.
        "apns-expiration": String(Math.floor(this.now() / 1000) + 24 * 3600),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload(n)),
    });
    let res = await this.transport(req(false));
    if (res.status === 403 && reasonOf(res.body) === "ExpiredProviderToken") res = await this.transport(req(true));
    if (res.status === 200) return { ok: true };
    const reason = reasonOf(res.body);
    if (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") return { ok: false, gone: true, reason };
    return { ok: false, gone: false, status: res.status, reason };
  }
}

// payload is the notification itself, made here from a notice's few
// fields: a box cannot add any of its own.
export function payload(n: Notice) {
  return {
    aps: { alert: { title: n.title, body: n.body }, sound: "default", "thread-id": n.kind === "run" ? `${n.box}/run/${n.run}` : `${n.box}/${n.session ?? ""}` },
    berth: { v: 1, box: n.box, kind: n.kind, ...(n.session ? { session: n.session } : {}), ...(n.run ? { run: n.run } : {}) },
  };
}

const reasonOf = (body: string): string => {
  try {
    return String((JSON.parse(body) as { reason?: string }).reason ?? "");
  } catch {
    return "";
  }
};

// http2Transport keeps one connection per APNs host, as Apple asks, and
// makes a new one when it closes.
export function http2Transport(): Transport {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (host: string) => {
    const s = sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    const fresh = connect(host);
    fresh.on("error", () => sessions.delete(host));
    fresh.on("close", () => sessions.delete(host));
    // Not kept alive for the connection alone: a function may freeze.
    fresh.unref();
    sessions.set(host, fresh);
    return fresh;
  };
  return (r) =>
    new Promise((resolve, reject) => {
      const stream = session(r.host).request({ [constants.HTTP2_HEADER_METHOD]: "POST", [constants.HTTP2_HEADER_PATH]: r.path, ...r.headers });
      stream.setTimeout(10_000, () => stream.close(constants.NGHTTP2_CANCEL));
      let status = 0;
      let body = "";
      stream.on("response", (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      stream.setEncoding("utf8");
      stream.on("data", (d: string) => (body += d));
      stream.on("end", () => resolve({ status, body }));
      stream.on("error", reject);
      stream.end(r.body);
    });
}
