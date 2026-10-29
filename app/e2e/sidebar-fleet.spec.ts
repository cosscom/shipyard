import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// The sidebar with hundreds of worktrees (?bench=fleet, src/lib/mock-bench.ts:
// 300 more over four boxes, each with an agent; 310 rows with the plain
// fixtures', a main checkout with an agent at work among them). Its rows sit in a RowLayer
// (components/sidebar/row-layer.tsx): one context menu and one tooltip for
// all of them, and a row's buttons and menus made only once it is pointed
// at or focused. What that keeps small is counted here, which doesn't move
// with the machine; the time it takes is reported (pnpm perf for the rest).

const FLEET = { bench: "fleet", worktrees: "300" };

// Hundreds of rows take a while to load on a busy runner.
test.slow();

// Base UI's per-row parts, which made 300 rows cost over a second at start.
const ROOTS = "[data-row-menu] :is([data-slot=tooltip-trigger], [data-slot=menu-trigger], [data-slot=context-menu-trigger])";

async function longTasks(page: Page) {
  return page.evaluate(() => (window as unknown as { __long: number[] }).__long.reduce((a, b) => a + b, 0));
}

test("300 worktrees: the sidebar stays small and its rows make no menus or tooltips until used", async ({ app }, info) => {
  mockOnly();
  await app.page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__long.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  await app.open({ params: FLEET });
  const page = app.page;
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByTestId("worktree-row")).toHaveCount(310);

  // Nothing per row but the row: no tooltip, menu or context menu of its own.
  await expect(page.locator(ROOTS)).toHaveCount(0);
  await expect(sidebar.locator("[data-slot=context-menu-trigger]:has([data-row-menu])")).toHaveCount(1);
  // About 17 elements a row; it was 8,086 in all with every row's menus.
  const nodes = await sidebar.evaluate((s) => s.getElementsByTagName("*").length);
  info.annotations.push({ type: "sidebar DOM nodes", description: String(nodes) });
  expect(nodes).toBeLessThan(6500);

  // The start's long tasks, reported: timings move with the machine.
  await page.waitForTimeout(1000);
  info.annotations.push({ type: "start-up long tasks (ms)", description: String(Math.round(await longTasks(page))) });

  // Rows out of sight don't spin or pulse.
  const offscreen = await sidebar.locator("[data-row-menu][data-offscreen]").count();
  expect(offscreen).toBeGreaterThan(200);

  // Pointed at, a row draws its buttons, and only that row.
  const row = app.worktree("acme-build/auth-cache-36");
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const actions = page.getByRole("button", { name: "auth-cache-36 actions", exact: true });
  await expect(actions).toBeVisible();
  // Its + and ⋯ menus (and at most the row the pointer came by).
  expect(await page.locator("[data-row-menu] [data-slot=menu-trigger]").count()).toBeLessThanOrEqual(4);
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Its tooltip: where it is, from the one the list shares.
  await page.mouse.move(800, 450);
  await row.hover();
  await expect(page.locator("[data-slot=tooltip-popup]")).toContainText("/home/me/acme-api-auth-cache-36");
  await page.mouse.move(800, 450);
  await expect(page.locator("[data-slot=tooltip-popup]")).toHaveCount(0);

  // Right-click: its menu, the row marked while it is open.
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Rename…/ })).toBeVisible();
  await expect(row.locator("xpath=ancestor::*[@data-row-menu][1]")).toHaveAttribute("data-menu-open", "");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(row.locator("xpath=ancestor::*[@data-row-menu][1]")).not.toHaveAttribute("data-menu-open", "");
});

test("the keyboard: Shift+F10 and the menu key open a row's menu, F2 renames it, Shift+Tab reaches the row before's buttons", async ({ app }) => {
  mockOnly();
  await app.open({ params: FLEET });
  const page = app.page;
  const row = app.worktree("acme-build/auth-cache-36");
  await row.focus();

  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "New agent", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await row.focus();
  await page.keyboard.press("ContextMenu");
  const rename = page.getByRole("menuitem", { name: /Rename…/ });
  await expect(rename).toBeVisible();
  await page.keyboard.press("Escape");

  // F2: the row turns into its name's field; Enter keeps the name.
  await row.focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Display name for auth-cache-36" });
  await expect(field).toBeFocused();
  await field.fill("Acme auth cache");
  await field.press("Enter");
  await expect(app.worktree("acme-build/auth-cache-36")).toHaveAttribute("data-title", "Acme auth cache");

  // Tab goes through a row's buttons; Shift+Tab from the next row comes
  // back to this one's last, though it had never been pointed at.
  const rows = page.locator("[data-testid=sidebar] [data-testid=worktree-row]");
  const at = await rows.evaluateAll((els) => els.findIndex((e) => e.getAttribute("data-worktree") === "acme-ci/auth-cache-216"));
  const before = await rows.nth(at - 1).getAttribute("data-worktree");
  await rows.nth(at).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName(new RegExp(`^${before!.split("/")[1]} actions$`));
});

test("projects fold and open, and drag into a section", async ({ app }) => {
  mockOnly();
  await app.open({ params: FLEET });
  const page = app.page;
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByTestId("worktree-row")).toHaveCount(310);
  const all = 310;

  // The project's row is the tree's node (aria-expanded); its chevron is
  // the pointer's way to fold it, with a tip from the list's one tooltip,
  // and ← → on the row the keyboard's (keyboard.spec.ts).
  const project = sidebar.locator('[data-sidebar="menu-button"][aria-expanded]').filter({ has: page.getByText("acme-api", { exact: true }) });
  const chevron = project.locator("[data-fold]");
  await chevron.hover();
  await expect(page.locator("[data-slot=tooltip-popup]")).toHaveText("Hide acme-api");
  await chevron.click();
  await expect(project).toHaveAttribute("aria-expanded", "false");
  const folded = await sidebar.getByTestId("worktree-row").count();
  expect(folded).toBeLessThan(all - 90);
  await chevron.click();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByTestId("worktree-row")).toHaveCount(all);

  // Dragged onto Personal, a project moves there (in the plain fixtures:
  // with hundreds of rows between them the drag would have to scroll). The
  // window is tall enough that the list fits above whatever sits at the
  // sidebar's foot (the skills notice), so nothing scrolls under the drag.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await app.open();
  // Personal is empty: just its heading until the drag, which takes the drop.
  const personal = sidebar.locator("[data-testid=project-section][data-section=Personal]");
  const evals = sidebar.locator("[draggable=true]", { hasText: "evals" });
  await expect(personal.locator("[draggable=true]", { hasText: "evals" })).toHaveCount(0);
  await evals.dragTo(personal.getByTestId("section-name"));
  await expect(personal.locator("[draggable=true]", { hasText: "evals" })).toBeVisible();
});
