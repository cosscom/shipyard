import { expect, mockOnly, test } from "./fixtures";

// Long web addresses in an agent's questions (?scene=question-links, made
// up): they wrap inside the card, link to the whole address, and a link in
// an option opens without picking it. One the box cut short isn't linked.

const LINK_URL = "https://shop.example.com/admin/oauth/authorize?client_id=0000example0000example&scope=read_products,write_products,read_orders&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&state=mock-state-1234567890abcdef";
const OPTION_URL = `${LINK_URL}&grant_options%5B%5D=per-user`;

const opened = (app: { page: import("@playwright/test").Page }) => app.page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test.beforeEach(async ({ app }) => {
  mockOnly("answers a question on a box");
  await app.page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (url?: string | URL) => {
      w.__opened.push(String(url));
      return null;
    };
  });
});

for (const width of [1440, 390]) {
  test(`at ${width}px a long address wraps inside the card, linked whole`, async ({ app }) => {
    await app.open({ params: { view: "conversation", scene: "question-links" } });
    await app.openWorktree("gpu/shop");
    // A phone's width has room for the chat alone.
    if (width < 800) await app.page.getByRole("button", { name: "Hide the sidebar" }).first().click();
    await app.page.setViewportSize({ width, height: 900 });
    const form = app.chat.getByTestId("question-form");
    await expect(form).toContainText("Claude asks you 2 questions");
    const links = form.locator("a.cv-link");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute("href", LINK_URL);
    await expect(links.nth(0)).toHaveText(LINK_URL);
    await expect(links.nth(1)).toHaveAttribute("href", OPTION_URL);
    // Nothing runs past the card: it wraps, over several lines.
    expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const card = (await form.boundingBox())!;
    for (const link of [links.nth(0), links.nth(1)]) {
      const b = (await link.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(card.x);
      expect(b.x + b.width).toBeLessThanOrEqual(card.x + card.width + 1);
      expect(await link.evaluate((el) => el.getClientRects().length)).toBeGreaterThan(1);
    }
    if (process.env.BERTH_SHOTS) await form.screenshot({ path: `${process.env.BERTH_SHOTS}/question-links-${width}.png` });
  });
}

test("a link in an option opens it and leaves the pick alone, by mouse and by keyboard", async ({ app }) => {
  await app.open({ params: { view: "conversation", scene: "question-links" } });
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  const approved = form.getByRole("radio", { name: /^Approved/ });
  const link = form.getByRole("link", { name: OPTION_URL });
  await expect(approved).not.toBeChecked();

  await link.click();
  await expect.poll(() => opened(app)).toEqual([OPTION_URL]);
  await expect(approved).not.toBeChecked();

  await link.focus();
  await app.page.keyboard.press("Enter");
  await expect.poll(() => opened(app)).toEqual([OPTION_URL, OPTION_URL]);
  await expect(approved).not.toBeChecked();
  await expect(link).toBeFocused();
  // The radio group's arrow keys don't reach in and pick either.
  await app.page.keyboard.press("ArrowDown");
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(0);

  // The question's own link opens too; the rest of the row still picks.
  await form.getByRole("link", { name: LINK_URL, exact: true }).click();
  await expect.poll(() => opened(app)).toEqual([OPTION_URL, OPTION_URL, LINK_URL]);
  await form.getByText("Approved", { exact: true }).click();
  await expect(approved).toBeChecked();
});

test("an address the box cut short shows, wrapped, with no link", async ({ app }) => {
  await app.open({ params: { view: "conversation", scene: "question-links" } });
  await app.openWorktree("gpu/shop");
  const form = app.chat.getByTestId("question-form");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();
  await form.getByRole("radio", { name: /^It failed/ }).click();
  await next.click();
  await expect(form).toContainText("2 of 2");
  const no = form.getByRole("radio", { name: /^No/ }).locator("xpath=ancestor::label[1]");
  await expect(no).toContainText("https://logs.example.com/explorer?query=");
  await expect(no).toContainText("project=acme-shop&…");
  await expect(no.locator("a")).toHaveCount(0);
  expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // The review shows the whole question, address and all, wrapped.
  await form.getByRole("radio", { name: /^Yes/ }).click();
  await next.click();
  await expect(form).toContainText("Review your answers");
  await expect(form.getByRole("button", { name: /Approve the app/ })).toContainText(LINK_URL);
  expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
