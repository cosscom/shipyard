// dashboard-stop-unanswered: a bulk Stop whose box goes away as Stop is
// pressed, on a real box (dev-box.sh's devq), as features/dashboard-stop.md
// describes. It makes two throwaway worktrees of acme-shop with a Claude
// Code in each, kills the box's berthd (SIGKILL, a crash) as Stop is
// pressed, and starts it again 20 s later, as dev-box.sh does. Meanwhile the
// rows wait for the box rather than fail. Once it's back, the start is asked
// again under the same key, so the box ends with one stop run (whether or
// not it took the first ask), and the job ends as that run did; git on the
// box agrees. Nothing it didn't make is touched; dev-box.sh down removes the
// lot.
import { execFileSync, spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const live = true;
export const params = { sidebar: "list" };
// While the box is paused, the app's requests to it fail.
export const allowErrors = [/Failed to load resource/, /net::ERR_/];

const API = "/v1/boxes/devq/api";
// Unique per run, as a branch outlives its archived worktree.
const TAG = Date.now().toString(36).slice(-4);
const NAMES = [`verify-mute-${TAG}-a`, `verify-mute-${TAG}-b`];
const DIR = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";
const ROOT = execFileSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// startBox starts the dev box's berthd again, as dev-box.sh up does.
function startBox() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BERTH_")));
  const log = openSync(join(DIR, "berthd.log"), "a");
  const p = spawn(join(ROOT, "bin/berthd"), ["serve", "--listen", "127.0.0.1:7544"], { env: { ...env, BERTH_HOME: `${DIR}/box-home`, BERTH_USER_DIR: `${DIR}/box-user`, TMUX_TMPDIR: `${DIR}/tmux` }, detached: true, stdio: ["ignore", log, log] });
  p.unref();
  writeFileSync(join(DIR, "berthd.pid"), `${p.pid}\n`);
}

export async function run({ page, shot, step, expect, call }) {
  const post = (path, body) => call(`${API}${path}`, { method: "POST", body: JSON.stringify(body) });
  const tray = page.getByRole("region", { name: "Background jobs" });
  const dialog = page.getByRole("alertdialog");
  const title = (n) => `Throwaway ${n}`;
  const card = (n) => page.locator("article[role=button]", { hasText: title(n) });
  const repo = (await call(`${API}/locations`)).find((l) => l.name === "acme-shop").path;
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const paths = {};

  step("make two worktrees of acme-shop, a Claude Code in each");
  for (const n of NAMES) paths[n] = (await post("/locations/acme-shop/worktrees", { name: n })).path;
  for (const n of NAMES) await post("/sessions", { name: `${n}-claude`, location: `acme-shop/${n}`, agent: "claude", title: title(n) });
  await call(`${API}/locations/acme-shop/scripts`, { method: "PUT", body: JSON.stringify({ archive: "" }) });

  step("pick them on the Agent Dashboard and tick archiving");
  await page.keyboard.press("Meta+j");
  await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();
  for (const n of NAMES) await expect(card(n)).toBeVisible({ timeout: 30_000 });
  const select = page.getByRole("button", { name: "Select", exact: true });
  if (await select.isVisible()) await select.click();
  for (const n of NAMES) await card(n).getByText(title(n)).click();
  await page.getByRole("button", { name: `Stop ${NAMES.length}…` }).click();
  const archiveBox = dialog.getByRole("checkbox", { name: /Archive their worktrees where it's safe/ });
  if (!(await archiveBox.isChecked())) await archiveBox.click();

  step("press Stop and kill the box's berthd at once: its answer, if any, is lost");
  const pid = Number(readFileSync(`${DIR}/berthd.pid`, "utf8").trim());
  const job = tray.getByRole("group", { name: "Stopping 2 agents" });
  const pressed = Date.now();
  await dialog.getByRole("button", { name: "Stop 2 agents" }).click();
  process.kill(pid, "SIGKILL");
  const down = Date.now();
  try {
    await expect(dialog).toBeHidden({ timeout: 1000 });
    await page.waitForTimeout(8000);
    await shot("mute-1-box-down");
    const rows = (await job.getByRole("listitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    step(`with the box down the rows say: ${rows.join(" | ")}`);
    while (Date.now() - down < 20_000) await page.waitForTimeout(1000);
    const failed = await job.getByRole("listitem").filter({ hasText: "Failed" }).count();
    if (failed) throw new Error(`${failed} rows failed while the box was down`);
    step(`after ${Math.round((Date.now() - down) / 1000)} s down, no row failed`);
  } finally {
    startBox();
  }

  step("the box is back: the job ends as its run did");
  await expect(job).toContainText("2 stopped, 2 archived", { timeout: 90_000 });
  await shot("mute-2-done");
  const runs = (await call(`${API}/runs?template=stop&limit=20`)).filter((r) => r.title === "Stopping 2 agents" && Date.parse(r.created) >= pressed - 2000);
  if (runs.length !== 1) throw new Error(`the box has ${runs.length} runs for it, not one: ${runs.map((r) => r.id).join(", ")}`);
  step(`one stop run on the box for it (group ${runs[0].group}): ${runs[0].id} ${runs[0].status}`);
  const after = git("worktree", "list", "--porcelain");
  for (const n of NAMES) if (after.includes(paths[n])) throw new Error(`${n}'s worktree is still there`);
  const branches = git("branch", "--list", "--format=%(refname:short)").split("\n");
  for (const n of NAMES) if (!branches.includes(n)) throw new Error(`${n}'s branch is gone`);
  step("git on the box agrees: both worktrees gone, both branches kept");
}
