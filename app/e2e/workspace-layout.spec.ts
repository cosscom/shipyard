import { expect, mockOnly, test } from "./fixtures";

// The workspace layout (Labs › Layout › Workspaces): no sidebar; named
// workspaces of agent panes across the top, every other agent in the strip
// along the bottom.

test.beforeEach(async ({ app }) => {
  mockOnly();
  await app.open({ params: { layout: "workspace", view: "conversation" } });
});

// Panes are in the DOM by id, not where they show: find one by its place.
const paneAt = (app: { panes: import("@playwright/test").Locator; page: import("@playwright/test").Page }, place: string) => app.panes.filter({ has: app.page.getByTestId("pane-place").filter({ hasText: place }) });

const chip = (app: { page: import("@playwright/test").Page }, session: string) => app.page.locator(`[data-deck-strip] [data-testid=strip-agent][data-session="${session}"]`);

test("two agents side by side: focus moves between them, and one zooms to fill the workspace", async ({ app }) => {
  const { page } = app;
  await expect(page.getByText("Main is empty")).toBeVisible();
  // What needs you leads the strip.
  await expect(page.locator("[data-deck-strip] [data-testid=strip-agent]").first()).toHaveAttribute("data-state", "waiting");

  await chip(app, "devl/checkout-fix-claude").click();
  await expect(app.panes).toHaveCount(1);
  await chip(app, "gpu/judge-v2-claude").click();
  await expect(app.panes).toHaveCount(2);
  // Side by side, each naming its worktree and box.
  const left = paneAt(app, "checkout-fix");
  const right = paneAt(app, "judge-v2");
  const [a, b] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(b!.x - a!.x).toBeGreaterThan(400);
  // The one that needs you says so.
  await expect(left.locator("[data-needs-you]")).toBeVisible();
  await expect(right.locator("[data-needs-you]")).toHaveCount(0);
  // On screen, they leave the strip; the workspace's tab counts who needs you.
  await expect(chip(app, "devl/checkout-fix-claude")).toHaveCount(0);
  await expect(page.locator("[data-deck='Main'] [aria-label='1 needs you']")).toBeVisible();

  // The new one has the keyboard; ⌘⌥← moves it to the left pane.
  await expect(right).toHaveAttribute("data-pane-focused", "");
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await expect(left).toHaveAttribute("data-pane-focused", "");

  // ⌘⇧↵ zooms the focused pane; the other waits in the strip, behind it.
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(app.panes).toHaveCount(1);
  await expect(app.panes.first()).toHaveAttribute("data-zoomed", "");
  await expect(app.panes.first().getByTestId("pane-place")).toContainText("checkout-fix");
  await expect(chip(app, "gpu/judge-v2-claude")).toBeVisible();
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(app.panes).toHaveCount(2);

  // Grid and back: the same two panes, rearranged, nothing reloaded.
  await page.getByRole("radio", { name: "Grid" }).or(page.getByRole("button", { name: "Grid" })).first().click();
  await expect(app.panes).toHaveCount(2);
});

test("a worktree opens from the strip or ⌘E, beside the others or in the focused pane's place", async ({ app }) => {
  const { page } = app;
  await chip(app, "gpu/shop-claude").click();
  await expect(app.panes).toHaveCount(1);
  await expect(app.panes.first().getByTestId("pane-place")).toContainText("shop");
  // ⌥-click: in the focused pane's place, which goes back to the strip.
  await chip(app, "devl/qa-deck-codex").click({ modifiers: ["Alt"] });
  await expect(app.panes).toHaveCount(1);
  await expect(app.panes.first().getByTestId("pane-place")).toContainText("qa-deck");
  await expect(chip(app, "gpu/shop-claude")).toBeVisible();

  // ⌘E: every agent and worktree, to type into.
  await page.keyboard.press("Meta+e");
  const dialog = page.getByRole("dialog", { name: "Open an agent or worktree" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").or(dialog.getByRole("textbox")).first().fill("search-perf");
  await dialog.getByRole("option", { name: /search-perf/ }).first().click();
  await expect(dialog).toBeHidden();
  await expect(app.panes).toHaveCount(2);
  await expect(paneAt(app, "search-perf")).toBeVisible();
  await expect(paneAt(app, "qa-deck")).toBeVisible();

  // The strip's label opens every box, project and worktree, offline boxes too.
  await page.getByTestId("deck-tray").click();
  const tray = page.getByTestId("deck-tray-panel");
  await expect(tray).toContainText("old-vps");
  await tray.getByRole("button", { name: /Tune the judge prompt/ }).click();
  await expect(tray).toBeHidden();
  await expect(app.panes).toHaveCount(3);
  await expect(paneAt(app, "judge-v2")).toBeVisible();
});

test("a new task lands in a new pane, another workspace starts empty, and Settings is a click away", async ({ app }) => {
  const { page } = app;
  await chip(app, "devl/search-perf-claude").click();
  await expect(app.panes).toHaveCount(1);

  await page.locator("[data-deck-bar]").getByRole("button", { name: /New task/ }).click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("textbox").first().fill("say hello");
  await composer.getByRole("button", { name: /^Start/ }).click();
  await expect(composer).toBeHidden();
  // Beside the agent already there, not instead of it.
  await expect(app.panes).toHaveCount(2);

  // A second workspace starts empty; ⌘1 comes back to the first, as it was.
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page.getByText("Workspace 2 is empty")).toBeVisible();
  await expect(page.getByTestId("deck-how")).toContainText("finds any agent or worktree");
  await expect(app.panes).toHaveCount(0);
  await page.keyboard.press("Meta+1");
  await expect(app.panes).toHaveCount(2);

  // Settings, and back to the workspace.
  const labs = await app.openSettings("labs");
  await expect(labs.getByRole("radio", { name: "Workspaces" }).or(labs.getByRole("button", { name: "Workspaces" })).first()).toBeVisible();
  await page.locator("[data-deck-bar]").getByRole("button", { name: "Close" }).click();
  await expect(app.panes).toHaveCount(2);
});
