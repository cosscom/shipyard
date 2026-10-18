import { expect, mockOnly, test } from "./fixtures";

// A box's browsers, in Settings › Boxes (the sidebar's foot opens it): who
// started each, what it costs, and Stop for those Shipyard or its sessions
// started.
// The mock's devl runs a session's Playwright tests at 486% CPU, berth's own
// agent browser, one left by an ended session, an agent-browser session and
// the box user's own Chrome (src/lib/mock-processes.ts).

test.beforeEach(() => mockOnly("a box's processes are mock fixtures, and Stop would stop them"));

test("the sidebar's foot leads to the box's browsers, and Stop stops one", async ({ app }) => {
  const { page } = app;
  await app.open();
  await page.getByTestId("sidebar-boxes").click();
  const panel = page.getByTestId("settings-boxes").locator("[data-testid=box-processes-card][data-box=devl]");
  await expect(panel).toBeVisible();
  const playwright = panel.getByTestId("box-browser").filter({ hasText: "Playwright tests in shop/https-linear-app-acme" });
  await expect(playwright).toContainText("486%");
  await expect(playwright).toContainText("1.3 GB");
  await expect(panel.getByTestId("box-browser").filter({ hasText: "Agent browser for shop/checkout-fix" })).toContainText("Shipyard");
  await expect(panel.getByTestId("box-browser").filter({ hasText: "left by ended session order-export-claude" })).toContainText("Left behind");
  // The box user's own Chrome is listed, never stoppable.
  const own = panel.locator("[data-testid=box-browser][data-owner=other]");
  await expect(own).toContainText("Chrome, not started by Shipyard");
  await expect(own.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  // The session near its memory limit, with the limit.
  await expect(panel.getByTestId("box-session").first()).toContainText("11.8 GB of 12 GB");

  await playwright.getByRole("button", { name: /^Stop Playwright tests/ }).click();
  await expect(page.getByText("Stopped Playwright tests in shop/https-linear-app-acme")).toBeVisible();
  await expect(panel.getByTestId("box-browser").filter({ hasText: "Playwright tests in" })).toHaveCount(0);
  await expect(panel.getByTestId("box-browser")).toHaveCount(4);
});

test("Settings › Boxes lists the same browsers and sets a per-session memory limit", async ({ app }) => {
  await app.open();
  const boxes = await app.openSettings("boxes");
  const card = boxes.locator("[data-testid=box-processes-card][data-box=devl]");
  await expect(card).toContainText("Browsers and sessions");
  await expect(card.getByTestId("box-browser").first()).toBeVisible();
  await expect(card.getByRole("combobox", { name: "Memory limit per session" })).toContainText("12 GB per session");
});

test("a session near its memory limit says so in its chat and its tab", async ({ app }) => {
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree("devl/https-linear-app-acme");
  await expect(app.chat).toBeVisible();
  const notice = app.page.locator("[data-notice=memory]:visible");
  await expect(notice).toContainText("near its memory limit");
  await expect(notice).toContainText("using 11.8 GB, near its 12 GB limit");
  await expect(app.page.getByTestId("tab-memory").first()).toBeVisible();
});
