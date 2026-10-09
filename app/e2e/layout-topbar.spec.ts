import { type App, expect, mockOnly, test } from "./fixtures";

// Labs › Layout › Top bar: no sidebar; the project you're in, your open
// worktrees as tabs and the places across the top, and ⌃⇥ for every agent.

test.beforeEach(() => mockOnly("opens mock worktrees and starts a task"));

const open = (app: App) => app.open({ prefs: { layout: "topbar" } });

test("the top bar takes the sidebar's place", async ({ app }) => {
  const { page } = app;
  await open(app);
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("the project switcher goes to any worktree, which gets a tab", async ({ app }) => {
  const { page } = app;
  await open(app);
  await page.getByTestId("topbar-project").click();
  await page.locator('[data-testid=topbar-worktree-item][data-worktree="devl/search-perf"]').click();
  const tab = page.locator("[data-testid=topbar-tab][data-selected]");
  await expect(tab).toContainText("search-perf");
  await expect(app.panes.first()).toBeVisible();
  // Home and back by its tab.
  await page.getByTestId("nav-home").click();
  await expect(page.locator("[data-testid=topbar-tab][data-selected]")).toHaveCount(0);
  await page.locator("[data-testid=topbar-tab]", { hasText: "search-perf" }).click();
  await expect(page.locator("[data-testid=topbar-tab][data-selected]")).toContainText("search-perf");
});

test("⌘E and a few letters of a task go to its worktree", async ({ app }) => {
  const { page } = app;
  await open(app);
  await page.keyboard.press("Meta+e");
  await page.getByRole("combobox", { name: "Go to a worktree or task" }).fill("judge");
  await expect(page.getByTestId("topbar-worktree-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=topbar-tab][data-selected]")).toContainText("judge-v2");
});

test("what needs you is one click away", async ({ app }) => {
  const { page } = app;
  await open(app);
  await expect(page.getByTestId("topbar-needs-you")).toContainText("2");
  await page.getByTestId("topbar-needs-you").click();
  await expect(page.locator("[data-testid=topbar-tab][data-selected]")).toContainText("checkout-fix");
});

test("holding ⌃ and pressing ⇥ shows every agent, and letting go opens the one picked", async ({ app }) => {
  const { page } = app;
  await open(app);
  // The agents are in: the bar counts them.
  await expect(page.getByTestId("topbar-needs-you")).toBeVisible();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  const switcher = page.getByTestId("agent-switcher");
  await expect(switcher).toBeVisible();
  await expect(switcher.locator("[data-testid=switcher-lane][data-lane=waiting] [data-testid=switcher-card]").first()).toContainText("Fix checkout webhook retries");
  await expect(switcher.locator("[data-testid=switcher-card][data-picked]")).toContainText("Fix checkout webhook retries");
  await page.keyboard.press("Tab");
  await expect(switcher.locator("[data-testid=switcher-card][data-picked]")).toContainText("Plan the checkout release");
  await page.keyboard.up("Control");
  await expect(switcher).toBeHidden();
  await expect(page.locator("[data-testid=topbar-tab][data-selected]")).toContainText("shop");
});

test("closing a tab leaves its agents running and shows the next one", async ({ app }) => {
  const { page } = app;
  await open(app);
  await page.getByTestId("topbar-needs-you").click();
  await expect(page.locator("[data-testid=topbar-tab]")).toHaveCount(1);
  const key = await page.locator("[data-testid=topbar-tab][data-selected]").getAttribute("data-ws");
  await page.locator(`[data-testid=topbar-tab-close][data-ws="${key}"]`).click();
  await expect(page.locator("[data-testid=topbar-tab]")).toHaveCount(0);
  await expect(page.getByTestId("topbar-needs-you")).toContainText("2");
});

test("New task starts work from the top bar", async ({ app }) => {
  const { page } = app;
  await open(app);
  await page.getByTestId("layout-new-task").click();
  const composer = page.getByRole("dialog");
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox").first().fill("say hello");
  await composer.getByRole("button", { name: /^Start/ }).click();
  await expect(composer).toBeHidden();
});

test("Settings is in the top bar, and Labs picks the layout", async ({ app }) => {
  const { page } = app;
  await open(app);
  const labs = await app.openSettings("labs");
  await expect(labs.getByRole("combobox")).toContainText("Top bar");
  await labs.getByRole("combobox").click();
  await page.getByRole("option", { name: "Sidebar (current)" }).click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("topbar")).toHaveCount(0);
});
