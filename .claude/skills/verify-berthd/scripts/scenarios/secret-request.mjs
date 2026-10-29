// An agent asks for a secret (features/secret-request.md): its card on the
// board and in its chat, the masked field and its reveal toggle, Save
// securely (one POST to the box, then the value is in no DOM node, field,
// transcript item or storage), the production card's warnings with no
// expiry picker, a refused save that keeps the value in the field alone,
// and Decline.
//
// On the mock (?secrets: devl's search-perf Claude asks for ACME_TOKEN, a
// staging token in the box's encrypted file; gpu's ci-flake Claude asks to
// replace ACME_LEDGER_PROD in GCP Secret Manager, production, with a grant):
//
//   node drive.mjs secret-request --port $PORT

export const params = { secrets: "1", sidebar: "list", view: "conversation" };

const SENTINEL = "acme-sentinel-7f3a9c1e";
const REFUSED = "acme-denied-2b8d";
const REASON = "To call the acme staging API from the search benchmark.\nRead-only is enough.";
const HONEST = "The agent can use this in commands. A command that prints it puts it in the chat.";
const WARN = /\btext-warning-foreground\b/;

// Everywhere a value could be left: the document's markup, every field's
// live value (markup doesn't have it), and the page's storage.
const leftovers = (page, v) =>
  page.evaluate((v) => {
    const where = [];
    if (document.documentElement.outerHTML.includes(v)) where.push("outerHTML");
    for (const el of document.querySelectorAll("input, textarea")) if (el.value.includes(v)) where.push(`field ${el.getAttribute("aria-label") ?? el.name ?? el.tagName}`);
    if (JSON.stringify({ ...localStorage }).includes(v)) where.push("localStorage");
    if (JSON.stringify({ ...sessionStorage }).includes(v)) where.push("sessionStorage");
    return where;
  }, v);

export async function run({ page, shot, step, expect }) {
  const pane = page.locator("[data-testid=pane]:visible");
  const chat = pane.locator("[data-testid=chat]");
  const calls = () => page.evaluate(() => ({ ...window.__berthCalls }));
  const saves = () => page.evaluate(() => window.__secretSaves ?? []);
  const open = async (worktree) => {
    await page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`).click({ position: { x: 32, y: 12 } });
    await expect(chat.locator("[data-testid=chat-item]").first()).toBeVisible();
  };

  step("the Agent Dashboard: both agents in Needs you, each with its secret card in place of its last lines");
  await page.keyboard.press("Meta+j");
  const board = page.getByTestId("dashboard-board");
  await expect(board).toBeVisible();
  const boardCards = board.getByTestId("secret-card");
  await expect(boardCards).toHaveCount(2);
  const boardStaging = board.locator("[data-testid=secret-card][data-secret-id=sr-acme-token]");
  await expect(boardStaging.getByTestId("secret-name")).toHaveText("ACME_TOKEN");
  await expect(boardStaging.getByTestId("secret-input")).toHaveAttribute("type", "password");
  await expect(boardStaging).toContainText(HONEST);
  await boardStaging.scrollIntoViewIfNeeded();
  await shot("1-board-cards");

  step("open devl/search-perf's chat: the card with the name, the reason verbatim, who asks, the store, the expiry picker on the agent's 24 hours");
  await open("devl/search-perf");
  const card = chat.getByTestId("secret-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("secret-name")).toHaveText("ACME_TOKEN");
  expect(await card.getByTestId("secret-reason").evaluate((el) => el.textContent)).toBe(REASON);
  await expect(card.getByTestId("secret-session")).toHaveText("Speed up product search · Claude Code");
  await expect(card.getByTestId("secret-store")).toHaveText("Encrypted file");
  await expect(card.getByTestId("secret-environment")).toHaveText("Staging");
  await expect(card.getByTestId("secret-environment")).not.toHaveClass(WARN);
  await expect(card).toContainText(HONEST);
  await expect(card.getByTestId("secret-input")).toHaveAttribute("type", "password");
  const expiry = card.getByTestId("secret-expiry");
  for (const label of ["No expiry", "1 hour", "24 hours", "7 days"]) await expect(expiry.getByRole("button", { name: label })).toBeVisible();
  await expect(expiry.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("secret-save")).toBeDisabled();
  // No Allow / Deny for it, and the reply box says where the value goes.
  await expect(chat.getByRole("button", { name: /^(Allow|Deny|Yes|No)$/ })).toHaveCount(0);
  await expect(pane.locator("[data-testid=composer]").getByRole("textbox", { name: "Reply" })).toHaveAttribute("placeholder", "Give ACME_TOKEN in the card above, never here");
  await card.scrollIntoViewIfNeeded();
  await shot("2-chat-card");

  step("type the value: masked, and in no attribute of the page while typed");
  const input = card.getByTestId("secret-input");
  await input.fill(SENTINEL);
  await expect(card.getByTestId("secret-save")).toBeEnabled();
  expect(await page.evaluate((v) => document.documentElement.outerHTML.includes(v), SENTINEL)).toBe(false);

  step("the reveal toggle shows it, and hides it again");
  const reveal = card.getByTestId("secret-reveal");
  await expect(reveal).toHaveAccessibleName("Show the value");
  await reveal.click();
  await expect(input).toHaveAttribute("type", "text");
  await expect(reveal).toHaveAccessibleName("Hide the value");
  await page.mouse.move(10, 890);
  await shot("3-revealed");
  await reveal.click();
  await expect(input).toHaveAttribute("type", "password");

  step("the box says secret.requested: a needs-you notification names the secret and why, never a value");
  await page.evaluate(() => window.__secrets.announce());
  const toast = page.locator("[data-slot=toast-title]", { hasText: "Speed up product search asks for a secret" });
  await expect(toast).toBeVisible();
  await expect(page.locator("[data-slot=toast-description]", { hasText: "ACME_TOKEN — To call the acme staging API" })).toBeVisible();
  await shot("3b-notification");

  step("pick 7 days and Save securely: one POST to secrets/requests/sr-acme-token/save");
  await expiry.getByRole("button", { name: "7 days" }).click();
  const before = (await calls())["POST devl/secrets/requests/sr-acme-token/save"] ?? 0;
  await card.getByTestId("secret-save").click();
  await expect.poll(async () => (await calls())["POST devl/secrets/requests/sr-acme-token/save"] ?? 0).toBe(before + 1);
  await expect.poll(saves).toEqual([{ box: "devl", id: "sr-acme-token", expires: "7d" }]);

  step("the request ends and the card goes; the value is nowhere: no DOM node, no field, no transcript item, no storage");
  await expect(chat.getByTestId("secret-card")).toHaveCount(0);
  // secret.request.ended settles the notification: its toast goes.
  await expect(toast).toHaveCount(0);
  expect(await leftovers(page, SENTINEL)).toEqual([]);
  for (const t of await chat.locator("[data-testid=chat-item]").allTextContents()) expect(t.includes(SENTINEL)).toBe(false);
  await expect(pane.locator("[data-testid=composer]").getByRole("textbox", { name: "Reply" })).not.toHaveAttribute("placeholder", /ACME_TOKEN/);
  await shot("4-saved");

  step("open gpu/ci-flake's chat: a production replace, environment, project and grant in the warning colour, no expiry picker");
  await open("gpu/ci-flake");
  const prod = chat.getByTestId("secret-card");
  await expect(prod).toHaveAttribute("data-environment", "production");
  await expect(prod.getByTestId("secret-name")).toHaveText("Replace ACME_LEDGER_PROD");
  await expect(prod.getByTestId("secret-replaced")).toHaveText("· Replaces the one saved 9d ago");
  await expect(prod.getByTestId("secret-store")).toHaveText("GCP Secret Manager · acme-prod");
  await expect(prod.getByTestId("secret-where")).toHaveClass(WARN);
  await expect(prod.getByTestId("secret-environment")).toHaveText("Production");
  await expect(prod.getByTestId("secret-environment")).toHaveClass(WARN);
  await expect(prod.getByTestId("secret-grant")).toHaveText("Grants ledger-backfill@acme-prod.iam.gserviceaccount.com read access to this one secret");
  await expect(prod.getByTestId("secret-grant")).toHaveClass(WARN);
  await expect(prod.getByTestId("secret-expiry")).toHaveCount(0);
  await expect(prod).toContainText("Production secrets never expire.");
  await prod.scrollIntoViewIfNeeded();
  await shot("5-production-card");

  step("a save the box refuses: its words on the card, the value still in the field and nowhere else, nothing sent again");
  await prod.getByTestId("secret-input").fill(REFUSED);
  await prod.getByTestId("secret-save").click();
  await expect(prod.getByTestId("secret-error")).toHaveText("Couldn't save it: Missing permission secretmanager.secrets.create on project acme-prod. The value is still in the field, and nowhere else.");
  await expect(prod.getByTestId("secret-input")).toHaveValue(REFUSED);
  expect(await page.evaluate((v) => document.documentElement.outerHTML.includes(v), REFUSED)).toBe(false);
  expect((await calls())["POST gpu/secrets/requests/sr-acme-ledger/save"]).toBe(1);
  await page.waitForTimeout(1500);
  expect((await calls())["POST gpu/secrets/requests/sr-acme-ledger/save"]).toBe(1);
  expect(await saves()).toHaveLength(1);
  await shot("6-save-refused");

  step("Decline: one POST to secrets/requests/sr-acme-ledger/decline, and the card goes with what was typed");
  await prod.getByTestId("secret-decline").click();
  await expect.poll(async () => (await calls())["POST gpu/secrets/requests/sr-acme-ledger/decline"] ?? 0).toBe(1);
  await expect(chat.getByTestId("secret-card")).toHaveCount(0);
  expect(await leftovers(page, REFUSED)).toEqual([]);
  await shot("7-declined");

  step("the board again: no secret card left");
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("dashboard-board")).toBeVisible();
  await expect(page.getByTestId("dashboard-board").getByTestId("secret-card")).toHaveCount(0);
}
