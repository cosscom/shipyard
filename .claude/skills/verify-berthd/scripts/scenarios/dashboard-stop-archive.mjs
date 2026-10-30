// The Agent Dashboard's bulk Stop, with "Archive their worktrees where it's
// safe" ticked (views/dashboard/stop.tsx): the dialog closes at once and
// the run goes on in the background-jobs tray (components/jobs-tray.tsx).
// With ?noruns every box is one from before runs, so this is the app's own
// loop, the fallback (boxes with runs: dashboard-stop-lid on a real box, and
// the e2e). A clean worktree with an archive script archives in the
// background, one without archives (slowly: ?slowremove), a dirty one is
// kept, and one with another agent still in it is kept; the tray reports
// those two. Then a
// clean run fades, and Stop the rest leaves the unsent ones (?slowstop).
// features/dashboard-stop.md.

export const params = { slowremove: "4000", slowstop: "1500", noruns: "1" };

const picks = [
  // devl / search-perf: shop has an archive script, so it runs first.
  "Speed up product search",
  // gpu / ci-flake: no archive script, so it goes after gpu's 4 s.
  "Move acme billing to the new ledger",
  // devl / checkout-fix: uncommitted work, so git keeps it.
  "Fix checkout webhook retries",
  // devl / order-export: two more agents still run there.
  "Export orders as CSV from the admin",
];

export async function run({ page, shot, step, expect }) {
  const dialog = page.getByRole("alertdialog");
  const archiveBox = dialog.getByRole("checkbox", { name: /Archive their worktrees where it's safe/ });
  const tray = page.getByRole("region", { name: "Background jobs" });
  const job = (title) => tray.getByRole("group", { name: title });
  const jobRow = (title, label) => job(title).getByRole("listitem").filter({ hasText: label });
  const toast = (text) => page.locator("[data-slot=toast-viewport] > *", { hasText: text });
  // The Worktrees table lists every box's; the sidebar shows one project.
  const listed = (name) => page.getByRole("checkbox", { name: `Select ${name}`, exact: true });
  const board = async () => {
    await page.keyboard.press("Meta+j");
    await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();
  };
  const stopPicked = async (titles) => {
    // Still picking after the last run, or not yet.
    const select = page.getByRole("button", { name: "Select", exact: true });
    if (await select.isVisible()) await select.click();
    for (const t of titles) await page.locator("article[role=button]", { hasText: t }).getByText(t).click();
    await page.getByRole("button", { name: `Stop ${titles.length}…` }).click();
    await expect(dialog).toBeVisible();
  };
  const confirmStop = async (n, label) => {
    const t0 = Date.now();
    await dialog.getByRole("button", { name: `Stop ${n} agent${n === 1 ? "" : "s"}` }).click();
    const closed = dialog.waitFor({ state: "hidden", timeout: 15_000 }).then(() => Date.now() - t0);
    await page.waitForTimeout(300);
    await shot(label);
    const ms = await closed;
    step(`the dialog closed ${ms} ms after Stop was pressed`);
    if (ms > 1000) throw new Error(`the dialog stayed open ${ms} ms, waiting on the boxes`);
  };

  step("open the Agent Dashboard, Select, and pick four agents");
  await board();
  await stopPicked(picks);
  await expect(archiveBox).not.toBeChecked();
  await expect(dialog).toContainText("its worktree and files are kept");
  await shot("01-stop-dialog-unticked");

  step("tick 'Archive their worktrees where it's safe': the copy says so");
  await archiveBox.click();
  await expect(archiveBox).toBeChecked();
  await expect(dialog).toContainText("then its worktree is archived where it's safe");
  await shot("02-stop-dialog-ticked");

  step("Stop 4 agents: the dialog goes at once, the tray takes over");
  await confirmStop(picks.length, "03-just-after-stop");
  const first = job("Stopping 4 agents");
  await expect(first).toContainText(/Stopping 4 agents · [0-3]\/4/);

  step("mid-run: the tray lists each by box, ci-flake Archiving… on gpu");
  await expect(jobRow("Stopping 4 agents", "ci-flake")).toContainText("Archiving…");
  await expect(first).toContainText("devl");
  await expect(first).toContainText("gpu");
  await shot("04-tray-mid-run");

  step("fold it: one line with the count and a spinner");
  await first.getByRole("button", { name: "Fold" }).click();
  const pill = tray.getByRole("button", { expanded: false });
  await expect(pill).toContainText(/Stopping 4 agents · [0-3]\/4/);
  await shot("05-tray-folded");

  step("go elsewhere while it runs: the Worktrees view opens, the tray stays");
  await page.getByTestId("nav-worktrees").click();
  await expect(listed("checkout-fix")).toBeVisible();
  await expect(tray).toBeVisible();
  await shot("06-elsewhere-while-running");
  await pill.click();

  step("it ends as a report of what was kept, each saying why");
  await expect(first).toContainText("4 stopped, 2 archived, 2 kept", { timeout: 15_000 });
  await expect(first.getByRole("listitem")).toHaveCount(2);
  await expect(jobRow("Stopping 4 agents", "checkout-fix")).toContainText("Stopped · Kept: uncommitted changes");
  await expect(jobRow("Stopping 4 agents", "order-export")).toContainText("Stopped · Kept: another agent is still running there");
  await shot("07-tray-report");

  step("in the Worktrees table the archived ones are gone, the kept ones stay");
  await expect(listed("checkout-fix")).toBeVisible();
  await expect(listed("order-export")).toBeVisible();
  await expect(listed("ci-flake")).toHaveCount(0, { timeout: 10_000 });
  await expect(listed("search-perf")).toHaveCount(0, { timeout: 10_000 });

  step("dismiss the report");
  await first.getByRole("button", { name: "Dismiss" }).click();
  await expect(tray).toHaveCount(0);

  step("the choice is remembered: Clean up… opens with the box ticked");
  await board();
  await page.getByRole("button", { name: "Clean up…" }).click();
  await expect(archiveBox).toBeChecked();
  await expect(dialog).toContainText("Their worktrees are archived where it's safe");
  await shot("08-cleanup-remembers");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  step("a clean run (archive unticked): the toast, a one-line summary, then it fades");
  await stopPicked(["Tune the judge prompt"]);
  await archiveBox.click();
  await expect(archiveBox).not.toBeChecked();
  await confirmStop(1, "09-clean-just-after-stop");
  await expect(toast("Stopped 1 agent")).toContainText("Their worktrees are kept.", { timeout: 10_000 });
  await expect(job("Stopping 1 agent")).toContainText("1 stopped");
  await shot("10-clean-summary");
  await expect(tray).toHaveCount(0, { timeout: 15_000 });
  step("the clean run's summary faded on its own");
  await shot("11-clean-faded");

  step("Stop the rest: four picked, three in flight, the fourth never sent");
  await stopPicked(["Add tests for the export job", "Rerun the evals once the vendor replies", "Fix the cart badge after a refund", "Plan the checkout release"]);
  await confirmStop(4, "12-four-just-after-stop");
  const rest = job("Stopping 4 agents");
  await expect(rest.getByRole("listitem").filter({ hasText: "Stopping…" })).toHaveCount(3);
  await rest.getByRole("button", { name: "Stop the rest" }).click();
  await expect(rest).toContainText("3 stopped, 1 not stopped", { timeout: 10_000 });
  await expect(rest.getByRole("listitem").filter({ hasText: "Not stopped" })).toHaveCount(1);
  await shot("13-stop-the-rest-report");
}
