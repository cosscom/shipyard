// node --experimental-strip-types --test src/lib/css-has.test.ts (pnpm test)
//
// A rule that asks the whole page :has() (body:has(…) .x, :root:has(…)) makes
// Chrome restyle every element whenever any element is added anywhere: a
// streamed reply's words, a menu opening, a key typed into a composer. In a
// long chat that was 9 ms a draft update, and 35 ms a key on Home with 300
// worktrees. Say it with an attribute on the root instead (scenes.tsx:
// data-berth-dialog).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const src = join(import.meta.dirname, "..");

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(css|tsx?)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// In CSS, a selector; in components, a Tailwind arbitrary variant
// ("[body:has(…)_&]:…", "[:root:has(…)_&]:…").
const PAGE_HAS = /(?:^|[\s,{}(>~+[])(?:html|body|:root)(?:\[[^\]]*\]|\.[\w-]+)*:has\(/m;

test("no stylesheet or class asks the whole page :has()", () => {
  const found: string[] = [];
  for (const f of files(src)) {
    let text = readFileSync(f, "utf8");
    if (f.endsWith(".css")) text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    else text = [...text.matchAll(/\[[^\]\s"'`]*:has\([^\s"'`]*/g)].map((m) => m[0]).join("\n");
    for (const line of text.split("\n")) if (PAGE_HAS.test(line)) found.push(`${f.slice(src.length + 1)}: ${line.trim()}`);
  }
  assert.deepEqual(found, []);
});
