// node --experimental-strip-types --test src/lib/type-scale.test.ts (pnpm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cn, TYPE_SCALE } from "./utils.ts";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

test("every step of the type scale is defined in index.css in rem, with a line height", () => {
  for (const name of TYPE_SCALE) {
    assert.match(css, new RegExp(`--text-${name}:\\s*[\\d.]+rem;`), `--text-${name}`);
    assert.match(css, new RegExp(`--text-${name}--line-height:\\s*[\\d.]+rem;`), `--text-${name}--line-height`);
    // A colour of the same name would make text-<name> a colour too.
    assert.doesNotMatch(css, new RegExp(`--color-${name}:`), `--color-${name} clashes with text-${name}`);
  }
});

test("a step keeps its colour beside it, and replaces another size", () => {
  assert.equal(cn("text-desc", "text-muted-foreground"), "text-desc text-muted-foreground");
  assert.equal(cn("text-muted-foreground", "text-meta"), "text-muted-foreground text-meta");
  assert.equal(cn("text-sm", "text-row"), "text-row");
  assert.equal(cn("text-page-title", "text-xs"), "text-xs");
});
