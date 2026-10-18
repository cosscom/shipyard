#!/usr/bin/env node
// drive.mjs <scenario> --port N [--out DIR]: drive the app's preview build
// on its mock fixtures through a scenario (scenarios/*.mjs), with the
// scenario's test plugins loaded as built-ins, and keep the evidence.
// See ../SKILL.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const require = createRequire(join(root, "app/package.json"));
const { chromium, expect } = require("@playwright/test");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const port = flag("--port");
if (!name || !port) {
  console.error("usage: drive.mjs <scenario> --port N [--out DIR]");
  process.exit(2);
}
const file = name.endsWith(".mjs") || name.includes("/") ? resolve(name) : join(here, "scenarios", `${name}.mjs`);
const scenario = await import(pathToFileURL(isAbsolute(file) ? file : resolve(file)).href);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(flag("--out") ?? `/tmp/verify-berthd/${name.replace(/.*\//, "").replace(/\.mjs$/, "")}-${stamp}`);
mkdirSync(out, { recursive: true });

const log = [];
const steps = [];
const failures = [];
const allow = scenario.allowErrors ?? [];
const step = (text) => {
  steps.push(text);
  console.log(`- ${text}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
// The laptop agent's ports: a mock run must never reach them.
await context.route(/^https?:\/\/(?:[^/]*\.)?(?:localhost|127\.0\.0\.1|\[::1\]):(?:1377|1378|1379)(?:\/|$)/, (r) => r.abort());
const page = await context.newPage();
page.on("console", (m) => {
  log.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === "error" && !allow.some((re) => re.test(m.text()))) failures.push(`console error: ${m.text()}`);
});
page.on("pageerror", (e) => {
  log.push(`[pageerror] ${e.message}`);
  failures.push(`page error: ${e.message}`);
});

const plugins = scenario.plugins ?? [];
if (plugins.length) {
  await page.route("**/builtin-plugins/index.json", async (r) => {
    const res = await r.fetch();
    const list = await res.json();
    await r.fulfill({ response: res, json: [...list, ...plugins.map((p) => ({ id: p.id, name: p.name, version: "0.0.0-verify", main: "index.js" }))] });
  });
  for (const p of plugins) await page.route(`**/builtin-plugins/${p.id}/index.js`, (r) => r.fulfill({ contentType: "text/javascript", body: p.source }));
}

const shot = async (label) => {
  await page.screenshot({ path: join(out, `${label}.png`) });
  writeFileSync(join(out, `${label}.aria.txt`), await page.locator("body").ariaSnapshot());
  console.log(`  saved ${label}.png`);
};

let ok = true;
try {
  step(`open http://localhost:${port}/?mock=1`);
  await page.goto(`http://localhost:${port}/?mock=1`);
  await expect(page.getByTestId("nav-home")).toBeVisible({ timeout: 20_000 });
  await scenario.run({ page, shot, step, expect });
} catch (err) {
  ok = false;
  failures.push(`scenario failed: ${err.message?.split("\n").slice(0, 6).join("\n")}`);
  await page.screenshot({ path: join(out, "failed.png") }).catch(() => {});
}
await browser.close();
if (failures.length) ok = false;
writeFileSync(join(out, "console.txt"), `${log.join("\n")}\n`);
writeFileSync(join(out, "result.json"), `${JSON.stringify({ scenario: name, ok, steps, failures }, null, 2)}\n`);
for (const f of failures) console.error(f);
console.log(`${ok ? "OK" : "FAILED"}: evidence in ${out}`);
process.exit(ok ? 0 : 1);
