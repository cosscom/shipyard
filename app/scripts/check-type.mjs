// Fails when the app sizes text any way but the type scale.
//
// Text is sized by role (index.css): text-page-title, text-title,
// text-heading, text-subtitle, text-body, text-section, text-row, text-desc,
// text-label, text-meta, text-tag and text-mono. A raw size (text-sm,
// text-xs, text-[11px]) is a new step on the scale that nobody chose, and a
// dozen of those is why two pages that should match don't.
//
// coss ui's own parts (components/ui) keep their sizes: they are the kit's.
// A file in ALLOW draws text as a picture (an illustration, a terminal's
// grid) and says why.
//
//   node scripts/check-type.mjs            check app/src
//   node scripts/check-type.mjs --count    how many each file has, most first
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const src = join(app, "src");

const ALLOW = new Map([
  ["components/whats-new/art.tsx", "What's new's pictures: miniature mock screens drawn on a 480×280 canvas and scaled to fit"],
  ["views/settings/theme-preview.tsx", "a theme card's drawing of a sidebar and a terminal; at 11px its lines wrap"],
  ["views/settings/chat-miniature.tsx", "the chat drawn at about 60% in the chat-background preview"],
]);

const RAW = /(?<![\w-])text-(?:\[[0-9.]+(?:px|rem|em)\]|xs|sm|base|lg|xl|[2-9]xl)(?![\w[-])/g;

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (relative(src, p) === join("components", "ui")) continue;
      yield* files(p);
    } else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) yield p;
  }
}

const found = [];
for await (const f of files(src)) {
  const rel = relative(src, f);
  if (ALLOW.has(rel)) continue;
  const lines = (await readFile(f, "utf8")).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RAW)) found.push({ rel, line: i + 1, cls: m[0] });
  });
}

if (process.argv.includes("--count")) {
  const by = new Map();
  for (const f of found) by.set(f.rel, (by.get(f.rel) ?? 0) + 1);
  for (const [rel, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)} ${rel}`);
  console.log(`${found.length} raw sizes in ${by.size} files`);
  process.exit(0);
}

if (found.length) {
  for (const f of found) console.error(`src/${f.rel}:${f.line}: ${f.cls} — use the type scale (index.css: text-body, text-desc, text-meta, text-tag, …)`);
  console.error(`\n${found.length} raw text sizes. Size text by role with the type scale; see the comment in scripts/check-type.mjs.`);
  process.exit(1);
}
console.log("check-type: every size is the scale's");
