// Links in a terminal's text (lib/terminal): web addresses found in a line,
// and OSC 8 hyperlinks (a program's "text that links somewhere"), whose
// addresses ghostty-web 0.4 keeps to itself, so they are read from the
// output here on the way in.

export interface UrlMatch {
  start: number;
  // Exclusive.
  end: number;
  url: string;
}

// Web and mail addresses only: what the app can hand to the system browser
// (lib/open-url, and the shell plugin's scope in the app).
const URL_RE = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"*]+$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

// findUrls finds the addresses in a line of a terminal's text. Punctuation
// that ends a sentence is left out, and so is a closing bracket the address
// doesn't open: "(see https://example.com/a)" links https://example.com/a,
// https://en.wikipedia.org/wiki/Tmux_(software) keeps its own.
export function findUrls(line: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(line); m; m = URL_RE.exec(line)) {
    let url = m[0];
    for (;;) {
      const before = url;
      url = url.replace(TRAILING, "");
      const last = url.at(-1);
      if (last && CLOSERS[last] && count(url, CLOSERS[last]) < count(url, last)) url = url.slice(0, -1);
      if (url === before) break;
    }
    if (/^(?:https?:\/\/|mailto:)./i.test(url)) out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

function count(s: string, c: string): number {
  let n = 0;
  for (const x of s) if (x === c) n++;
  return n;
}

// Only these open from a terminal: a file:// or ssh:// link would go
// nowhere useful, or somewhere surprising.
export const openable = (uri: string): boolean => /^(?:https?:\/\/[^\s]|mailto:[^\s])/i.test(uri);

const MAX_OSC = 4096;
const MAX_LABEL = 1024;
const MAX_LINKS = 500;

// HyperlinkTracker reads a terminal's output for OSC 8 hyperlinks
// (ESC ] 8 ; params ; URI ST, the text, then ESC ] 8 ; ; ST) and remembers
// each one's text and address, the most recent few hundred. A cell on the
// screen only says that it is part of some hyperlink; its text is looked up
// here (uriFor). Output with no OSC 8 in it costs a scan for ESC ] 8 only.
export class HyperlinkTracker {
  private mode: "text" | "esc" | "escArg" | "csi" | "osc" | "oscEsc" = "text";
  private osc = "";
  private uri: string | null = null;
  private label = "";
  private carry = "";
  private bytesCarry: Uint8Array | null = null;
  private decoder: TextDecoder | null = null;
  private readonly links = new Map<string, string>();

  // feed takes output as the terminal gets it, in pieces cut anywhere.
  feed(data: string | Uint8Array) {
    if (typeof data === "string") {
      const s = this.carry + data;
      this.carry = "";
      if (this.idle() && !s.includes("\x1b]8;")) {
        this.carry = partial(s);
        return;
      }
      this.scan(s);
      return;
    }
    let b = data;
    if (this.bytesCarry) {
      const joined = new Uint8Array(this.bytesCarry.length + b.length);
      joined.set(this.bytesCarry);
      joined.set(b, this.bytesCarry.length);
      b = joined;
      this.bytesCarry = null;
    }
    if (this.idle() && !hasOsc8(b)) {
      this.decoder = null;
      const at = partialBytes(b);
      if (at >= 0) this.bytesCarry = b.slice(at);
      return;
    }
    this.decoder ??= new TextDecoder();
    this.scan(this.decoder.decode(b, { stream: true }));
  }

  // uriFor is the address of the hyperlink whose text (or, for one that
  // wraps onto the next row, a piece of whose text) this is.
  uriFor(text: string): string | undefined {
    const t = text.trim();
    if (!t) return undefined;
    const exact = this.links.get(t);
    if (exact) return exact;
    if (t.length < 2) return undefined;
    let found: string | undefined;
    for (const [label, uri] of this.links) if (label.includes(t)) found = uri;
    return found;
  }

  reset() {
    this.mode = "text";
    this.osc = "";
    this.uri = null;
    this.label = "";
    this.carry = "";
    this.bytesCarry = null;
    this.decoder = null;
  }

  private idle() {
    return this.mode === "text" && this.uri === null;
  }

  private scan(s: string) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      switch (this.mode) {
        case "text":
          if (c === "\x1b") this.mode = "esc";
          else if (this.uri !== null && c >= " " && c !== "\x7f" && this.label.length < MAX_LABEL) this.label += c;
          break;
        case "esc":
          if (c === "]") {
            this.mode = "osc";
            this.osc = "";
          } else if (c === "[") this.mode = "csi";
          else if ("()*+-./#%".includes(c)) this.mode = "escArg";
          else this.mode = "text";
          break;
        case "escArg":
          this.mode = "text";
          break;
        case "csi":
          if (c >= "@" && c <= "~") this.mode = "text";
          break;
        case "osc":
          if (c === "\x07") this.endOsc();
          else if (c === "\x1b") this.mode = "oscEsc";
          else if (this.osc.length < MAX_OSC) this.osc += c;
          break;
        case "oscEsc":
          this.endOsc();
          // ESC \ ends it; ESC and anything else starts the next sequence.
          if (c !== "\\") {
            this.mode = "esc";
            i--;
          }
          break;
      }
    }
  }

  private endOsc() {
    this.mode = "text";
    const osc = this.osc;
    this.osc = "";
    if (!osc.startsWith("8;")) return;
    const params = osc.indexOf(";", 2);
    if (params < 0) return;
    const uri = osc.slice(params + 1);
    this.close();
    if (uri) this.uri = uri;
  }

  private close() {
    const label = this.label.trim();
    if (this.uri !== null && label) {
      this.links.delete(label);
      this.links.set(label, this.uri);
      if (this.links.size > MAX_LINKS) this.links.delete(this.links.keys().next().value!);
    }
    this.uri = null;
    this.label = "";
  }
}

// What may be the start of ESC ] 8 ; at the end of a piece of output.
function partial(s: string): string {
  const at = s.lastIndexOf("\x1b", s.length - 1);
  return at >= 0 && at >= s.length - 3 && "\x1b]8;".startsWith(s.slice(at)) ? s.slice(at) : "";
}

function partialBytes(b: Uint8Array): number {
  for (let at = Math.max(0, b.length - 3); at < b.length; at++) {
    if (b[at] !== 0x1b) continue;
    const rest = b.length - at;
    if ((rest < 2 || b[at + 1] === 0x5d) && (rest < 3 || b[at + 2] === 0x38)) return at;
  }
  return -1;
}

function hasOsc8(b: Uint8Array): boolean {
  for (let i = b.indexOf(0x1b); i >= 0 && i < b.length - 3; i = b.indexOf(0x1b, i + 1)) {
    if (b[i + 1] === 0x5d && b[i + 2] === 0x38 && b[i + 3] === 0x3b) return true;
  }
  return false;
}
