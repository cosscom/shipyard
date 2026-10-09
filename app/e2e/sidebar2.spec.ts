import { expect, mockOnly, test } from "./fixtures";

// Labs › Sidebar › Agents first (components/sidebar2): agents by what they
// need from you, rows that say what each is doing, recent work, projects
// folded below, and the places in one bar at the bottom.

const prefs = { labs: true, labsChosen: true, layout: "sidebar2" };

test("agents first: what needs you comes first, in words, and a click goes to the agent", async ({ app }) => {
  mockOnly();
  await app.open({ prefs });
  const page = app.page;
  const side = page.locator("[data-layout=sidebar2]");
  await expect(side).toBeVisible();

  // Sections in order of what they ask of you.
  await expect.poll(() => side.getByTestId("s2-section").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")).slice(0, 3))).toEqual(["waiting", "running", "recent"]);

  // A waiting agent says what it wants.
  const waiting = side.locator('[data-testid=s2-agent][data-session="devl/checkout-fix-claude"]');
  await expect(waiting).toHaveAttribute("data-agent-state", "waiting");
  // Named by its worktree, as the tree names it; its task is in its name for a screen reader and in its card.
  await expect(waiting).toContainText("checkout-fix");
  await expect(waiting).toHaveAccessibleName(/Fix checkout webhook retries/);
  await expect(waiting).toContainText("Wants to run");
  await expect(waiting).toContainText("pnpm prisma migrate dev");
  // Only agents count as needing you; Review says its own count.
  await expect(side.locator("[data-section=waiting]").getByRole("button", { name: /^Needs you/ })).toContainText("2");
  await expect(side.getByTestId("nav-review")).toHaveAccessibleName(/Review, \d+ to review/);
  // A permission is answered right in the row.
  await expect(side.locator("li", { has: page.locator('[data-session="devl/checkout-fix-claude"]') }).getByRole("button", { name: /Allow once/ })).toBeVisible();

  // A click opens it, with its tab in front.
  await waiting.click();
  await expect(waiting).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Fix checkout webhook retries/);
});

test("agents first: a project unfolds to its worktrees, by box, and one opens", async ({ app }) => {
  mockOnly();
  await app.open({ prefs });
  const side = app.page.locator("[data-layout=sidebar2]");
  const shop = side.locator("[data-testid=s2-project][data-project=shop]");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-expanded", "true");
  // A child sits under its parent; quiet worktrees wait behind one row.
  const row = side.locator('[data-testid=s2-worktree][data-worktree="devl/qa-deck"]');
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(app.page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Build the QA deck/);
  // Its agent's row, above, is the one marked strongly; the tree's row faintly.
  await expect(side.locator('[data-testid=s2-agent][data-session="devl/qa-deck-codex"]')).toHaveAttribute("data-selected", "strong");
  await expect(row).toHaveAttribute("data-selected", "faint");
  await expect(side.locator('[data-testid=s2-worktree][data-worktree="devl/https-linear-app-acme"]')).toBeVisible();
});

test("agents first: New task starts work, and it shows up as working", async ({ app }) => {
  mockOnly("starts an agent");
  await app.open({ prefs });
  const page = app.page;
  await page.getByTestId("s2-new-task").click();
  const composer = page.getByRole("dialog").getByTestId("task-composer");
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox").first().fill("Tidy the export job logs");
  await composer.getByRole("button", { name: "Start" }).click();
  await expect(app.panes.first()).toBeVisible();
  const row = page.locator("[data-layout=sidebar2] [data-section=running] [data-testid=s2-agent]", { hasText: "Tidy the export job logs" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-agent-state", "running");
});

test("agents first: the filter narrows every list to one project", async ({ app }) => {
  mockOnly();
  await app.open({ prefs });
  const page = app.page;
  const side = page.locator("[data-layout=sidebar2]");
  await side.getByTestId("s2-scope").click();
  await page.getByRole("menuitemradio", { name: "evals" }).click();
  await page.keyboard.press("Escape");
  await expect(side.getByTestId("s2-scope")).toContainText("evals");
  await expect(side.locator("[data-testid=s2-agent]")).toHaveCount(1);
  await expect(side.locator('[data-testid=s2-agent][data-session="gpu/judge-v2-claude"]')).toBeVisible();
  await expect(side.getByTestId("s2-project")).toHaveCount(1);
  await side.getByRole("button", { name: "Show everything" }).click();
  await expect(side.getByTestId("s2-scope")).toHaveAccessibleName("Show one project or box");
  await expect(side.locator("[data-testid=s2-agent][data-agent-state=waiting]")).toHaveCount(2);
});

test("agents first: Settings is in the bottom bar, and Labs switches back to the classic sidebar", async ({ app }) => {
  mockOnly();
  await app.open({ prefs });
  const page = app.page;
  const labs = await app.openSettings("labs");
  await expect(page.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
  await labs.getByRole("button", { name: "Classic" }).click();
  await expect(page.locator("[data-layout=sidebar2]")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { layout: string }).layout).toBe("default");
});
