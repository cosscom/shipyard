import type { Locator } from "@playwright/test";

import { agentWorktree, expect, mockOnly, test } from "./fixtures";

// An agent's pane as a conversation: what the transcript draws and what
// the person can do from it.

test.beforeEach(async ({ app }) => {
  await app.open({ params: { view: "conversation" } });
});

test("a worktree's agent opens as its chat", async ({ app }) => {
  const wt = await agentWorktree(app, "devl/checkout-fix");
  await app.openWorktree(wt);
  await expect(app.chat).toBeVisible();
  await expect(app.chat.locator("[data-testid=chat-item]").first()).toBeVisible();
  await expect(app.composer.getByRole("textbox", { name: "Reply" })).toBeVisible();
  // The tab strip names the agent's tab; with one worktree there are no groups.
  await expect(app.page.locator("[data-tab-strip] [data-tab]").first()).toBeVisible();
  await expect(app.page.locator("[data-tab-strip] [data-group]")).toHaveCount(0);
});

test("a reply's Markdown draws, with its code highlighted", async ({ app }) => {
  mockOnly();
  await app.openWorktree("gpu/shop");
  const md = app.chat.locator("[data-kind=text] .cv-md").filter({ has: app.page.locator("pre") });
  await expect(md.getByRole("heading", { name: "The fix, in short" })).toBeVisible();
  await expect(md.locator("li").filter({ hasText: "Retries stop after five" })).toBeVisible();
  await expect(md.locator("strong", { hasText: "five" })).toBeVisible();
  // Coloured by the theme's syntax colours once the highlighter has run.
  const tokens = md.locator("pre code span[style*='--diffs-token']");
  await expect(tokens.first()).toBeVisible();
  expect(await tokens.count()).toBeGreaterThan(5);
  await expect(md.locator("pre code")).toContainText("orders.byIdempotencyKey(event.idempotencyKey)");
});

test("a reply shows a worktree picture and opens its file", async ({ app }) => {
  mockOnly();
  await app.open({ params: { view: "conversation", scene: "chat-image" } });
  await app.openWorktree("gpu/shop");
  const card = app.chat.getByTestId("chat-worktree-image");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-path", "screenshots/checkout-result.png");
  const image = card.getByRole("img", { name: "Checkout result" });
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(960);
  if (process.env.BERTH_SHOTS) {
    await card.scrollIntoViewIfNeeded();
    await app.page.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-worktree-image.png` });
    await card.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-worktree-image-detail.png` });
  }
  await card.getByRole("button", { name: "Source" }).click();
  await expect(card).toContainText("![Checkout result](screenshots/checkout-result.png)");
  await card.getByRole("button", { name: "Image" }).click();
  await card.getByRole("button", { name: "Open Checkout result" }).click();
  await expect(app.page.locator("[data-testid=file-pane][data-path='screenshots/checkout-result.png'] [data-testid=file-image] img")).toBeVisible();
});

test("Markdown tables can chart numbers and filter failed rows", async ({ app }) => {
  mockOnly();
  await app.open({ params: { view: "conversation", scene: "chat-tables" } });
  await app.openWorktree("gpu/shop");
  const speed = app.chat.locator(".cv-table").filter({ hasText: "Before (ms)" });
  await expect(speed).toBeVisible();
  await speed.getByRole("button", { name: "Chart" }).click();
  const chart = speed.getByTestId("chat-table-chart");
  await expect(chart).toBeVisible();
  await expect(chart.locator("[data-chart-type=bar]")).toBeVisible();
  await expect(chart.locator("[data-chart-type=bar] svg").first()).toBeVisible();
  if (process.env.BERTH_SHOTS) {
    // Let the chart's reveal finish before recording its final appearance.
    await app.page.waitForTimeout(1200);
    await chart.scrollIntoViewIfNeeded();
    await app.page.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-table-chart.png` });
    await speed.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-table-chart-detail.png` });
  }
  await speed.getByRole("button", { name: "Explore" }).click();
  const explored = speed.getByTestId("chat-explored-table");
  await explored.getByRole("button", { name: "After (ms)" }).click();
  await expect(explored.locator("tbody tr").first()).toContainText("Cart");

  const checks = app.chat.locator(".cv-table").filter({ hasText: "Retry webhook" });
  await checks.getByRole("button", { name: "Explore" }).click();
  await checks.getByRole("button", { name: "Failures only" }).click();
  await expect(checks.getByTestId("chat-explored-table").locator("tbody tr")).toHaveCount(2);
  await expect(checks.getByTestId("chat-explored-table")).not.toContainText("Search index");
  if (process.env.BERTH_SHOTS) await checks.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-table-failures-detail.png` });
  await checks.getByRole("button", { name: "Original" }).click();
  await expect(checks.locator(":scope > table")).toBeVisible();
  await expect(checks.locator(":scope > table")).toContainText("Search index");
});

test("a test report shows failures and opens the failed file", async ({ app }) => {
  mockOnly();
  await app.open({ params: { view: "conversation", scene: "chat-tests" } });
  await app.openWorktree("gpu/shop");
  const card = app.chat.getByTestId("chat-test-results");
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 failed");
  await expect(card).toContainText("8 passed");
  await expect(card).toContainText("reuses an order when a webhook retries");
  const block = card.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' cv-pre ')]").first();
  if (process.env.BERTH_SHOTS) {
    await block.scrollIntoViewIfNeeded();
    await app.page.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-test-results.png` });
    await block.screenshot({ path: `${process.env.BERTH_SHOTS}/chat-test-results-detail.png` });
  }
  await block.getByRole("button", { name: "Show test output" }).click();
  await expect(block.locator("pre")).toBeVisible();
  await block.getByRole("button", { name: "Show test results" }).click();
  await card.getByRole("button", { name: /Open apps\/web\/lib\/checkout\/createOrder\.test\.ts line 42/ }).click();
  await expect(app.page.locator("[data-testid=file-pane][data-path='apps/web/lib/checkout/createOrder.test.ts']")).toBeVisible();
});

test("an edit opens to its change, highlighted", async ({ app }) => {
  mockOnly();
  await app.openWorktree("devl/checkout-fix");
  const edit = app.chat.locator("[data-testid=chat-item][data-kind=edit]").filter({ hasText: "webhook.ts" }).first();
  const toggle = edit.getByRole("button", { expanded: false });
  await toggle.click();
  await expect(edit.getByRole("button", { expanded: true })).toBeVisible();
  await expect(edit.getByRole("button", { name: "Open in Review" })).toBeVisible();
  // The change, drawn by the diff renderer (in its shadow root) with syntax colours.
  const diff = edit.locator("diffs-container");
  await expect(diff.getByText("orders.byIdempotencyKey", { exact: false }).first()).toBeVisible();
  await expect(diff.locator("[style*='--diffs-token']").first()).toBeAttached();
});

test("a tool call opens to what it did", async ({ app }) => {
  mockOnly();
  await app.openWorktree("gpu/shop");
  // The steps before the answer fold into one line; open it, then the call.
  const fold = app.chat.getByRole("button", { name: /^Work(ed|ing)/ }).first();
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const group = app.chat.getByRole("button", { name: /Read 2 files/ });
  await group.click();
  const call = app.chat.getByRole("button", { name: /Read\s*ts\s*webhook\.ts/ });
  await call.click();
  await expect(call).toHaveAttribute("aria-expanded", "true");
  await expect(app.chat.getByText("export async function handleWebhook(req: Request)")).toBeVisible();
});

test("a form of questions steps through to a review and submits", async ({ app }) => {
  mockOnly("answers a question on a box");
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  await expect(form).toContainText("Claude asks you 3 questions");
  // While it asks, the reply box points at the form.
  await expect(app.composer.getByRole("textbox", { name: "Reply" })).toHaveAttribute("placeholder", "Answer Claude's questions above");
  // The form's own button, after the steps' (one of which is "Review").
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();

  // 1: one pick.
  await expect(form).toContainText("1 of 3");
  await expect(next).toBeDisabled();
  await form.getByRole("radio", { name: /Next minor/ }).click();
  await next.click();
  // 2: several picks, and words of the person's own.
  await expect(form).toContainText("2 of 3");
  await form.getByRole("checkbox", { name: /Unit tests/ }).click();
  await form.getByRole("checkbox", { name: /E2E on staging/ }).click();
  await form.getByRole("textbox", { name: "Your own answer" }).fill("smoke the checkout");
  await next.click();
  // 3: the person's own words instead of an option.
  await expect(form).toContainText("3 of 3");
  await form.getByRole("textbox", { name: "Your own answer" }).fill("ops on call");
  await expect(next).toHaveText(/Review/);
  await next.click();

  // The review lists every answer; one can be changed from there.
  await expect(form).toContainText("Review your answers");
  await expect(form).toContainText("Next minor");
  await expect(form).toContainText("Unit tests, E2E on staging, smoke the checkout");
  await expect(form).toContainText("ops on call");
  await form.getByRole("button", { name: /Who should review the change\?/ }).click();
  await expect(form).toContainText("3 of 3");
  await form.getByRole("radio", { name: /bailey/ }).click();
  await next.click();
  await expect(form).toContainText("bailey");
  await expect(next).toHaveText(/Submit answers/);
  await next.click();

  // Answered: the form becomes what was picked, and the agent goes on.
  await expect(form).toHaveCount(0);
  const answered = app.chat.locator("[data-testid=chat-item][data-kind=question]");
  await expect(answered).toContainText("Answered 3 questions");
  await expect(answered).toContainText("Unit tests, E2E on staging, smoke the checkout");
  await expect(app.chat.getByText("I'll plan it for Next minor")).toBeVisible();
});

test("answers the box couldn't deliver stay in the form, to retry or copy", async ({ app }) => {
  mockOnly("answers a question on a box");
  await app.open({ params: { view: "conversation", scene: "answer-stuck" } });
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();
  const words = "Ship it Thursday only if the payment provider's sandbox is green by Wednesday noon; otherwise hold it for QA and tell support before anything else.";
  await form.getByRole("radio", { name: "Something else" }).click();
  await form.getByRole("textbox", { name: "Your own answer" }).fill(words);
  await next.click();
  await form.getByRole("checkbox", { name: /Unit tests/ }).click();
  await next.click();
  await form.getByRole("radio", { name: /bailey/ }).click();
  await next.click();
  await expect(next).toHaveText(/Submit answers/);
  await next.click();

  // It didn't take: the form stays, with every answer and why.
  const failed = form.getByTestId("question-form-failed");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("Your answers didn't reach Claude");
  await expect(failed).toContainText("Claude's screen doesn't show its questions");
  await expect(form).toContainText("Review your answers");
  await expect(form).toContainText(words);
  await expect(form).toContainText("Unit tests");

  // Copy answers: each under its question's name, ready to paste.
  await app.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await failed.getByRole("button", { name: "Copy answers" }).click();
  await expect.poll(() => app.page.evaluate(() => navigator.clipboard.readText())).toBe(`Release: ${words}\nChecks: Unit tests\nReviewer: bailey`);

  // Retry goes, and the form becomes what was answered.
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(form).toHaveCount(0);
  const answered = app.chat.locator("[data-testid=chat-item][data-kind=question]");
  await expect(answered).toContainText("Answered 3 questions");
  await expect(answered).toContainText(words);
});

// drop lets files fall on the element, as from Finder: a note and a small
// image, or one image of size bytes (which the mock uploads at 1 MB/s).
async function drop(target: Locator, size?: number) {
  await target.evaluate(
    (el, size) => {
      const dt = new DataTransfer();
      if (size) dt.items.add(new File([new Uint8Array(size)], "flow-step-3.png", { type: "image/png" }));
      else {
        dt.items.add(new File(["The banner overlaps the total.\n"], "notes.md", { type: "text/markdown" }));
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" }));
      }
      for (const type of ["dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    size,
  );
}

// pasteShot pastes a screenshot into the field, as the app gets one from
// macOS.
async function pasteShot(field: Locator) {
  await field.evaluate(async (el) => {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 64;
    c.getContext("2d")!.fillRect(0, 0, 96, 64);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test("files in the reply box and dropped on the form go with its answer", async ({ app }) => {
  mockOnly("answers a question on a box");
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  await expect(form).toContainText("1 of 3");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();

  // Dropped on the reply box while Claude asks: they show on the form, as
  // its first answer in the person's own words, and not in the reply box.
  await drop(app.composer.getByRole("textbox", { name: "Reply" }));
  const chips = form.getByTestId("attachment-chip");
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) await expect(chip).toHaveAttribute("data-state", "ready");
  await expect(app.composer.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(app.composer.getByRole("textbox", { name: "Reply" })).toHaveAttribute("placeholder", "Your attachments go with your answer above");
  await expect(form.getByRole("radio", { name: "Something else" })).toBeChecked();
  // The files alone answer it; words go before them.
  await expect(next).toBeEnabled();
  await form.getByRole("textbox", { name: "Your own answer" }).fill("the banner step was off");
  await next.click();
  await form.getByRole("checkbox", { name: /Unit tests/ }).click();
  await next.click();
  await form.getByRole("radio", { name: /bailey/ }).click();
  await next.click();
  await expect(form).toContainText("Review your answers");
  await expect(form).toContainText("the banner step was offnotes.md, shot.png");

  // Dropped on the form at its review: it goes with the answer in words.
  // Submit waits for its upload.
  await drop(form, 2_500_000);
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(2)).toHaveAttribute("data-state", "uploading");
  await expect(next).toBeDisabled();
  await expect(form).toContainText(/Uploading the image \(\d+%\)/);
  await expect(chips.nth(2)).toHaveAttribute("data-state", "ready", { timeout: 10_000 });
  await expect(form).toContainText("notes.md, shot.png, flow-step-3.png");
  await next.click();

  // Answered: the files by name; Claude got their paths after the words,
  // and the reply box doesn't send them again.
  await expect(form).toHaveCount(0);
  const answered = app.chat.locator("[data-testid=chat-item][data-kind=question]");
  await expect(answered.getByTestId("answer-attachments")).toHaveText("notes.md, shot.png, flow-step-3.png");
  await expect(app.chat).toContainText(/I'll plan it for the banner step was off \[attached: \S+\/\.berth\/attachments\/\d{8}-\d{6}-notes\.md, \S+-shot\.png, \S+-flow-step-3\.png\]/);
  await expect(app.composer.getByTestId("attachment-chip")).toHaveCount(0);
});

test("a screenshot pasted into the form's own words is an answer, kept when it doesn't go", async ({ app }) => {
  mockOnly("answers a question on a box");
  await app.open({ params: { view: "conversation", scene: "answer-stuck" } });
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();
  await form.getByRole("radio", { name: /Next minor/ }).click();
  // Pasted after a pick: the answer turns to the person's own words.
  await pasteShot(form.getByRole("textbox", { name: "Your own answer" }));
  await expect(form.getByTestId("attachment-chip")).toHaveText(/pasted-\d+\.png/);
  await expect(form.getByRole("radio", { name: "Something else" })).toBeChecked();
  await next.click();
  await form.getByRole("checkbox", { name: /Unit tests/ }).click();
  await next.click();
  await form.getByRole("radio", { name: /bailey/ }).click();
  await next.click();
  await next.click();

  // It didn't take: the form keeps the screenshot.
  const failed = form.getByTestId("question-form-failed");
  await expect(failed).toBeVisible();
  await expect(form.getByTestId("attachment-chip")).toHaveCount(1);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(form).toHaveCount(0);
  const answered = app.chat.locator("[data-testid=chat-item][data-kind=question]");
  await expect(answered.getByTestId("answer-attachments")).toHaveText(/^pasted-\d+\.png$/);
  await expect(app.composer.getByTestId("attachment-chip")).toHaveCount(0);
});

test("the artifacts chip lists the pages an agent published", async ({ app }) => {
  mockOnly();
  await app.openWorktree("devl/search-perf");
  const chip = app.page.getByTestId("artifacts-chip");
  await expect(chip).toHaveAccessibleName(/8 artifacts Claude published/);
  await chip.click();
  const pop = app.page.getByTestId("artifacts-popover");
  await expect(pop).toBeVisible();
  // Newest first; the baseline, published twice, once under its new title.
  await expect(pop.getByRole("listitem")).toHaveCount(8);
  await expect(pop.getByRole("listitem").first()).toContainText("Slow query log, last 24 hours");
  await expect(pop).toContainText("Search latency: before and after");
  // Show one in the chat: the popover closes on the artifact's card.
  await pop.getByRole("listitem").last().hover();
  await pop.getByRole("button", { name: /Show Query plans, before in the chat/ }).click();
  await expect(app.chat.locator("[data-kind=artifact]").filter({ hasText: "Query plans, before" }).locator(":scope > *")).toBeInViewport();
});

test("a reply sent while the agent works waits as pending", async ({ app }) => {
  mockOnly("sends a prompt");
  // judge-v2's agent is mid-turn, and stays so in the fixtures.
  await app.openWorktree("gpu/judge-v2");
  const box = app.composer.getByRole("textbox", { name: "Reply" });
  await expect(box).toHaveAttribute("placeholder", "Claude is working: it reads this at its next step");
  await box.fill("Also try the stricter rubric, please");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  const pending = app.chat.getByTestId("queued-reply");
  await expect(pending).toContainText("Also try the stricter rubric, please");
  await expect(pending).toContainText("Queued: sends when Claude finishes");
  await expect(pending.getByRole("button", { name: "Send now" })).toBeEnabled();
});

test("a turn that ended while its work runs on shows the hourglass and takes a new turn", async ({ app }) => {
  mockOnly();
  // Turn check read its finished turn as work still running (unfinished).
  await app.openWorktree("devl/order-export");
  await app.page.locator("[data-tab-strip] [data-tab]", { hasText: "Add tests for the export job" }).click();
  const onWork = app.chat.locator("[data-kind=on-its-work]");
  await expect(onWork).toHaveText("Waiting on its work");
  await expect(app.chat.locator("[data-kind=thinking]")).toHaveCount(0);
  await expect(app.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(app.panes.getByRole("button", { name: /^Stop / })).toHaveCount(0);
  await onWork.getByText("Waiting on its work").hover();
  await expect(app.page.locator("[data-slot=tooltip-popup]")).toContainText("Its turn ended while its work runs on");
  // A live turn keeps its spinner, Stop and Queue.
  await app.openWorktree("gpu/judge-v2");
  await expect(app.chat.locator("[data-kind=thinking]")).toBeVisible();
  await expect(app.panes.getByRole("button", { name: "Stop Claude" })).toBeVisible();
  await expect(app.composer.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
});

// selectWords selects an element's words, as a triple click does.
async function selectWords(el: import("@playwright/test").Locator) {
  await el.scrollIntoViewIfNeeded();
  await el.click({ clickCount: 3 });
}

test("words selected in a reply can be quoted in the reply box", async ({ app }) => {
  mockOnly();
  await app.openWorktree("gpu/shop");
  const words = app.chat.locator(".cv-md li").filter({ hasText: "Retries stop after" });
  await selectWords(words);
  const bar = app.page.getByTestId("selection-actions");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("textbox", { name: "Ask Claude about this" })).toBeVisible();
  await bar.getByRole("button", { name: "Quote in reply" }).click();
  await expect(bar).toBeHidden();
  const box = app.composer.getByRole("textbox", { name: "Reply" });
  await expect(box).toHaveValue("> Retries stop after five tries over ten minutes.\n\n");
  await expect(box).toBeFocused();
  // Escape puts the bar away, and a click elsewhere does too.
  await selectWords(words);
  await expect(bar).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("a question about selected words goes to the agent with them quoted", async ({ app }) => {
  mockOnly("sends a prompt");
  await app.openWorktree("gpu/judge-v2");
  await selectWords(app.chat.locator("[data-kind=text] .cv-md p").first());
  const bar = app.page.getByTestId("selection-actions");
  const ask = bar.getByRole("textbox", { name: "Ask Claude about this" });
  await ask.fill("Which test is failing?");
  await ask.press("Enter");
  await expect(bar).toBeHidden();
  // Claude is mid-turn, so it waits as any reply would.
  const pending = app.chat.getByTestId("queued-reply");
  await expect(pending).toContainText("> I’ll start from the failing test in judge-v2 and work outwards.");
  await expect(pending).toContainText("Which test is failing?");
});

test("a code block is headed by its language, with a Copy that says so", async ({ app }) => {
  mockOnly();
  await app.openWorktree("gpu/shop");
  const block = app.chat.locator(".cv-md .cv-pre").first();
  await expect(block.locator(".cv-pre-lang")).toHaveText("TypeScript");
  const copy = block.getByRole("button", { name: "Copy code" });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveText("Copied", { useInnerText: true });
  expect(await app.page.evaluate(() => navigator.clipboard.readText())).toContain("orders.byIdempotencyKey(event.idempotencyKey)");
});
