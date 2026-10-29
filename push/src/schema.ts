// What the relay accepts, exactly: anything else is refused, so a box (or
// whoever has a phone's key) can't put more in a notification than a box
// would.

// A notice from a box (internal/box/phonev2.go relayNotice).
export interface Notice {
  v: 1;
  kind: "session" | "run";
  state: "waiting" | "finished";
  title: string;
  body: string;
  box: string;
  session?: string;
  run?: string;
  collapse: string;
}

// A phone app asking for a key.
export interface Registration {
  platform: "ios";
  token: string;
  env: "production" | "sandbox";
  bundle: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const NAME = /^[\p{L}\p{N}._\-/:@]+$/u;
// Printable text on one line: no control characters, no bidi overrides.
const TEXT = /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).find((k) => !keys.includes(k));

function text(v: unknown, max: number, pattern: RegExp): string | undefined {
  if (typeof v !== "string" || !v || [...v].length > max || !pattern.test(v)) return undefined;
  return v;
}

export function checkNotice(v: unknown): Checked<Notice> {
  if (!isObject(v)) return { ok: false, error: "a notice is a JSON object" };
  const extra = only(v, ["v", "kind", "state", "title", "body", "box", "session", "run", "collapse"]);
  if (extra) return { ok: false, error: `unknown field ${JSON.stringify(extra.slice(0, 40))}` };
  if (v.v !== 1) return { ok: false, error: "v must be 1" };
  if (v.kind !== "session" && v.kind !== "run") return { ok: false, error: "kind must be session or run" };
  if (v.state !== "waiting" && v.state !== "finished") return { ok: false, error: "state must be waiting or finished" };
  const title = text(v.title, 80, TEXT);
  const body = text(v.body, 160, TEXT);
  const box = text(v.box, 120, NAME);
  const collapse = text(v.collapse, 200, TEXT);
  if (!title || !body || !box || !collapse) return { ok: false, error: "title (80), body (160), box (120) and collapse (200) are short text" };
  const session = v.session === undefined ? undefined : text(v.session, 120, NAME);
  const run = v.run === undefined ? undefined : text(v.run, 120, NAME);
  if ((v.session !== undefined && !session) || (v.run !== undefined && !run)) return { ok: false, error: "session and run are names" };
  if (v.kind === "run" && !run) return { ok: false, error: "a run's notice names the run" };
  return { ok: true, value: { v: 1, kind: v.kind, state: v.state, title, body, box, session, run, collapse } };
}

export function checkRegistration(v: unknown, topic: string): Checked<Registration> {
  if (!isObject(v)) return { ok: false, error: "a registration is a JSON object" };
  const extra = only(v, ["platform", "token", "env", "bundle"]);
  if (extra) return { ok: false, error: `unknown field ${JSON.stringify(extra.slice(0, 40))}` };
  if (v.platform === "android") return { ok: false, error: "Android isn't supported yet" };
  if (v.platform !== "ios") return { ok: false, error: "platform must be ios" };
  if (typeof v.token !== "string" || !/^[0-9a-fA-F]{64,200}$/.test(v.token)) return { ok: false, error: "token must be an APNs device token, as hex" };
  if (v.env !== "production" && v.env !== "sandbox") return { ok: false, error: "env must be production or sandbox" };
  if (v.bundle !== topic) return { ok: false, error: "this relay doesn't send for that app" };
  return { ok: true, value: { platform: "ios", token: v.token.toLowerCase(), env: v.env, bundle: v.bundle } };
}
