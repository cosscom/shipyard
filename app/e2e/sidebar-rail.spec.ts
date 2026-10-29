import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// The rail sidebar, the default layout (components/sidebar/rail-layout.tsx):
// the places and a tile per project on a narrow rail, and the picked
// project's worktrees on a sheet beside it. On the mock fixtures: shop has
// an agent waiting for you, evals one at work, and notes nothing going on.

const rail = { sidebarLayout: "rail" };

// Switching to notes, where no agent is at work, shows its main checkout and
// never opens a new task (lib/project-landing); landsOnMain checks that.
async function landsOnMain(page: Page) {
  await expect(page.getByTestId("nav-home")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
}

test("every project is a tile on the rail that says when it needs you or works", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await expect(page.getByTestId("project-rail")).toBeVisible();
  const tiles = page.getByTestId("rail-project");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator("[data-testid=rail-project][data-project=shop]")).toHaveAttribute("data-state", "waiting");
  await expect(page.locator("[data-testid=rail-project][data-project=evals]")).toHaveAttribute("data-state", "running");
  await expect(page.locator("[data-testid=rail-project][data-project=notes]")).not.toHaveAttribute("data-state");
  // A project with no GitHub owner gets an identicon, never an empty tile.
  await expect(page.locator("[data-testid=rail-project] :is([data-testid=project-avatar], [data-testid=project-identicon])")).toHaveCount(3);
});

test("picking a tile shows that project's worktrees beside the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("rail-project")).toHaveCount(3);
  const page = app.page;
  const shop = page.locator("[data-testid=rail-project][data-project=shop]");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  const sheet = page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-testid=worktree-row][data-worktree="devl/checkout-fix"]')).toBeVisible();
  // Another project's worktrees stay off the sheet.
  await expect(app.worktree("gpu/judge-v2")).toHaveCount(0);

  await page.locator("[data-testid=rail-project][data-project=notes]").click();
  await landsOnMain(page);
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true }).locator('[data-testid=worktree-row][data-worktree="devl/notes"]')).toHaveAttribute("data-active", "true");
});

test("switching to a tile lands on its agent that worked last", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("rail-project")).toHaveCount(3);
  const page = app.page;
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");

  // Of shop's agents at work or waiting, qa-deck's changed state last.
  await page.locator("[data-testid=rail-project][data-project=shop]").click();
  await expect(app.worktree("devl/qa-deck")).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("tab", { name: /^Build the QA deck for the release/, selected: true })).toBeVisible();
  await expect(page.getByTestId("nav-home")).not.toHaveAttribute("aria-current", "page");

  // evals has an agent at work in judge-v2.
  await page.locator("[data-testid=rail-project][data-project=evals]").click();
  await expect(app.worktree("gpu/judge-v2")).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("tab", { name: /^Tune the judge prompt/, selected: true })).toBeVisible();
});

test("switching to a tile with no agent at work shows its main checkout, not a new task", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("rail-project")).toHaveCount(3);
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=notes]").click();
  await landsOnMain(page);
  await expect(page.locator("[data-testid=rail-project][data-project=notes]")).toHaveAttribute("aria-current", "true");
});

test("picking the tile already picked leaves the main area as it was", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("rail-project")).toHaveCount(3);
  const page = app.page;
  const shop = page.locator("[data-testid=rail-project][data-project=shop]");
  await shop.click();
  await expect(app.worktree("devl/qa-deck")).toHaveAttribute("data-active", "true");

  await page.getByTestId("project-rail").getByTestId("nav-home").click();
  await expect(page.getByTestId("project-rail").getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true })).toBeVisible();
  await expect(page.getByTestId("project-rail").getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("opening a worktree from elsewhere picks its project on the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  // Every box's projects in, so the first listed (picked until you pick one) is settled.
  await expect(app.page.getByTestId("rail-project")).toHaveCount(3);
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=notes]").click();
  await landsOnMain(page);
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();

  // From ⌘K.
  const input = page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
  const option = page.getByRole("option", { name: /checkout-fix/ }).first();
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("Meta+k");
    await input.fill("checkout-fix");
    await expect(option).toBeVisible({ timeout: 500 });
  }).toPass();
  await option.click();

  await expect(page.locator("[data-testid=rail-project][data-project=shop]")).toHaveAttribute("aria-current", "true");
  await expect(app.worktree("devl/checkout-fix")).toHaveAttribute("data-active", "true");
});

test("folded away, the rail keeps its projects, the traffic lights over its middle, and a tile opens its project", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: { ...rail, version: 4, uiFontSize: 11 } });
  const page = app.page;
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  const folded = page.getByTestId("sidebar-rail");
  await expect(folded.getByTestId("rail-project")).toHaveCount(3);
  await expect(page.getByTestId("sidebar-sheet")).toHaveCount(0);
  // The traffic lights (14pt to 74pt) sit over its middle whatever the text size.
  await expect.poll(async () => (await folded.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(88);
  await folded.locator("[data-testid=rail-project][data-project=notes]").click();
  await landsOnMain(page);
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();
});

test("the rail's places and Settings go where the sidebar's do", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  const rail_ = page.getByTestId("project-rail");
  await expect(rail_.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await rail_.getByTestId("nav-review").click();
  await expect(rail_.getByTestId("nav-review")).toHaveAttribute("aria-current", "page");
  await rail_.getByTestId("nav-settings").click();
  await expect(rail_.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
});

test("an update moves the list sidebar to the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: { version: 3, sidebarLayout: "list" } });
  await expect(app.page.getByTestId("project-rail")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { sidebarLayout: string }).sidebarLayout).toBe("rail");
});

test("an update keeps a two-column sidebar someone chose", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: { version: 3, sidebarLayout: "columns" } });
  await expect(app.page.getByTestId("sidebar-projects")).toBeVisible();
  await expect(app.page.getByTestId("project-rail")).toHaveCount(0);
});

test("the sheet's boxes, their contents and their ends each line up", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=shop]").click();
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  const lanes = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-testid=sidebar-sheet]")!.getBoundingClientRect();
      const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const row = document.querySelector("[data-testid=worktree-row]")!;
      const label = [...document.querySelectorAll("[data-testid=sidebar-sheet] h3")].find((h) => h.textContent === "Worktrees")!;
      const left = (r: DOMRect) => Math.round(r.left - sheet.left);
      const right = (r: DOMRect) => Math.round(sheet.right - r.right);
      return {
        boxes: [left(q("[data-testid=tasks-heading] > span")), left(q("[data-testid=sheet-search]")), left(row.getBoundingClientRect()), left(q("[data-testid=sidebar-boxes]"))],
        contents: [left(q("[data-testid=sheet-search] svg")), left(label.getBoundingClientRect()), left(row.querySelector("[role=img]")!.getBoundingClientRect()), left(q("[data-testid=sidebar-boxes] > span"))],
        ends: [right(q("[data-testid=sheet-search]")), right(label.parentElement!.querySelector("button")!.getBoundingClientRect()), right(row.getBoundingClientRect())],
      };
    });
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  await expect.poll(async () => { const l = await lanes(); return same(l.boxes) && same(l.contents) && same(l.ends); }).toBe(true);
});

test("the sheet's top edge carries on the tab bar's bottom line", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  const lined = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-testid=sidebar-sheet]")!.getBoundingClientRect();
      const bar = document.querySelector("[data-tab-bar]")!.getBoundingClientRect();
      return Math.round(sheet.top) === Math.round(bar.bottom - 1);
    });
  await expect.poll(lined).toBe(true);
  // At a larger text size too (⌘+ twice), since both are sized in rem.
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(() => app.stored("berth.prefs").then((p) => (p as { uiFontSize: number }).uiFontSize)).toBe(15);
  await expect.poll(lined).toBe(true);
});

test("the sheet's + next to Worktrees opens a new worktree in that project", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=shop]").click();
  await page.getByRole("button", { name: "New worktree in shop" }).click();
  const dialog = page.getByRole("dialog", { name: "New worktree" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Project: shop" })).toBeVisible();
});

// A row's own name sits beside its title only with room for a few letters
// of it, never a letter and an ellipsis: where it doesn't fit it wraps out
// of the row's one line. A wider sheet shows them again.
test("a row's own name shows a few letters or none, at any width", async ({ app }) => {
  mockOnly();
  const page = app.page;
  await page.setViewportSize({ width: 1600, height: 900 });
  await app.open({ prefs: { ...rail, sidebarWidth: 400 } });
  await page.locator("[data-testid=rail-project][data-project=shop]").click();
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  const names = () =>
    page.locator("[data-testid=worktree-row-name]").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const shown = r.width > 0 && r.top < el.parentElement!.getBoundingClientRect().bottom;
        // In the mono face a character is 0.6em wide.
        return { shown, chars: r.width / (parseFloat(getComputedStyle(el).fontSize) * 0.6) };
      }),
    );
  const wide = await names();
  expect(wide.some((n) => n.shown)).toBe(true);
  for (const n of wide) if (n.shown) expect(n.chars).toBeGreaterThan(6.5);
  // Narrower, fewer show, and still none as a fragment.
  await page.evaluate(() => document.documentElement.style.setProperty("--sidebar-w", "300px"));
  await expect.poll(async () => (await names()).filter((n) => n.shown).length).toBeLessThan(wide.filter((n) => n.shown).length);
  for (const n of await names()) if (n.shown) expect(n.chars).toBeGreaterThan(6.5);
});
