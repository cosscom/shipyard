import { expect, mockOnly, test } from "./fixtures";

// Settings → Agents keeps a project off the Agent Dashboard: its agents
// leave the board and the counts beside it, the board says how many
// projects are kept off, and Show brings them back.

test("a project kept off the Agent Dashboard leaves the board until shown again", async ({ app }) => {
  mockOnly("writes the projects document");
  // Without Labs, the first place is the Agent Dashboard itself.
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  const { page } = app;
  const working = page.getByRole("region", { name: "Working" });
  const idle = page.getByRole("region", { name: "Idle" });
  await page.getByTestId("nav-home").click();
  await expect(working.getByText("Tune the judge prompt")).toBeVisible();
  await expect(working.getByText("Build the QA deck for the release")).toBeVisible();
  await expect(page.getByTestId("dashboard-off-board")).toHaveCount(0);

  const agents = await app.openSettings("agents");
  await expect(agents.getByText("Every project shows on the dashboard.")).toBeVisible();
  await agents.getByRole("combobox").click();
  await page.getByRole("option", { name: "evals" }).click();
  await expect(agents.getByText("Kept off")).toBeVisible();

  // evals' agents (its main checkout and a worktree) are gone; shop's stay.
  await app.leaveSettings();
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("dashboard-off-board")).toHaveText("1 project kept off");
  await expect(working.getByText("Build the QA deck for the release")).toBeVisible();
  await expect(working.getByText("Tune the judge prompt")).toHaveCount(0);
  await expect(idle.getByText(/evals/)).toHaveCount(0);

  // The note leads back to the setting, and Show undoes it.
  await page.getByTestId("dashboard-off-board").click();
  await expect(agents).toBeVisible();
  await agents.getByRole("button", { name: "Show" }).click();
  await expect(agents.getByText("Every project shows on the dashboard.")).toBeVisible();
  await app.leaveSettings();
  await page.getByTestId("nav-home").click();
  await expect(working.getByText("Tune the judge prompt")).toBeVisible();
  await expect(page.getByTestId("dashboard-off-board")).toHaveCount(0);
});

test("a project kept off leaves the sidebar's waiting count", async ({ app }) => {
  mockOnly("writes the projects document");
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  const { page } = app;
  // Both agents waiting on you are in shop (on devl and on gpu); the
  // count sits beside the place, in its menu item.
  const home = page.locator("[data-sidebar=menu-item]:has([data-testid=nav-home])");
  await expect(home).toContainText("2");
  const agents = await app.openSettings("agents");
  await agents.getByRole("combobox").click();
  await page.getByRole("option", { name: "shop" }).click();
  await expect(agents.getByText("Kept off, on devl, gpu")).toBeVisible();
  await app.leaveSettings();
  await expect(home).not.toContainText("2");
  await page.getByTestId("nav-home").click();
  await expect(page.getByRole("region", { name: "Needs you" }).getByText("Nothing needs you.")).toBeVisible();
});

test("two projects kept off in quick succession both stay off", async ({ app }) => {
  mockOnly("writes the projects document");
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  const { page } = app;
  const agents = await app.openSettings("agents");
  // One right after the other (lib/one-at-a-time.test.ts covers two saves
  // that overlap).
  await agents.getByRole("combobox").click();
  await page.getByRole("option", { name: "evals" }).click();
  await agents.getByRole("combobox").click();
  await page.getByRole("option", { name: "shop" }).click();
  await expect(agents.getByRole("button", { name: "Show" })).toHaveCount(2);
  // What the laptop agent kept: showing one reads the stored document
  // again before writing it, so the other is still off only if both landed.
  await agents.getByRole("button", { name: "Show" }).first().click();
  await expect(agents.getByRole("button", { name: "Show" })).toHaveCount(1);
});
