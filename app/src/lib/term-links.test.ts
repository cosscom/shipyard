// node --experimental-strip-types --test src/lib/term-links.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { continues, findUrls, HyperlinkTracker, joinRows, linksAround, openable, type Rows } from "./term-links.ts";

const urls = (line: string) => findUrls(line).map((m) => [m.url, line.slice(m.start, m.end)]);

test("addresses in a line are found where they are, without the sentence around them", () => {
  assert.deepEqual(urls("see https://example.com/acme for more"), [["https://example.com/acme", "https://example.com/acme"]]);
  assert.deepEqual(findUrls("see https://example.com/acme for more")[0], { start: 4, end: 28, url: "https://example.com/acme" });
  assert.deepEqual(urls("Opened https://github.com/acme/web/pull/47."), [["https://github.com/acme/web/pull/47", "https://github.com/acme/web/pull/47"]]);
  assert.deepEqual(urls("(see http://localhost:3000/api?q=1&x=2)"), [["http://localhost:3000/api?q=1&x=2", "http://localhost:3000/api?q=1&x=2"]]);
  assert.deepEqual(urls("https://en.wikipedia.org/wiki/Tmux_(software), then"), [["https://en.wikipedia.org/wiki/Tmux_(software)", "https://en.wikipedia.org/wiki/Tmux_(software)"]]);
  assert.deepEqual(urls('"https://example.com/a" and <https://example.com/b>'), [
    ["https://example.com/a", "https://example.com/a"],
    ["https://example.com/b", "https://example.com/b"],
  ]);
  assert.deepEqual(urls("mail mailto:dev@example.com now"), [["mailto:dev@example.com", "mailto:dev@example.com"]]);
  assert.deepEqual(urls("no links: https:// file:///etc/hosts ssh://box"), []);
});

test("only web and mail addresses open from a terminal", () => {
  assert.ok(openable("https://example.com"));
  assert.ok(openable("http://localhost:3000"));
  assert.ok(openable("mailto:dev@example.com"));
  assert.ok(!openable("file:///etc/hosts"));
  assert.ok(!openable("ssh://box"));
  assert.ok(!openable("javascript:alert(1)"));
  assert.ok(!openable("https://"));
});

test("an OSC 8 hyperlink's text gives its address back", () => {
  const h = new HyperlinkTracker();
  h.feed("and \x1b]8;;https://example.com/osc\x1b\\the label\x1b]8;;\x1b\\ here\r\n");
  assert.equal(h.uriFor("the label"), "https://example.com/osc");
  assert.equal(h.uriFor("  the label "), "https://example.com/osc");
  // A piece of it, as on a row it wrapped from.
  assert.equal(h.uriFor("label"), "https://example.com/osc");
  assert.equal(h.uriFor("here"), undefined);
  // BEL ends it as well, with parameters (tmux sends an id), and colours
  // inside the text are not part of it.
  h.feed("\x1b]8;id=tmux1;https://example.com/pr\x07PR \x1b[1m#47\x1b[0m\x1b]8;;\x07");
  assert.equal(h.uriFor("PR #47"), "https://example.com/pr");
  // The latest address for the same text wins.
  h.feed("\x1b]8;;https://example.com/osc2\x1b\\the label\x1b]8;;\x1b\\");
  assert.equal(h.uriFor("the label"), "https://example.com/osc2");
});

// fx's "Sign in with Codex" screen (fx 0.0.13), with a made-up address.
const AUTH = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_acme0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=c3RhdGVhY21l&originator=fx";

test("a sign-in link's text gives its address from any word of it, as fx and tmux send it", () => {
  // fx itself, with its own id, its colours reset inside the link.
  const fx = new HyperlinkTracker();
  fx.feed(`\x1b[1m\x1b[38;5;255m  Open   \x1b[4m\x1b]8;id=fx-codex-auth;${AUTH}\x1b\\Authorize with Codex\x1b[0m\x1b]8;;\x1b\\`);
  // tmux 3.6 attached with its hyperlinks feature: its own id, and the
  // colours reset after the link.
  const tmux = new HyperlinkTracker();
  tmux.feed(`\x1b[5;1H\x1b[1m\x1b[38;5;255m  Open   \x1b[4m\x1b]8;id=tmux3;${AUTH}\x1b\\Authorize with Codex\x1b]8;;\x1b\\\x1b(B\x1b[m\x1b[K\r\n`);
  for (const h of [fx, tmux]) {
    for (const text of ["Authorize with Codex", "Authorize", "with Codex", " with ", "Codex"]) assert.equal(h.uriFor(text), AUTH, text);
    assert.equal(h.uriFor("Open"), undefined);
  }
  // Without the feature, tmux sent the text alone: nothing to open.
  const plain = new HyperlinkTracker();
  plain.feed("\x1b[5;1H\x1b[1m\x1b[38;5;255m  Open   \x1b[4mAuthorize with Codex\x1b(B\x1b[m\x1b[K\r\n");
  assert.equal(plain.uriFor("Authorize with Codex"), undefined);
});

test("a link tmux draws in pieces, moving the cursor between them, is found from all of it", () => {
  const h = new HyperlinkTracker();
  // One hyperlink, its text put in two places: as "Authorize with" and
  // "Codex", not "Authorize withCodex".
  h.feed(`\x1b[5;10H\x1b]8;id=tmux3;${AUTH}\x1b\\Authorize with\x1b[5;25HCodex\x1b]8;;\x1b\\`);
  assert.equal(h.uriFor("Authorize with Codex"), AUTH);
  assert.equal(h.uriFor("withCodex"), undefined);
  // Each piece a hyperlink of its own (tmux opens it again for each).
  const again = new HyperlinkTracker();
  again.feed(`\x1b]8;id=tmux4;${AUTH}\x1b\\Authorize\x1b]8;;\x1b\\\x1b[C\x1b]8;id=tmux4;${AUTH}\x1b\\with\x1b]8;;\x1b\\ \x1b]8;id=tmux4;${AUTH}\x1b\\Codex\x1b]8;;\x1b\\`);
  assert.equal(again.uriFor("Authorize with Codex"), AUTH);
  // Across a line break, as on two rows.
  const rows = new HyperlinkTracker();
  rows.feed(`\x1b]8;;${AUTH}\x1b\\Authorize\r\nwith Codex\x1b]8;;\x1b\\`);
  assert.equal(rows.uriFor("Authorizewith Codex"), AUTH);
  // Text only partly made of one link's pieces is not that link.
  assert.equal(again.uriFor("Authorize the acme app"), undefined);
  again.feed("\x1b]8;;https://example.com/acme\x1b\\acme app\x1b]8;;\x1b\\");
  assert.equal(again.uriFor("Authorize acme app"), undefined);
  assert.equal(again.uriFor("acme app"), "https://example.com/acme");
});

test("hyperlinks cut across pieces of output are read whole, as text or bytes", () => {
  const whole = "x \x1b]8;;https://example.com/split\x1b\\split ✓ link\x1b]8;;\x1b\\ y";
  for (const cut of [1, 2, 3, 4, 5, 10, 30, 36, 40, 44, 50]) {
    const s = new HyperlinkTracker();
    s.feed(whole.slice(0, cut));
    s.feed(whole.slice(cut));
    assert.equal(s.uriFor("split ✓ link"), "https://example.com/split", `text cut at ${cut}`);
    const bytes = new TextEncoder().encode(whole);
    for (const at of [cut, bytes.length - cut]) {
      const b = new HyperlinkTracker();
      b.feed(bytes.slice(0, at));
      b.feed(bytes.slice(at));
      assert.equal(b.uriFor("split ✓ link"), "https://example.com/split", `bytes cut at ${at}`);
    }
  }
});

test("output without hyperlinks leaves nothing behind", () => {
  const h = new HyperlinkTracker();
  h.feed("\x1b[1mbold\x1b[0m \x1b]0;title\x07 https://example.com\r\n");
  h.feed(new TextEncoder().encode("plain \x1b[32mgreen\x1b[0m"));
  assert.equal(h.uriFor("bold"), undefined);
  assert.equal(h.uriFor("https://example.com"), undefined);
});

// A screen of `cols` columns, each row padded to the full width as the
// terminal's cells are; wrapped lists the rows the terminal soft-wrapped.
function screen(cols: number, lines: string[], wrapped: number[] = []): Rows {
  const rows = lines.map((l) => l.padEnd(cols, " "));
  return { text: (y) => rows[y], wrapped: (y) => wrapped.includes(y) };
}

// A line cut into rows of `cols`, as a terminal wraps it.
function cut(line: string, cols: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += cols) out.push(line.slice(i, i + cols));
  return out;
}

const SIGN_IN =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_acme0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
  "&scope=openid%20profile%20email%20offline_access&code_challenge=Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg&code_challenge_method=S256" +
  "&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=c3RhdGVzdGF0ZXN0YXRlc3RhdGVzdGF0ZXN0YXRlcw";

const urlsAt = (rows: Rows, y: number) => linksAround(rows, y, findUrls).map((l) => ({ url: l.match.url, ...l.span }));

test("an address the terminal wrapped is found whole from any of its rows", () => {
  const lines = ["If your browser did not open, go to:", ...cut(SIGN_IN, 80), "", "Waiting for sign-in"];
  const last = lines.length - 3;
  assert.ok(last >= 4, "the address takes four rows or more");
  const rows = screen(80, lines, Array.from({ length: last - 1 }, (_, i) => i + 1));
  for (let y = 1; y <= last; y++) {
    assert.deepEqual(urlsAt(rows, y), [{ url: SIGN_IN, start: { x: 0, y: 1 }, end: { x: (SIGN_IN.length - 1) % 80, y: last } }], `from row ${y}`);
  }
  assert.deepEqual(urlsAt(rows, 0), []);
  assert.deepEqual(urlsAt(rows, last + 2), []);
});

test("an address tmux redrew row by row, with no wrap marked, is found whole", () => {
  // tmux puts each row with the cursor: the outer terminal never wraps,
  // so only the text says the rows go on.
  const lines = ["  Sign in at " + SIGN_IN.slice(0, 27), ...cut(SIGN_IN.slice(27), 40), "", "> "];
  const rows = screen(40, lines);
  const last = lines.length - 3;
  for (let y = 0; y <= last; y++) {
    assert.deepEqual(urlsAt(rows, y), [{ url: SIGN_IN, start: { x: 13, y: 0 }, end: { x: (SIGN_IN.length - 27 - 1) % 40, y: last } }], `from row ${y}`);
  }
  // The device code link from a CLI's sign-in, at a narrow width.
  const fx = screen(24, ["Open https://vercel.com/", "oauth/device?user_code=L", "NWD-GLJB to sign in"]);
  for (const y of [0, 1, 2]) assert.deepEqual(urlsAt(fx, y).map((l) => l.url), ["https://vercel.com/oauth/device?user_code=LNWD-GLJB"]);
});

test("rows go on only when wrapped, or full to the last column into text that picks up without a space", () => {
  assert.ok(continues("short", true, "anything"));
  assert.ok(continues("https://example.com/a", false, "bc/d"));
  // The next row starts with a space, or the row doesn't reach its end.
  assert.ok(!continues("https://example.com/a", false, " next"));
  assert.ok(!continues("https://example.com/a   ", false, "next"));
  // A box's border is not part of an address.
  assert.ok(!continues("see https://example.com/a", false, "│ next"));
  assert.ok(!continues("│ https://example.com/a │", false, "more"));

  // An address that ends at the last column, then an unrelated line
  // starting with a space, then one under a row that stops short.
  const ends = "Opened https://example.com/acme/pull/47";
  const rows = screen(ends.length, [ends, "  next line", "short", "https://example.com/b"]);
  assert.deepEqual(urlsAt(rows, 0), [{ url: "https://example.com/acme/pull/47", start: { x: 7, y: 0 }, end: { x: ends.length - 1, y: 0 } }]);
  assert.equal(joinRows(rows, 1)?.texts.length, 1);
  assert.deepEqual(urlsAt(rows, 3), [{ url: "https://example.com/b", start: { x: 0, y: 3 }, end: { x: 20, y: 3 } }]);
});

test("a run of rows is followed only so far", () => {
  const rows = screen(10, Array.from({ length: 200 }, () => "a".repeat(10)));
  const line = joinRows(rows, 100)!;
  assert.ok(line.texts.length <= 32);
  assert.ok(line.first <= 100 && line.first + line.texts.length > 100);
});
