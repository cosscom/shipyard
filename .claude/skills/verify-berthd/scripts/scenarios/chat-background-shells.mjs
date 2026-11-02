// The chat's background-work chip and its panel on the mock
// (features/chat-background-shells.md):
//
//   node drive.mjs chat-background-shells --port $PORT
//
// gpu/judge-v2's agent left three shells: the dev server still running,
// the payment tests done (exit 0) and a lint that failed (exit 3). The chip
// counts only the running one; the panel shows each ended shell's exit code
// and a duration that stays put.

export async function run({ page, shot, step, expect }) {
  await page.goto(page.url().replace(/\?.*/, "?mock=1&sidebar=list&view=conversation"));
  await expect(page.getByTestId("nav-home")).toBeVisible();
  const pane = page.locator("[data-testid=pane]:visible").first();

  step("open gpu/judge-v2's chat");
  await page.locator('[data-testid=worktree-row][data-worktree="gpu/judge-v2"]').click({ position: { x: 32, y: 12 } });
  await expect(pane.getByTestId("chat")).toBeVisible();

  step("the chip counts only the shell still running");
  const chip = pane.getByRole("button", { name: /^Background work: / });
  await expect(chip).toHaveAccessibleName("Background work: 1 shell running");
  await chip.click();
  const row = (label) => page.getByRole("button", { name: new RegExp(label) });
  const ended = [
    ["Watch the payment tests", "Done · exit 0", "3m"],
    ["Lint the checkout package", "Failed · exit 3", "30s"],
  ];
  const durations = async () => {
    for (const [label, , took] of ended) await expect(row(label).getByTestId("job-took")).toHaveText(took);
  };
  await expect(row("Start the dev server").getByTestId("job-state")).toHaveText("Running");
  for (const [label, state] of ended) await expect(row(label).getByTestId("job-state")).toHaveText(state);
  await durations();
  await shot("panel");

  step("the ended ones' durations stay put while the clock ticks");
  await page.waitForTimeout(16_000); // the chip's clock ticks every 15s
  await durations();
  await shot("panel-later");
}
