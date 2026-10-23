import { expect, mockOnly, test } from "./fixtures";

// Back and forward through the places you've been (lib/nav-history.ts), and
// archiving the worktree in front taking you back to where you were before
// it rather than Home.

test("Back and Forward walk the places you've been, and archiving the worktree in front goes back", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  const back = page.getByTestId("history-back");
  const forward = page.getByTestId("history-forward");
  const dashboard = page.getByRole("heading", { name: "Agent Dashboard" });
  const inWorktree = page.getByRole("heading", { level: 1, name: /search-perf/ });

  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await page.keyboard.press("Meta+j");
  await expect(dashboard).toBeVisible();
  // The browser's own layout here is US's, or not known: a US keyboard's keys.
  await back.hover();
  await expect(page.locator("[data-slot=tooltip-popup]")).toHaveText("Back (⌘[)");
  await page.getByTestId("dashboard-board").locator("article", { hasText: "Speed up product search" }).click();
  await expect(inWorktree).toBeAttached();

  await back.click();
  await expect(dashboard).toBeVisible();
  await forward.click();
  await expect(inWorktree).toBeAttached();
  await expect(forward).toBeDisabled();
  await page.keyboard.press("Meta+BracketLeft");
  await expect(dashboard).toBeVisible();
  await page.keyboard.press("Meta+BracketRight");
  await expect(inWorktree).toBeAttached();

  await page.keyboard.press("Meta+w");
  await page.getByRole("button", { name: "Archive this worktree…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByText("Archived search-perf")).toBeVisible();
  await expect(dashboard).toBeVisible();
  await expect(inWorktree).toHaveCount(0);
  await expect(forward).toBeDisabled();
});

// Back and Forward are matched by the key's place, so on a layout where [
// and ] need ⌥ they show the keys in that place (lib/key-layout.ts): here
// Norwegian's, as navigator.keyboard.getLayoutMap() says it.
test("on a Norwegian keyboard, Back and Forward show ⌘Å and ⌘¨, and every description fits its line", async ({ app }) => {
  mockOnly();
  await app.context.addInitScript(() => {
    const w = window as unknown as { __layout: [string, string][] };
    w.__layout = [["BracketLeft", "å"], ["BracketRight", "¨"], ["KeyD", "d"]];
    const keyboard = Object.assign(new EventTarget(), { getLayoutMap: async () => new Map(w.__layout) });
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
  });
  await app.open();
  const page = app.page;
  const tip = page.locator("[data-slot=tooltip-popup]");

  // An arrow with nowhere to go has no tooltip: go somewhere, then back.
  await page.keyboard.press("Meta+j");
  await page.getByTestId("history-back").hover();
  await expect(tip).toHaveText("Back (⌘Å)");
  await page.keyboard.press("Meta+BracketLeft");
  await page.getByTestId("history-forward").hover();
  await expect(tip).toHaveText("Forward (⌘¨)");

  await page.keyboard.press("Meta+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByRole("listitem").filter({ hasText: "Back to where you were" })).toContainText("⌘Å");
  await expect(sheet.getByRole("listitem").filter({ hasText: "Forward again, after Back" })).toContainText("⌘¨");
  await expect(sheet.getByRole("listitem").filter({ hasText: "Search and commands" })).toContainText("⌘K");
  const cut = await sheet.locator("li .truncate").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
  expect(cut).toEqual([]);

  // Switched to a US layout with the window in front all along: the sheet
  // asks again as it opens.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __layout: [string, string][] }).__layout = [["BracketLeft", "["], ["BracketRight", "]"]];
  });
  await page.keyboard.press("Meta+/");
  await expect(sheet.getByRole("listitem").filter({ hasText: "Back to where you were" })).toContainText("⌘[");
});
