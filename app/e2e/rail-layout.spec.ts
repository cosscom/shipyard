import { expect, mockOnly, test } from "./fixtures";

// Labs › Layout › Icon rail (components/rail-layout): a rail of projects
// whose peeks list their worktrees and agents, and a title bar whose
// breadcrumb (Project / Worktree / Agent) switches at every step.

const RAIL = { prefs: { labs: true, labsChosen: true, layout: "rail" } };

test("the rail peeks at a project's worktrees by state, and a click goes there", async ({ app }) => {
  mockOnly();
  await app.open(RAIL);
  const { page } = app;
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  const rail = page.getByTestId("project-rail");
  await expect(rail).toBeVisible();

  // shop's mark says two agents need you and one works, without a word.
  const shop = rail.locator('[data-testid=rail-project][data-project="shop"]');
  await expect(shop).toHaveAccessibleName(/shop, 2 need you, 1 working/);

  // Pointing at it peeks: its worktrees by what they need, needs-you first.
  await shop.hover();
  const peek = page.getByTestId("rail-peek");
  await expect(peek).toBeVisible();
  const lanes = await peek.getByTestId("rail-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-lane")));
  expect(lanes).toEqual(["waiting", "running", "finished", "quiet"]);
  const fix = peek.locator('[data-testid=rail-wt][data-worktree="devl/checkout-fix"]');
  await expect(fix).toContainText("Fix checkout webhook retries");
  await expect(fix).toContainText("pnpm prisma migrate dev");

  // One click: the worktree opens with its agent in front, and the
  // breadcrumb and the rail say where you are.
  await fix.click();
  await expect(peek).toBeHidden();
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Fix checkout webhook retries/);
  await expect(page.getByTestId("crumb-project")).toContainText("shop");
  await expect(page.getByTestId("crumb-worktree")).toContainText("checkout-fix");
  // shop is on two boxes, so the box shows.
  await expect(page.getByTestId("crumb-worktree")).toContainText("devl");
  // One agent: its name is on its tab, so the breadcrumb stops at the worktree.
  await expect(page.getByTestId("crumb-agent")).toHaveCount(0);
  await expect(shop).toHaveAttribute("aria-current", "true");

  // A dot per agent at work, the ones that need you first.
  const pips = await shop.getByTestId("rail-pips").locator("[data-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(pips.slice(0, 3)).toEqual(["waiting", "waiting", "running"]);

  // A click on a mark goes to the project, where its agent works; so does ⌃n.
  await page.mouse.move(700, 500);
  await rail.locator('[data-testid=rail-project][data-project="evals"]').click();
  await expect(page.getByTestId("crumb-worktree")).toContainText("judge-v2");
  await page.keyboard.press("Control+3");
  await expect(page.getByTestId("crumb-project")).toContainText("shop");

  // A box that is away is said at the rail's foot.
  await expect(rail.getByTestId("rail-away")).toHaveAccessibleName(/old-vps is offline/);
});

test("the breadcrumb switches worktree, agent and project", async ({ app }) => {
  mockOnly();
  await app.open(RAIL);
  const { page } = app;

  // From Home, the first crumb lists the projects: evals opens where its
  // agent works.
  await expect(page.getByTestId("crumb-project")).toContainText("Home");
  await page.getByTestId("crumb-project").click();
  await page.locator('[data-testid=crumb-project-item][data-project="evals"]').click();
  await expect(page.getByTestId("crumb-worktree")).toContainText("judge-v2");
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Tune the judge prompt/);

  // Back to shop, then across its worktrees by the worktree crumb.
  await page.getByTestId("crumb-project").click();
  await page.locator('[data-testid=crumb-project-item][data-project="shop"]').click();
  await expect(page.getByTestId("crumb-project")).toContainText("shop");
  await page.getByTestId("crumb-worktree").click();
  await page.getByRole("menu").locator('[data-testid=rail-wt][data-worktree="devl/qa-deck"]').click();
  await expect(page.getByTestId("crumb-worktree")).toContainText("qa-deck");
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Build the QA deck/);

  // A worktree with several agents: the agent crumb goes between them.
  await page.getByTestId("crumb-worktree").click();
  await page.getByRole("menu").locator('[data-testid=rail-wt][data-worktree="devl/order-export"]').click();
  await expect(page.getByTestId("crumb-worktree")).toContainText("order-export");
  await page.getByTestId("crumb-agent").click();
  await page.getByTestId("crumb-agent-item").filter({ hasText: "Add tests for the export job" }).click();
  await expect(page.getByTestId("crumb-agent")).toContainText("Add tests for the export job");
  await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName(/Add tests for the export job/);
});

test("needs you goes round the agents that wait, and new work starts from the title bar or a peek", async ({ app }) => {
  mockOnly();
  await app.open(RAIL);
  const { page } = app;

  const needs = page.getByTestId("title-needs-you");
  await expect(needs).toContainText("2 need you");
  const tab = page.locator("[role=tab][aria-selected=true]");
  await needs.click();
  await expect(tab).toHaveAccessibleName(/Plan the checkout release|Fix checkout webhook retries/);
  const plan = /Plan the checkout release/.test((await tab.textContent()) ?? "");
  await needs.click();
  await expect(tab).toHaveAccessibleName(plan ? /Fix checkout webhook retries/ : /Plan the checkout release/);

  // New task from the title bar opens the composer.
  await page.getByTestId("title-new-task").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // From a project's peek, the composer starts in that project, and the
  // new task opens.
  await page.locator('[data-testid=rail-project][data-project="notes"]').hover();
  await page.getByTestId("rail-peek").getByTestId("rail-new-task").click();
  const composer = page.getByRole("dialog");
  await expect(composer).toContainText("notes");
  await composer.getByRole("textbox").first().fill("say hello");
  await composer.getByRole("button", { name: /^Start/ }).click();
  await expect(composer).toBeHidden();
  await expect(page.getByTestId("crumb-project")).toContainText("notes");
});

test("Settings is at the rail's foot, and Labs puts the sidebar back", async ({ app }) => {
  mockOnly();
  const body = await (async () => {
    await app.open(RAIL);
    return app.openSettings("labs");
  })();
  const { page } = app;
  await expect(page.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("crumb-project")).toContainText("Settings");
  await body.getByRole("button", { name: "Sidebar", exact: true }).click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("project-rail")).toHaveCount(0);
  await expect(page.getByTestId("title-bar")).toHaveCount(0);
  expect(((await app.stored("berth.prefs")) as { layout?: string }).layout).toBe("sidebar");
});
