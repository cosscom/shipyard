
import { type App, expect } from "./fixtures";

// The app's screens and states, as the accessibility checks (a11y.spec.ts)
// visit them: each scene opens the app on the mock fixtures and gets one
// surface showing. Stable hooks only (data-testid, roles), as elsewhere.

export interface Scene {
  id: string;
  // The checks that need the whole app on screen; contrast runs these in
  // every built-in theme.
  key?: boolean;
  // Another state of a screen another scene already checks: run only with
  // A11Y_FULL=1, to keep CI quick.
  extra?: boolean;
  run(app: App, theme: string): Promise<void>;
}

const chat = async (app: App, theme: string, wt: string, params: Record<string, string> = {}) => {
  await app.open({ theme, params: { view: "conversation", ...params } });
  await app.openWorktree(wt);
  await expect(app.chat).toBeVisible();
};

export async function openBrowser(app: App) {
  await app.openWorktree("devl/checkout-fix");
  await app.page.getByRole("button", { name: "New tab" }).click();
  await app.page.getByRole("option", { name: /New browser tab/ }).click();
  const pane = app.page.locator("[data-testid=browser-pane]:visible");
  const address = pane.getByRole("textbox", { name: "Address" });
  await address.fill("http://checkout-fix.shop.devl.localhost:1377/cart");
  await address.press("Enter");
  await expect(pane.frameLocator("iframe").locator("h1")).toBeVisible();
  return pane;
}

const CART = `<!doctype html><html lang="en"><title>Cart</title><body><h1>Cart</h1><script>console.error("checkout failed: 500");</script></body></html>`;

// Artifacts and visual diffs (components/art): the search-perf agent's,
// in its chat (lib/art/mock-artifacts.ts, lib/art/mock-vdiff.ts).
const P95 = "d2e8f1a0b3";
const VD = "46ab3c4e1b";
const CLEAR = "39fdf22244";
const artCard = (app: App, id: string) => app.page.locator(`[data-testid=pane]:visible [data-art-card="${id}"]`).first();
const artPane = (app: App) => app.page.locator("[data-testid=pane][data-pane-kind=artifact]:visible");

// reachCard scrolls the chat up, as a person would, until the card is drawn.
async function reachCard(app: App, id: string) {
  const c = artCard(app, id);
  // Drawn already near the end of the chat (the p95 chart), or further up.
  await c.waitFor({ state: "attached", timeout: 3000 }).catch(() => {});
  const box = await app.chat.boundingBox();
  if (box) await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60 && (await c.count()) === 0; i++) {
    await app.page.mouse.wheel(0, -600);
    await app.page.waitForTimeout(60);
  }
  await c.scrollIntoViewIfNeeded();
  return c;
}

async function openArt(app: App, theme: string, id: string) {
  await chat(app, theme, "devl/search-perf");
  const c = await reachCard(app, id);
  await c.getByRole("button", { name: "Open", exact: true }).click();
  return artPane(app);
}

// atRest takes the pointer off the board's tiles: a chart under it shows
// that segment and dims the rest (bklit's hover), which isn't how it rests.
async function atRest(app: App) {
  await app.page.mouse.move(1, 1);
  // And its thumbnails done drawing.
  await app.page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
}

// fromBoard opens one of search-perf's artifacts from its board.
async function fromBoard(app: App, theme: string, id: string) {
  await chat(app, theme, "devl/search-perf");
  await app.page.getByTestId("art-chip").click();
  await app.page.locator(`[data-art-tile="${id}"]`).getByRole("button", { name: /^Open .*/ }).last().click();
  return app.page.locator(`[data-testid=artifact-pane][data-art-id="${id}"]:visible`);
}

const settings = (section: string): Scene => ({
  id: `settings-${section}`,
  key: section === "appearance" || section === "general",
  async run(app, theme) {
    await app.open({ theme });
    const body = await app.openSettings(section);
    // Plugins reads its lists after the page: wait for the listing's rows.
    if (section === "plugins") await expect(body.getByTestId("market-plugin").first()).toBeVisible();
  },
});

export const scenes: Scene[] = [
  {
    id: "home",
    key: true,
    async run(app, theme) {
      await app.open({ theme });
    },
  },
  {
    id: "palette",
    key: true,
    async run(app, theme) {
      await app.open({ theme });
      await app.page.keyboard.press("Meta+k");
      await expect(app.page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    // What's new (components/whats-new), its first and its key-hint slide.
    id: "whats-new",
    key: true,
    async run(app, theme) {
      await app.open({ theme });
      await app.openSettings("about");
      await app.page.getByTestId("about-whats-new").click();
      await expect(app.page.getByTestId("whats-new")).toBeVisible();
      await app.page.keyboard.press("ArrowRight");
      await app.page.keyboard.press("ArrowRight");
      await expect(app.page.getByRole("tab", { name: "Console and network" })).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    id: "whats-new-nudge",
    async run(app, theme) {
      await app.open({ theme, prefs: { whatsNewSeen: "0.3.9", version: 3 }, params: { version: "0.3.10" } });
      await expect(app.page.getByTestId("whats-new-nudge")).toBeVisible();
    },
  },
  {
    id: "shortcuts-sheet",
    async run(app, theme) {
      await app.open({ theme });
      await app.page.keyboard.press("Meta+Slash");
      await expect(app.page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    id: "notifications",
    async run(app, theme) {
      await app.open({ theme });
      await app.page.keyboard.press("Meta+Shift+n");
      await expect(app.page.getByRole("dialog").or(app.page.getByTestId("notification-center"))).toBeVisible();
    },
  },
  {
    id: "chat-permission-tasks",
    key: true,
    async run(app, theme) {
      await chat(app, theme, "devl/checkout-fix");
    },
  },
  {
    id: "chat-question",
    extra: true,
    async run(app, theme) {
      await chat(app, theme, "gpu/shop");
      await expect(app.chat.getByTestId("question-form")).toBeVisible();
    },
  },
  {
    id: "chat-crew",
    async run(app, theme) {
      await chat(app, theme, "gpu/judge-v2");
    },
  },
  {
    id: "chat-agent-messages",
    async run(app, theme) {
      await chat(app, theme, "gpu/ci-flake");
    },
  },
  {
    id: "terminal",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await expect(app.panes.first()).toBeVisible();
    },
  },
  {
    id: "browser-devtools",
    async run(app, theme) {
      await app.context.route(/^https?:\/\/[^/]+\.localhost:1377(?:\/|$)/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: CART }));
      await app.open({ theme });
      const pane = await openBrowser(app);
      await app.page.keyboard.press("Meta+Alt+KeyI");
      await expect(pane.getByTestId("devtools-drawer")).toBeVisible();
    },
  },
  {
    id: "preview",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.getByRole("button", { name: "New tab" }).click();
      await app.page.getByRole("option", { name: /^Preview/ }).click();
      await expect(app.page.locator("[data-testid=preview-pane]:visible")).toBeVisible();
    },
  },
  {
    id: "compare",
    async run(app, theme) {
      await chat(app, theme, "devl/checkout-fix");
      await app.page.keyboard.press("Meta+Alt+KeyC");
      const input = app.page.getByPlaceholder("Compare checkout-fix with…");
      await input.fill("search-perf");
      await input.press("Enter");
      await expect(app.page.getByRole("toolbar", { name: /^Compare / })).toBeVisible();
    },
  },
  {
    id: "file-picker",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.keyboard.press("Meta+p");
      await expect(app.page.getByTestId("file-picker")).toBeVisible();
    },
  },
  {
    id: "file-tab",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.keyboard.press("Meta+p");
      await expect(app.page.getByTestId("file-picker")).toBeVisible();
      await app.page.keyboard.press("Enter");
      await expect(app.page.getByTestId("file-crumbs")).toBeVisible();
    },
  },
  {
    id: "files-panel",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.keyboard.press("Meta+Shift+E");
      await expect(app.page.getByTestId("files-panel")).toBeVisible();
    },
  },
  {
    id: "review",
    key: true,
    async run(app, theme) {
      await app.open({ theme });
      await app.page.getByTestId("nav-review").click();
      await expect(app.page.getByTestId("nav-review")).toHaveAttribute("data-active", "true");
    },
  },
  {
    // Review's Compare after a rerun of the judge whose reply wasn't valid:
    // the fallback, Retry and the earlier evaluation.
    id: "review-compare-rejudged",
    extra: true,
    async run(app, theme) {
      await app.open({ theme });
      await app.page.getByTestId("nav-review").click();
      await app.page.getByRole("button", { name: /refunds: 3 attempts · pick one/ }).click();
      const judge = app.page.getByRole("region", { name: "Judge on devl" });
      await judge.getByRole("button", { name: "Rerun judge" }).click();
      await expect(judge).toHaveAttribute("data-evaluation", "fallback", { timeout: 15_000 });
      await judge.getByRole("button", { name: "Earlier evaluations (1)" }).click();
      await expect(judge.getByRole("list", { name: "Earlier evaluations" })).toBeVisible();
    },
  },
  {
    id: "first-run",
    async run(app, theme) {
      await app.open({ theme, params: { fresh: "1" } }).catch(() => {});
      await expect(app.page.locator("body")).toBeVisible();
    },
  },
  {
    id: "team-page",
    async run(app, theme) {
      await app.open({ theme, params: { team: "acme", "team-link": "acme" } });
      await expect(app.page.getByTestId("team-page")).toContainText("Published by Acme");
    },
  },
  {
    // Home with a team suggestion's card, and the project's quiet mark
    // (lib/team-suggest.ts).
    id: "team-suggestion",
    extra: true,
    async run(app, theme) {
      await app.open({ theme, params: { teamsuggest: "1" } });
      await expect(app.page.getByTestId("team-suggest-card")).toBeVisible();
      await expect(app.page.getByTestId("team-suggest-mark")).toBeVisible();
    },
  },
  {
    // Just the kit's sheet (views/team/team-kit-sheet.tsx): what the kit
    // needs on the box, and the keys and init left unticked.
    id: "team-kit-sheet",
    extra: true,
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme, params: { teamsuggest: "1" } });
      await page.getByTestId("team-suggest-mark").locator("xpath=ancestor::button[1]").click({ button: "right" });
      await page.getByRole("menuitem", { name: /kit for this project/ }).click();
      await expect(page.getByTestId("team-kit-requires")).toBeVisible();
    },
  },
  {
    // A PR review link's sheet (views/pr-review), with setup files changed.
    id: "pr-review-sheet",
    async run(app, theme) {
      await app.open({ theme, params: { "review-link": "berth://review?repo=acme/shop&pr=57" } });
      await expect(app.page.getByTestId("pr-review-changes")).toBeVisible();
    },
  },
  {
    id: "pr-review-refused",
    extra: true,
    async run(app, theme) {
      await app.open({ theme, params: { "review-link": "berth://review?repo=acme/shop&pr=63" } });
      await expect(app.page.getByTestId("pr-review-refused")).toBeVisible();
    },
  },
  {
    id: "guided-install",
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme, params: { team: "acme", "team-page": "acme" } });
      await page.getByRole("button", { name: "Add a box" }).locator("visible=true").first().click();
      await page.getByText("Or let Shipyard set it up over SSH").click();
      await page.getByLabel("SSH host, like me@my-box").fill("dev@acme-box");
      await page.getByTestId("ssh-set-up").click();
      await expect(page.getByTestId("install-plan")).toBeVisible();
    },
  },
  ...["general", "notifications", "appearance", "terminal", "boxes", "computers", "phone", "agents", "integrations", "plugins", "shortcuts", "labs", "about", "developer"].map(settings),
  {
    id: "sidebar-rename",
    async run(app, theme) {
      await app.open({ theme });
      const row = app.worktree("devl/checkout-fix");
      await row.focus();
      await app.page.keyboard.press("F2");
      await expect(app.page.getByRole("textbox", { name: /name/i }).first()).toBeVisible();
    },
  },
  {
    id: "worktree-menu",
    async run(app, theme) {
      await app.open({ theme });
      await app.worktree("devl/checkout-fix").click({ button: "right" });
      await expect(app.page.getByRole("menu")).toBeVisible();
    },
  },
  {
    id: "new-tab-menu",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.getByRole("button", { name: "New tab" }).click();
      await expect(app.page.getByRole("option").first()).toBeVisible();
    },
  },
  {
    id: "rail",
    async run(app, theme) {
      await app.open({ theme });
      await app.page.getByRole("button", { name: "Hide the sidebar" }).click();
      await expect(app.page.getByRole("navigation", { name: "Agents" })).toBeVisible();
    },
  },
  {
    // The rail sidebar, the default: a project picked on the rail, its
    // worktrees on the sheet beside it.
    id: "sidebar-rail",
    async run(app, theme) {
      await app.open({ theme, prefs: { sidebarLayout: "rail" } });
      await app.page.locator("[data-testid=rail-project][data-project=shop]").click();
      await expect(app.worktree("devl/checkout-fix")).toBeVisible();
    },
  },
  {
    // The rail sidebar folded away (⌘\): the rail alone.
    id: "sidebar-rail-folded",
    extra: true,
    async run(app, theme) {
      await app.open({ theme, prefs: { version: 4, sidebarLayout: "rail" } });
      await app.page.getByRole("button", { name: "Hide the sidebar" }).click();
      await expect(app.page.getByTestId("sidebar-rail").getByTestId("rail-project").first()).toBeVisible();
    },
  },
  {
    // The two-column sidebar (Settings › Appearance): a project picked, its
    // tasks beside the projects.
    id: "sidebar-columns",
    async run(app, theme) {
      await app.open({ theme, prefs: { sidebarLayout: "columns" } });
      await app.page.locator("[data-testid=column-project][data-project=shop]").click();
      await expect(app.worktree("devl/checkout-fix")).toBeVisible();
    },
  },
  {
    // The sidebar's notice that boxes' skills aren't installed or are out
    // of date (components/sidebar/skills-notice.tsx), unfolded, with an
    // install a hook on the box refused.
    id: "skills-notice",
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme });
      await page.evaluate(() => (window as unknown as { __berthMockSkills: { refuse(box: string): void } }).__berthMockSkills.refuse("devl"));
      await page.getByTestId("skills-notices-more").click();
      await page.locator('[data-testid=skills-notice][data-box="devl"]').getByRole("button", { name: "Install now" }).click();
      await expect(page.getByTestId("skills-notice-error")).toBeVisible();
      await expect(page.locator('[data-testid=skills-notice][data-box="gpu"]')).toBeVisible();
    },
  },
  {
    // Its Snooze menu.
    id: "skills-notice-snooze",
    extra: true,
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme });
      await page.getByRole("button", { name: "Snooze the reminder for devl" }).click();
      await expect(page.getByRole("menuitem", { name: "Don't remind me for devl" })).toBeVisible();
    },
  },
  {
    // The same notices from the folded sidebar's one button.
    id: "skills-notice-rail",
    extra: true,
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme });
      await page.getByRole("button", { name: "Hide the sidebar" }).click();
      await page.getByTestId("skills-notices-rail").click();
      await expect(page.getByTestId("skills-notice")).toHaveCount(2);
    },
  },
  {
    // Settings → Agents with a box's reminder snoozed.
    id: "settings-agents-snoozed",
    extra: true,
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme });
      await page.getByRole("button", { name: "Snooze the reminder for devl" }).click();
      await page.getByRole("menuitem", { name: "Until tomorrow" }).click();
      const body = await app.openSettings("agents");
      await expect(body.getByRole("button", { name: "Remind me now" })).toBeVisible();
    },
  },
  {
    id: "artifact-card",
    async run(app, theme) {
      await chat(app, theme, "devl/search-perf");
      const c = artCard(app, P95);
      await c.scrollIntoViewIfNeeded();
      await expect(c.locator("[data-art-size=thumb] svg").first()).toBeAttached();
    },
  },
  {
    id: "artifact-chart",
    async run(app, theme) {
      const pane = await openArt(app, theme, P95);
      await expect(pane.locator("[data-chart-type=bar]")).toBeVisible();
    },
  },
  {
    id: "artifact-versions",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, P95);
      await app.page.evaluate(() => (window as unknown as { __art: { bump(): Promise<void> } }).__art.bump());
      await pane.getByTestId("art-versions").getByRole("radio", { name: /v1/ }).click();
      await expect(pane.getByTestId("art-old")).toContainText("Showing v1");
    },
  },
  {
    id: "artifact-source",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, P95);
      await pane.getByTestId("art-source-toggle").click();
      await expect(pane.getByTestId("art-source")).toBeVisible();
    },
  },
  {
    id: "artifact-board",
    async run(app, theme) {
      await chat(app, theme, "devl/search-perf");
      await app.page.getByTestId("art-chip").click();
      await expect(app.page.getByTestId("artifact-board").locator("[data-art-tile]").first()).toBeVisible();
      await atRest(app);
    },
  },
  {
    id: "artifact-table",
    extra: true,
    async run(app, theme) {
      await chat(app, theme, "devl/search-perf");
      await app.page.getByTestId("art-chip").click();
      const board = app.page.getByTestId("artifact-board");
      await board.locator("[data-filter=table]").click();
      await board.getByRole("button", { name: "Open Search test results", exact: true }).last().click();
      await expect(artPane(app).locator("[data-art-table]")).toBeVisible();
    },
  },
  {
    id: "artifact-heatmap",
    async run(app, theme) {
      const pane = await fromBoard(app, theme, "b7c2a9e1f0");
      await expect(pane.locator("[data-heatmap]")).toBeVisible();
    },
  },
  {
    id: "artifact-diagram",
    extra: true,
    async run(app, theme) {
      const pane = await fromBoard(app, theme, "a1f3c0d2e4");
      await expect(pane.locator("[data-art-diagram] svg").first()).toBeVisible();
    },
  },
  {
    id: "artifact-notes",
    extra: true,
    async run(app, theme) {
      const pane = await fromBoard(app, theme, "c4d9e2b7a1");
      await expect(pane.locator("[data-art-notes]")).toBeVisible();
    },
  },
  {
    id: "artifact-compare-lane",
    extra: true,
    async run(app, theme) {
      await chat(app, theme, "devl/search-perf");
      await app.page.keyboard.press("Meta+Alt+KeyC");
      const input = app.page.getByPlaceholder("Compare search-perf with…");
      await input.fill("checkout-fix");
      await input.press("Enter");
      await expect(app.page.getByRole("toolbar", { name: /^Compare / })).toBeVisible();
      await app.page.keyboard.press("Alt+Digit5");
      await expect(app.page.locator("[data-pane-area] [data-compare-side]:visible [data-testid=artifact-board]")).toHaveCount(2);
      await atRest(app);
    },
  },
  {
    id: "visual-diff-card",
    async run(app, theme) {
      await chat(app, theme, "devl/search-perf");
      const c = await reachCard(app, VD);
      await expect(c.locator("[data-vd-thumb=wipe]")).toBeVisible();
    },
  },
  {
    id: "visual-diff",
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await expect(pane.locator("[data-vd-canvas]").first()).toBeVisible();
      // A change chosen, so its caption and loud region show too.
      await pane.getByRole("button", { name: "Next change" }).locator("visible=true").click();
      await expect(pane.locator("[data-vd-caption]")).toBeVisible();
    },
  },
  {
    id: "visual-diff-side-by-side",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await pane.locator("[data-vd-mode=side]").click();
      await expect(pane.locator("[data-vd-stage=side] [data-vd-canvas]")).toHaveCount(2);
    },
  },
  {
    id: "visual-diff-onion",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await pane.locator("[data-vd-mode=onion]").click();
      await expect(pane.locator("[data-vd-stage=onion]")).toBeVisible();
    },
  },
  {
    id: "visual-diff-all-shots",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await pane.locator("[data-vd-all]").click();
      await expect(pane.locator("[data-vd-grid] [data-vd-cell]").first()).toBeVisible();
    },
  },
  {
    id: "visual-diff-older",
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await pane.getByTestId("art-versions").getByRole("radio", { name: /v1/ }).click();
      await expect(pane.locator("[data-vd-banner=bad]")).toBeVisible();
    },
  },
  {
    id: "visual-diff-accept",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, VD);
      await pane.locator("[data-vd-accept]").click();
      await expect(pane.locator("[data-vd-accept-ask]")).toBeVisible();
    },
  },
  {
    id: "visual-diff-all-clear",
    extra: true,
    async run(app, theme) {
      const pane = await openArt(app, theme, CLEAR);
      await expect(pane.locator("[data-vd-all-clear]")).toBeVisible();
    },
  },
  {
    // Beside the chat in a small window: the compact header (KindSpec
    // compact), its version menu open.
    id: "visual-diff-narrow",
    async run(app, theme) {
      await app.page.setViewportSize({ width: 900, height: 900 });
      await chat(app, theme, "devl/search-perf");
      const c = await reachCard(app, VD);
      await c.getByRole("button", { name: "Open Visual changes: search-perf vs main beside the chat" }).click();
      const pane = artPane(app);
      await expect(pane.locator("[data-vd-canvas]").first()).toBeVisible();
      await pane.getByTestId("art-version-menu").click();
      await expect(app.page.getByRole("menuitemradio").first()).toBeVisible();
      // The chat beside it is left out: it is the chat-* scenes' (checked
      // there in full), and here it is the unfocused pane, which a split
      // dims to 85% (workspace/pane.tsx) to show where the keyboard is.
      await app.page.locator("[data-testid=pane]:visible").filter({ has: app.page.locator("[data-testid=chat]") }).evaluate((el) => el.setAttribute("data-a11y-skip", ""));
    },
  },
  {
    id: "agent-browser-size",
    async run(app, theme) {
      await app.open({ theme });
      await app.openWorktree("devl/checkout-fix");
      await app.page.getByRole("button", { name: "New tab" }).click();
      await app.page.getByRole("option", { name: /New browser tab/ }).click();
      const pane = app.page.locator("[data-testid=browser-pane]:visible");
      await pane.getByRole("button", { name: /Agent's view/ }).click();
      await expect(pane.getByTestId("agent-size")).toContainText("1920×1080");
    },
  },
  {
    id: "team-setup-init-waiting",
    async run(app, theme) {
      const { page } = app;
      await app.open({ theme, params: { team: "acme", teamhold: "init", "team-page": "acme" } });
      await page.getByTestId("team-checklist").locator("visible=true").getByTestId("team-run").click();
      await expect(page.getByTestId("step-update")).toHaveAttribute("data-state", "waiting");
      await page.evaluate(() => (window as unknown as { __teamMock: { advance(n: string): void } }).__teamMock.advance("sudo"));
      await expect(page.getByTestId("repo-line-shop")).toHaveText("waiting for you", { timeout: 20_000 });
    },
  },
  {
    id: "new-task",
    async run(app, theme) {
      await app.open({ theme });
      await app.page.keyboard.press("Meta+n");
      await expect(app.page.getByRole("dialog")).toBeVisible();
    },
  },
  // Leadline's panels (plugins/leadline) on the mock helper's fixtures
  // (src/lib/mock-helper.ts): a list with a row's detail open beside it.
  {
    id: "leadline-queries",
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/checkout-fix", "Queries");
      await p.getByTestId("leadline-row").filter({ hasText: "FROM order_items" }).click();
      await expect(p.getByTestId("leadline-detail").getByTestId("leadline-traces").first()).toBeVisible();
    },
  },
  {
    id: "leadline-traces",
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/checkout-fix", "Traces");
      await p.getByTestId("leadline-row").filter({ hasText: "POST /api/checkout" }).first().click();
      await p.getByTestId("leadline-span").filter({ hasText: "INSERT INTO orders" }).click();
      await expect(p.getByTestId("leadline-span-info")).toBeVisible();
    },
  },
  {
    id: "leadline-logs",
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/checkout-fix", "Logs");
      await p.getByTestId("leadline-row").filter({ hasText: "webhook failed" }).first().click();
      await expect(p.getByTestId("leadline-log-info")).toBeVisible();
    },
  },
  {
    id: "leadline-endpoints",
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/checkout-fix", "Endpoints");
      await p.getByTestId("leadline-row").filter({ hasText: "webhooks" }).click();
      await expect(p.getByTestId("leadline-detail").getByTestId("leadline-traces").first()).toBeVisible();
    },
  },
  {
    id: "leadline-screen",
    async run(app, theme) {
      await app.open({ theme });
      // Its sidebar item starts under More: the palette's command is there
      // once the plugin has loaded.
      const input = app.page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
      const command = app.page.getByRole("option", { name: /^Show Leadline/ });
      await expect(async () => {
        if (!(await input.isVisible())) await app.page.keyboard.press("Meta+k");
        await input.fill("Show Leadline");
        if (!(await command.isVisible())) await app.page.keyboard.press("Escape");
        await expect(command).toBeVisible({ timeout: 500 });
      }).toPass();
      await command.click();
      await expect(app.page.getByTestId("leadline-heard").first()).toBeVisible();
    },
  },
  {
    id: "leadline-off",
    extra: true,
    async run(app, theme) {
      const p = await leadline(app, theme, "gpu/ci-flake", "Queries");
      await p.getByRole("button", { name: "Turn on…" }).click();
      await expect(app.page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    // A plugin that changed, with its program left running meanwhile.
    id: "plugin-helper-held",
    extra: true,
    async run(app, theme) {
      await app.open({ theme, params: { helper: "held" } });
      await app.page.getByRole("dialog", { name: "Leadline has changed" }).getByRole("button", { name: "Not now" }).click();
      const body = await app.openSettings("plugins");
      await expect(body.getByTestId("plugin-helper-held")).toBeVisible();
    },
  },
  {
    id: "leadline-nothing-yet",
    extra: true,
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/qa-deck", "Traces");
      await expect(p.getByTestId("leadline-notice")).toContainText("Nothing from qa-deck yet");
    },
  },
  {
    id: "leadline-send",
    extra: true,
    async run(app, theme) {
      const p = await leadline(app, theme, "devl/checkout-fix", "Endpoints");
      await p.getByRole("button", { name: "Send this failing endpoint to the agent" }).click();
      await expect(app.page.getByTestId("leadline-send").getByRole("textbox")).toBeVisible();
    },
  },
  // The Database panel (plugins/database) on the mock helper's acme shop
  // (src/lib/mock-database.ts): a table's grid, an edit in review, the
  // unlock confirm, the console with a result, and the states.
  {
    id: "database-browser",
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByTestId("database-table").filter({ hasText: "orders" }).last().click();
      await p.getByRole("button", { name: "Filter by status" }).click();
      // A cell picked: what it offers (the row its key points at) can be reached.
      await p.locator("[data-testid=database-row]:visible").first().locator('[data-col="customer_id"]').click();
      await expect(p.locator("[data-testid=database-row]:visible [aria-selected=true]")).toHaveCount(1);
    },
  },
  {
    id: "database-review",
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByTestId("database-table").filter({ hasText: "customers" }).click();
      await p.getByRole("button", { name: "Unlock writes…" }).click();
      await app.page.getByRole("alertdialog").getByRole("button", { name: "Unlock for 15 minutes" }).click();
      const plan = p.locator("[data-testid=database-row]:visible").first().locator('[data-col="plan"]');
      await plan.dblclick();
      await plan.getByRole("textbox").fill("business");
      await plan.getByRole("textbox").press("Enter");
      await p.getByRole("button", { name: "Add row" }).click();
      await p.getByRole("checkbox", { name: "Pick row 4", exact: true }).check();
      await p.getByRole("button", { name: "Delete 1 row" }).click();
      await p.getByTestId("database-staged").getByRole("button", { name: "Review…" }).click();
      await expect(app.page.getByTestId("database-review").getByTestId("database-change")).toHaveCount(3);
      // The sheet slides in.
      await app.page.waitForTimeout(400);
    },
  },
  {
    id: "database-staged",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByTestId("database-table").filter({ hasText: "customers" }).click();
      await p.getByRole("button", { name: "Unlock writes…" }).click();
      await app.page.getByRole("alertdialog").getByRole("button", { name: "Unlock for 15 minutes" }).click();
      await p.getByRole("button", { name: "Add row" }).click();
      const notes = p.locator("[data-testid=database-row]:visible").nth(3).locator('[data-col="notes"]');
      await notes.dblclick();
      await expect(notes.getByRole("button", { name: "Set NULL" })).toBeVisible();
    },
  },
  {
    id: "database-unlock",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByRole("button", { name: "Unlock writes…" }).click();
      await expect(app.page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    id: "database-structure",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByTestId("database-table").filter({ hasText: "order_items" }).click();
      await p.getByRole("group", { name: "What to show of the table" }).getByRole("button", { name: "Structure" }).click();
      await expect(p.getByTestId("database-structure")).toBeVisible();
    },
  },
  {
    id: "database-console",
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByRole("group", { name: "Browse the tables, or run SQL" }).getByRole("button", { name: "Console" }).click();
      await p.getByRole("textbox", { name: "SQL to run" }).click();
      await app.page.keyboard.type("SELECT id, name, notes FROM customers LIMIT 20");
      await app.page.keyboard.press("ControlOrMeta+Enter");
      await expect(p.locator("[data-testid=database-row]:visible").first()).toBeVisible();
    },
  },
  {
    id: "database-console-error",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByRole("group", { name: "Browse the tables, or run SQL" }).getByRole("button", { name: "Console" }).click();
      await p.getByRole("textbox", { name: "SQL to run" }).click();
      await app.page.keyboard.type("SELECT id, emial FROM customers");
      await app.page.keyboard.press("ControlOrMeta+Enter");
      await expect(p.getByTestId("database-error")).toBeVisible();
    },
  },
  {
    id: "database-other-engine",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix");
      await p.getByTestId("database-connection").click();
      await app.page.getByRole("menuitem", { name: /events/ }).click();
      await p.getByTestId("database-table").filter({ hasText: "deliveries" }).click();
      await expect(p.getByTestId("database-browse-only")).toBeVisible();
    },
  },
  // A database found in the worktree's .env: the file's name in the bar.
  {
    id: "database-from-env",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "env" });
      await expect(p.getByTestId("database-from-env")).toBeVisible();
    },
  },
  // A look that found none: what it looked at, over what always showed.
  {
    id: "database-env-refused",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "env-refused" });
      await expect(p.getByTestId("database-looked")).toBeVisible();
    },
  },
  // Connect a database…: the address field, masked, with what went wrong under it.
  {
    id: "database-connect",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "none" });
      await p.getByRole("button", { name: "Connect a database…" }).click();
      const dialog = app.page.getByRole("alertdialog");
      await dialog.getByLabel("Address", { exact: true }).fill("postgres://acme:acme@db.acme.example:5432/shop_staging");
      await dialog.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(dialog.getByTestId("database-connect-problem")).toBeVisible();
      await app.page.waitForTimeout(400);
    },
  },
  // A connection added by hand: how it got here, and Forget.
  {
    id: "database-by-hand",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "none" });
      await p.getByRole("button", { name: "Connect a database…" }).click();
      const dialog = app.page.getByRole("alertdialog");
      await dialog.getByLabel("Address", { exact: true }).fill("postgres://acme:acme@localhost:5433/shop_scratch");
      await dialog.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(p.getByTestId("database-by-hand")).toBeVisible();
    },
  },
  {
    id: "database-screen",
    async run(app, theme) {
      await app.open({ theme });
      const input = app.page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
      const command = app.page.getByRole("option", { name: /^Show Database/ });
      await expect(async () => {
        if (!(await input.isVisible())) await app.page.keyboard.press("Meta+k");
        await input.fill("Show Database");
        if (!(await command.isVisible())) await app.page.keyboard.press("Escape");
        await expect(command).toBeVisible({ timeout: 500 });
      }).toPass();
      await command.click();
      await expect(app.page.locator('[data-testid=database-box][data-box="devl"]')).toHaveAttribute("data-state", "running");
    },
  },
  {
    id: "database-off",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "gpu/ci-flake");
      await expect(p.getByTestId("database-notice")).toContainText("Database is off on gpu");
    },
  },
  {
    id: "database-none",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "none" });
      await expect(p.getByTestId("database-notice")).toContainText("No database for checkout-fix yet");
    },
  },
  {
    id: "database-old-box",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "unauthorized" });
      await expect(p.getByTestId("database-notice")).toContainText("devl needs updating for Database");
    },
  },
  {
    id: "database-refused",
    extra: true,
    async run(app, theme) {
      const p = await database(app, theme, "devl/checkout-fix", { db: "refused" });
      await expect(p.getByTestId("database-notice")).toContainText("Couldn't reach shop_checkout_fix");
    },
  },
];

// database opens the Database panel in a worktree, once the plugin has
// loaded and the "+" menu lists it.
async function database(app: App, theme: string, wt: string, params?: Record<string, string>) {
  await app.open({ theme, params });
  await app.openWorktree(wt);
  const option = app.page.getByRole("option", { name: /^Database/ });
  await expect(async () => {
    if (!(await option.isVisible())) await app.page.getByRole("button", { name: "New tab" }).click();
    await expect(option).toBeVisible({ timeout: 1000 });
  }).toPass();
  await option.click();
  const p = app.page.locator("[data-testid=database]:visible");
  await expect(p.getByTestId("database-tree").or(p.getByTestId("database-notice")).first()).toBeVisible();
  return p;
}

// leadline opens one of Leadline's panels in a worktree, once the plugin
// has loaded and the "+" menu lists it.
async function leadline(app: App, theme: string, wt: string, title: string) {
  await app.open({ theme });
  await app.openWorktree(wt);
  const option = app.page.getByRole("option", { name: new RegExp(`^${title}`) });
  await expect(async () => {
    if (!(await option.isVisible())) await app.page.getByRole("button", { name: "New tab" }).click();
    await expect(option).toBeVisible({ timeout: 1000 });
  }).toPass();
  await option.click();
  const p = app.page.locator(`[data-testid=leadline][data-leadline=${title.toLowerCase()}]:visible`);
  await expect(p.getByTestId("leadline-row").or(p.getByTestId("leadline-notice")).first()).toBeVisible();
  return p;
}

