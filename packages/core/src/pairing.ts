// Pairing a phone with boxes (internal/box/phone.go). The desktop app's QR
// code is a link to the first box's phone page with every box in the URL
// fragment, which never reaches a server or its logs:
//
//   http://100.64.0.7:1379/#pair=<base64url of [{name,url,token}]>
//
// The box's own phone page (internal/box/phoneui/app.js) and the phone app
// both read it. No URL, atob or TextEncoder here: React Native lacks some.

export interface PairedBox {
  name: string;
  url: string;
  token: string;
}

// pairingLink opens the first box's phone page and hands it every box.
export function pairingLink(boxes: PairedBox[]): string | undefined {
  if (!boxes.length) return undefined;
  const json = JSON.stringify(boxes.map((b) => ({ name: b.name, url: b.url, token: b.token })));
  return `${originOf(boxes[0].url)}/#pair=${toBase64url(utf8(json))}`;
}

// parsePairing reads the boxes from a pairing link, or from text holding
// one (a pasted message); undefined when there is none or it is damaged.
export function parsePairing(text: string): PairedBox[] | undefined {
  const m = String(text).match(/#pair=([A-Za-z0-9_-]+)/);
  if (!m) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(fromUtf8(fromBase64url(m[1])));
  } catch {
    return undefined;
  }
  const out: PairedBox[] = [];
  for (const b of Array.isArray(list) ? list : [list]) {
    if (!b || typeof b !== "object") continue;
    const { name, url, token } = b as Record<string, unknown>;
    const origin = typeof url === "string" ? originOf(url) : undefined;
    if (!origin || typeof token !== "string" || !token) continue;
    out.push({ name: typeof name === "string" && name ? name : hostOf(origin), url: origin, token });
  }
  return out.length ? out : undefined;
}

// originOf is a URL's scheme, host and port, lowercased; undefined unless it
// is http or https.
export function originOf(url: string): string | undefined {
  const m = url.trim().match(/^(https?):\/\/([^/?#@\s]+)(?=$|[/?#])/i);
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : undefined;
}

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64url(s: string): number[] {
  const out: number[] = [];
  let n = 0;
  let bits = 0;
  for (const c of s) {
    const v = B64.indexOf(c);
    if (v < 0) throw new Error("not base64url");
    n = (n << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((n >> bits) & 255);
    }
  }
  return out;
}

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function fromUtf8(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (!len || i + len > bytes.length) throw new Error("not UTF-8");
    let c = len === 1 ? b : b & (0xff >> (len + 1));
    for (let k = 1; k < len; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) throw new Error("not UTF-8");
      c = (c << 6) | (bytes[i + k] & 63);
    }
    out += String.fromCodePoint(c);
    i += len;
  }
  return out;
}
