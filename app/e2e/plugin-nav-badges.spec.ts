import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// A plugin sidebar item's useCount (SidebarItem.useCount, components/
// sidebar/nav.tsx): its count on the item's row, on More's row while the
// item is under More, and none for 0, undefined or a hook that throws. The
// plugin is a built-in served by the test, beside the app's own.

const PLUGIN = `
import { useStorage } from "@berth/plugin";
export default function (berth) {
  berth.addScreen({ id: "counts", title: "Counts", Component: () => null });
  const item = (id, title, useCount) => berth.addSidebarItem({ id, title, screen: "counts", useCount });
  item("three", "Three", () => 3);
  item("quiet", "Quiet", () => ({ n: 2, urgent: false }));
  item("stored", "Stored", () => useStorage("waiting", 4)[0]);
  item("zero", "Zero", () => 0);
  item("none", "None", () => undefined);
  item("boom", "Boom", () => { throw new Error("count boom"); });
}
`;

// A count whose effect's cleanup throws, which React reports while the
// plugin is being removed.
const TEARDOWN = `
import { useEffect } from "react";
export default function (berth) {
  berth.addScreen({ id: "teardown", title: "Teardown", Component: () => null });
  berth.addSidebarItem({ id: "teardown", title: "Teardown", screen: "teardown", useCount: () => {
    useEffect(() => () => { throw new Error("cleanup boom"); }, []);
    return { n: 1, urgent: false };
  } });
}
`;

async function withPlugins(page: Page, plugins: Record<string, string>) {
  await page.route("**/builtin-plugins/index.json", async (route) => {
    const res = await route.fetch();
    const list = (await res.json()) as unknown[];
    const extra = Object.keys(plugins).map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), version: "0.1.0", main: "index.js" }));
    await route.fulfill({ response: res, json: [...list, ...extra] });
  });
  for (const [id, body] of Object.entries(plugins)) await page.route(`**/builtin-plugins/${id}/index.js`, (route) => route.fulfill({ contentType: "text/javascript", body }));
}

const withCountsPlugin = (page: Page) => withPlugins(page, { counts: PLUGIN });

const row = (page: Page, id: string) => page.locator("li", { has: page.getByTestId(`nav-plugin:counts:${id}`) });

test("a plugin's counts show in More, and on More's row while they wait", async ({ app }) => {
  mockOnly("serves a test plugin");
  const errors: string[] = [];
  app.page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await withCountsPlugin(app.page);
  await app.open();
  const page = app.page;

  const more = page.locator("li", { has: page.getByTestId("nav-more") });
  await expect(more.getByTestId("nav-badge")).toHaveText("3");
  await expect(more.getByTestId("nav-badge")).toHaveClass(/text-warning-foreground/);

  await page.getByTestId("nav-more").click();
  const menu = page.getByRole("menu");
  const entry = (label: string) => menu.getByRole("menuitem", { name: label, exact: false });
  await expect(entry("Three")).toHaveText("Three3");
  await expect(entry("Quiet")).toHaveText("Quiet2");
  // useStorage reads the plugin's own storage, under its context.
  await expect(entry("Stored")).toHaveText("Stored4");
  await expect(entry("Zero")).toHaveText("Zero");
  await expect(entry("None")).toHaveText("None");
  await expect(entry("Boom")).toHaveText("Boom");
  await expect(entry("Three").locator("span").last()).toHaveClass(/text-warning-foreground/);
  await expect(entry("Quiet").locator("span").last()).toHaveClass(/text-muted-foreground/);

  // The throwing count is logged, and nothing else went wrong.
  await expect.poll(() => errors.some((e) => e.includes("plugin counts: the count for sidebar item Boom failed"))).toBe(true);
  expect(errors.filter((e) => !e.includes("count boom"))).toEqual([]);
});

test("a pinned plugin item shows its count on its own row, and no row shows 0 or a failed count", async ({ app }) => {
  mockOnly("serves a test plugin and saves the sidebar");
  await withCountsPlugin(app.page);
  await app.open();
  const page = app.page;

  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitem", { name: "Customize sidebar…" }).click();
  const sheet = page.getByRole("dialog", { name: "Customize sidebar" });
  for (const label of ["Three", "Quiet", "Zero", "Boom"]) {
    await sheet.locator("li", { has: page.getByText(label, { exact: true }) }).getByRole("button", { name: "Pin" }).click();
    await expect(page.getByTestId(`nav-plugin:counts:${label.toLowerCase()}`)).toBeVisible();
  }
  await sheet.getByRole("button", { name: "Done" }).click();

  await expect(row(page, "three").getByTestId("nav-badge")).toHaveText("3");
  await expect(row(page, "three").getByTestId("nav-badge")).toHaveClass(/text-warning-foreground/);
  await expect(row(page, "quiet").getByTestId("nav-badge")).toHaveText("2");
  await expect(row(page, "quiet").getByTestId("nav-badge")).not.toHaveClass(/text-warning-foreground/);
  await expect(row(page, "zero").getByTestId("nav-badge")).toHaveCount(0);
  await expect(row(page, "boom").getByTestId("nav-badge")).toHaveCount(0);
  // Stored is still under More, so More's row shows its amber 4.
  await expect(page.locator("li", { has: page.getByTestId("nav-more") }).getByTestId("nav-badge")).toHaveText("4");
});

test("a count that throws while its plugin turns off leaves the sidebar's other counts and the app's dialogs working", async ({ app }) => {
  mockOnly("serves test plugins");
  await withPlugins(app.page, { counts: PLUGIN, teardown: TEARDOWN });
  await app.open();
  const page = app.page;
  const more = page.locator("li", { has: page.getByTestId("nav-more") });
  await expect(more.getByTestId("nav-badge")).toHaveText("3");

  const plugins = await app.openSettings("plugins");
  await plugins.getByRole("switch", { name: "Turn off Teardown" }).click();
  await expect(plugins.getByRole("switch", { name: "Turn on Teardown" })).toBeVisible();

  // The other plugin's count is back once plugins reload, and ⌘K still opens.
  await expect(more.getByTestId("nav-badge")).toHaveText("3");
  const input = page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("Meta+k");
    await expect(input).toBeVisible({ timeout: 500 });
  }).toPass();
  await page.keyboard.press("Escape");
  await expect(more.getByTestId("nav-badge")).toHaveText("3");
});
