// A plugin sidebar item's count (SidebarItem.useCount): on More's row while
// the item is under More, in the More menu, and on the item's own row once
// pinned; none for 0 or a hook that throws, and the sidebar carries on.
// features/sidebar-nav.md.

export const plugins = [
  {
    id: "counts",
    name: "Counts",
    source: `
import { useStorage } from "@berth/plugin";
export default function (berth) {
  berth.addScreen({ id: "counts", title: "Counts", Component: () => null });
  const item = (id, title, useCount) => berth.addSidebarItem({ id, title, icon: "Inbox", screen: "counts", useCount });
  item("waiting", "Waiting", () => 3);
  item("quiet", "Quiet", () => ({ n: 2, urgent: false }));
  item("stored", "Stored", () => useStorage("waiting", 4)[0]);
  item("zero", "Zero", () => 0);
  item("boom", "Boom", () => { throw new Error("count boom"); });
}
`,
  },
];

// The throwing hook is logged, by design.
export const allowErrors = [/count boom/];

export async function run({ page, shot, step, expect }) {
  const more = page.locator("li", { has: page.getByTestId("nav-more") });
  const row = (id) => page.locator("li", { has: page.getByTestId(`nav-plugin:counts:${id}`) });

  step("More's row shows the first amber count under it: 3");
  await expect(more.getByTestId("nav-badge")).toHaveText("3");
  await shot("1-more-row");

  step("the More menu lists each item's count; Zero and Boom have none");
  await page.getByTestId("nav-more").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Waiting" })).toHaveText("Waiting3");
  await expect(menu.getByRole("menuitem", { name: "Quiet" })).toHaveText("Quiet2");
  await expect(menu.getByRole("menuitem", { name: "Stored" })).toHaveText("Stored4");
  await expect(menu.getByRole("menuitem", { name: "Zero" })).toHaveText("Zero");
  await expect(menu.getByRole("menuitem", { name: "Boom" })).toHaveText("Boom");
  await shot("2-more-menu");

  step("pin Waiting, Quiet, Zero and Boom in Customize sidebar");
  await menu.getByRole("menuitem", { name: "Customize sidebar…" }).click();
  const sheet = page.getByRole("dialog", { name: "Customize sidebar" });
  for (const label of ["Waiting", "Quiet", "Zero", "Boom"]) {
    await sheet.locator("li", { has: page.getByText(label, { exact: true }) }).getByRole("button", { name: "Pin" }).click();
    await expect(page.getByTestId(`nav-plugin:counts:${label.toLowerCase()}`)).toBeVisible();
  }
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();

  step("pinned rows: Waiting 3 (amber), Quiet 2 (quiet), Zero and Boom none; More's row now shows Stored's 4");
  await expect(row("waiting").getByTestId("nav-badge")).toHaveText("3");
  await expect(row("waiting").getByTestId("nav-badge")).toHaveClass(/text-warning-foreground/);
  await expect(row("quiet").getByTestId("nav-badge")).toHaveText("2");
  await expect(row("quiet").getByTestId("nav-badge")).not.toHaveClass(/text-warning-foreground/);
  await expect(row("zero").getByTestId("nav-badge")).toHaveCount(0);
  await expect(row("boom").getByTestId("nav-badge")).toHaveCount(0);
  await expect(more.getByTestId("nav-badge")).toHaveText("4");
  await shot("3-pinned-rows");

  step("Home's count is still its own: the mock's agents waiting");
  await expect(page.locator("li", { has: page.getByTestId("nav-home") }).getByTestId("nav-badge")).toBeVisible();

  step("a row with a count still opens its screen");
  await page.getByTestId("nav-plugin:counts:waiting").click();
  await expect(page.getByTestId("nav-plugin:counts:waiting")).toHaveAttribute("aria-current", "page");
  await shot("4-opened");
}
