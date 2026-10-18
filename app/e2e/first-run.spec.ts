import { expect, mockOnly, test } from "./fixtures";

// First run: what a new install, an older install and a person who turned
// Labs off each get (lib/prefs.ts migratePrefs).

type Saved = { labs?: boolean; labsChosen?: boolean; closeAgents?: string; version?: number };

test("a fresh install starts with Labs on and the harbour home", async ({ app }) => {
  await app.open();
  const prefs = (await app.stored("berth.prefs")) as Saved;
  expect(prefs).toMatchObject({ labs: true, labsChosen: false, closeAgents: "stop", version: 3 });
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
  await expect(app.page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
});

test("prefs an older Shipyard saved move to this version's defaults", async ({ app }) => {
  // Version 2 saved Labs off and "keep" only as the defaults of the day.
  await app.open({ prefs: { labs: false, closeAgents: "keep", agentCloseTips: 2, version: 2 } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: true, version: 3 });
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
});

test("prefs from before version 2 drop the old close default too", async ({ app }) => {
  await app.open({ prefs: { labs: false, closeAgents: "keep" } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: true, closeAgents: "stop", agentCloseTips: 0, version: 3 });
});

test("Labs turned off in Settings stays off", async ({ app }) => {
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: false, labsChosen: true });
  // Without Labs, the first place is the Agent Dashboard under its own name.
  await expect(app.page.getByTestId("nav-home")).toHaveText(/Agent Dashboard/);
  await expect(app.page.getByTestId("nav-dashboard")).toHaveCount(0);
});

test("Labs can be turned off and on in Settings", async ({ app }) => {
  await app.open();
  const labs = await app.openSettings("labs");
  const toggle = labs.getByRole("switch", { name: "Harbour home and conversations" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: false, labsChosen: true });
  // Settings has the window; the sidebar is back once it closes.
  await app.leaveSettings();
  await expect(app.page.getByTestId("nav-home")).toHaveText(/Agent Dashboard/);
  await app.openSettings("labs");
  await toggle.click();
  await app.leaveSettings();
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
});

test("a new account with no boxes is shown onboarding", async ({ app }) => {
  mockOnly("a new account is a mock fixture (?fresh)");
  await app.page.goto("/?mock=1&fresh=1");
  // Onboarding is the whole window until a box is added: no sidebar.
  await expect(app.page.getByTestId("nav-home")).toHaveCount(0);
  await expect(app.page.locator("main")).toContainText(/box/i);
});
