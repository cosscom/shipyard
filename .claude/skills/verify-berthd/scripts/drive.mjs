#!/usr/bin/env node
// drive.mjs <scenario> --port N [--out DIR] [--agent URL]: drive the
// app's preview build on its mock fixtures through a scenario
// (scenarios/*.mjs), with the scenario's test plugins loaded as built-ins,
// and keep the evidence. --agent drives a real laptop agent instead (a dev
// one, never 1377-1379), with its UI token in VERIFY_BERTH_TOKEN.
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
const agent = flag("--agent");
const token = process.env.VERIFY_BERTH_TOKEN;
if (!name || !port || (agent && !token)) {
  console.error("usage: drive.mjs <scenario> --port N [--out DIR] [--agent URL, with VERIFY_BERTH_TOKEN set]");
  process.exit(2);
}
const file = name.endsWith(".mjs") || name.includes("/") ? resolve(name) : join(here, "scenarios", `${name}.mjs`);
const scenario = await import(pathToFileURL(isAbsolute(file) ? file : resolve(file)).href);
if (scenario.live && !agent) {
  console.error(`${name} drives a real box: give it --agent (see ../features/chat-questions.md)`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(flag("--out") ?? `/tmp/verify-berthd/${name.replace(/.*\//, "").replace(/\.mjs$/, "")}-${stamp}`);
mkdirSync(out, { recursive: true });

const log = [];
const steps = [];
const failures = [];
const allow = scenario.allowErrors ?? [];
// The live agent's token is in the page's address: a browser build takes
// it only from ?token= (lib/api.ts endpoint, as e2e/live.mjs does). It is
// a dev agent's on loopback (dev-box.sh), and nothing the driver writes
// keeps it.
const redact = (text) => (token ? String(text).replaceAll(token, "<token>") : String(text));
const step = (text) => {
  steps.push(text);
  console.log(`- ${text}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
// The laptop agent's ports: a run must never reach this machine's own.
await context.route(/^https?:\/\/(?:[^/]*\.)?(?:localhost|127\.0\.0\.1|\[::1\]):(?:1377|1378|1379)(?:\/|$)/, (r) => r.abort());
// What the scenario stands in for before the app's own scripts run (a
// keyboard layout, say), in the page, with initArg.
if (scenario.init) await context.addInitScript(scenario.init, scenario.initArg);
const page = await context.newPage();
page.on("console", (m) => {
  log.push(redact(`[${m.type()}] ${m.text()}`));
  if (m.type() === "error" && !allow.some((re) => re.test(m.text()))) failures.push(redact(`console error: ${m.text()}`));
});
page.on("pageerror", (e) => {
  log.push(redact(`[pageerror] ${e.message}`));
  failures.push(redact(`page error: ${e.message}`));
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

// shot(label, locator) keeps only that part of the page, for a screen that
// also shows what stays out of evidence.
const shot = async (label, part) => {
  await (part ?? page).screenshot({ path: join(out, `${label}.png`) });
  writeFileSync(join(out, `${label}.aria.txt`), redact(await (part ?? page.locator("body")).ariaSnapshot()));
  console.log(`  saved ${label}.png`);
};

// call(path, init) is the laptop agent's API as the app calls it (a box's
// own under /v1/boxes/<box>/api/), for a live scenario to read a change's
// effect on the box.
const call = async (path, init = {}) => {
  const res = await fetch(`${agent}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  if (!res.ok) throw new Error(redact(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`));
  return res.json();
};

let ok = true;
try {
  const params = new URLSearchParams(agent ? { token, agent } : { mock: "1" });
  for (const [k, v] of Object.entries(scenario.params ?? {})) params.set(k, v);
  // The token is in the page's address, as the app takes it; never in the log.
  step(agent ? `open http://localhost:${port}/ on the agent at ${agent}` : `open http://localhost:${port}/?${params}`);
  await page.goto(`http://localhost:${port}/?${params}`);
  await expect(page.getByTestId("nav-home")).toBeVisible({ timeout: 20_000 });
  await scenario.run({ page, shot, step, expect, call });
} catch (err) {
  ok = false;
  failures.push(redact(`scenario failed: ${err.message?.split("\n").slice(0, 6).join("\n")}`));
  await page.screenshot({ path: join(out, "failed.png") }).catch(() => {});
}
await browser.close();
if (failures.length) ok = false;
writeFileSync(join(out, "console.txt"), `${log.join("\n")}\n`);
writeFileSync(join(out, "result.json"), `${JSON.stringify({ scenario: name, ok, steps, failures }, null, 2)}\n`);
for (const f of failures) console.error(f);
console.log(`${ok ? "OK" : "FAILED"}: evidence in ${out}`);
process.exit(ok ? 0 : 1);
