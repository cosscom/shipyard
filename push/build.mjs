// Builds the relay as one Vercel function, in the Build Output API's layout
// (.vercel/output), so the deploy is exactly what this bundles: every route
// goes to it.
//
//   node build.mjs
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const out = join(import.meta.dirname, ".vercel", "output");
const fn = join(out, "functions", "relay.func");
await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [join(import.meta.dirname, "src", "node.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
});

await writeFile(join(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 30 }, null, 2));
await writeFile(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "/(.*)",
          headers: { "strict-transport-security": "max-age=63072000; includeSubDomains; preload", "x-robots-tag": "noindex" },
          continue: true,
        },
        { src: "/(.*)", dest: "/relay" },
      ],
    },
    null,
    2,
  ),
);
console.log(`built ${fn}`);
