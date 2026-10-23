// Archive… from a worktree's menu: the dialog closes as soon as Archive is
// pressed, the row says "Archiving…" until its box is done, and a toast
// says how it went. The mock's box takes 4 s to remove a worktree with no
// archive script (?slowremove), as one with a big node_modules does.
// features/worktree-archive.md.

export const params = { slowremove: "4000", sidebar: "list" };

const SLOW = 4000;

export async function run({ page, shot, step, expect }) {
  const toast = (text) => page.locator("[data-slot=toast-viewport] > *", { hasText: text });
  const leaving = (name) => page.locator("[data-leaving]", { hasText: name });
  const archive = async (w) => {
    await page.locator(`[data-testid=worktree-row][data-worktree="${w}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    return dialog;
  };
  // pressArchive confirms and says how long the dialog stayed open. The
  // shot 300 ms in shows it spinning if it waits on the box.
  const pressArchive = async (dialog, label) => {
    const t0 = Date.now();
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    const closed = dialog.waitFor({ state: "hidden", timeout: SLOW * 3 }).then(() => Date.now() - t0);
    await page.waitForTimeout(300);
    await shot(label);
    const ms = await closed;
    step(`the dialog closed ${ms} ms after Archive was pressed`);
    if (ms > 1000) throw new Error(`the dialog stayed open ${ms} ms, waiting on the box`);
    return t0;
  };

  step("gpu/ci-flake (no archive script): Archive… asks first");
  const dialog = await archive("gpu/ci-flake");
  await expect(dialog).toContainText("Archive ci-flake?");
  await expect(dialog).toContainText("Branch me/ci-flake stays");
  await shot("1-confirm");

  step("press Archive: the dialog goes at once and the row says Archiving…");
  const t0 = await pressArchive(dialog, "2-just-after-archive");
  await expect(leaving("ci-flake")).toContainText("Archiving…");

  step("archive gpu/judge-v2 straight after: it waits its turn on gpu, marked too");
  await pressArchive(await archive("gpu/judge-v2"), "3-second-archive");
  await expect(leaving("ci-flake")).toContainText("Archiving…");
  await expect(leaving("judge-v2")).toContainText("Archiving…");
  await shot("4-both-archiving");

  step("when gpu answers, ci-flake goes and says its branch is kept");
  await expect(toast("Archived ci-flake")).toContainText("Branch me/ci-flake is kept.", { timeout: SLOW * 2 });
  step(`Archived ci-flake toast ${Date.now() - t0} ms after Archive`);
  await expect(page.locator('[data-worktree="gpu/ci-flake"]')).toHaveCount(0);
  await expect(leaving("ci-flake")).toHaveCount(0);
  await expect(leaving("judge-v2")).toContainText("Archiving…");
  await shot("5-first-archived");

  step("judge-v2 goes after it, one at a time per box");
  await expect(toast("Archived judge-v2")).toContainText("Branch judge-v2 is kept.", { timeout: SLOW * 2 });
  step(`Archived judge-v2 toast ${Date.now() - t0} ms after the first Archive`);
  await expect(page.locator('[data-worktree="gpu/judge-v2"]')).toHaveCount(0);
  await shot("6-both-archived");

  step("devl/qa-deck (archive script pnpm db:drop): the box runs it in the background");
  const scripted = await archive("devl/qa-deck");
  await expect(scripted).toContainText("pnpm db:drop");
  await pressArchive(scripted, "7-script-just-after-archive");
  await expect(toast("Archiving qa-deck")).toContainText("Its archive script is running on the box");
  await shot("8-script-running");
  await expect(toast("Archived qa-deck")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-worktree="devl/qa-deck"]')).toHaveCount(0);

  step("devl/checkout-fix (uncommitted work): kept, and a warning says why");
  await pressArchive(await archive("devl/checkout-fix"), "9-dirty-just-after-archive");
  await expect(toast("Couldn't archive checkout-fix")).toContainText("checkout-fix has uncommitted changes, so it was left as it is. Commit them first, or use Remove worktree to discard them.");
  await expect(page.locator('[data-testid=worktree-row][data-worktree="devl/checkout-fix"]')).toBeVisible();
  await expect(leaving("checkout-fix")).toHaveCount(0);
  await shot("10-dirty-kept");
}
