import type { Page } from "@playwright/test";

import { type App, expect, mockOnly, test } from "./fixtures";

// Labs › Layout › Command (components/command): no sidebar; one line across
// the top says where you are and who needs you, and the switcher (⌘K), ⌘E,
// ⌘[ ⌘] and ⌘1–9 get you around.

// open starts the mock app in the command layout. app.open() waits for the
// sidebar, which this layout doesn't have.
async function open(app: App, prefs: Record<string, unknown> = { commandCoachSeen: true }) {
  await app.context.addInitScript((p) => {
    if (sessionStorage.getItem("e2e.seeded")) return;
    sessionStorage.setItem("e2e.seeded", "1");
    localStorage.setItem("berth.prefs", JSON.stringify(p));
  }, { whatsNewSeen: "999.0.0", labs: true, labsChosen: true, layout: "command", ...prefs });
  await app.page.goto("/?mock=1");
  await expect(app.page.getByTestId("command-where")).toBeVisible();
  // Connected: the line isn't dimmed.
  await expect(app.page.locator("[aria-disabled=true]:has([data-testid=command-where])")).toHaveCount(0);
}

const where = (page: Page) => page.getByTestId("command-where");
const switcher = (page: Page) => page.getByTestId("switcher");
const activeTab = (page: Page) => page.locator("[role=tab][aria-selected=true]");

test("the window has no sidebar, and the switcher goes to a worktree, then back and forward", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(where(page)).toContainText("Home");
  await expect(page.getByTestId("command-summary")).toContainText("2 needs you");

  // Who needs you leads the switcher, each with its preview.
  await where(page).click();
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page).getByTestId("switcher-item").first()).toContainText("Fix checkout webhook retries");
  await expect(page.getByTestId("switcher-preview")).toContainText("pnpm prisma migrate dev");

  // Search finds a worktree; Enter goes there.
  await page.keyboard.type("qa-deck");
  const row = switcher(page).locator('[data-testid=switcher-item][data-value^="wt:devl:"]', { hasText: "qa-deck" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(switcher(page)).toBeHidden();
  await expect(where(page)).toContainText("qa-deck");

  // ⌘[ and ⌘] go back to Home and forward again.
  await page.keyboard.press("Meta+BracketLeft");
  await expect(where(page)).toContainText("Home");
  await page.keyboard.press("Meta+BracketRight");
  await expect(where(page)).toContainText("qa-deck");
});

test("⌘E goes to the agent waiting longest, then the next one", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  // The boxes have said who waits.
  await expect(page.getByTestId("command-summary")).toContainText("2 needs you");
  await page.keyboard.press("Meta+e");
  await expect(where(page)).toContainText("checkout-fix");
  await expect(activeTab(page)).toHaveAccessibleName(/Fix checkout webhook retries/);
  await page.keyboard.press("Meta+e");
  await expect(activeTab(page)).toHaveAccessibleName(/Plan the checkout release/);
  await expect(where(page)).toContainText("gpu");
});

test("⌘↵ in the switcher pins a worktree to ⌘1", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await page.keyboard.press("Meta+k");
  await expect(switcher(page)).toBeVisible();
  await page.keyboard.type("search-perf");
  const row = switcher(page).locator('[data-testid=switcher-item][data-value^="wt:devl:"]', { hasText: "search-perf" });
  await expect(row).toBeVisible();
  await row.hover();
  await expect(row).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Meta+Enter");
  await expect(row.getByText("⌘1")).toBeVisible();
  await expect.poll(async () => ((await app.stored("berth.prefs")) as { pins: string[] }).pins).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(switcher(page)).toBeHidden();

  await page.keyboard.press("Meta+1");
  await expect(where(page)).toContainText("search-perf");
});

test("a new task starts from the top line", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await page.getByRole("button", { name: "New task" }).click();
  const composer = page.getByRole("dialog");
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox").first().fill("say hello");
  await composer.getByRole("button", { name: /^Start/ }).click();
  await expect(composer).toBeHidden();
});

test("Settings is a key away, and the switcher reaches it too", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-general")).toBeVisible();
  await expect(where(page)).toContainText("Settings");

  await page.keyboard.press("Meta+BracketLeft");
  await expect(where(page)).toContainText("Home");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Review");
  await switcher(page).locator('[data-testid=switcher-item][data-value="place:review"]').click();
  await expect(where(page)).toContainText("Review");
});

test("the first time, a card names the keys, and goes away for good", async ({ app }) => {
  mockOnly();
  await open(app, { commandCoachSeen: false });
  const { page } = app;
  const coach = page.getByTestId("command-coach");
  await expect(coach).toContainText("Switch to anything");
  await coach.getByRole("button", { name: "Got it" }).click();
  await expect(coach).toBeHidden();
  await page.reload();
  await expect(where(page)).toBeVisible();
  await expect(coach).toBeHidden();
});

test("the switcher answers a permission without going to the agent", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await expect(page.getByTestId("command-summary")).toContainText("2 needs you");
  await page.keyboard.press("Meta+k");
  const preview = page.getByTestId("switcher-preview");
  await expect(preview).toContainText("Fix checkout webhook retries");
  await expect(preview.getByTestId("switcher-answers")).toBeVisible();
  await page.keyboard.press("Alt+KeyA");
  // "Allowed" until the agent carries on, when it leaves Needs you.
  await expect(preview.getByText(/^Allowed/).or(page.getByTestId("command-summary").getByText("1 needs you"))).toBeVisible();
  // Still where you were: answering doesn't navigate.
  await expect(switcher(page)).toBeVisible();
  await expect(where(page)).toContainText("Home");
});

test("⌘K twice goes back to the last place", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("qa-deck");
  await switcher(page).locator('[data-testid=switcher-item][data-value^="wt:devl:"]', { hasText: "qa-deck" }).click();
  await expect(where(page)).toContainText("qa-deck");
  await page.keyboard.press("Meta+k");
  await expect(switcher(page)).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(switcher(page)).toBeHidden();
  await expect(where(page)).toContainText("Home");
});

test("⇥ in the empty switcher groups every agent by project and box", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("switcher-by-state")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("switcher-by-place")).toHaveAttribute("aria-pressed", "true");
  await expect(switcher(page).getByText(/^shop · devl · \d+ agents?/)).toBeVisible();
  await expect(switcher(page).getByText(/^evals · gpu/)).toBeVisible();
});

test("hovering the count peeks at the agents, every project's at a glance", async ({ app }) => {
  mockOnly();
  await open(app);
  const { page } = app;
  await expect(page.getByTestId("command-summary")).toContainText("2 needs you");
  await page.getByTestId("command-summary").hover();
  const peek = page.getByTestId("command-peek");
  await expect(peek).toContainText("Fix checkout webhook retries");
  await expect(peek.getByTestId("peek-answers")).toBeVisible();
  await expect(peek.getByTestId("peek-projects")).toContainText("shop · devl");
  // A box that's away says so.
  await expect(peek.getByTestId("peek-projects")).toContainText("old-vps");
});
