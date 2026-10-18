import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// The sidebar's edge (components/sidebar/resize-handle.tsx): drag it to
// size the sidebar between 200px and 420px, double-click for the 304px
// default, or use the keyboard; past the narrowest it folds to the rail.

const width = async (page: Page) => Math.round((await page.getByTestId("sidebar").boundingBox())!.width);

// drag moves the pointer from the handle's middle by dx, in steps, and can
// check something before letting go.
async function drag(page: Page, dx: number, during?: () => Promise<void>) {
  const handle = page.getByTestId("sidebar-handle");
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await during?.();
  await page.mouse.up();
}

test("the edge drags between the narrowest and the widest, and double-click puts the default back", async ({ app }) => {
  await app.open();
  const page = app.page;
  const handle = page.getByRole("separator", { name: "Resize the sidebar" });
  await expect(handle).toHaveAttribute("aria-valuenow", "304");
  await expect(handle).toHaveAttribute("aria-valuemin", "200");
  await expect(handle).toHaveAttribute("aria-valuemax", "420");
  await expect.poll(() => width(page)).toBe(304);

  // Wider, with nothing selected and the main area following as it goes.
  const main = page.locator("main").first();
  const before = (await main.boundingBox())!.width;
  await drag(page, 100, async () => {
    await expect(page.locator("html")).toHaveClass(/berth-resizing/);
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("");
    await expect.poll(() => width(page)).toBe(404);
  });
  await expect(page.locator("html")).not.toHaveClass(/berth-resizing/);
  await expect.poll(() => width(page)).toBe(404);
  await expect(handle).toHaveAttribute("aria-valuenow", "404");
  await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(Math.round(before) - 100);

  // Held at the widest, and at the narrowest short of folding.
  await drag(page, 600);
  await expect.poll(() => width(page)).toBe(420);
  await drag(page, -240);
  await expect.poll(() => width(page)).toBe(200);
  await expect(page.getByTestId("sidebar-rail")).toHaveCount(0);

  // Double-click: the default.
  await handle.dblclick();
  await expect.poll(() => width(page)).toBe(304);
  await expect(handle).toHaveAttribute("aria-valuenow", "304");
});

test("the keyboard sizes it: arrows, Shift for bigger steps, Home and End", async ({ app }) => {
  await app.open();
  const page = app.page;
  const handle = page.getByRole("separator", { name: "Resize the sidebar" });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "384");
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "368");
  await expect.poll(() => width(page)).toBe(368);
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "200");
  await expect.poll(() => width(page)).toBe(200);
  await page.keyboard.press("Enter");
  await expect(handle).toHaveAttribute("aria-valuenow", "304");
});

test("the width is kept across a reload, and a smaller window holds it to 40%", async ({ app }) => {
  await app.open();
  const page = app.page;
  await drag(page, 60);
  await expect.poll(() => width(page)).toBe(364);
  expect(((await app.stored("berth.prefs")) as { sidebarWidth: number }).sidebarWidth).toBe(364);
  await page.reload();
  await expect(page.getByTestId("nav-home")).toBeVisible();
  await expect.poll(() => width(page)).toBe(364);

  // A window 700px wide holds the sidebar to the default 304px (40% would be 280), not 364.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(() => width(page)).toBe(304);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => width(page)).toBe(364);
});

test("dragged past the narrowest it folds to the rail; the rail's edge drags it open again; Esc cancels", async ({ app }) => {
  await app.open();
  const page = app.page;

  // Esc mid-drag puts it back as it was.
  const handle = page.getByTestId("sidebar-handle");
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 100, 300, { steps: 6 });
  await expect.poll(() => width(page)).toBe(404);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(304);

  // Past the narrowest: the rail.
  await drag(page, -160);
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  expect(((await app.stored("berth.prefs")) as { sidebarCollapsed: boolean; sidebarWidth: number }).sidebarCollapsed).toBe(true);

  // Its edge dragged out opens it at the width dragged to.
  const rail = page.getByRole("separator", { name: "Open the sidebar" });
  await expect(rail).toHaveAttribute("aria-valuenow", "76");
  await drag(page, 250);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect.poll(() => width(page)).toBe(326);

  // ⌘\ folds and opens it at the width it had.
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();
  await page.getByRole("button", { name: "Show the sidebar (⌘\\)" }).click();
  await expect.poll(() => width(page)).toBe(326);
});
