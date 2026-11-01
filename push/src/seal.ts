import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// A phone app's key: its device token sealed so that only the relay can
// open it. The app hands the key to each box it pairs with, and a box sends
// it back with every notice; boxes never see the token, and the relay keeps
// nothing. Anyone holding a key can have the relay send that one phone the
// few fields a notice allows, which is what a box needs and no more.
//
//   v1.<kid>.<base64url(iv ‖ AES-256-GCM ciphertext ‖ tag)>
//
// kid names the sealing key, so the relay can seal with a new one while
// keys sealed with the old one still open (SEAL_KEYS keeps both).

export interface Sealed {
  // The device token, as hex.
  token: string;
  // APNs' production or development (sandbox) service.
  env: "production" | "sandbox";
  // The app it was issued for (its bundle id, APNs' topic).
  bundle: string;
  // When it was sealed, Unix seconds.
  iat: number;
}

export type SealKeys = Record<string, Buffer>;

const aad = (kid: string) => Buffer.from(`berth-push v1|${kid}`);

export function seal(keys: SealKeys, kid: string, s: Sealed): string {
  const key = keys[kid];
  if (!key) throw new Error(`no sealing key ${kid}`);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(kid));
  const body = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
  return `v1.${kid}.${Buffer.concat([iv, body, c.getAuthTag()]).toString("base64url")}`;
}

// open returns what a key sealed, or undefined for anything else: another
// version, an unknown kid, a key changed by one bit.
export function open(keys: SealKeys, key: string): Sealed | undefined {
  const m = /^v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return undefined;
  const k = keys[m[1]];
  if (!k) return undefined;
  const raw = Buffer.from(m[2], "base64url");
  if (raw.length < 12 + 16 + 2) return undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    d.setAAD(aad(m[1]));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const s = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8")) as Sealed;
    if (typeof s.token !== "string" || (s.env !== "production" && s.env !== "sandbox") || typeof s.bundle !== "string") return undefined;
    return s;
  } catch {
    return undefined;
  }
}

// sealKeys reads SEAL_KEYS: {"<kid>": "<base64 of 32 bytes>", …}.
export function sealKeys(json: string | undefined): SealKeys {
  const out: SealKeys = {};
  if (!json) return out;
  for (const [kid, b64] of Object.entries(JSON.parse(json) as Record<string, string>)) {
    const key = Buffer.from(b64, "base64");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid) || key.length !== 32) throw new Error(`SEAL_KEYS: ${kid} must be 32 bytes, base64`);
    out[kid] = key;
  }
  return out;
}
