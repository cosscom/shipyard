import { expect, type App, mockOnly, test } from "./fixtures";

// The board's bulk Stop asks, then carries on in the background-jobs tray,
// its dialog gone at once. It can archive the stopped agents' worktrees
// too, where it's safe. Each box with runs does its share itself, as a stop
// run that waits for an archive script to finish; with ?noruns the boxes
// are older ones and the app does it all, as it used to. In the fixtures
// shop on devl has an archive script, so an archive runs it first;
// ci-flake on gpu has none, so it goes at once (slowly, with ?slowremove);
// checkout-fix has uncommitted work, so git keeps it; order-export has
// three agents, so stopping one leaves the others there.

const prefs = { labs: false, labsChosen: true, version: 3 };

// A card on the board, picked while selecting (or opened otherwise).
const pick = (app: App, title: string) => app.page.locator("article[role=button]", { hasText: title }).getByText(title).click();

async function stopPicked(app: App, titles: string[]) {
  const { page } = app;
  await page.getByTestId("nav-home").click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const t of titles) await pick(app, t);
  await page.getByRole("button", { name: `Stop ${titles.length}…` }).click();
  return page.getByRole("alertdialog");
}

const archiveBox = (app: App) => app.page.getByRole("checkbox", { name: /Archive their worktrees where it's safe/ });
const tray = (app: App) => app.page.getByRole("region", { name: "Background jobs" });
const job = (app: App, title: string) => tray(app).getByRole("group", { name: title });
const jobRow = (app: App, title: string, label: string) => job(app, title).getByRole("listitem").filter({ hasText: label });
const toast = (app: App, text: string) => app.page.locator("[data-slot=toast-viewport] > *", { hasText: text });

test("ticked, Stop closes at once; the tray shows the run, folds, and reports the kept worktree", async ({ app }) => {
  mockOnly("stops agents and archives worktrees");
  // gpu takes 3 s to remove a worktree, as one with a big node_modules does.
  await app.open({ prefs, params: { slowremove: "3000" } });
  const dialog = await stopPicked(app, ["Speed up product search", "Move acme billing to the new ledger", "Fix checkout webhook retries"]);
  await expect(archiveBox(app)).not.toBeChecked();
  await archiveBox(app).click();
  await expect(dialog).toContainText("then its worktree is archived where it's safe");
  await dialog.getByRole("button", { name: "Stop 3 agents" }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });

  // Mid-run: the title counts, and the slow one says it is archiving.
  const running = job(app, "Stopping 3 agents");
  await expect(running).toContainText(/Stopping 3 agents · [0-2]\/3/);
  await expect(jobRow(app, "Stopping 3 agents", "ci-flake")).toContainText("Archiving…");

  // Folded, it is one line; the choice is remembered.
  await running.getByRole("button", { name: "Fold" }).click();
  const pill = tray(app).getByRole("button", { expanded: false });
  await expect(pill).toContainText(/Stopping 3 agents · [0-2]\/3/);
  await expect.poll(() => app.stored("berth.jobs.folded")).toBe(true);
  await pill.click();

  // Kept work makes a report that lists only it, until it's dismissed. The
  // box waited for search-perf's archive script: archived, not archiving.
  await expect(running).toContainText("3 stopped, 2 archived, 1 kept", { timeout: 10_000 });
  await expect(running.getByRole("listitem")).toHaveCount(1);
  await expect(jobRow(app, "Stopping 3 agents", "checkout-fix")).toContainText("Stopped · Kept: uncommitted changes");
  await running.getByRole("button", { name: "Dismiss" }).click();
  await expect(tray(app)).toHaveCount(0);

  // The clean ones go (search-perf once its script has run); the dirty one stays.
  await expect(app.worktree("gpu/ci-flake")).toHaveCount(0, { timeout: 10_000 });
  await expect(app.worktree("devl/search-perf")).toHaveCount(0, { timeout: 10_000 });
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
});

test("on boxes without runs the app does it: an archive script says archiving until the box says it's gone", async ({ app }) => {
  mockOnly("stops agents and archives worktrees");
  await app.open({ prefs, params: { noruns: "1", slowremove: "3000" } });
  const dialog = await stopPicked(app, ["Speed up product search", "Move acme billing to the new ledger", "Fix checkout webhook retries"]);
  await archiveBox(app).click();
  await dialog.getByRole("button", { name: "Stop 3 agents" }).click();
  const running = job(app, "Stopping 3 agents");
  await expect(jobRow(app, "Stopping 3 agents", "ci-flake")).toContainText("Archiving…");
  // search-perf's archive script runs on: its row says so, and the job
  // holds devl's line until the box says the worktree went.
  await expect(jobRow(app, "Stopping 3 agents", "search-perf")).toContainText("Stopped · Archiving: its archive script runs, then it goes", { timeout: 10_000 });
  await expect(running).toContainText("3 stopped, 2 archived, 1 kept", { timeout: 10_000 });
  await expect(jobRow(app, "Stopping 3 agents", "checkout-fix")).toContainText("Stopped · Kept: uncommitted changes");
  await expect(app.worktree("gpu/ci-flake")).toHaveCount(0, { timeout: 10_000 });
  await expect(app.worktree("devl/search-perf")).toHaveCount(0, { timeout: 10_000 });
});

test("a worktree where another agent still runs is kept, and the report says so", async ({ app }) => {
  mockOnly("stops agents and archives worktrees");
  await app.open({ prefs });
  const dialog = await stopPicked(app, ["Export orders as CSV from the admin"]);
  await archiveBox(app).click();
  await dialog.getByRole("button", { name: "Stop 1 agent" }).click();
  await expect(dialog).toBeHidden({ timeout: 1000 });
  await expect(job(app, "Stopping 1 agent")).toContainText("1 stopped, 1 kept");
  await expect(jobRow(app, "Stopping 1 agent", "order-export")).toContainText("Kept: another agent is still running there");
  await expect(app.worktree("devl/order-export")).toBeVisible();
});

test("unticked, a clean run only stops, says so in a toast, and fades from the tray", async ({ app }) => {
  mockOnly("stops agents");
  await app.open({ prefs });
  const dialog = await stopPicked(app, ["Speed up product search"]);
  await expect(dialog).toContainText("its worktree and files are kept");
  await dialog.getByRole("button", { name: "Stop 1 agent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toast(app, "Stopped 1 agent")).toContainText("Their worktrees are kept.");
  await expect(job(app, "Stopping 1 agent")).toContainText("1 stopped");
  await expect(job(app, "Stopping 1 agent").getByRole("listitem")).toHaveCount(0);
  await expect(tray(app)).toHaveCount(0, { timeout: 15_000 });
  await expect(app.worktree("devl/search-perf")).toBeVisible();
});

test("Stop the rest sends no more; the ones already asked stop, the rest say Not stopped", async ({ app }) => {
  mockOnly("stops agents");
  // Each stop takes 2 s to answer, so devl's run has three in flight and
  // two waiting.
  await app.open({ prefs, params: { slowstop: "2000" } });
  const dialog = await stopPicked(app, ["Speed up product search", "Build the QA deck for the release", "Export orders as CSV from the admin", "Add tests for the export job", "Fix the cart badge after a refund"]);
  await dialog.getByRole("button", { name: "Stop 5 agents" }).click();
  const running = job(app, "Stopping 5 agents");
  await expect(running.getByRole("listitem").filter({ hasText: "Stopping…" })).toHaveCount(3);
  await running.getByRole("button", { name: "Stop the rest" }).click();
  await expect(running).toContainText("3 stopped, 2 not stopped", { timeout: 10_000 });
  await expect(running.getByRole("listitem").filter({ hasText: "Not stopped" })).toHaveCount(2);
});

test("the job carries on when you leave the board", async ({ app }) => {
  mockOnly("stops agents and archives worktrees");
  await app.open({ prefs, params: { slowremove: "2000" } });
  const dialog = await stopPicked(app, ["Move acme billing to the new ledger"]);
  await archiveBox(app).click();
  await dialog.getByRole("button", { name: "Stop 1 agent" }).click();
  await expect(jobRow(app, "Stopping 1 agent", "ci-flake")).toContainText("Archiving…");
  await app.page.getByTestId("nav-worktrees").click();
  await expect(app.page.getByRole("heading", { name: "Agent Dashboard" })).toHaveCount(0);
  await expect(job(app, "Stopping 1 agent")).toContainText("1 stopped, 1 archived", { timeout: 10_000 });
  await expect(toast(app, "Stopped 1 agent · archived 1 worktree")).toContainText("Their branches are kept.");
});

test("the archive choice is remembered, and not offered for the main checkout alone", async ({ app }) => {
  mockOnly("stops agents");
  await app.open({ prefs });
  let dialog = await stopPicked(app, ["Speed up product search"]);
  await archiveBox(app).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.stored("berth.dashboard.stopArchives")).toBe(true);

  await app.page.getByRole("button", { name: "Stop 1…" }).click();
  dialog = app.page.getByRole("alertdialog");
  await expect(archiveBox(app)).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Only gpu's main checkout: there is nothing to archive.
  await pick(app, "Speed up product search");
  await pick(app, "Plan the checkout release");
  await app.page.getByRole("button", { name: "Stop 1…" }).click();
  await expect(app.page.getByRole("alertdialog")).toContainText("its worktree and files are kept");
  await expect(archiveBox(app)).toHaveCount(0);
});

test("the Worktrees table's Stop sessions and Archive go through the box's stop run", async ({ app }) => {
  mockOnly("stops sessions and archives worktrees");
  await app.open({ prefs });
  const { page } = app;
  await page.getByTestId("nav-worktrees").click();
  const select = (name: string) => page.getByRole("checkbox", { name: `Select ${name}` }).locator("xpath=..").click();
  await select("order-export");
  await page.getByRole("button", { name: "Stop sessions" }).click();
  const bar = page.getByRole("status").filter({ hasText: "Stop sessions:" });
  await expect(bar).toContainText("Stop sessions: 1 done", { timeout: 10_000 });
  await bar.getByRole("button", { name: "Dismiss" }).click();
  await select("order-export");
  await select("search-perf");
  await select("checkout-fix");
  // devl's loop panel sits over the bar's right end: by keyboard, as a person can.
  await page.getByRole("button", { name: "Archive…" }).press("Enter");
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Archive 2" }).click();
  // search-perf goes once shop's archive script ran; checkout-fix keeps its work.
  await expect(dialog).toContainText("Archived 1 of 2", { timeout: 15_000 });
  await expect(dialog).toContainText("Has uncommitted changes");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Select search-perf" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("checkbox", { name: "Select checkout-fix" })).toBeVisible();
});
