import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// The two-column sidebar (Settings › Appearance, components/sidebar/columns.tsx):
// the places and a row per project in the first column, the picked
// project's tasks in the second. On the mock fixtures: shop has an agent
// waiting for you, evals one at work, and notes nothing going on.

const columns = { sidebarLayout: "columns" };

// Switching to notes, where no session is open (its one agent ended),
// shows its main checkout with a new task in it on top (lib/project-landing);
// landsOnNewTask checks that, then closes the new task.
async function landsOnNewTask(page: Page) {
  await expect(page.getByTestId("nav-home")).not.toHaveAttribute("aria-current", "page");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Project: notes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test("picking two columns in Appearance gives two columns, and the list brings the single list back", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await expect(page.getByTestId("sidebar-projects")).toHaveCount(0);

  const look = await app.openSettings("appearance");
  await look.getByRole("button", { name: "Two columns", exact: true }).click();
  await app.leaveSettings();

  await expect(page.getByTestId("sidebar-projects")).toBeVisible();
  await expect(page.getByTestId("sidebar-tasks")).toBeVisible();
  await expect(page.getByTestId("column-project")).toHaveCount(3);
  // Only the picked project's tasks show, not every project's.
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "evals", exact: true })).toBeVisible();
  await expect(app.worktree("devl/checkout-fix")).toHaveCount(0);

  await app.openSettings("appearance").then((s) => s.getByRole("button", { name: "List", exact: true }).click());
  await app.leaveSettings();
  await expect(page.getByTestId("sidebar-projects")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-tasks")).toHaveCount(0);
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { sidebarLayout: string }).sidebarLayout).toBe("list");
});

test("switching to a project shows its tasks and lands on its agent that worked last", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("column-project")).toHaveCount(3);
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
  // Of shop's agents at work or waiting, qa-deck's changed state last.
  await expect(app.worktree("devl/qa-deck")).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("tab", { name: /^Build the QA deck for the release/, selected: true })).toBeVisible();
  await expect(page.getByTestId("nav-home")).not.toHaveAttribute("aria-current", "page");

  // On to evals, where an agent is at work in judge-v2.
  await page.locator("[data-testid=column-project][data-project=evals]").click();
  await expect(app.worktree("gpu/judge-v2")).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("tab", { name: /^Tune the judge prompt/, selected: true })).toBeVisible();
});

test("switching to a project with no session open shows its main checkout and a new task", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("column-project")).toHaveCount(3);
  const page = app.page;
  // Nothing open in notes: its row is grayed out, unlike shop's.
  await expect(page.locator("[data-testid=column-project][data-project=notes]")).toHaveAttribute("data-idle", "true");
  await expect(page.locator("[data-testid=column-project][data-project=shop]")).not.toHaveAttribute("data-idle");
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  await landsOnNewTask(page);
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true }).locator('[data-testid=worktree-row][data-worktree="devl/notes"]')).toHaveAttribute("data-active", "true");
});

test("picking the project already picked leaves the main area as it was", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("column-project")).toHaveCount(3);
  const page = app.page;
  const shop = page.locator("[data-testid=column-project][data-project=shop]");
  await shop.click();
  await expect(app.worktree("devl/qa-deck")).toHaveAttribute("data-active", "true");

  await page.getByTestId("nav-home").first().click();
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true })).toBeVisible();
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("column-project")).toHaveCount(3);
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  await landsOnNewTask(page);
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
  // Every box's projects in first: evals comes with gpu's and goes first,
  // which would move the rows under the keys.
  await expect(rows).toHaveCount(3);
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
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("column-project")).toHaveCount(3);
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=notes]").click();
  await landsOnNewTask(page);
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

test("each column's boxes, their contents and their ends line up on the sidebar's lanes", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: columns });
  const page = app.page;
  await page.locator("[data-testid=column-project][data-project=shop]").click();
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  const lanes = () =>
    page.evaluate(() => {
      // Each column's box inside its borders (the first has one between them).
      const inner = (el: Element) => {
        const r = el.getBoundingClientRect();
        return new DOMRect(r.left + el.clientLeft, r.top, el.clientWidth, r.height);
      };
      const first = inner(document.querySelector("[data-testid=sidebar-projects]")!);
      const tasks = inner(document.querySelector("[data-testid=sidebar-tasks]")!);
      const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const row = document.querySelector("[data-testid=worktree-row][data-worktree='devl/checkout-fix']")!;
      const left = (r: DOMRect, col: DOMRect) => Math.round(r.left - col.left);
      const right = (r: DOMRect, col: DOMRect) => Math.round(col.right - r.right);
      return {
        boxes: [left(q("[data-testid=nav-home]"), first), left(q("[data-testid=column-project]"), first), left(row.getBoundingClientRect(), tasks)],
        contents: [left(q("[data-testid=nav-home] svg"), first), left(q("[data-testid=tasks-heading] h2"), tasks), left(row.querySelector("[role=img]")!.getBoundingClientRect(), tasks)],
        ends: [right(q("[data-testid=nav-home]"), first), right(q("[data-testid=column-project]"), first), right(row.getBoundingClientRect(), tasks), right(q("[data-testid=tasks-fold]"), tasks)],
      };
    });
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  await expect
    .poll(async () => {
      const l = await lanes();
      return same(l.boxes) && same(l.contents) && same(l.ends);
    })
    .toBe(true);
});
