// node --experimental-strip-types --test src/lib/term-links.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { findUrls, HyperlinkTracker, openable } from "./term-links.ts";

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
