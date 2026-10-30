// dashboard-stop-lid: the board's bulk Stop goes on while the laptop
// sleeps, on a real box (dev-box.sh's devq), as features/dashboard-stop.md
// describes. It makes its own throwaway worktrees of acme-shop with a
// Claude Code in each: three clean, one with an uncommitted file, and one
// shared with a second agent that isn't stopped. acme-shop gets a slow
// archive script, so the run is still archiving when the laptop agent is
// paused (SIGSTOP, the lid closing). The box carries on; once the agent is
// back the tray shows how it ended, and git on the box agrees. Then a
// second Stop, and the app is reloaded (a relaunch) mid-run: the tray
// brings the job back from the box. Last, the Worktrees table's Stop
// sessions and Archive, each a stop run on the box too. Nothing it didn't
// make is touched; dev-box.sh down removes the lot.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const live = true;
export const params = { sidebar: "list" };
// While the agent is paused, the app's requests to it fail.
export const allowErrors = [/Failed to load resource/, /net::ERR_/];

const API = "/v1/boxes/devq/api";
const LID = ["verify-lid-a", "verify-lid-b", "verify-lid-c", "verify-lid-dirty", "verify-lid-shared"];
const RELAUNCH = ["verify-relaunch-a", "verify-relaunch-b"];
const DIR = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";

// The dev box's laptop agent: the one on 9378 with dev-box.sh's state.
function agentPid() {
  const out = execFileSync("ss", ["-ltnpH", "sport = :9378"], { encoding: "utf8" });
  for (const m of out.matchAll(/pid=(\d+)/g)) {
    const env = readFileSync(`/proc/${m[1]}/environ`, "utf8").split("\0");
    if (env.includes(`BERTH_HOME=${DIR}/lap-home`)) return Number(m[1]);
  }
  throw new Error("no dev-box agent on 9378");
}

export async function run({ page, shot, step, expect, call }) {
  const post = (path, body) => call(`${API}${path}`, { method: "POST", body: JSON.stringify(body) });
  const tray = page.getByRole("region", { name: "Background jobs" });
  const dialog = page.getByRole("alertdialog");
  const title = (n) => `Throwaway ${n}`;
  const card = (n) => page.locator("article[role=button]", { hasText: title(n) });
  const repo = (await call(`${API}/locations`)).find((l) => l.name === "acme-shop").path;
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const worktrees = () => git("worktree", "list", "--porcelain");
  const branches = () => git("branch", "--list", "--format=%(refname:short)").split("\n");
  const paths = {};

  step("make the worktrees, a Claude Code in each, an uncommitted file in verify-lid-dirty and a second agent in verify-lid-shared");
  for (const n of [...LID, ...RELAUNCH]) paths[n] = (await post("/locations/acme-shop/worktrees", { name: n })).path;
  for (const n of [...LID, ...RELAUNCH]) await post("/sessions", { name: `${n}-claude`, location: `acme-shop/${n}`, agent: "claude", title: title(n) });
  await post("/sessions", { name: "verify-lid-outsider", location: "acme-shop/verify-lid-shared", agent: "claude", title: "Throwaway outsider" });
  writeFileSync(join(paths["verify-lid-dirty"], "notes.txt"), "not committed\n");
  step("acme-shop's archive script takes 6 s, so the run is mid-archive when the lid closes");
  await call(`${API}/locations/acme-shop/scripts`, { method: "PUT", body: JSON.stringify({ archive: "sleep 6" }) });

  const pick = async (names) => {
    await page.keyboard.press("Meta+j");
    await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();
    for (const n of names) await expect(card(n)).toBeVisible({ timeout: 30_000 });
    // Still selecting after the last Stop: no Select to press.
    const select = page.getByRole("button", { name: "Select", exact: true });
    if (await select.isVisible()) await select.click();
    for (const n of names) await card(n).getByText(title(n)).click();
    await page.getByRole("button", { name: `Stop ${names.length}…` }).click();
    const archiveBox = dialog.getByRole("checkbox", { name: /Archive their worktrees where it's safe/ });
    if (!(await archiveBox.isChecked())) await archiveBox.click();
    await dialog.getByRole("button", { name: `Stop ${names.length} agents` }).click();
    await expect(dialog).toBeHidden({ timeout: 1000 });
  };

  step("Stop the five with archiving ticked");
  await pick(LID);
  const job = tray.getByRole("group", { name: "Stopping 5 agents" });
  await expect(job.getByRole("listitem").filter({ hasText: "Archiving…" })).toHaveCount(1, { timeout: 30_000 });
  await shot("lid-1-archiving");

  step("close the lid: pause the laptop agent for 25 s while the box archives");
  const pid = agentPid();
  process.kill(pid, "SIGSTOP");
  const paused = Date.now();
  try {
    while (Date.now() - paused < 25_000) await page.waitForTimeout(1000);
    step(`while paused, git on the box: ${worktrees().split("\n").filter((l) => l.startsWith("worktree ") && l.includes("verify-lid")).length} verify-lid worktrees left`);
  } finally {
    process.kill(pid, "SIGCONT");
  }
  step("open the lid: the tray catches up with the box");
  await expect(job).toContainText("5 stopped, 3 archived, 2 kept", { timeout: 60_000 });
  await expect(job.getByRole("listitem")).toHaveCount(2);
  await expect(job.getByRole("listitem").filter({ hasText: "verify-lid-dirty" })).toContainText("Stopped · Kept: uncommitted changes");
  await expect(job.getByRole("listitem").filter({ hasText: "verify-lid-shared" })).toContainText("Stopped · Kept: another agent is still running there");
  await shot("lid-2-report-after-wake");

  step("git on the box agrees: a, b and c archived, dirty and shared kept, every branch kept, the outsider still running");
  const after = worktrees();
  for (const n of ["verify-lid-a", "verify-lid-b", "verify-lid-c"]) if (after.includes(paths[n])) throw new Error(`${n}'s worktree is still there`);
  for (const n of ["verify-lid-dirty", "verify-lid-shared"]) if (!after.includes(paths[n])) throw new Error(`${n} was archived`);
  for (const n of LID) if (!branches().some((b) => b.endsWith(n))) throw new Error(`${n}'s branch is gone`);
  const sessions = await call(`${API}/sessions`);
  for (const n of LID) if (sessions.some((s) => s.name === `${n}-claude` && !s.exited)) throw new Error(`${n}-claude still runs`);
  if (!sessions.some((s) => s.name === "verify-lid-outsider" && !s.exited)) throw new Error("the outsider was stopped");
  step(`git worktree list:\n${after.trim()}`);
  const stops = (await call(`${API}/runs?template=stop&limit=5`)).filter((r) => r.title === "Stopping 5 agents");
  if (stops[0]?.status !== "succeeded" && stops[0]?.status !== "failed") throw new Error(`the box's run is ${stops[0]?.status}`);
  step(`the box's run ${stops[0].id}: ${stops[0].status}`);
  await job.getByRole("button", { name: "Dismiss" }).click();

  step("Stop two more, and reload the app (a relaunch) while the box archives");
  await pick(RELAUNCH);
  await expect(tray.getByRole("group", { name: "Stopping 2 agents" }).getByRole("listitem").filter({ hasText: "Archiving…" })).toHaveCount(1, { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("nav-home")).toBeVisible({ timeout: 30_000 });
  const back = tray.getByRole("group", { name: "Stopping 2 agents" });
  await expect(back).toBeVisible({ timeout: 30_000 });
  await shot("lid-3-reattached-running");
  await expect(back).toContainText("2 stopped, 2 archived", { timeout: 60_000 });
  await shot("lid-4-reattached-done");
  for (const n of RELAUNCH) if (worktrees().includes(paths[n])) throw new Error(`${n}'s worktree is still there`);
  step("after the relaunch the tray showed the box's run, and it ended 2 stopped, 2 archived; git agrees");
  await call(`${API}/locations/acme-shop/scripts`, { method: "PUT", body: JSON.stringify({ archive: "" }) });

  step("the Worktrees table: Stop sessions in verify-lid-shared, then Archive it, each as a stop run on the box");
  const ranOnBox = async (title) => {
    let r;
    await expect.poll(async () => (r = (await call(`${API}/runs?template=stop&limit=10`)).find((x) => x.title === title))?.status, { timeout: 30_000 }).toBe("succeeded");
    step(`the box's run "${title}": ${r.id} ${r.status}`);
  };
  const row = page.getByRole("checkbox", { name: "Select verify-lid-shared" });
  await page.getByTestId("nav-worktrees").click();
  await row.locator("xpath=..").click();
  await page.getByRole("button", { name: "Stop sessions" }).click();
  await ranOnBox("Stop sessions in 1 worktree");
  if ((await call(`${API}/sessions`)).some((s) => s.name === "verify-lid-outsider" && !s.exited)) throw new Error("the outsider still runs");
  await shot("lid-5-table-stopped");
  // Dismissing the outcome keeps the row selected.
  await page.getByRole("status").filter({ hasText: "Stop sessions:" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(row).toBeChecked();
  await page.getByRole("button", { name: /^Archive/ }).click();
  await dialog.getByRole("button", { name: "Archive 1" }).click();
  await ranOnBox("Archive 1 worktree");
  await expect(dialog).toContainText("Archived 1 worktree", { timeout: 30_000 });
  await shot("lid-6-table-archived");
  if (worktrees().includes(paths["verify-lid-shared"])) throw new Error("verify-lid-shared is still there");
  if (!branches().some((b) => b.endsWith("verify-lid-shared"))) throw new Error("verify-lid-shared's branch is gone");
  step("git agrees: verify-lid-shared archived, its branch kept");
}
