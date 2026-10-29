// node --experimental-strip-types --test packages/core/src/pairing.test.ts (pnpm test in app/)
import assert from "node:assert/strict";
import { test } from "node:test";

import { originOf, pairingLink, parsePairing, type PairedBox } from "./pairing.ts";

const boxes: PairedBox[] = [
  { name: "acme-dev", url: "http://100.64.0.7:1379/", token: "a".repeat(48) },
  { name: "acme-büro ✓", url: "http://acme-gpu.tail1234.ts.net:1379", token: "b".repeat(48) },
];

test("a pairing link opens the first box and carries every box", () => {
  const link = pairingLink(boxes)!;
  assert.match(link, /^http:\/\/100\.64\.0\.7:1379\/#pair=[A-Za-z0-9_-]+$/);
  assert.deepEqual(parsePairing(link), [
    { name: "acme-dev", url: "http://100.64.0.7:1379", token: "a".repeat(48) },
    { name: "acme-büro ✓", url: "http://acme-gpu.tail1234.ts.net:1379", token: "b".repeat(48) },
  ]);
});

test("the link's base64url is the same as the browser's", () => {
  const json = JSON.stringify(boxes.map((b) => ({ name: b.name, url: b.url, token: b.token })));
  const want = Buffer.from(json, "utf8").toString("base64url");
  assert.equal(pairingLink(boxes), `http://100.64.0.7:1379/#pair=${want}`);
});

test("a link pasted inside a message still pairs", () => {
  const link = pairingLink(boxes.slice(0, 1))!;
  assert.equal(parsePairing(`Open this on your phone: ${link} (Shipyard)`)?.length, 1);
});

test("a single box, not in a list, pairs", () => {
  const b64 = Buffer.from(JSON.stringify({ url: "http://100.64.0.9:1379", token: "c".repeat(48) })).toString("base64url");
  assert.deepEqual(parsePairing(`#pair=${b64}`), [{ name: "100.64.0.9", url: "http://100.64.0.9:1379", token: "c".repeat(48) }]);
});

test("damaged links and boxes without a token or web address pair nothing", () => {
  const enc = (v: unknown) => "#pair=" + Buffer.from(JSON.stringify(v)).toString("base64url");
  assert.equal(parsePairing("http://100.64.0.7:1379/"), undefined);
  assert.equal(parsePairing("#pair=not*base64"), undefined);
  assert.equal(parsePairing("#pair=" + Buffer.from("{oops").toString("base64url")), undefined);
  assert.equal(parsePairing("#pair=" + Buffer.from([0xff, 0xfe]).toString("base64url")), undefined);
  assert.equal(parsePairing(enc([{ name: "x", url: "http://100.64.0.7:1379" }])), undefined);
  assert.equal(parsePairing(enc([{ name: "x", url: "javascript:alert(1)", token: "t" }])), undefined);
  assert.equal(parsePairing(enc([{ name: "x", url: "http://user@evil:1379", token: "t" }])), undefined);
});

test("an origin is the scheme, host and port", () => {
  assert.equal(originOf("HTTP://Acme.TS.net:1379/#s=x"), "http://acme.ts.net:1379");
  assert.equal(originOf("https://[fd7a::1]:1379/path"), "https://[fd7a::1]:1379");
  assert.equal(originOf("ftp://acme"), undefined);
});
