// Claude Code's plan limits on the Usage screen, from a structured agent
// (features/usage-limits.md): the Usage plugin is turned on, its Accounts
// tab puts the box's new sessions on account "acme-max", one cheap
// structured turn runs there, and the box writes what that turn said of the
// account's limits to ~/.berth/limits/acme-max.json. The screen's 5-hour
// and weekly meters show the same numbers as the file, and as Claude Code's
// own /usage (claude-usage.sh), the ground truth.
//
// On a dev box with a HOME of its own and a signed-in account linked in
// (../dev-box.sh):
//
//   export VERIFY_BOX_DIR=/tmp/vb-limits VERIFY_BOX_HOME=/tmp/vb-limits/home VERIFY_CLAUDE_ACCOUNT=/path/to/signed-in/claude-config-dir
//   dev-box.sh up && eval "$(dev-box.sh env)"
//   node drive.mjs usage-limits-live --port $PORT --agent http://127.0.0.1:9378
//
// The screen also lists the account's sessions and projects, so the shots
// keep only the limits.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const live = true;

const BOX = (process.env.VERIFY_WORKTREE ?? "devq/acme-shop").split("/")[0];
const HOME = process.env.VERIFY_BOX_HOME;
const ACCOUNT = process.env.VERIFY_CLAUDE_ACCOUNT;
const SESSION = "limits";

const limitsFile = () => {
  try {
    return JSON.parse(readFileSync(join(HOME, ".berth", "limits", "acme-max.json"), "utf8"));
  } catch {
    return null;
  }
};

export async function run({ page, shot, step, expect, call }) {
  if (!HOME || !ACCOUNT) throw new Error("set VERIFY_BOX_HOME and VERIFY_CLAUDE_ACCOUNT, as dev-box.sh up had them");
  if (limitsFile()) throw new Error("the box already has limits for acme-max: start from a fresh dev box");

  step("turn on Usage & accounts in Settings → Plugins");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-plugins").click();
  const plugins = page.getByTestId("settings-plugins");
  await plugins.getByRole("switch", { name: "Turn on Usage & accounts" }).click({ timeout: 15_000 });
  await expect(plugins.getByRole("switch", { name: "Turn off Usage & accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByTestId("nav-home")).toBeVisible();

  step("open Usage, Accounts: new sessions on the box use acme-max");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Switch agent account");
  await page.getByRole("option", { name: /^Switch agent account/ }).click();
  await page.getByRole("button", { name: "Use acme-max for…" }).click({ timeout: 60_000 });
  await page.getByRole("menuitem", { name: `Everywhere on ${BOX}` }).click();
  await expect.poll(async () => (await call(`/v1/boxes/${BOX}/api/env`)).env?.CLAUDE_CONFIG_DIR ?? "", { timeout: 15_000 }).toContain("acme-max");

  step("one cheap structured turn on acme-max");
  const started = Date.now();
  try {
    // Inside the try: a POST that times out may still have started it.
    await call(`/v1/boxes/${BOX}/api/sessions`, { method: "POST", body: JSON.stringify({ name: SESSION, location: "acme-shop", agent: "claude", driver: "claude", model: "haiku", prompt: "Reply with just: ok" }) });
    await checkLimits({ page, shot, step, expect, started });
  } finally {
    // Gone before the dev box is: an agent still running when it goes
    // down writes its account folder again (dev-box.sh up refuses it).
    await call(`/v1/boxes/${BOX}/api/sessions/${SESSION}`, { method: "DELETE" }).catch(() => {});
  }
}

async function checkLimits({ page, shot, step, expect, started }) {
  await expect.poll(() => limitsFile()?.at ?? "", { timeout: 180_000, intervals: [1_000] }).not.toBe("");
  const file = limitsFile();
  const five = Math.round(file.limits.five_hour.used_percentage);
  const week = Math.round(file.limits.seven_day.used_percentage);
  const at = Date.parse(file.at);
  if (!Number.isFinite(at) || at < started - 5_000) throw new Error(`the file's reading isn't from this turn: ${file.at}`);
  step(`the box wrote acme-max.json: 5-hour ${five}%, weekly ${week}%, as of ${file.at}`);

  const truth = execFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "claude-usage.sh"), [ACCOUNT], { encoding: "utf8" }).trim();
  const usage = Object.fromEntries(truth.split(" ").map((kv) => kv.split("=").map((v, i) => (i ? Number(v) : v))));
  step(`Claude Code's /usage: 5-hour ${usage.five_hour}%, weekly ${usage.seven_day}%`);
  // Two readings seconds apart: an account in use elsewhere can move a
  // point between them.
  if (Math.abs(usage.five_hour - five) > 1 || Math.abs(usage.seven_day - week) > 1) throw new Error(`the file (${five}%, ${week}%) isn't what /usage says (${truth})`);

  step("the Usage screen shows the same");
  await page.getByRole("group", { name: "Show" }).getByText("Usage", { exact: true }).click();
  // The screen read the box when it opened, before the turn; it reads again
  // every 5 minutes, or now with Refresh.
  await page.getByRole("button", { name: "Refresh" }).first().click();
  const fiveMeter = page.getByRole("meter", { name: "5-hour limit" });
  const weekMeter = page.getByRole("meter", { name: "Weekly limit" });
  await expect(fiveMeter).toHaveAttribute("aria-valuenow", String(five), { timeout: 90_000 });
  await expect(weekMeter).toHaveAttribute("aria-valuenow", String(week));
  const rows = fiveMeter.locator("xpath=ancestor::div[contains(@class,'border-t')][1]");
  await expect(rows).toContainText(`${five}% used`);
  await expect(rows).toContainText(`${week}% used`);
  await shot("1-usage-claude-limits", rows);
}
