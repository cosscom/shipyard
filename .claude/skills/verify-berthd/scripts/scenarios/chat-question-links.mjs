// Long web addresses in an agent's questions (features/chat-questions.md,
// questions-links), on the mock's ?scene=question-links (made-up data):
//
//   node drive.mjs chat-question-links --port $PORT
//
// At 1440x900 and at a phone's width, dark and light: the sign-in address
// in the question and the longer one in "Approved"'s description wrap
// inside the card, and each links the whole address. Clicking the option's
// link, or Enter on it, opens it (window.open, what lib/open-url calls
// outside the Mac app) and picks nothing; the row around it still picks.
// Step 2's address, cut short by the box (its "…"), shows with no link.
// The review shows the first question whole.

export const params = { sidebar: "list", view: "conversation", scene: "question-links" };

const LINK_URL = "https://shop.example.com/admin/oauth/authorize?client_id=0000example0000example&scope=read_products,write_products,read_orders&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&state=mock-state-1234567890abcdef";
const OPTION_URL = `${LINK_URL}&grant_options%5B%5D=per-user`;

export async function run({ page, shot, step, expect }) {
  // Record what would open in the browser, instead of opening it.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await page.reload();
  await expect(page.getByTestId("nav-home")).toBeVisible({ timeout: 20_000 });
  const opened = () => page.evaluate(() => window.__opened);
  const chat = page.locator("[data-testid=pane]:visible [data-testid=chat]");
  const form = chat.getByTestId("question-form");
  // The theme, as a person picks it: the command palette's Themes.
  const theme = async (name) => {
    const input = page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
    const item = page.getByRole("option", { name: new RegExp(`^${name}`) });
    await expect(async () => {
      if (!(await input.isVisible())) await page.keyboard.press("Meta+k");
      await input.fill(name);
      await expect(item).toBeVisible({ timeout: 500 });
    }).toPass();
    await item.click();
    await expect(input).toBeHidden();
    step(`theme: ${name}`);
  };
  const fits = async (label) => {
    const over = await form.evaluate((el) => el.scrollWidth - el.clientWidth);
    if (over > 0) throw new Error(`${label}: the card runs ${over}px past its edge`);
    const card = await form.boundingBox();
    for (const link of await form.locator("a.cv-link").all()) {
      const b = await link.boundingBox();
      if (b.x < card.x - 1 || b.x + b.width > card.x + card.width + 1) throw new Error(`${label}: a link sits outside the card`);
    }
  };

  step("open gpu/shop's chat: Claude asks 2 questions, with long addresses");
  await page.locator('[data-testid=worktree-row][data-worktree="gpu/shop"]').click({ position: { x: 32, y: 12 } });
  await expect(form).toContainText("Claude asks you 2 questions");
  const links = form.locator("a.cv-link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", LINK_URL);
  await expect(links.nth(0)).toHaveText(LINK_URL);
  await expect(links.nth(1)).toHaveAttribute("href", OPTION_URL);
  await expect(links.nth(1)).toHaveText(OPTION_URL);
  step(`question link href is the whole address (${LINK_URL.length} chars), the option's too (${OPTION_URL.length} chars)`);
  await fits("1440 dark");
  await form.scrollIntoViewIfNeeded();
  await shot("desktop-dark");
  await theme("Shipyard Light");
  await fits("1440 light");
  await shot("desktop-light");
  await theme("Shipyard Dark");

  step("click the link in Approved's description");
  const approved = form.getByRole("radio", { name: /^Approved/ });
  const optionLink = form.getByRole("link", { name: OPTION_URL });
  await optionLink.click();
  await expect.poll(opened).toEqual([OPTION_URL]);
  await expect(approved).not.toBeChecked();
  step(`opened ${OPTION_URL.slice(0, 60)}… in full; Approved is not picked`);
  step("Enter on the focused link");
  await optionLink.focus();
  await page.keyboard.press("Enter");
  await expect.poll(opened).toEqual([OPTION_URL, OPTION_URL]);
  await expect(approved).not.toBeChecked();
  step("opened again; still nothing picked");
  step("click the question's own link");
  await form.getByRole("link", { name: LINK_URL, exact: true }).click();
  await expect.poll(opened).toEqual([OPTION_URL, OPTION_URL, LINK_URL]);
  step("click Approved's label: it is picked");
  await form.getByText("Approved", { exact: true }).click();
  await expect(approved).toBeChecked();
  await shot("picked-after-links");

  step("at a phone's width (390x844), the sidebar hidden");
  await page.getByRole("button", { name: "Hide the sidebar" }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(links.nth(0)).toBeVisible();
  await fits("390 dark");
  await form.scrollIntoViewIfNeeded();
  await shot("phone-dark");
  await theme("Shipyard Light");
  await fits("390 light");
  await shot("phone-light");
  await theme("Shipyard Dark");

  step("step 2: the address the box cut short shows, with no link");
  await form.getByRole("button", { name: /^Next$/ }).last().click();
  await expect(form).toContainText("2 of 2");
  const no = form.getByRole("radio", { name: /^No/ }).locator("xpath=ancestor::label[1]");
  await expect(no).toContainText("project=acme-shop&…");
  await expect(no.locator("a")).toHaveCount(0);
  await fits("390 step 2");
  await form.scrollIntoViewIfNeeded();
  await shot("phone-cut-short");

  step("the review shows the first question whole");
  await form.getByRole("radio", { name: /^Yes/ }).click();
  await form.getByRole("button", { name: /^Review$/ }).last().click();
  await expect(form).toContainText("Review your answers");
  await expect(form.getByRole("button", { name: /Approve the app/ })).toContainText(LINK_URL);
  await fits("390 review");
  await form.scrollIntoViewIfNeeded();
  await shot("phone-review");
}
