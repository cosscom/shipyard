import { expect, mockOnly, test } from "./fixtures";

// An agent that runs in chat (structured) has only the host that runs it in
// its pane, one line per frame ("out stream_event"), and the host's command
// line ends in '--permission-prompt-tool' 'stdio'. Its board card shows what
// it asks, or the last lines of its reply, and the prompt it started with:
// never those frames, and never "stdio" (lib/chat-card.ts). A terminal
// agent's card still shows its screen.

const HOST = /out stream_event|out control_request|out assistant|stdio/;

async function openBoard(app: import("./fixtures").App) {
  mockOnly("the agents in chat are mock fixtures (?structured)");
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 }, params: { structured: "1" } });
  await app.page.getByTestId("nav-home").click();
  return {
    needsYou: app.page.getByRole("region", { name: "Needs you" }),
    working: app.page.getByRole("region", { name: "Working" }),
  };
}

test("a chat card waiting on you shows what it asks, its answers, and no host frames", async ({ app }) => {
  const { needsYou } = await openBoard(app);
  const permission = needsYou.locator("article", { hasText: "Move acme billing to the new ledger" });
  await expect(permission).toContainText("Backfill the new ledger from this year's invoices");
  await expect(permission).toContainText("$ pnpm ledger:backfill --since 2025-01-01");
  await expect(permission.getByRole("button", { name: /^1\s*Yes$/ })).toBeVisible();
  await expect(permission.getByRole("button", { name: /^3\s*No$/ })).toBeVisible();
  // Its conversation's first prompt, not the host's last word.
  await expect(permission.getByText(/^“Move acme billing onto the new ledger\. Send helpers to map every ledger write/)).toBeVisible();
  // A form of questions is answered in its chat: the question, no chips.
  const question = needsYou.locator("article", { hasText: "Plan the checkout release" });
  await expect(question).toContainText("Three questions about the release window");
  await expect(question.getByRole("button", { name: /^\d\s/ })).toHaveCount(0);
  for (const card of [permission, question]) await expect(card).not.toContainText(HOST);
});

test("a chat card at work shows the last lines of its reply", async ({ app }) => {
  const { working } = await openBoard(app);
  const card = working.locator("article", { hasText: "Tune the judge prompt" });
  await expect(card).toContainText("0.82 agreement with the labels, was 0.74");
  await expect(card).toContainText("Next: rerun the hard set with a length penalty.");
  await expect(card).not.toContainText(HOST);
});

test("a terminal card beside them still shows its screen and its menu", async ({ app }) => {
  const { needsYou } = await openBoard(app);
  const card = needsYou.locator("article", { hasText: "Fix checkout webhook retries" });
  await expect(card).toContainText("the order lock for the whole backoff.");
  await expect(card.getByRole("button", { name: /^1\s*Yes, cap it at 30s$/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /^2\s*No, leave it$/ })).toBeVisible();
});
