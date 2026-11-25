// A flow its runs-per-hour limit holds back, on the mock (features/flows.md,
// flows-limit): the flow list's "Limit reached" badge on the every-minute
// mock flow, the same badge in its editor, and the warning beside the limit
// that follows the limit as it is typed.

export async function run({ page, shot, step, expect }) {
  step("Automations lists the flows; the every-minute one says what its limit refused");
  await page.getByTestId("nav-automations").click();
  // Off the sidebar, so no row's tooltip covers the shots.
  await page.mouse.move(1200, 880);
  const row = page.getByRole("button").filter({ hasText: "Sweep stale previews every minute" });
  await expect(row.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 7 refused in the last hour");
  await expect(page.getByRole("button").filter({ hasText: "Post to Slack when setup fails" }).getByTestId("flow-limit-badge")).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shot("1-flow-list-badge");

  step("open it: the editor shows the badge and, by At most, how many starts the schedule loses");
  await row.click();
  await expect(page.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 7 refused in the last hour");
  const warning = page.getByTestId("flow-rate-warning");
  await expect(warning).toHaveText("This schedule fires up to 60 times an hour; the limit is 20, so about 40 starts an hour will be refused.");
  await warning.scrollIntoViewIfNeeded();
  await shot("2-editor-warning");

  step("type a limit of 45: the warning follows it; 60 clears it");
  const limit = page.getByPlaceholder("20 (default)");
  await limit.fill("45");
  await expect(warning).toHaveText("This schedule fires up to 60 times an hour; the limit is 45, so about 15 starts an hour will be refused.");
  await limit.fill("60");
  await expect(warning).toHaveCount(0);
  await shot("3-editor-fits");
}
