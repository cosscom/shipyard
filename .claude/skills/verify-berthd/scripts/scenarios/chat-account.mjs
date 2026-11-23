// The chat's foot names the account its agent runs on, when the box has
// more than one for the agent (features/chat-account.md), on the mock:
//
//   node drive.mjs chat-account --port $PORT
//
// devl has two Claude Code accounts, the default and work, and
// checkout-fix's agent runs on work: its foot reads "work" after the model,
// with the folder in the tooltip. gpu has one account per agent, so
// gpu/shop's foot has no account chip, its other chips as they were.

export async function run({ page, shot, step, expect }) {
  await page.goto(page.url().replace(/\?.*/, "?mock=1&sidebar=list&view=conversation"));
  await expect(page.getByTestId("nav-home")).toBeVisible();
  const pane = page.locator("[data-testid=pane]:visible");
  const foot = pane.locator("[data-chat-controls]");
  const open = async (worktree) => {
    await page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`).click({ position: { x: 32, y: 12 } });
    await expect(pane.locator("[data-testid=chat] [data-testid=chat-item]").first()).toBeVisible();
  };

  step("open devl/checkout-fix, whose agent runs on the work account of two");
  await open("devl/checkout-fix");
  const account = foot.getByTestId("chat-account");
  await expect(account).toHaveText("work");
  await expect(account).toHaveAccessibleName("Account: work");
  // After the model chip, before the context.
  const order = await foot.evaluate((el) => [...el.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label")));
  const model = order.findIndex((l) => l?.startsWith("Model: "));
  if (model < 0 || order[model + 1] !== "Account: work") throw new Error(`the account chip isn't after the model chip: ${order.join(" | ")}`);
  step("hover it for the folder");
  await account.hover();
  await expect(page.locator("[data-slot=tooltip-popup]")).toHaveText("Claude Code account in /home/me/.berth/accounts/claude/work");
  await page.waitForTimeout(300); // its fade-in, for the picture
  await shot("1-two-accounts");
  step("it only says: clicking it opens nothing");
  await account.click();
  await expect(page.locator("[data-slot=menu-popup], [data-slot=popover-popup]")).toHaveCount(0);

  step("open gpu/shop, on a box with one Claude Code account: no account chip");
  await page.mouse.move(0, 0);
  await open("gpu/shop");
  await expect(foot.getByRole("button", { name: /^Model: / })).toBeVisible();
  await expect(foot.getByTestId("chat-account")).toHaveCount(0);
  await shot("2-one-account");
}
