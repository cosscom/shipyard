import { expect, mockOnly, test } from "./fixtures";
import type { Page } from "@playwright/test";

// Team setup (views/team, lib/mock-team.ts): an org's <org>/.berth read
// with this computer's gh, one page from the org card to "You're set up".
// The mock's ?team= picks a scenario; &teamhold= holds the run at a point;
// window.__teamMock.advance(name) moves it on.

test.beforeEach(() => mockOnly("Team setup's scenarios are mock fixtures"));

const advance = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __teamMock: { advance(n: string): void } }).__teamMock.advance(n), name);
const step = (page: Page, id: string) => page.getByTestId(`step-${id}`);
const repo = (page: Page, id: string) => page.getByTestId(`repo-${id}`);
const checklist = (page: Page) => page.getByTestId("team-checklist").locator("visible=true");

async function startRun(page: Page) {
  await checklist(page).getByTestId("team-run").click();
  await expect(step(page, "update")).toHaveAttribute("data-state", "waiting");
}

test("first run: Joining a team? opens the team setup in the whole window", async ({ app }) => {
  const { page } = app;
  await page.goto("/?mock=1&fresh=1");
  await expect(page.getByRole("heading", { name: "Joining a team?" })).toBeVisible();
  await page.getByLabel("GitHub org").fill("github.com/acme");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Acme team setup" })).toBeVisible();
  // Still first run: no sidebar yet, and the box is the one thing to add.
  await expect(page.getByTestId("nav-home")).toHaveCount(0);
  await expect(checklist(page).getByRole("button", { name: "Add your box" })).toBeVisible();
  await expect(checklist(page).getByTestId("team-run")).toBeDisabled();
  await expect(checklist(page)).toContainText("Pick or add the box to set up");
});

test("Add a box offers to set the box up for a team", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme" } });
  // The sidebar's More menu has its ways to add a project or a box.
  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitem", { name: /Add a box/ }).click();
  await page.getByTestId("addbox-team").click();
  await expect(page.getByRole("heading", { name: "Which GitHub org?" })).toBeVisible();
  await page.getByLabel("GitHub org").fill("acme");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Acme team setup" })).toBeVisible();
});

test("a berth://team link opens the org's setup, read like its repo on GitHub", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-link": "acme" } });
  const pageEl = page.getByTestId("team-page");
  await expect(pageEl).toContainText("Opened from a link");
  await expect(pageEl).toContainText("Published by Acme on GitHub");
  await expect(pageEl).toContainText("Verified");
  await expect(pageEl).toContainText("dana-acme");
  await expect(page.getByTestId("team-commit")).toHaveText("4e1c9a2");
  await expect(checklist(page)).toContainText("You have access to all 3 repos");
  // The new box is picked: the one with no projects yet.
  await expect(checklist(page).getByRole("combobox")).toContainText("sean-dev");
  await expect(page.getByTestId("team-page")).not.toContainText("the Shipyard project");
});

test("without the GitHub CLI, the page says how to install it", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "nogh", "team-link": "acme" } });
  await expect(page.getByTestId("team-github")).toHaveAttribute("data-state", "missing");
  await expect(page.getByRole("heading", { name: "Install GitHub's CLI first" })).toBeVisible();
  await expect(page.getByTestId("team-github")).toContainText("brew install gh");
  // Sign-in comes before the org card.
  await expect(page.getByRole("heading", { name: "Acme team setup" })).toHaveCount(0);
});

test("signed out: Connect GitHub runs gh auth login, and the page carries on when it's done", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "signedout", "team-link": "acme" } });
  await page.getByTestId("connect-github").click();
  await expect(page.getByText("Waiting for gh auth login to finish")).toBeVisible();
  await expect(page.getByTestId("team-github")).toContainText("gh auth login");
  await expect(page.getByRole("heading", { name: "Acme team setup" })).toBeVisible({ timeout: 8000 });
});

test("every line opens to its commands, and Read every command shows the .berth files", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-page": "acme" } });
  await expect(step(page, "docker")).toContainText("sudo");
  await step(page, "docker").getByRole("button").first().click();
  await expect(step(page, "docker")).toContainText("sudo usermod -aG docker $USER");
  await repo(page, "shop").getByRole("button").first().click();
  await expect(repo(page, "shop")).toContainText("git clone https://github.com/acme/shop");
  await expect(step(page, "github")).toContainText("Shipyard");
  // The keys are 1Password references: Shipyard signs op in on the box, as a
  // step of its own after GitHub's.
  await expect(step(page, "1password")).toContainText("1Password on the box");
  await expect(step(page, "1password")).toContainText("Shipyard");
  await step(page, "1password").getByRole("button").first().click();
  await expect(step(page, "1password")).toContainText("berthd secret signin");
  await page.getByTestId("read-every-command").click();
  await expect(page.getByTestId("team-file")).toContainText("set -euo pipefail");
  await expect(page.getByText(/lines call sudo, marked/)).toBeVisible();
  await page.getByRole("tab", { name: "team.json" }).click();
  await expect(page.getByTestId("team-file")).toContainText('"schema": "berth.team/v1"');
});

test("no access: You can't read this setup", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "unreadable", "team-link": "acme" } });
  await expect(page.getByRole("heading", { name: "You can't read this setup" })).toBeVisible();
  await expect(page.getByTestId("team-unreadable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(page.getByTestId("team-checklist")).toHaveCount(0);
});

test("partial access: the repo you can't read is left out, and the rest set up", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "partial", "team-page": "acme" } });
  await expect(page.getByTestId("access-partial").locator("visible=true")).toContainText("You can't read acme/billing-api: ask an admin");
  await expect(page.getByTestId("access-partial").locator("visible=true")).toContainText("Set up the other 2");
  await expect(repo(page, "billing-api")).toContainText("You can't read it");
  await expect(checklist(page).getByTestId("team-run")).toBeEnabled();
});

test("box and keys: one line, the asked key entered once", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-page": "acme" } });
  const keys = checklist(page).getByTestId("keys-line");
  await expect(keys).toHaveText("5 from 1Password · 1 to enter");
  await checklist(page).getByLabel(/MAIL_API_KEY/).fill("SG.test");
  await expect(keys).toHaveText("5 from 1Password · 1 entered");
  await expect(checklist(page)).toContainText("4 steps ask for your password on sean-dev");
  await expect(checklist(page)).toContainText("It signs in to GitHub itself, and to 1Password, in its own terminal");
});

test("running: sudo waits in the box's terminal, then the box signs in to GitHub with a code", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", teamhold: "github", "team-page": "acme" } });
  await startRun(page);
  await expect(step(page, "update")).toContainText("Type it in the terminal below; Shipyard doesn't see or keep it");
  // The sidebar and the status bar show it from the start.
  await expect(page.getByTestId("team-status")).toContainText("Setting up sean-dev for Acme · waiting for your password");
  await expect(page.getByTestId("team-sidebar")).toContainText("queued");
  // The password goes to the terminal, never to Shipyard.
  await step(page, "update").locator("[data-pane-kind], .xterm, canvas, [contenteditable]").first().click().catch(() => {});
  await page.keyboard.type("hunter2");
  await page.keyboard.press("Enter");
  await advance(page, "sudo");
  await expect(step(page, "github")).toHaveAttribute("data-state", "waiting", { timeout: 15_000 });
  await expect(page.getByTestId("device-code")).toContainText("C4L1-7Q2M");
  await expect(page.getByRole("button", { name: /Open github.com\/login\/device/ })).toBeVisible();
  await expect(page.getByTestId("team-runcard").locator("visible=true")).toContainText("Sign the box in to GitHub");
});

test("1Password: op asks in the box's terminal, which the step shows, then the setup carries on", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", teamhold: "1password", "team-page": "acme" } });
  await startRun(page);
  await advance(page, "sudo");
  await expect(step(page, "1password")).toHaveAttribute("data-state", "waiting", { timeout: 15_000 });
  await expect(step(page, "1password")).toContainText("op on sean-dev is asking you to sign in to 1Password");
  await expect(step(page, "1password")).toContainText("Shipyard keeps only op's session there");
  await expect(page.getByTestId("team-runcard").locator("visible=true")).toContainText("Sign the box in to 1Password");
  await expect(page.getByTestId("team-status")).toContainText("waiting for 1Password");
  await advance(page, "1password");
  // The box is done (its steps fold into one line), and the repos follow.
  await expect(step(page, "1password")).toHaveCount(0, { timeout: 10_000 });
  await expect(repo(page, "shop")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});

test("a box without tmux: the Box check says how to install it, and setup waits for it", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", tmux: "missing", "team-page": "acme" } });
  const box = page.getByTestId("check-box").locator("visible=true");
  await expect(box).toHaveAttribute("data-state", "warn");
  await expect(box).toContainText("Install tmux on sean-dev");
  await expect(box).toContainText("Shipyard runs the team setup's steps, and later your agents, in tmux on the box.");
  await expect(box).toContainText("sudo apt install tmux");
  await expect(checklist(page).getByTestId("team-run")).toBeDisabled();
  await expect(checklist(page)).toContainText("Install tmux on sean-dev first");
  // Installed on the box: Check again finds it.
  await box.getByRole("button", { name: "Check again" }).click();
  await box.getByRole("button", { name: "Check again" }).click();
  await expect(box).toHaveAttribute("data-state", "done");
  await expect(checklist(page).getByTestId("team-run")).toBeEnabled();
});

test("a repo that's ready offers Start on it while the others set up", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", teamhold: "repos", "team-page": "acme" } });
  await startRun(page);
  await advance(page, "sudo");
  await expect(repo(page, "shop")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(repo(page, "billing-api")).toHaveAttribute("data-state", "setting-up");
  await expect(page.getByTestId("team-sidebar")).toContainText("new");
  await expect(page.getByTestId("team-status")).toContainText("1 of 3 repos ready");
  await repo(page, "shop").getByRole("button", { name: "Start on shop" }).click();
  // The composer, on that repo and box, for a task there.
  const composer = page.getByRole("dialog");
  await expect(composer).toBeVisible();
  await expect(composer).toContainText("shop");
  await expect(composer).toContainText("sean-dev");
});

// A repo's first-time setup runs in a terminal of its own in its checkout.
// When it stops at a question, the page says so and opens that terminal,
// rather than leaving it to be found by opening the main checkout; once
// answered the setup finishes, and a worktree is a click away.
test("a repo's first-time setup that asks something says so, and its terminal is a click away", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", teamhold: "init", "team-page": "acme" } });
  await startRun(page);
  await advance(page, "sudo");
  const shop = repo(page, "shop");
  await expect(shop.getByTestId("repo-line-shop")).toHaveText("waiting for you", { timeout: 20_000 });
  await expect(page.getByTestId("team-status")).toContainText("shop waits for you");
  await shop.getByTestId("repo-terminal-shop").click();
  // Its terminal, in front: the question is answered there.
  await expect(page.getByRole("tab", { name: /shop first-time setup/ }).first()).toBeVisible();
  await advance(page, "init");
  await page.getByTestId("team-sidebar").click();
  await expect(page.getByRole("heading", { name: "You're set up for Acme" })).toBeVisible({ timeout: 25_000 });
  // Ready means ready: New task on shop opens the composer there at once.
  await page.getByTestId("team-done").getByRole("button", { name: "New task" }).first().click();
  const composer = page.getByRole("dialog");
  await expect(composer).toContainText("shop");
  await composer.getByRole("textbox").first().fill("say hello");
  await composer.getByRole("button", { name: /^Start/ }).click();
  await expect(composer).toBeHidden();
});

test("a failed step shows why, and Retry goes on from it to You're set up", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "fail", "team-page": "acme" } });
  await startRun(page);
  await advance(page, "sudo");
  await expect(step(page, "postgres")).toHaveAttribute("data-state", "failed", { timeout: 15_000 });
  await expect(step(page, "postgres")).toContainText("port is already allocated");
  await expect(step(page, "docker")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("team-status")).toContainText("Acme setup stopped at Postgres in Docker");
  await step(page, "postgres").getByRole("button", { name: "Retry from Postgres" }).click();
  await expect(page.getByRole("heading", { name: "You're set up for Acme" })).toBeVisible({ timeout: 25_000 });
});

test("You're set up: the team's first task and each repo", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "done", "team-page": "acme" } });
  const done = page.getByTestId("team-done");
  await expect(done.getByRole("heading", { name: "You're set up for Acme" })).toBeVisible();
  await expect(done.getByLabel("First task", { exact: true })).toHaveValue(/good first issue/);
  await expect(done.getByTestId("start-first-task")).toBeEnabled();
  await expect(done).toContainText("acme/billing-api");
  await expect(done).toContainText("Shipyard never had it, and nothing kept it");
});

test("an update shows on this page as a diff, and runs only when asked", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "update" } });
  const card = page.getByTestId("team-update-card");
  await expect(card).toContainText("Acme's setup changed");
  await card.getByRole("button", { name: "Review update" }).click();
  const diff = page.getByTestId("team-diff");
  await expect(diff).toContainText("Node 20 → 22");
  await expect(diff).toContainText("acme/search");
  await expect(diff.locator("li", { hasText: "Playwright's system libraries" })).toContainText("sudo");
  await expect(page.getByText(/is a new step that asks for your password/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await checklist(page).getByRole("button", { name: "Update sean-dev" }).click();
  await expect(page.getByTestId("team-runcard").locator("visible=true")).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("an org without .berth: its repos, the Shipyard-configured ones picked", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-page": "northwind" } });
  await expect(page.getByTestId("team-none")).toHaveText("Northwind Labs");
  const box = (name: string) => page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
  await expect(box("northwind/storefront")).toBeChecked();
  await expect(box("northwind/api")).toBeChecked();
  await expect(box("northwind/handbook")).not.toBeChecked();
  await expect(checklist(page).getByTestId("team-run")).toHaveText("Set up 2 repos");
  await box("northwind/api").click();
  await expect(checklist(page).getByTestId("team-run")).toHaveText("Set up 1 repo");
});

// Clones the box already has (&team-clones=1): acme/shop at ~/work/acme-shop
// with uncommitted changes, acme/website at ~/src/website, clean. The page
// decides which a repo uses; nothing found is used without a choice but
// the one clean clone it starts on.
test("a repo already cloned on the box: Found … · Use this, or Clone a fresh copy", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-clones": "1", "team-page": "acme" } });
  // The new box is picked once the boxes' projects are in: its clones are the ones offered.
  await expect(checklist(page).getByRole("combobox")).toContainText("sean-dev");
  await expect(page.getByTestId("team-page")).not.toContainText("the Shipyard project");
  const shop = page.getByTestId("found-shop");
  await expect(shop).toContainText("Found ~/work/acme-shop, a clone of acme/shop (on branch feat/x, 3 uncommitted changes)");
  // Uncommitted changes: a fresh clone until you say otherwise.
  await expect(page.getByTestId("fresh-shop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("found-review-shop")).toHaveCount(0);
  // One clean clone: used, and the review says where the init runs.
  await expect(page.getByTestId("use-website")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("found-review-website")).toContainText("Runs in your existing checkout ~/src/website");
  await expect(page.locator("section", { has: page.locator("#plan-repos") })).toContainText("3 repos, 1 from a clone you have, the rest cloned as you");
  // Use this on shop: in place, its changes and branch left alone.
  await page.getByTestId("use-shop").click();
  const review = page.getByTestId("found-review-shop");
  await expect(review).toContainText("Runs in your existing checkout ~/work/acme-shop: .env from .env.example");
  await expect(review).toContainText("Your uncommitted changes stay as they are.");
  await expect(review).toContainText("nothing is checked out, stashed, reset or pulled, and an existing .env keeps its values");
  await expect(review).toContainText("Its other worktree shows in the sidebar, set up the first time you open it");
  await repo(page, "shop").getByRole("button").first().click();
  await expect(repo(page, "shop")).toContainText("# uses your existing checkout ~/work/acme-shop");
  await expect(repo(page, "shop")).not.toContainText("git clone https://github.com/acme/shop");
  // Clone a fresh copy on website instead.
  await page.getByTestId("fresh-website").click();
  await expect(page.getByTestId("found-review-website")).toHaveCount(0);
  await expect(page.getByTestId("use-website")).toHaveAttribute("aria-pressed", "false");
});

test("a found clone that is behind offers Pull as a button of its own", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-clones": "1", "team-page": "acme" } });
  // The new box is picked once the boxes' projects are in: its clones are the ones offered.
  await expect(checklist(page).getByRole("combobox")).toContainText("sean-dev");
  await expect(page.getByTestId("team-page")).not.toContainText("the Shipyard project");
  const review = page.getByTestId("found-review-website");
  await expect(review).toContainText("2 commits behind its upstream");
  await review.getByRole("button", { name: "Pull" }).click();
  await expect(page.getByText("Pulled ~/src/website")).toBeVisible();
  await expect(review).not.toContainText("behind its upstream");
});

test("a repo set up from a clone you have runs in place, and its worktree waits for its first open", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-clones": "1", "team-page": "acme" } });
  // The new box is picked once the boxes' projects are in: its clones are the ones offered.
  await expect(checklist(page).getByRole("combobox")).toContainText("sean-dev");
  await expect(page.getByTestId("team-page")).not.toContainText("the Shipyard project");
  await page.getByTestId("use-shop").click();
  await page.getByTestId("fresh-website").click();
  await startRun(page);
  await advance(page, "sudo");
  await expect(repo(page, "shop")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(page.getByTestId("adopted-shop")).toHaveText("In your existing checkout ~/work/acme-shop, as it was · 1 worktree set up on first open");
  await expect(page.getByTestId("adopted-website")).toHaveCount(0);
  // Its worktree is in the sidebar (past shop's busier ones), set up the
  // first time it's opened.
  await page.getByRole("button", { name: /^Show \d+ older$/ }).first().click();
  await expect(page.getByTestId("setup-on-open").first()).toHaveText("set up on first open");
});

test("an org without .berth offers the clones the box has too", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-clones": "1", "team-page": "northwind" } });
  const found = page.getByTestId("found-storefront");
  await expect(found).toContainText("Found ~/work/storefront, a clone of northwind/storefront (on branch main, no uncommitted changes)");
  await expect(page.getByTestId("use-storefront")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("fresh-storefront").click();
  await expect(page.getByTestId("use-storefront")).toHaveAttribute("aria-pressed", "false");
  // Not picked: nothing to choose.
  await page.getByRole("checkbox", { name: /^northwind\/storefront\b/ }).click();
  await expect(found).toHaveCount(0);
});

test("in the background, a toast says when a repo is ready", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", teamhold: "repos", "team-page": "acme" } });
  await startRun(page);
  await advance(page, "sudo");
  await page.getByTestId("team-runcard").locator("visible=true").getByRole("button", { name: "Run in background" }).click();
  await expect(page.getByText("shop is ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Start on shop" })).toBeVisible();
});

test("the page fits 900px: the plan starts above the fold", async ({ app }) => {
  const { page } = app;
  await page.setViewportSize({ width: 900, height: 720 });
  await app.open({ params: { team: "acme", "team-page": "acme" } });
  await expect(page.getByTestId("team-checklist").locator("visible=true")).toHaveAttribute("data-compact", "true");
  const first = await step(page, "packages").boundingBox();
  expect(first && first.y + first.height).toBeLessThan(720 - 26);
});

// A setup can also load from a link to any repo, branch or folder, to try
// one before <org>/.berth exists. The card names where it came from and
// claims nothing for the team it is for.
const LINK = "https://github.com/jo-acme/acme-setup/tree/team-setup/team";

async function expectFromLink(page: Page) {
  await expect(page.getByRole("heading", { name: "Acme team setup" })).toBeVisible();
  await expect(page.getByTestId("team-source")).toContainText("jo-acme/acme-setup · team-setup branch · team/");
  const provenance = page.getByTestId("team-provenance");
  await expect(provenance).toContainText("A team setup for Acme, loaded from jo-acme's repo, not from acme/.berth");
  await expect(page.getByTestId("team-page")).not.toContainText("Published by");
  await expect(page.getByTestId("team-page").getByText("Verified")).toHaveCount(0);
  await expect(page.getByTestId("team-commit")).toHaveText("b81d0e4");
  await expect(checklist(page).getByTestId("team-run")).toHaveText("Set up for Acme");
}

test("a berth://team?src= link opens a setup from a repo's branch, and sets the box up from it", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-link-src": LINK } });
  await expect(page.getByTestId("team-page")).toContainText("Opened from a link");
  await expectFromLink(page);
  await page.getByTestId("read-every-command").click();
  await expect(page.getByRole("tab", { name: "team/team.json" })).toBeVisible();
  await page.keyboard.press("Escape");
  await startRun(page);
  await expect(page.getByTestId("team-sidebar")).toContainText("Acme on sean-dev");
  await advance(page, "sudo");
  await expect(repo(page, "shop")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});

test("a setup link typed where an org goes opens it too", async ({ app }) => {
  const { page } = app;
  await page.goto("/?mock=1&fresh=1");
  await page.getByLabel("GitHub org").fill(LINK);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectFromLink(page);
});

test("a setup link pasted in the command palette opens it", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme" } });
  await page.getByRole("button", { name: /Search/ }).first().click();
  await page.keyboard.type("jo-acme/acme-setup/tree/team-setup/team");
  await page.getByRole("option", { name: /Open team setup from link/ }).click();
  await expectFromLink(page);
});

test("a link that can't be read says so, and never offers the repo picker", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-link-src": "github.com/someone/private-setup@main" } });
  await expect(page.getByRole("heading", { name: "You can't read this setup" })).toBeVisible();
  await expect(page.getByTestId("team-unreadable")).toContainText("someone/private-setup@main");
  await expect(page.getByTestId("team-none")).toHaveCount(0);
});

// Skipping 1Password. Acme's shared keys are 1Password references: shop has
// four and asks for one of its own, billing-api has one.
const ACME = { team: "acme", "team-page": "acme" };
const acmeRun = (page: Page) =>
  page.evaluate(() => {
    const runs = (window as unknown as { __teamMock: { runs: Record<string, { steps: { id: string }[]; onepassword_skipped?: boolean }> } }).__teamMock.runs;
    const r = runs["sean-dev/acme"];
    return r && { steps: r.steps.map((s) => s.id), skipped: !!r.onepassword_skipped };
  });

test("Skip 1Password: the shared keys are typed once, blank ones listed as missing, op never asked", async ({ app }) => {
  const { page } = app;
  await app.open({ params: ACME });
  const list = checklist(page);
  // 1Password is the default when the keys are op:// references.
  await expect(list.getByTestId("op-use")).toHaveAttribute("aria-checked", "true");
  await expect(list.getByTestId("keys-line")).toHaveText("5 from 1Password · 1 to enter");
  await expect(step(page, "1password")).toBeVisible();
  await list.getByTestId("op-skip").click();
  await expect(list.getByTestId("op-skip")).toHaveAttribute("aria-checked", "true");
  await expect(list.getByTestId("op-note")).toContainText("leave it blank");
  // Each shared key is asked for, beside the asked one.
  await expect(list.getByTestId("keys-line")).toHaveText("6 to enter");
  await expect(list.getByTestId("key-input-STRIPE_SECRET_KEY")).toContainText("the team's, from 1Password");
  await expect(list.getByTestId("key-input-MAIL_API_KEY")).toContainText("yours alone");
  await list.getByLabel(/STRIPE_SECRET_KEY/).fill("sk_test_typed");
  await list.getByLabel(/MAIL_API_KEY/).fill("mail-test");
  await expect(list.getByTestId("keys-line")).toHaveText("4 to enter");
  // The plan has no 1Password step, and says the keys are typed.
  await expect(step(page, "1password")).toHaveCount(0);
  await expect(page.getByTestId("plan-keys-skip")).toContainText("1Password skipped");
  await expect(list).toContainText("It signs in to GitHub itself in its own terminal");

  await list.getByTestId("team-run").click();
  await expect(step(page, "update")).toHaveAttribute("data-state", "waiting");
  await advance(page, "sudo");
  await expect(page.getByRole("heading", { name: "You're set up for Acme" })).toBeVisible({ timeout: 25_000 });
  // op was never part of it: no 1Password step ran on the box.
  expect(await acmeRun(page)).toEqual({ steps: ["update", "packages", "docker", "cli", "node", "yarn", "postgres", "redis", "agents", "github"], skipped: true });
  // The blank ones, listed by repo with where to add them; 1Password can come later.
  const missing = page.getByTestId("team-missing-keys");
  await expect(missing).toContainText("Missing keys: add them in Project settings");
  await expect(missing).toContainText("MAPS_API_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET");
  await expect(missing).toContainText("SHOP_API_KEY");
  await expect(missing).not.toContainText("STRIPE_SECRET_KEY");
  await expect(missing).not.toContainText("MAIL_API_KEY");
  await expect(missing.getByTestId("use-1password")).toBeVisible();
  // The project says so too, in its settings.
  await missing.getByRole("button", { name: "Project settings" }).first().click();
  const note = page.getByTestId("project-missing-keys");
  await expect(note).toContainText("MAPS_API_KEY");
  await expect(note.getByTestId("use-1password")).toBeVisible();
  // Use 1Password: the references go back, and op signs in once.
  await note.getByTestId("use-1password").click();
  await expect(step(page, "1password")).toBeVisible();
  await expect.poll(async () => (await acmeRun(page))?.skipped).toBe(false);
});

test("Skip 1Password with every key left blank: all of them are missing, and the setup still finishes", async ({ app }) => {
  const { page } = app;
  await app.open({ params: ACME });
  const list = checklist(page);
  await list.getByTestId("op-skip").click();
  await expect(list.getByTestId("keys-line")).toHaveText("6 to enter");
  await list.getByTestId("team-run").click();
  await expect(step(page, "update")).toHaveAttribute("data-state", "waiting");
  await advance(page, "sudo");
  await expect(page.getByRole("heading", { name: "You're set up for Acme" })).toBeVisible({ timeout: 25_000 });
  const missing = page.getByTestId("team-missing-keys");
  for (const k of ["MAIL_API_KEY", "MAPS_API_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SHOP_API_KEY"]) await expect(missing).toContainText(k);
  expect((await acmeRun(page))?.steps).not.toContain("1password");
});

test("Use 1Password (the default): the keys aren't asked for, and op signs in on the box", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { ...ACME, teamhold: "1password" } });
  const list = checklist(page);
  await expect(list.getByTestId("key-input-STRIPE_SECRET_KEY")).toHaveCount(0);
  await list.getByTestId("team-run").click();
  await expect(step(page, "update")).toHaveAttribute("data-state", "waiting");
  await advance(page, "sudo");
  await expect(step(page, "1password")).toHaveAttribute("data-state", "waiting", { timeout: 15_000 });
  expect(await acmeRun(page)).toMatchObject({ skipped: false });
});

test("a team that requires 1Password: Skip isn't offered, and says why", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { ...ACME, "team-op": "required" } });
  const list = checklist(page);
  await expect(list.getByTestId("op-skip")).toBeDisabled();
  await expect(list.getByTestId("op-note")).toContainText("Acme requires 1Password for its 5 shared keys");
});
