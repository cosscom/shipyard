// dashboard-sub-states: on the mock, the board's four columns; the preset from
// Settings, two amber columns with their counts and a card tagged not sorted;
// and removing the set brings the four back. See ../../features/dashboard-sub-states.md.
export const params = { labs: "0" };

export async function run({ page, shot, step, expect }) {
  const board = page.getByTestId("dashboard-board");
  await step("With no sub-states, the board has its four columns");
  await page.getByTestId("nav-home").click();
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/]);
  await shot("four-columns");

  await step("Turn on the preset in Settings");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-agents").click();
  const panel = page.getByTestId("substates");
  await panel.getByRole("button", { name: "Use Needs a decision and Needs you to act" }).click();
  await expect(panel.getByRole("textbox", { name: "Name of column 1" })).toHaveValue("Needs a decision");
  await expect(panel.getByTestId("substates-outdated")).toContainText("gpu runs an older berthd");
  await expect(panel.getByTestId("substates-turncheck-off")).toContainText("Turn check is off on devl");
  await panel.scrollIntoViewIfNeeded();
  await shot("settings");
  await page.getByRole("button", { name: "Back to app" }).click();

  await step("Two amber columns replace Needs you, with counts and a tagged card");
  await page.getByTestId("nav-home").click();
  await expect(board.getByRole("region")).toHaveText([/Needs a decision/, /Needs you to act/, /Working/, /Done/, /Idle/]);
  const decision = board.getByRole("region", { name: "Needs a decision" });
  const act = board.getByRole("region", { name: "Needs you to act" });
  await expect(act.locator("article", { hasText: "Fix checkout webhook retries" })).toBeVisible();
  await expect(act.getByTestId("not-sorted")).toHaveCount(0);
  await expect(decision.getByTestId("not-sorted")).toHaveCount(1);
  await shot("two-columns");

  await step("Removing them brings the four back");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-agents").click();
  await panel.getByRole("button", { name: "Remove Needs a decision" }).click();
  await panel.getByRole("button", { name: "Remove Needs you to act" }).click();
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByTestId("substates-changed")).toContainText("removed all sub-states");
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByTestId("nav-home").click();
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/]);
  await expect(board.getByTestId("not-sorted")).toHaveCount(0);
  await shot("four-columns-after");
}
