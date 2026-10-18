import { BOX, fakeAgent } from "./fake-agent";
import { expect, mockOnly, test } from "./fixtures";

// Boxes are a detail of the sidebar: no rows of their own in the list by
// project, one quiet line at its foot (a dot each, what is online), whose
// tip says how each box is and how busy, and whose menu holds every box's
// actions. A project's own menu has its box's. A project whose box went
// away dims and says so where a time would be. The mock has devl and gpu
// online (gpu runs an older berthd) and old-vps offline, with no projects
// known (src/lib/mock.ts).

test.beforeEach(() => mockOnly("the boxes are mock fixtures"));

test("boxes live in the sidebar's foot, not as rows in the list", async ({ app }) => {
  const { page } = app;
  await app.open();
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByTestId("worktree-row").first()).toBeVisible();
  // old-vps, offline with nothing known, is no row: only the foot says it.
  await expect(sidebar.getByRole("group", { name: /^old-vps/ })).toHaveCount(0);
  const foot = page.getByTestId("sidebar-boxes");
  await expect(foot).toHaveText(/devl, gpu online/);
  await foot.hover();
  const lines = page.getByTestId("boxes-tip-line");
  await expect(lines).toHaveCount(3);
  await expect(lines.filter({ hasText: "old-vps" })).toContainText("offline");
  await expect(lines.filter({ hasText: "devl" })).toContainText("% mem");
  await expect(lines.filter({ hasText: "gpu" })).toContainText("outdated");
  // The status bar no longer repeats them.
  await expect(page.getByText(/\d+\/\d+ boxes online/)).toHaveCount(0);
  await expect(page.locator("[data-testid^=box-meter-]")).toHaveCount(0);
  // A click still opens Settings › Boxes.
  await foot.click();
  await expect(page.getByTestId("settings-boxes")).toBeVisible();
});

test("the foot's menu has each box's actions, and so does a project's", async ({ app }) => {
  const { page } = app;
  await app.open();
  const foot = page.getByTestId("sidebar-boxes");
  await foot.hover();
  await page.getByRole("button", { name: "Box actions" }).click();
  await page.getByRole("menuitem", { name: "old-vps" }).click();
  await expect(page.getByRole("menuitem", { name: "Reconnect" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Right-click is the same menu.
  await foot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "devl" }).click();
  await expect(page.getByRole("menuitem", { name: "New terminal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // evals is on gpu alone: its menu has a submenu named after the box.
  const evals = page.getByTestId("sidebar").getByRole("button", { name: "evals", exact: true });
  await evals.click({ button: "right" });
  await page.getByRole("menuitem", { name: "gpu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Copy address" })).toBeVisible();
});

test("only rows whose agent needs you, works or just finished say a time; idle rows say nothing", async ({ app }) => {
  const { page } = app;
  await app.open();
  const sidebar = page.getByTestId("sidebar");
  const rows = sidebar.getByTestId("worktree-row");
  await expect(rows.first()).toBeVisible();
  const idle = rows.filter({ has: page.getByRole("img", { name: "Idle" }) });
  expect(await idle.count()).toBeGreaterThan(0);
  for (const r of await idle.all()) await expect(r.getByTestId("row-time")).toHaveText("");
  const working = rows.filter({ has: page.getByRole("img", { name: "Working" }) }).first();
  await expect(working.getByTestId("row-time")).not.toHaveText("");
  // Idle draws nothing in the status lane.
  await expect(idle.first().getByRole("img", { name: "Idle" }).locator("*")).toHaveCount(0);
});

test("a project whose box goes away dims and says offline where a time would be", async ({ app }) => {
  const agent = await fakeAgent();
  try {
    await app.open({ agent });
    const row = app.worktree(`${BOX}/fix`);
    await expect(row).toBeVisible();
    agent.away = { state: "offline", since: new Date(Date.now() - 3 * 3600_000).toISOString() };
    agent.event({ type: "box.disconnected", data: { box: BOX } });
    const sidebar = app.page.getByTestId("sidebar");
    const word = sidebar.getByTestId("away-word");
    await expect(word).toHaveText("offline");
    // The header's tip names the box and how long it has been away. (Its
    // button is disabled, so the pointer meets the tip's wrapper.)
    const header = sidebar.locator("[data-slot=tip-disabled]", { has: app.page.getByRole("button", { name: "shop offline", exact: true }) });
    await header.hover();
    await expect(app.page.locator("[data-slot=tooltip-popup]")).toContainText(`${BOX} is offline for 3h`);
    // The row stays, quiet, without a time.
    await expect(row).toBeVisible();
    await expect(row.getByTestId("row-time")).toHaveText("");
    // Its box's actions are still in its menu: Reconnect.
    await header.hover();
    await app.page.getByRole("button", { name: "shop actions" }).click();
    await app.page.getByRole("menuitem", { name: BOX, exact: true }).click();
    await expect(app.page.getByRole("menuitem", { name: "Reconnect" })).toBeVisible();
  } finally {
    await agent.close();
  }
});
