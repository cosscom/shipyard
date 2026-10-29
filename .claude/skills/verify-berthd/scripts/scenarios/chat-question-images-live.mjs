// chat-question-images-live: a real Claude Code on a dev box asks one
// question (AskUserQuestion), and the chat's card answers it with words of
// the person's own and two images: one dropped on the reply box while the
// question waits (the reply box hands it to the card), one pasted into the
// card's own words. The images go up to the worktree and their paths go
// after the words; Claude reads both and says what they show. The images
// are drawn here, with words on them only Claude's Read can tell it. Works
// on either driver: VERIFY_WORKTREE names a worktree whose agent runs in
// its terminal or structured. See ../../features/attachments.md.
export const live = true;
export const params = { view: "conversation", sidebar: "list" };

const WORDS = "this one is off";

// image draws a PNG with words on it, in the page.
const image = (page, text, colour) =>
  page.evaluate(
    async ({ text, colour }) => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 240;
      const g = c.getContext("2d");
      g.fillStyle = colour;
      g.fillRect(0, 0, 480, 240);
      g.fillStyle = "#fff";
      g.font = "bold 40px sans-serif";
      g.textAlign = "center";
      g.fillText(text, 240, 135);
      const b = await new Promise((r) => c.toBlob(r, "image/png"));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    },
    { text, colour },
  );

export async function run({ page, shot, step, expect }) {
  const worktree = process.env.VERIFY_WORKTREE;
  if (!worktree) throw new Error("set VERIFY_WORKTREE to the worktree row's box/name");
  step(`open ${worktree}'s agent in chat`);
  const row = page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`);
  await row.click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  const chat = pane.getByTestId("chat");
  let reply = pane.getByRole("textbox", { name: "What should Claude Code do?", exact: true });
  try {
    await expect(reply).toBeEditable({ timeout: 15_000 });
  } catch {
    reply = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
  }

  step("ask Claude for a question; the prompt says nothing of images");
  await reply.fill('Use the AskUserQuestion tool to ask me one question: "Which screen of the checkout looks wrong?" with options "Cart" and "Payment". Then reply in two sentences: what is wrong and how you will fix it.');
  await reply.press("Enter");
  const form = chat.getByTestId("question-form");
  await expect(form).toBeVisible({ timeout: 180_000 });
  const composer = pane.getByTestId("composer");
  const field = composer.getByRole("textbox", { name: "Reply" });

  step("drop an image on the reply box while the question waits");
  const dropped = await image(page, "ORANGE GIRAFFE 7316", "#f97316");
  await field.evaluate((el, bytes) => {
    const dt = new DataTransfer();
    // A name with a space, and none of the words on the image.
    dt.items.add(new File([new Uint8Array(bytes)], "checkout step 2.png", { type: "image/png" }));
    for (const type of ["dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dropped);
  const chips = form.getByTestId("attachment-chip");
  await expect(chips).toHaveCount(1);
  await expect(composer.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(form.getByRole("radio", { name: "Something else" })).toBeChecked();

  step("paste a second image into the card's own words, then write them");
  const pasted = await image(page, "TEAL ANCHOR 0948", "#0d9488");
  const own = form.getByRole("textbox", { name: "Your own answer" });
  await own.evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) await expect(chip).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await own.fill(WORDS);
  await shot("1-card-with-images");

  step("submit");
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(form).toHaveCount(0, { timeout: 60_000 });
  const answered = chat.locator("[data-testid=chat-item][data-kind=question]").last();
  await expect(answered).toContainText(WORDS, { timeout: 60_000 });
  await expect(answered.getByTestId("answer-attachments")).toHaveText(/checkout-step-2\.png, pasted-\d+\.png/);
  await expect(composer.getByTestId("attachment-chip")).toHaveCount(0);
  await shot("2-answered");

  step("Claude reads both images and says what they show");
  const last = chat.locator("[data-testid=chat-item][data-kind=text]").last();
  // Both words at once: the second can come a sentence after the first.
  await expect(last).toContainText(/^(?=[\s\S]*giraffe)(?=[\s\S]*anchor)/i, { timeout: 180_000 });
  // By now the card shows the answer as Claude's record has it, not as sent.
  await expect(answered).toContainText(WORDS);
  await expect(answered.getByTestId("answer-attachments")).toHaveText(/checkout-step-2\.png, pasted-\d+\.png/);
  await shot("3-claude-read-them");
}
