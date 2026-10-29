import { expect, mockOnly, test } from "./fixtures";

// A full-page view's content starts on its header's gutter (px-page, the
// grid in index.css), so the view's name and what's under it line up.

// lined says whether the left of the view's title and of the first thing
// under its header that `content` picks, in the page (<main>): beside the
// sidebar the header sits in the window's band above the page's card.
async function lined(page: import("@playwright/test").Page, title: string, content: string) {
  return page.evaluate(
    ({ title, content }) => {
      const h1 = [...document.querySelectorAll("header h1")].find((h) => h.textContent === title);
      const el = document.querySelector("main")?.querySelector(content);
      if (!h1 || !el) return false;
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
      return Math.round(h1.getBoundingClientRect().left) === Math.round(el.getBoundingClientRect().left + pad);
    },
    { title, content },
  );
}

test("the Agent Dashboard's columns start under its title", async ({ app }) => {
  mockOnly();
  // Without Labs, the first place is the Agent Dashboard itself.
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  await app.page.getByTestId("nav-home").click();
  await expect.poll(() => lined(app.page, "Agent Dashboard", "section[aria-label]")).toBe(true);
});

test("the Worktrees view's filters start under its title", async ({ app }) => {
  mockOnly();
  await app.open();
  await app.page.getByTestId("nav-worktrees").click();
  await expect.poll(() => lined(app.page, "Worktrees", "[class*='@container/toolbar'] > :first-child")).toBe(true);
});

test("Kits' cards start under its title, and a row of them ends on one line", async ({ app }) => {
  mockOnly();
  await app.open();
  await app.page.getByTestId("nav-more").click();
  await app.page.getByRole("menuitem", { name: /Kits/ }).click();
  const cards = app.page.locator("[data-slot=card]");
  await expect(cards.nth(1)).toBeVisible();
  await expect.poll(() => lined(app.page, "Kits", "[data-slot=card]")).toBe(true);
  // Side by side, the two are one height, so their footers line up.
  const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(Math.round(a!.y)).toBe(Math.round(b!.y));
  expect(Math.round(a!.height)).toBe(Math.round(b!.height));
});

test("Review's work starts under its title", async ({ app }) => {
  mockOnly();
  await app.open();
  await app.page.getByTestId("nav-review").click();
  // A row's content (its padding in from its highlight) is on the gutter.
  await expect.poll(() => lined(app.page, "Review", "ul[aria-label='Work to review'] li button")).toBe(true);
});
