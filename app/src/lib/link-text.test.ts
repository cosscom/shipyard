// node --experimental-strip-types --test src/lib/link-text.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { linkParts } from "./link-text.ts";

const OAUTH = "https://shop.example.com/admin/oauth/authorize?client_id=0000example&scope=read_products,write_products&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&state=mock-state-1234567890abcdef";

test("a long sign-in address with a query string is one link, whole", () => {
  assert.deepEqual(linkParts(`Open ${OAUTH} to approve the app`), [{ text: "Open " }, { text: OAUTH, url: OAUTH }, { text: " to approve the app" }]);
});

test("punctuation that ends the sentence stays out of the link", () => {
  assert.deepEqual(linkParts("See https://example.com/a."), [{ text: "See " }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: "." }]);
  assert.deepEqual(linkParts("(see https://example.com/b)"), [{ text: "(see " }, { text: "https://example.com/b", url: "https://example.com/b" }, { text: ")" }]);
});

test("every address in the text is a link", () => {
  assert.deepEqual(linkParts("https://a.example.com and http://b.example.com/x"), [
    { text: "https://a.example.com", url: "https://a.example.com" },
    { text: " and " },
    { text: "http://b.example.com/x", url: "http://b.example.com/x" },
  ]);
});

test("an address the box cut short, into its trailing …, is shown but not linked", () => {
  const clipped = `Open ${OAUTH.slice(0, 120)}…`;
  assert.deepEqual(linkParts(clipped), [{ text: clipped }]);
  // Cut right after a punctuation mark the address doesn't end in, too.
  assert.deepEqual(linkParts("Open https://example.com/a?x=1&…"), [{ text: "Open https://example.com/a?x=1&…" }]);
});

test("an apostrophe in an address is part of it, and a quote around one isn't", () => {
  const url = "https://example.com/search?q=O'Reilly&page=2";
  assert.deepEqual(linkParts(`See ${url} now`), [{ text: "See " }, { text: url, url }, { text: " now" }]);
  assert.deepEqual(linkParts("Open 'https://example.com/a' first"), [{ text: "Open '" }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: "' first" }]);
});

test("an address with an apostrophe that the box cut short is not linked either", () => {
  assert.deepEqual(linkParts("Open https://example.com/search?q=O'Reill…"), [{ text: "Open https://example.com/search?q=O'Reill…" }]);
});

test("an ellipsis inside the text is not the box's cut", () => {
  assert.deepEqual(linkParts("Try https://example.com/a… or not"), [{ text: "Try " }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: "… or not" }]);
  // A sentence's punctuation before the ellipsis stays out of the link too.
  assert.deepEqual(linkParts("Try https://example.com/a.… or not"), [{ text: "Try " }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: ".… or not" }]);
  assert.deepEqual(linkParts("(try https://example.com/a)… or not"), [{ text: "(try " }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: ")… or not" }]);
});

test("an address that ended before the cut is still a link", () => {
  assert.deepEqual(linkParts("Open https://example.com/a and then some words that run on…"), [{ text: "Open " }, { text: "https://example.com/a", url: "https://example.com/a" }, { text: " and then some words that run on…" }]);
});

test("other schemes are not linked", () => {
  assert.deepEqual(linkParts("Mail mailto:ops@example.com or open file:///etc/hosts"), [{ text: "Mail mailto:ops@example.com or open file:///etc/hosts" }]);
  assert.deepEqual(linkParts("javascript:alert(1)"), [{ text: "javascript:alert(1)" }]);
});

test("text without an address is one part, and no text is none", () => {
  assert.deepEqual(linkParts("Which release?"), [{ text: "Which release?" }]);
  assert.deepEqual(linkParts(""), []);
});
