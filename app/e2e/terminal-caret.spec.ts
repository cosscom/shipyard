import { expect, mockOnly, test } from "./fixtures";

// ghostty-web makes the element it draws in contenteditable, so a focused
// terminal would show the browser's own caret beside its canvas: a thin
// blinking line down the pane's left edge. The terminal draws its own
// cursor; the browser's stays hidden.

test("a focused ghostty terminal shows no browser caret beside its canvas", async ({ app }) => {
  mockOnly("starts a session on a box");
  await app.open({ prefs: { terminal: { renderer: "ghostty" } } });
  const page = app.page;
  await expect(page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
  await page.keyboard.press("Meta+KeyT");
  const picker = page.getByRole("dialog", { name: "New terminal on a box" });
  await expect(picker).toBeVisible();
  await page.keyboard.type("gpu");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();

  const pane = page.locator("[data-testid=pane][data-pane-kind=terminal]:visible");
  const editable = pane.locator("[data-terminal] [contenteditable=true]");
  await expect(editable).toHaveCount(1);
  await expect(editable.locator("canvas")).toBeVisible();
  await editable.click();
  await expect(editable).toBeFocused();
  await expect(editable).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
});
