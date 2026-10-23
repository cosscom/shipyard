// The Agent Dashboard's cards for agents that run in chat
// (features/chat-board-cards.md): their pane holds only the host that runs
// them, so a card shows what the agent asks, or the last lines of its
// reply, and the prompt it started with. Never the host's frames
// ("out stream_event"), and never "stdio". A terminal agent's card still
// shows the last lines of its screen.
//
// On the mock (?structured: search-perf's and three of gpu's Claudes run in
// chat; the rest in their terminals):
//
//   node drive.mjs chat-board-cards --port $PORT

export const params = { structured: "1" };

const HOST = /out stream_event|out control_request|out system|in user|stdio/;

export async function run({ page, shot, step, expect }) {
  const board = page.getByTestId("dashboard-board");
  const card = (title) => board.locator("article", { hasText: title });
  const box = (c) => c.locator(".font-mono.text-tag");

  step("open the Agent Dashboard");
  await page.keyboard.press("Meta+j");
  await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible();
  await expect(board).toBeVisible();

  step("in chat, waiting on a command: the command and why, its answers as chips, the prompt it started with");
  const permission = card("Move acme billing to the new ledger");
  await expect(permission).toBeVisible();
  await expect(box(permission)).toContainText("Backfill the new ledger from this year's invoices");
  await expect(box(permission)).toContainText("$ pnpm ledger:backfill --since 2025-01-01");
  for (const label of ["Yes", "No"]) await expect(permission.getByRole("button", { name: new RegExp(`^\\d\\s*${label}$`) })).toBeVisible();
  // Its conversation's first prompt, not the host's last word.
  await expect(permission.getByText(/^“Move acme billing onto the new ledger\. Send helpers to map every ledger write/)).toBeVisible();
  await expect(permission).not.toContainText(HOST);
  await permission.scrollIntoViewIfNeeded();
  await shot("1-waiting-permission");

  step("in chat, asking a question: the question, no made-up answers");
  const question = card("Plan the checkout release");
  await expect(box(question)).toContainText("Three questions about the release window");
  await expect(question.getByRole("button", { name: /^\d\s/ })).toHaveCount(0);
  await expect(question).not.toContainText(HOST);
  await question.scrollIntoViewIfNeeded();
  await shot("2-waiting-question");

  step("in chat, working: the last lines of what it said");
  const working = card("Tune the judge prompt");
  await expect(box(working)).toContainText("0.82 agreement with the labels, was 0.74");
  await expect(box(working)).toContainText("Next: rerun the hard set with a length penalty.");
  await expect(working).not.toContainText(HOST);
  await working.scrollIntoViewIfNeeded();
  await shot("3-working");

  step("in chat, done: its last reply");
  const done = card("Speed up product search");
  await expect(box(done)).toContainText("Within budget: /search p95 is 410 ms against 500 ms.");
  await expect(done).not.toContainText(HOST);
  await done.scrollIntoViewIfNeeded();
  await shot("4-done");

  step("in its terminal, waiting: unchanged, the last lines of its screen and its menu's chips");
  const terminal = card("Fix checkout webhook retries");
  await expect(box(terminal)).toContainText("the order lock for the whole backoff.");
  await expect(terminal.getByRole("button", { name: /^1\s*Yes, cap it at 30s$/ })).toBeVisible();
  await terminal.scrollIntoViewIfNeeded();
  await shot("5-terminal");

  step("nowhere on the board: a host frame or stdio");
  await expect(board).not.toContainText(HOST);
  await page.evaluate(() => document.querySelector("[data-testid=dashboard-board]")?.scrollTo(0, 0));
  await shot("6-board");
}
