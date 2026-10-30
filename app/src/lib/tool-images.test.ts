// node --experimental-strip-types --test src/lib/tool-images.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { outputParts } from "./tool-images.ts";

const png = (n: number, line: number) => ({ n, line, mediaType: "image/png" });

test("each served picture stands in place of its own [image] line", () => {
  assert.deepEqual(outputParts("two shots\n[image]\nbetween\n[image]", [png(0, 1), png(1, 3)]), [
    { kind: "text", text: "two shots" },
    { kind: "image", image: png(0, 1) },
    { kind: "text", text: "between" },
    { kind: "image", image: png(1, 3) },
  ]);
});

test("text that only reads [image], and a picture the box doesn't serve, stay text", () => {
  assert.deepEqual(outputParts("written:\n[image]\n[image]\n[image]", [png(2, 3)]), [
    { kind: "text", text: "written:\n[image]\n[image]" },
    { kind: "image", image: png(2, 3) },
  ]);
});

test("a picture cut out of a long output comes after the cut", () => {
  assert.deepEqual(outputParts("head\n… 9 more lines …\ntail", [png(0, 1), png(1, 1)]), [
    { kind: "text", text: "head\n… 9 more lines …" },
    { kind: "image", image: png(0, 1) },
    { kind: "image", image: png(1, 1) },
    { kind: "text", text: "tail" },
  ]);
});

test("output without pictures is its text", () => {
  assert.deepEqual(outputParts("ok", undefined), [{ kind: "text", text: "ok" }]);
  assert.deepEqual(outputParts("", []), []);
});
