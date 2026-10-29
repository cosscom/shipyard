// Fails when packages/core reaches past itself: an import of a package, an
// alias (@/lib/…), a path without its .ts extension, or the DOM.
//
// The desktop app (Vite), the phone app (Metro) and node's test runner all
// load packages/core's files as they are, so each may import only its
// neighbours by a relative path with .ts, plus types from the plugin SDK.
// tsc -p ../packages/core (in check:core, after this) checks the rest:
// that lib has no DOM.
//
//   node scripts/check-core.mjs
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const core = resolve(app, "..", "packages", "core", "src");
const SDK = "../../plugin-sdk/src/types.ts";

const problems = [];
for (const name of (await readdir(core, { recursive: true })).filter((n) => n.endsWith(".ts"))) {
  const file = join(core, name);
  const test = name.endsWith(".test.ts");
  const src = await readFile(file, "utf8");
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+"([^"]+)"/gms)) {
    const [, , type, spec] = m;
    const line = src.slice(0, m.index).split("\n").length + (m[0].match(/^\s*/)[0].split("\n").length - 1);
    const where = `${relative(resolve(app, ".."), file)}:${line}`;
    if (test && spec.startsWith("node:")) continue;
    if (spec === SDK) {
      if (!type) problems.push(`${where}: import only types from the plugin SDK (import type …)`);
      continue;
    }
    if (!spec.startsWith("./")) problems.push(`${where}: "${spec}" is outside packages/core; import a neighbour by ./name.ts`);
    else if (!spec.endsWith(".ts")) problems.push(`${where}: "${spec}" needs its .ts extension`);
  }
}

if (problems.length) {
  console.error(`packages/core may only import its own files (./x.ts) and the plugin SDK's types:\n\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("check:core: packages/core imports only itself");
