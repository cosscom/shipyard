import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// The sidebar's arrangement is read from the laptop agent (lib/nav.ts,
// /v1/app/sidebar). Until it is read the default shows and nothing can be
// changed, so the default is never saved over it; a read that fails is
// tried again until the stored arrangement arrives. The mock keeps the
// document across reloads, and ?failapp=sidebar fails it until
// __mockApp.recover("sidebar").

const sidebar = (page: Page) => page.getByTestId("sidebar");
type MockApp = { doc(key: string): unknown; recover(key: string): void };
const stored = (page: Page) => page.evaluate(() => (window as unknown as { __mockApp: MockApp }).__mockApp.doc("sidebar"));
const recover = (page: Page) => page.evaluate(() => (window as unknown as { __mockApp: MockApp }).__mockApp.recover("sidebar"));

async function pinKits(page: Page) {
  await page.getByTestId("nav-more").click();
  await page.getByTestId("nav-customize").click();
  const sheet = page.getByRole("dialog", { name: "Customize sidebar" });
  await sheet.locator("li", { has: page.getByText("Kits", { exact: true }) }).getByRole("button", { name: "Pin" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar(page).getByTestId("nav-kits")).toBeVisible();
}

test("a pinned place is still pinned after a reload", async ({ app }) => {
  mockOnly("pins a place");
  await app.open();
  const page = app.page;
  await expect(sidebar(page).getByTestId("nav-kits")).toHaveCount(0);
  await pinKits(page);
  await page.reload();
  await expect(sidebar(page).getByTestId("nav-home")).toBeVisible();
  await expect(sidebar(page).getByTestId("nav-kits")).toBeVisible();
});

test("a layout that doesn't load: the default shows, Customize waits, then the stored layout replaces it", async ({ app }) => {
  mockOnly("fails the sidebar's document");
  await app.open();
  const page = app.page;
  await pinKits(page);
  const saved = await stored(page);
  expect((saved as { pinned: string[] }).pinned).toContain("kits");

  // The app starts again while the agent can't answer for the layout.
  await app.open({ params: { failapp: "sidebar" } });
  await expect(sidebar(page).getByTestId("nav-automations")).toBeVisible();
  await expect(sidebar(page).getByTestId("nav-kits")).toHaveCount(0);

  // Customize is blocked, and says why, in More's menu; a change from a
  // row's right-click is refused with the same note.
  await page.getByTestId("nav-more").click();
  await expect(page.getByTestId("nav-customize")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("nav-not-loaded")).toHaveText("Your saved layout hasn't loaded yet. Trying again…");
  await page.keyboard.press("Escape");
  await sidebar(page).getByTestId("nav-review").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await expect(page.getByText("Your saved layout hasn't loaded yet. Trying again…").last()).toBeVisible();
  await expect(sidebar(page).getByTestId("nav-review")).toBeVisible();
  // Nothing was written over the stored layout.
  expect(await stored(page)).toEqual(saved);

  // The agent answers again: the stored layout replaces the default.
  await recover(page);
  await expect(sidebar(page).getByTestId("nav-kits")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("nav-more").click();
  await expect(page.getByTestId("nav-not-loaded")).toHaveCount(0);
  await page.getByTestId("nav-customize").click();
  await expect(page.getByRole("dialog", { name: "Customize sidebar" })).toBeVisible();
  expect(await stored(page)).toEqual(saved);
});
