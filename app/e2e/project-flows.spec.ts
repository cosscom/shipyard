import { expect, mockOnly, test } from "./fixtures";

// Project settings lists a project's flows, a kit's among them. A kit flow
// can use a run step kind (pr, loop, gate, …) the flow editor doesn't edit:
// it shows with a plain icon, and the page doesn't throw (the fixture fails
// the test if it does).

test.beforeEach(() => mockOnly("devl's shop kit is a mock fixture"));

test("a kit flow with a run step shows in Project settings", async ({ app }) => {
  const { page } = app;
  await app.open();
  const shop = page.locator("button[aria-expanded][draggable]").filter({ has: page.getByText("shop", { exact: true }) });
  await shop.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Project settings/ }).click();
  await page.getByRole("menuitem", { name: "devl", exact: true }).locator("visible=true").last().click();
  const flows = page.locator("section#flows");
  await expect(flows.getByText("Open a PR when the checks pass")).toBeVisible();
  await expect(flows.getByText("Lint what changed after every Claude turn")).toBeVisible();
});

// A flow whose runs-per-hour limit refused starts says so in the list and
// the editor, and an every-minute schedule over the default limit of 20 is
// warned about next to the limit, which changes as the limit is typed.
test("a flow over its runs-per-hour limit shows what it refused and why", async ({ app }) => {
  const { page } = app;
  await app.open();
  await page.getByTestId("nav-automations").click();
  const row = page.getByRole("button").filter({ hasText: "Sweep stale previews every minute" });
  await expect(row.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 7 refused in the last hour");
  // A flow the limit never refused has no badge.
  await expect(page.getByRole("button").filter({ hasText: "Post to Slack when setup fails" }).getByTestId("flow-limit-badge")).toHaveCount(0);

  await row.click();
  await expect(page.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 7 refused in the last hour");
  const warning = page.getByTestId("flow-rate-warning");
  await expect(warning).toHaveText("This schedule fires up to 60 times an hour; the limit is 20, so about 40 starts an hour will be refused.");
  const limit = page.getByPlaceholder("20 (default)");
  await limit.fill("45");
  await expect(warning).toHaveText("This schedule fires up to 60 times an hour; the limit is 45, so about 15 starts an hour will be refused.");
  await limit.fill("60");
  await expect(warning).toHaveCount(0);
});
