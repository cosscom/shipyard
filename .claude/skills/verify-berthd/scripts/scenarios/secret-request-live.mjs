// secret-request-live: the save step of ../secret-request-live.sh, in the
// app against a dev box (VERIFY_DRIVER=claude ../dev-box.sh up). The real
// Claude in session "ask" has asked for ACME_TOKEN; this opens its chat,
// finds the card, types the run's sentinel (VERIFY_SECRET_SENTINEL), and
// presses Save securely, as a person would. The card goes, the request is
// saved on the box, and the value is in no DOM node afterwards. See
// ../../features/secret-request.md.
export const live = true;
export const params = { view: "conversation", sidebar: "list" };

export async function run({ page, shot, step, expect, call }) {
  const sentinel = process.env.VERIFY_SECRET_SENTINEL;
  const worktree = process.env.VERIFY_WORKTREE;
  if (!sentinel || !worktree) throw new Error("run by ../secret-request-live.sh: VERIFY_SECRET_SENTINEL and VERIFY_WORKTREE");

  step("open the agent's chat");
  await page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`).click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  await expect(pane.getByTestId("chat")).toBeVisible({ timeout: 30_000 });

  step("the agent's request shows as a masked card");
  const card = pane.getByTestId("chat").getByTestId("secret-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("secret-name")).toHaveText("ACME_TOKEN");
  await expect(card.getByTestId("secret-reason")).toHaveText("verify: deploy the acme app to staging");
  await expect(card.getByTestId("secret-store")).toHaveText(/Encrypted file|Keychain|Secret Service/);
  const input = card.getByTestId("secret-input");
  await expect(input).toHaveAttribute("type", "password");
  await shot("1-live-card");

  step("type the value and save it securely");
  await input.fill(sentinel);
  await card.getByTestId("secret-save").click();
  await expect(pane.getByTestId("chat").getByTestId("secret-card")).toHaveCount(0, { timeout: 30_000 });
  await shot("2-live-saved");

  step("the box has it saved, and the page holds the value nowhere");
  const pending = await call("/v1/boxes/devq/api/secrets/requests");
  if (pending.some((r) => r.session === "ask")) throw new Error(`still pending: ${JSON.stringify(pending)}`);
  const inPage = await page.evaluate((s) => document.documentElement.outerHTML.includes(s) || [...document.querySelectorAll("input,textarea")].some((el) => el.value.includes(s)) || JSON.stringify({ ...localStorage }).includes(s) || JSON.stringify({ ...sessionStorage }).includes(s), sentinel);
  if (inPage) throw new Error("the value is still in the page");
}
