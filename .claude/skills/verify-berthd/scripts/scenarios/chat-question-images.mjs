// chat-question-images: on the mock, Claude's form of three questions
// takes files. Two dropped on the reply box while it waits show on the
// card instead, as the first answer in the person's own words; a 2.5 MB
// image dropped on the card at its review holds Submit until it is up;
// the answer goes with the files' paths after the words, and the reply box
// is empty after. See ../../features/attachments.md.
export const params = { view: "conversation", sidebar: "list" };

const drop = (target, size) =>
  target.evaluate((el, size) => {
    const dt = new DataTransfer();
    if (size) dt.items.add(new File([new Uint8Array(size)], "flow-step-3.png", { type: "image/png" }));
    else {
      dt.items.add(new File(["The banner overlaps the total.\n"], "notes.md", { type: "text/markdown" }));
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" }));
    }
    for (const type of ["dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, size);

export async function run({ page, shot, step, expect }) {
  step("open gpu/shop, where Claude asks three questions");
  await page.locator('[data-testid=worktree-row][data-worktree="gpu/shop"]').click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  const form = pane.getByTestId("question-form");
  await expect(form).toContainText("Claude asks you 3 questions");
  const composer = pane.getByTestId("composer");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();

  step("drop a note and a screenshot on the reply box");
  await drop(composer.getByRole("textbox", { name: "Reply" }));
  const chips = form.getByTestId("attachment-chip");
  await expect(chips).toHaveCount(2);
  await expect(composer.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(form.getByRole("radio", { name: "Something else" })).toBeChecked();
  await form.getByRole("textbox", { name: "Your own answer" }).fill("the banner step was off");
  await shot("1-card-takes-the-reply-box-files");

  step("answer the other two, to the review");
  await next.click();
  await form.getByRole("checkbox", { name: /Unit tests/ }).click();
  await next.click();
  await form.getByRole("radio", { name: /bailey/ }).click();
  await next.click();
  await expect(form).toContainText("Review your answers");

  step("drop a 2.5 MB image on the card: Submit waits for it");
  await drop(form, 2_500_000);
  await expect(chips.nth(2)).toHaveAttribute("data-state", "uploading");
  await expect(next).toBeDisabled();
  await expect(form).toContainText(/Uploading the image \(\d+%\)/);
  await shot("2-submit-waits-for-the-upload");
  await expect(chips.nth(2)).toHaveAttribute("data-state", "ready", { timeout: 10_000 });
  await expect(next).toBeEnabled();
  await expect(form).toContainText("the banner step was offnotes.md, shot.png, flow-step-3.png");
  await shot("3-review-with-files");

  step("submit: the files go as paths after the words");
  await next.click();
  await expect(form).toHaveCount(0);
  const answered = pane.locator("[data-testid=chat-item][data-kind=question]");
  await expect(answered.getByTestId("answer-attachments")).toHaveText("notes.md, shot.png, flow-step-3.png");
  await expect(pane.getByTestId("chat")).toContainText(/the banner step was off \[attached: \S+-notes\.md, \S+-shot\.png, \S+-flow-step-3\.png\]/);
  await expect(composer.getByTestId("attachment-chip")).toHaveCount(0);
  await shot("4-answered");
}
