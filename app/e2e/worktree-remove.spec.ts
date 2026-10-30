import { expect, mockOnly, test } from "./fixtures";

// Removing a worktree asks nothing: it shows "Removing…" and goes. One with
// uncommitted work (checkout-fix, in the fixtures) is kept, and the toast
// that says so offers to remove it anyway. Archive asks, then carries on
// the same way, its dialog gone at once.

test("Remove worktree removes it without a dialog, and a dirty one only when told to", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;

  const clean = app.worktree("devl/search-perf");
  await clean.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove worktree", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(clean).toHaveCount(0, { timeout: 10_000 });

  const dirty = app.worktree("devl/checkout-fix");
  await dirty.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove worktree", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const toast = page.locator("[data-slot=toast-viewport] > *", { hasText: "Kept checkout-fix" });
  await expect(toast).toBeVisible();
  await expect(dirty).toBeVisible();
  // Another toast can be stacked over it; its button still takes the keyboard.
  await toast.getByRole("button", { name: "Remove anyway" }).focus();
  await page.keyboard.press("Enter");
  await expect(dirty).toHaveCount(0, { timeout: 10_000 });
});

test("Archive closes its dialog at once and the worktree goes when its box is done", async ({ app }) => {
  mockOnly();
  // A box takes 4 s to remove a worktree, as one with a big node_modules does.
  await app.open({ params: { slowremove: "4000" } });
  const page = app.page;
  const toast = (text: string) => page.locator("[data-slot=toast-viewport] > *", { hasText: text });
  const dialog = page.getByRole("alertdialog");

  const row = app.worktree("gpu/ci-flake");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });
  await expect(page.locator("[data-leaving]", { hasText: "ci-flake" })).toContainText("Archiving…");
  // It is a one-row job in the tray, which sums it up when it's done.
  const job = page.getByRole("region", { name: "Background jobs" }).getByRole("group", { name: "Archiving ci-flake" });
  await expect(job.getByRole("listitem")).toContainText("Archiving…");
  await expect(toast("Archived ci-flake")).toContainText("Branch me/ci-flake is kept.", { timeout: 10_000 });
  await expect(job).toContainText("Archived ci-flake");
  await expect(row).toHaveCount(0);

  // Uncommitted work: kept, and the toast says why.
  const dirty = app.worktree("devl/checkout-fix");
  await dirty.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });
  await expect(toast("Couldn't archive checkout-fix")).toContainText("Commit them first, or use Remove worktree to discard them.");
  await expect(dirty).toBeVisible();
  // The tray keeps a report of it until it's dismissed.
  const kept = page.getByRole("region", { name: "Background jobs" }).getByRole("group", { name: "Archiving checkout-fix" });
  await expect(kept).toContainText("Kept checkout-fix");
  await expect(kept.getByRole("listitem")).toContainText("Kept: uncommitted changes");
});

test("Delete in the Worktrees table removes the selected ones without a dialog", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await page.getByTestId("nav-worktrees").click();
  // The checkbox's cell takes the click; the checkbox itself doesn't.
  await page.getByRole("checkbox", { name: "Select qa-deck" }).locator("xpath=..").click();
  await page.getByRole("checkbox", { name: "Select search-perf" }).locator("xpath=..").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Select qa-deck" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("checkbox", { name: "Select search-perf" })).toHaveCount(0);
});
