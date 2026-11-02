import { expect, mockOnly, test } from "./fixtures";

const BOARD_PREFS = { labs: false, labsChosen: true, version: 3 };

// With none set, the board has its four columns, as it always had.
test("with no sub-states the board has its four columns", async ({ app }) => {
  mockOnly("the sub-states are a mock box's");
  await app.open({ prefs: BOARD_PREFS });
  await app.page.getByTestId("nav-home").click();
  const board = app.page.getByTestId("dashboard-board");
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/]);
  await expect(board.getByTestId("not-sorted")).toHaveCount(0);
  await app.page.screenshot({ path: test.info().outputPath("four-columns.png") });
});

test("the preset splits Needs you into two amber columns, with counts and a not sorted tag, and removing it restores the one", async ({ app }) => {
  mockOnly("the sub-states are a mock box's");
  await app.open({ prefs: BOARD_PREFS });
  const settings = await app.openSettings("agents");
  await settings.getByRole("button", { name: "Use Needs a decision and Needs you to act" }).click();
  await expect(settings.getByRole("textbox", { name: "Name of column 1" })).toHaveValue("Needs a decision");
  await expect(settings.getByRole("textbox", { name: "Name of column 2" })).toHaveValue("Needs you to act");
  await expect(settings.getByTestId("substates-changed")).toContainText("turned on the preset, by laptop:demo");

  await app.leaveSettings();
  await app.page.getByTestId("nav-home").click();
  const board = app.page.getByTestId("dashboard-board");
  await expect(board.getByRole("region")).toHaveText([/Needs a decision/, /Needs you to act/, /Working/, /Done/, /Idle/]);
  const decision = board.getByRole("region", { name: "Needs a decision" });
  const act = board.getByRole("region", { name: "Needs you to act" });
  // Placed on a box that keeps sub-states: in its column, no tag.
  await expect(act.locator("article")).toHaveCount(1);
  await expect(act.locator("article", { hasText: "Fix checkout webhook retries" })).toBeVisible();
  await expect(act.getByTestId("not-sorted")).toHaveCount(0);
  await expect(act.locator("header").getByText("1", { exact: true })).toBeVisible();
  // On an older box it has no sub-state: the default, tagged, not lost.
  await expect(decision.locator("article", { hasText: "Plan the checkout release" })).toBeVisible();
  await expect(decision.locator("article")).toHaveCount(1);
  await expect(decision.getByTestId("not-sorted")).toHaveCount(1);
  await expect(decision.locator("header").getByText("1", { exact: true })).toBeVisible();
  // Amber means needs you, on both.
  for (const column of [decision, act]) {
    await expect(column.locator("header").locator(".text-warning-foreground").first()).toBeVisible();
  }
  await expect(board.getByRole("region", { name: "Needs you", exact: true })).toHaveCount(0);
  await app.page.screenshot({ path: test.info().outputPath("two-columns.png") });

  // Everything else still says Needs you.
  await expect(app.page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();

  const again = await app.openSettings("agents");
  await again.getByRole("button", { name: "Remove Needs a decision" }).click();
  await again.getByRole("button", { name: "Remove Needs you to act" }).click();
  await again.getByRole("button", { name: "Save" }).click();
  await expect(again.getByTestId("substates-changed")).toContainText("removed all sub-states");
  await app.leaveSettings();
  await app.page.getByTestId("nav-home").click();
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/]);
  await expect(board.getByTestId("not-sorted")).toHaveCount(0);
});

test("the editor adds, renames, reorders and removes, and says what the boxes can't do", async ({ app }) => {
  mockOnly("the sub-states are a mock box's");
  await app.open({ prefs: BOARD_PREFS });
  const settings = await app.openSettings("agents");
  await settings.getByRole("button", { name: "Add a column" }).click();
  // Nothing half made is saved.
  await expect(settings.getByRole("button", { name: "Save" })).toBeDisabled();
  await settings.getByRole("textbox", { name: "Name of column 1" }).fill("Waiting on a person");
  await settings.getByRole("textbox", { name: "Description of column 1" }).fill("It needs a person to look at something.");
  await settings.getByRole("button", { name: "Add a column" }).click();
  await settings.getByRole("textbox", { name: "Name of column 2" }).fill("Needs a key");
  await settings.getByRole("textbox", { name: "Description of column 2" }).fill("It needs a credential it can't get.");
  await settings.getByRole("button", { name: "Move Needs a key up" }).click();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(settings.getByRole("textbox", { name: "Name of column 1" })).toHaveValue("Needs a key");

  await settings.getByRole("textbox", { name: "Name of column 1" }).fill("Needs a credential");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("button", { name: "Save" })).toHaveCount(0);

  // An older box, and one where turn check is off, each get a word.
  await expect(settings.getByTestId("substates-outdated")).toContainText("gpu runs an older berthd");
  await expect(settings.getByTestId("substates-turncheck-off")).toContainText("Turn check is off on devl");

  await app.leaveSettings();
  await app.page.getByTestId("nav-home").click();
  await expect(app.page.getByTestId("dashboard-board").getByRole("region")).toHaveText([/Needs a credential/, /Waiting on a person/, /Working/, /Done/, /Idle/]);

  // At most six.
  const later = await app.openSettings("agents");
  for (let i = 0; i < 4; i++) await later.getByRole("button", { name: "Add a column" }).click();
  await expect(later.getByRole("button", { name: "Add a column" })).toBeDisabled();
});
