// The sidebar's arrangement outlives a reload, and a layout that doesn't
// load leaves the default showing with Customize blocked until it arrives
// (lib/nav.ts). The mock keeps the document across reloads, and
// ?failapp=sidebar fails it until __mockApp.recover("sidebar").
// features/sidebar-nav.md.

// The list sidebar, where the places are rows (nav-<id>).
export const params = { sidebar: "list" };

export async function run({ page, shot, step, expect }) {
  const sidebar = page.getByTestId("sidebar");
  const stored = () => page.evaluate(() => window.__mockApp.doc("sidebar"));

  step("pin Kits in Customize sidebar");
  await expect(sidebar.getByTestId("nav-kits")).toHaveCount(0);
  await page.getByTestId("nav-more").click();
  await page.getByTestId("nav-customize").click();
  const sheet = page.getByRole("dialog", { name: "Customize sidebar" });
  await sheet.locator("li", { has: page.getByText("Kits", { exact: true }) }).getByRole("button", { name: "Pin" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar.getByTestId("nav-kits")).toBeVisible();
  await shot("1-pinned");

  step("reload: Kits is still pinned");
  await page.reload();
  await expect(sidebar.getByTestId("nav-home")).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByTestId("nav-kits")).toBeVisible();
  await shot("2-after-reload");
  const saved = await stored();

  step("start again while the agent can't answer for the layout: the default shows");
  const url = new URL(page.url());
  url.searchParams.set("failapp", "sidebar");
  await page.goto(url.href);
  await expect(sidebar.getByTestId("nav-automations")).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByTestId("nav-kits")).toHaveCount(0);

  step("More's Customize sidebar… is blocked, with the note");
  await page.getByTestId("nav-more").click();
  await expect(page.getByTestId("nav-customize")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("nav-not-loaded")).toBeVisible();
  await shot("3-customize-blocked");
  await page.keyboard.press("Escape");

  step("Hide on a row's right-click is refused with the same note, and Review stays");
  await sidebar.getByTestId("nav-review").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await expect(page.getByText("Your saved layout hasn't loaded yet").last()).toBeVisible();
  await expect(sidebar.getByTestId("nav-review")).toBeVisible();
  await shot("4-change-refused");
  if (JSON.stringify(await stored()) !== JSON.stringify(saved)) throw new Error("the stored layout changed while it hadn't loaded");

  step("the agent answers again: the stored layout replaces the default, and Customize opens");
  await page.evaluate(() => window.__mockApp.recover("sidebar"));
  await expect(sidebar.getByTestId("nav-kits")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("nav-more").click();
  await expect(page.getByTestId("nav-not-loaded")).toHaveCount(0);
  await page.getByTestId("nav-customize").click();
  await expect(sheet).toBeVisible();
  await shot("5-recovered");
  if (JSON.stringify(await stored()) !== JSON.stringify(saved)) throw new Error("the stored layout changed");
}
