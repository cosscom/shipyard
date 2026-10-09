import { type App, expect, mockOnly, test } from "./fixtures";

// Labs › Layout › Inbox (components/inbox): every agent in one list by what
// it needs from you, the worktree you open beside it, and keys to triage.

async function openInbox(app: App) {
  await app.page.goto("/?mock=1&layout=inbox");
  await expect(app.page.getByTestId("inbox")).toBeVisible();
  // Connected: the agents are listed.
  await expect(app.page.getByTestId("inbox-row").first()).toBeVisible();
}

const cursorRow = (app: App) => app.page.locator("[data-testid=inbox-row][data-cursor]");

test("the inbox lists agents by what they need, and the keyboard triages them", async ({ app }) => {
  mockOnly();
  await openInbox(app);
  const page = app.page;
  const sections = page.getByTestId("inbox-section");
  await expect(sections).toHaveCount(3);
  expect(await sections.evaluateAll((els) => els.map((e) => e.getAttribute("data-section")))).toEqual(["needs", "working", "recent"]);
  // The agent that has waited longest is on top, and says what it asks.
  const top = page.locator("[data-testid=inbox-row]").first();
  await expect(top).toHaveAttribute("data-id", "devl/checkout-fix-claude");
  await expect(top).toContainText("Fix checkout webhook retries");
  await expect(top).toContainText("pnpm prisma migrate dev");

  // The list has the keyboard: j and k move the cursor.
  await expect(cursorRow(app)).toHaveAttribute("data-id", "devl/checkout-fix-claude");
  await expect(page.locator("[data-inbox-row='devl/checkout-fix-claude']")).toBeFocused();
  await page.keyboard.press("j");
  const second = await page.locator("[data-testid=inbox-row]").nth(1).getAttribute("data-id");
  await expect(cursorRow(app)).toHaveAttribute("data-id", second!);
  await page.keyboard.press("k");
  await expect(cursorRow(app)).toHaveAttribute("data-id", "devl/checkout-fix-claude");

  // e puts it away, the cursor goes to the next row; z brings it back.
  await page.keyboard.press("e");
  await expect(page.locator("[data-testid=inbox-row][data-id='devl/checkout-fix-claude']")).toHaveCount(0);
  await expect(cursorRow(app)).toHaveAttribute("data-id", second!);
  await expect(page.getByTestId("inbox-show-done")).toContainText("1 marked done");
  await page.keyboard.press("z");
  await expect(page.locator("[data-testid=inbox-row][data-id='devl/checkout-fix-claude']")).toBeVisible();
  await expect(page.getByTestId("inbox-show-done")).toHaveCount(0);

  // y allows the ask under the cursor, as its button says.
  const ask = page.locator("[data-testid=inbox-row][data-id='devl/checkout-fix-claude']");
  await expect(ask.getByRole("button", { name: /^Allow once/ })).toBeVisible();
  await page.locator("[data-inbox-row='devl/checkout-fix-claude']").focus();
  await page.keyboard.press("y");
  await expect(ask).toContainText("Allowed · resuming");

  // ↵ opens the agent's worktree beside the list, its tab in front.
  await expect(async () => {
    await page.locator("[data-inbox-row='devl/checkout-fix-claude']").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-testid=inbox-row][data-id='devl/checkout-fix-claude']")).toHaveAttribute("data-open", "true", { timeout: 2000 });
  }).toPass();
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Fix checkout webhook retries/);
  await expect(app.panes.first()).toBeVisible();

  // ⌘J brings the keyboard back to the list from the worktree.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.locator("[data-inbox-row]:focus")).toHaveCount(1, { timeout: 1000 });
  }).toPass();
});

test("New task brings the composer forward and starts work", async ({ app }) => {
  mockOnly("starts an agent");
  await openInbox(app);
  const page = app.page;
  await page.getByTestId("inbox-compose").click();
  await expect(page.getByTestId("inbox-home")).toBeVisible();
  const box = page.getByTestId("task-composer").getByRole("textbox").first();
  await expect(box).toBeFocused();
  await page.keyboard.type("Add a health check endpoint");
  await page.getByTestId("task-composer").getByRole("button", { name: "Start" }).click();
  // The new task's worktree opens beside the list.
  await expect(app.panes.first()).toBeVisible();
  await expect(page.getByTestId("inbox-home")).toBeHidden();
});

test("c starts a task from the list too", async ({ app }) => {
  mockOnly();
  await openInbox(app);
  const page = app.page;
  await expect(page.locator("[data-inbox-row]:focus")).toHaveCount(1);
  await page.keyboard.press("c");
  await expect(page.getByTestId("task-composer").getByRole("textbox").first()).toBeFocused();
});

test("the projects tree, Review and Settings are a click away, and Labs switches back", async ({ app }) => {
  mockOnly();
  await openInbox(app);
  const page = app.page;

  // The tree, a tab away, opens a worktree too.
  await page.getByTestId("inbox-tab-projects").click();
  await app.openWorktree("devl/search-perf");

  // Review, at the foot.
  await page.getByTestId("inbox-nav-review").click();
  await expect(page.getByTestId("inbox-nav-review")).toHaveAttribute("aria-current", "page");

  // Settings › Labs › Layout: back to the sidebar.
  const labs = await app.openSettings("labs");
  await labs.getByRole("button", { name: "Sidebar", exact: true }).click();
  await expect(page.getByTestId("inbox")).toBeHidden();
  await expect(page.getByTestId("nav-home")).toBeVisible();
});

test("a narrow window folds the list while a worktree is open, and ⌘J lays it over", async ({ app }) => {
  mockOnly();
  await app.page.setViewportSize({ width: 900, height: 700 });
  await openInbox(app);
  const page = app.page;
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("inbox-strip")).toBeVisible();
  await expect(page.getByTestId("inbox")).toBeHidden();
  await page.getByTestId("inbox-unfold").click();
  await expect(page.getByTestId("inbox")).toBeVisible();
  // Picking a row puts it away again.
  await page.locator("[data-inbox-row]").nth(2).click();
  await expect(page.getByTestId("inbox")).toBeHidden();
  await expect(page.getByTestId("inbox-strip")).toBeVisible();
});
