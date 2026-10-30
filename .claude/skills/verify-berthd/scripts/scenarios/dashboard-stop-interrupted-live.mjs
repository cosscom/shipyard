// dashboard-stop-interrupted-live: a removal git doesn't finish in time,
// on a real box (dev-box.sh's devq), as features/dashboard-stop.md
// describes. The box is restarted with a git on its PATH that, for
// verify-slow only, deletes the worktree's .git and .gitignore (so its
// node_modules reads as new) and then hangs, as a
// `git worktree remove` of a big folder on a busy box did, and with
// BERTH_WORKTREE_REMOVE_TIMEOUT=5s. A bulk Stop of verify-slow and
// verify-ok must report the cause in words (timed out), never a bare
// "git worktree remove:", and leave verify-slow half removed. Archive…
// from the sidebar then finishes it: the folder goes, git drops it, the
// branch stays. The box gets its own git back at the end.
// VERIFY_BERTHD=<berthd> runs it on another build (a before: an old box
// stops git after 60 s and says nothing).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const live = true;
export const params = { sidebar: "list" };
// The box is restarted twice on purpose: the agent answers 503 meanwhile.
// A stopped agent's card can still ask for its screen once (404); every
// failed request is logged as a step, so that one shows as such.
export const allowErrors = [/status of 503/, /status of 404/, /net::ERR_/];

const API = "/v1/boxes/devq/api";
const SLOW = "verify-slow";
const OK = "verify-ok";
const devBox = fileURLToPath(new URL("../dev-box.sh", import.meta.url));

function restartBox(env) {
  const args = ["restart", ...(process.env.VERIFY_BERTHD ? [process.env.VERIFY_BERTHD] : [])];
  return execFileSync(devBox, args, { encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

export async function run({ page, shot, step, expect, call }) {
  // Which request failed, since the console doesn't say.
  page.on("response", (r) => r.status() >= 400 && step(`(${r.status()} ${r.request().method()} ${new URL(r.url()).pathname})`));
  const post = (path, body) => call(`${API}${path}`, { method: "POST", body: JSON.stringify(body) });
  const tray = page.getByRole("region", { name: "Background jobs" });
  const dialog = page.getByRole("alertdialog");
  const title = (n) => `Throwaway ${n}`;

  step(`restart the box with a git that deletes ${SLOW}'s .git and then hangs, and a 5 s removal budget`);
  const bin = mkdtempSync(join(tmpdir(), "verify-git-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$3 $4 $5" in\n  "worktree remove "*/acme-shop-${SLOW}) rm -f "$5/.git" "$5/.gitignore"; exec sleep 900 ;;\nesac\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  step(restartBox({ PATH: `${bin}:${process.env.PATH}`, BERTH_WORKTREE_REMOVE_TIMEOUT: "5s" }));
  try {
    await stopAndFinish({ page, shot, step, expect, call, post, tray, dialog, title });
  } finally {
    step(`give the box its own git back: ${restartBox({})}`);
    rmSync(bin, { recursive: true, force: true });
  }
}

async function stopAndFinish({ page, shot, step, expect, call, post, tray, dialog, title }) {
  // The restarted box answers again before anything is asked of it.
  await expect.poll(async () => (await call(`${API}/locations`).catch(() => [])).length, { timeout: 30_000 }).toBeGreaterThan(0);
  // A removal stopped halfway can delete .gitignore before what it ignores.
  const acme = (await call(`${API}/locations`)).find((l) => l.name === "acme-shop").path;
  if (!existsSync(join(acme, ".gitignore"))) {
    writeFileSync(join(acme, ".gitignore"), "node_modules\n");
    execFileSync("git", ["-C", acme, "add", ".gitignore"]);
    execFileSync("git", ["-C", acme, "-c", "user.name=acme", "-c", "user.email=dev@acme.test", "commit", "-qm", "ignore node_modules"]);
  }
  step(`make ${SLOW} and ${OK} in acme-shop, a Claude Code in each, and node_modules in ${SLOW}`);
  const paths = {};
  for (const n of [SLOW, OK]) paths[n] = (await post("/locations/acme-shop/worktrees", { name: n })).path;
  mkdirSync(join(paths[SLOW], "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(paths[SLOW], "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  for (const n of [SLOW, OK]) await post("/sessions", { name: `${n}-claude`, location: `acme-shop/${n}`, agent: "claude", title: title(n) });
  const repo = (await call(`${API}/locations`)).find((l) => l.name === "acme-shop").path;
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const worktrees = () => git("worktree", "list", "--porcelain");
  const branches = () => git("branch", "--list", "--format=%(refname:short)").split("\n");

  step("stop both from the Agent Dashboard, archiving ticked");
  await page.keyboard.press("Meta+j");
  await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();
  for (const n of [SLOW, OK]) await expect(page.locator("article[role=button]", { hasText: title(n) })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const n of [SLOW, OK]) await page.locator("article[role=button]", { hasText: title(n) }).getByText(title(n)).click();
  await page.getByRole("button", { name: "Stop 2…" }).click();
  const archiveBox = dialog.getByRole("checkbox", { name: /Archive their worktrees where it's safe/ });
  if (!(await archiveBox.isChecked())) await archiveBox.click();
  await dialog.getByRole("button", { name: "Stop 2 agents" }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });
  const job = tray.getByRole("group", { name: "Stopping 2 agents" });
  // An old box gives up on git after 60 s.
  await expect(job).toContainText("2 stopped, 1 archived, 1 failed", { timeout: 120_000 });
  const row = job.getByRole("listitem");
  await expect(row).toHaveCount(1);
  const said = (await row.innerText()).replace(/\s+/g, " ").trim();
  step(`the failed row reads: ${said}`);
  await shot("interrupted-1-tray-report");
  if (/git worktree remove:\s*$/.test(said)) throw new Error(`the row ends at "git worktree remove:", with no cause: ${said}`);
  await expect(row).toContainText("Couldn't archive: git worktree remove timed out after 5s and was stopped");
  await expect(row).toContainText("archiving it again finishes it");

  step(`git agrees: ${OK} is gone, ${SLOW} is half removed (prunable, its files still there)`);
  const listed = worktrees();
  if (listed.includes(`worktree ${paths[OK]}\n`)) throw new Error(`${OK}'s worktree is still there`);
  const entry = listed.split("\n\n").find((e) => e.startsWith(`worktree ${paths[SLOW]}\n`));
  if (!entry?.includes("prunable")) throw new Error(`git doesn't list ${SLOW} as prunable:\n${listed}`);
  if (existsSync(join(paths[SLOW], ".git")) || existsSync(join(paths[SLOW], ".gitignore")) || !existsSync(join(paths[SLOW], "node_modules"))) throw new Error(`${SLOW} isn't half removed`);
  step(`git worktree list:\n${listed.trim()}`);
  await job.getByRole("button", { name: "Dismiss" }).click();

  step(`Archive… ${SLOW} from the sidebar finishes it`);
  await page.locator(`[data-testid=worktree-row][data-worktree="devq/${SLOW}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });
  const solo = tray.getByRole("group", { name: `Archiving ${SLOW}` });
  await expect(solo).toContainText(`Archived ${SLOW}`, { timeout: 30_000 });
  await shot("interrupted-2-finished");
  if (existsSync(paths[SLOW])) throw new Error(`${SLOW}'s folder is still there`);
  if (worktrees().includes(paths[SLOW])) throw new Error(`git still lists ${SLOW}`);
  for (const n of [SLOW, OK]) if (!branches().some((b) => b.endsWith(n))) throw new Error(`${n}'s branch is gone`);
  await expect(page.locator(`[data-testid=worktree-row][data-worktree="devq/${SLOW}"]`)).toHaveCount(0);
  step(`its folder is gone, git no longer lists it, and both branches stay:\n${worktrees().trim()}`);
}
