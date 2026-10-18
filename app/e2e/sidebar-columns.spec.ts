import { expect, mockOnly, test } from "./fixtures";

// The two-column sidebar (Settings › Labs, components/sidebar/columns.tsx):
// the places and a row per project in the first column, the picked
// project's tasks in the second. On the mock fixtures: shop has an agent
// waiting for you, evals one at work, and notes nothing going on.

const columns = { sidebarLayout: "columns" };

test("turning it on in Labs gives two columns, and turning it off brings the single list back", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await expect(page.getByTestId("sidebar-projects")).toHaveCount(0);

  const labs = await app.openSettings("labs");
  const toggle = labs.getByRole("switch", { name: "Two-column sidebar" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await app.leaveSettings();

  await expect(page.getByTestId("sidebar-projects")).toBeVisible();
  await expect(page.getByTestId("sidebar-tasks")).toBeVisible();
  await expect(page.getByTestId("column-project")).toHaveCount(3);
  // Only the picked project's tasks show, not every project's.
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "evals", exact: true })).toBeVisible();
  await expect(app.worktree("devl/checkout-fix")).toHaveCount(0);

  await app.openSettings("labs");
  await page.getByRole("switch", { name: "Two-column sidebar" }).click();
  await app.leaveSettings();
  await expect(page.getByTestId("sidebar-projects")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-tasks")).toHaveCount(0);
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { sidebarLayout: string }).sidebarLayout).toBe("list");
});

test("picking a project shows its tasks and leaves the main area as it was", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");

  const shop = page.locator("[data-testid=column-project][data-project=shop]");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  const tasks = page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true });
  await expect(tasks).toBeVisible();
  await expect(tasks.locator('[data-testid=worktree-row][data-worktree="devl/checkout-fix"]')).toBeVisible();
  // Children hang under their parent on the guide, as in the list.
  await expect(tasks.getByTestId("worktree-children").first()).toBeVisible();
  // Still Home in front.
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");

  // A project with nothing going on says so, with ways to start.
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  const empty = page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true }).getByTestId("tasks-empty");
  await expect(empty).toContainText("No tasks here yet.");
  await expect(empty.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Open the main checkout" })).toBeVisible();
});

test("rows in the tasks column open, rename and have their menus as in the list", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=shop]").click();
  await app.openWorktree("devl/checkout-fix");
  await expect(app.panes.first()).toBeVisible();

  const row = app.worktree("devl/checkout-fix");
  await row.click({ button: "right", position: { x: 32, y: 12 } });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await row.focus();
  await page.keyboard.press("F2");
  await expect(page.getByRole("textbox", { name: /name/i }).first()).toBeVisible();
});

test("opening a worktree from elsewhere picks its project", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();

  // From the rail, with the sidebar folded away.
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await page.locator('[data-testid=rail-agent][data-session="devl/checkout-fix-claude"]').click();
  await page.getByRole("button", { name: /Show the sidebar/ }).click();

  await expect(page.locator("[data-testid=column-project][data-project=shop]")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true })).toBeVisible();
  await expect(app.worktree("devl/checkout-fix")).toHaveAttribute("data-active", "true");
});

test("a project's row says only that something needs you or works", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const row = (name: string) => app.page.locator(`[data-testid=column-project][data-project=${name}]`);
  await expect(row("shop").getByRole("img", { name: "Needs you" })).toBeVisible();
  await expect(row("evals").getByRole("img", { name: "Working" })).toBeVisible();
  await expect(row("notes").getByRole("img")).toHaveCount(0);
  // Amber and blue, nothing else.
  await expect(row("shop").locator(".bg-warning")).toHaveCount(1);
  await expect(row("evals").locator("svg.text-info")).toHaveCount(1);
});

test("the project list goes by ↑ and ↓", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  const rows = page.getByTestId("column-project");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows.last()).toHaveAttribute("aria-current", "true");
});

test("the tasks column folds away and comes back, and is sized by its edge", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  const tasks = page.getByTestId("sidebar-tasks");
  await expect(tasks).toBeVisible();

  await page.getByRole("button", { name: "Hide the tasks" }).click();
  await expect(tasks).toHaveCount(0);
  expect(((await app.stored("berth.prefs")) as { tasksFolded: boolean }).tasksFolded).toBe(true);
  await page.getByRole("button", { name: "Show the tasks" }).click();
  await expect(tasks).toBeVisible();

  // Folded, picking a project brings its tasks back too.
  await page.getByRole("button", { name: "Hide the tasks" }).click();
  await page.locator("[data-testid=column-project][data-project=shop]").click();
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true })).toBeVisible();

  // Its edge sizes it by keyboard, and the width is kept.
  const handle = page.getByTestId("tasks-handle");
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBe(before + 16);
  await expect.poll(async () => ((await app.stored("berth.prefs")) as { tasksWidth: number }).tasksWidth).toBe(before + 16);
  await expect.poll(async () => Math.round((await tasks.boundingBox())?.width ?? 0)).toBe(before + 16);
});

test("the choice and the picked project survive a reload", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("sidebar-projects")).toBeVisible();
  await expect(page.locator("[data-testid=column-project][data-project=notes]")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();
});

test("the main area keeps its room in a 1200px window", async ({ app }) => {
  mockOnly();
  await app.page.setViewportSize({ width: 1200, height: 800 });
  await app.open({ prefs: { ...columns, tasksWidth: 380 } });
  const sidebar = await app.page.getByTestId("sidebar").boundingBox();
  expect(sidebar?.width ?? 999).toBeLessThanOrEqual(482);
});

test("grouped by box, boxes head their projects and a project's tasks are its tasks on that box", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitemradio", { name: "Box" }).click();
  await page.keyboard.press("Escape");
  const list = page.getByRole("group", { name: "Projects" });
  await expect(list.getByRole("group", { name: /^devl, / })).toBeVisible();
  const shop = list.locator("[data-testid=column-project][data-project=shop]").first();
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true }).locator('[data-testid=worktree-row][data-worktree="devl/checkout-fix"]')).toBeVisible();
});
