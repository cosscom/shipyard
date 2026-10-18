import type { Page } from "@playwright/test";

import { type App, expect, mockOnly, test } from "./fixtures";

// The sidebar's quiet notice that a box's Shipyard skills aren't installed
// or are out of date (lib/skills-notice.ts, components/sidebar/
// skills-notice.tsx). In the fixtures devl has none for Claude Code and gpu
// has three older ones; old-vps is offline, so it says nothing. One notice
// shows whole and the rest fold under "1 more box". Install now uses the
// box's own install call; Snooze puts a box's notice away until a time, and
// "Don't remind me" until Settings → Agents turns it back on.

test.beforeEach(() => mockOnly("the boxes' skills are mock fixtures"));

// Snoozes end by the wall clock ("tomorrow" is nine the next morning, a
// month is thirty days on at the same time of day), so the page keeps one
// time zone wherever the suite runs: no clocks change under a test.
test.use({ timezoneId: "UTC" });

const card = (page: Page) => page.getByTestId("skills-notices");
const notice = (page: Page, box: string) => page.locator(`[data-testid=skills-notice][data-box="${box}"]`);
const more = (page: Page) => page.getByTestId("skills-notices-more");
const snoozeMenu = (page: Page, box: string) => page.getByRole("button", { name: `Snooze the reminder for ${box}` });

type MockSkills = { refuse(box: string, why?: string): void; allow(box: string): void; drop(box: string): void };
const mock = (page: Page, fn: "refuse" | "allow" | "drop", box: string, why?: string) =>
  page.evaluate(([f, b, w]) => (window as unknown as { __berthMockSkills: MockSkills }).__berthMockSkills[f as "refuse"](b as string, w), [fn, box, why] as const);

// A Monday afternoon, half past three. The clock is the page's own from
// here on: it runs as usual, and a test moves it past a snooze instead of
// waiting.
const MONDAY = new Date(Date.UTC(2026, 9, 12, 15, 30, 0));
async function openAt(app: App, opts: Parameters<App["open"]>[0] = {}) {
  await app.page.clock.install({ time: MONDAY });
  await app.open(opts);
}

async function snooze(page: Page, box: string, choice: string) {
  await snoozeMenu(page, box).click();
  await page.getByRole("menuitem", { name: choice }).click();
  await expect(notice(page, box)).toHaveCount(0);
}

test("the sidebar says which box's skills aren't installed, and folds the others under a count", async ({ app }) => {
  const { page } = app;
  await app.open();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Shipyard's skills" })).toBeVisible();
  await expect(notice(page, "devl")).toContainText("devl: Shipyard's skills aren't installed for Claude Code");
  await expect(notice(page, "devl")).toHaveAttribute("data-kind", "missing");
  await expect(notice(page, "devl").getByRole("button", { name: "Install now" })).toBeVisible();
  // One box whole; gpu waits under the fold, and unfolds.
  await expect(notice(page, "gpu")).toHaveCount(0);
  await expect(more(page)).toHaveText("1 more box");
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await more(page).click();
  await expect(more(page)).toHaveAttribute("aria-expanded", "true");
  await expect(notice(page, "gpu")).toContainText("gpu: 3 skills are out of date");
  await expect(notice(page, "gpu")).toHaveAttribute("data-kind", "outdated");
  await expect(notice(page, "gpu").getByRole("button", { name: "Update now" })).toBeVisible();
  // old-vps is offline: nothing about it.
  await expect(page.getByTestId("skills-notice")).toHaveCount(2);
  await expect(notice(page, "old-vps")).toHaveCount(0);
  // Quiet: no toast, and the bell counts nothing for it.
  await expect(page.locator("[data-slot=toast-title]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName("Notifications");
});

test("a new account with no boxes has no notice", async ({ app }) => {
  const { page } = app;
  await page.goto("/?mock=1&fresh=1");
  // Onboarding, once the app has heard there are no boxes.
  await expect(page.locator("main")).toContainText(/box/i);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("skills-notices-rail")).toHaveCount(0);
});

test("Install now installs the skills for the box's user, and the notice goes", async ({ app }) => {
  const { page } = app;
  await app.open();
  const devl = notice(page, "devl");
  await devl.getByRole("button", { name: "Install now" }).click();
  await expect(devl).toHaveCount(0);
  // gpu's takes its place, with nothing left to fold.
  await expect(notice(page, "gpu")).toContainText("gpu: 3 skills are out of date");
  await expect(more(page)).toHaveCount(0);
  // Settings → Agents agrees: nothing left to install on devl.
  const agents = await app.openSettings("agents");
  await expect(agents.getByRole("button", { name: "All installed" })).toBeVisible();
});

test("Install now says it is installing while the box works, and takes no second click", async ({ app }) => {
  const { page } = app;
  await openAt(app);
  const devl = notice(page, "devl");
  await expect(devl).toHaveAttribute("data-state", "idle");
  // The clock stops, so the box's answer waits until it is let through.
  await page.clock.pauseAt(new Date(MONDAY.getTime() + 60_000));
  await devl.getByRole("button", { name: "Install now" }).click();
  await expect(devl).toHaveAttribute("data-state", "installing");
  await expect(devl.getByRole("button", { name: "Installing…" })).toBeDisabled();
  await expect(snoozeMenu(page, "devl")).toBeDisabled();
  await expect(devl.getByRole("status")).toHaveText("Installing Shipyard's skills on devl…");
  await page.clock.resume();
  await expect(devl).toHaveCount(0);
});

test("Update now brings older skills up to date, and the last notice takes the card with it", async ({ app }) => {
  const { page } = app;
  await app.open();
  await more(page).click();
  await notice(page, "gpu").getByRole("button", { name: "Update now" }).click();
  await expect(notice(page, "gpu")).toHaveCount(0);
  await expect(notice(page, "devl")).toBeVisible();
  await notice(page, "devl").getByRole("button", { name: "Install now" }).click();
  await expect(card(page)).toHaveCount(0);
});

test("a hook that refuses the install is said in the notice, with Retry and the way to the box's skills in Settings", async ({ app }) => {
  const { page } = app;
  await app.open();
  await mock(page, "refuse", "gpu", "skills on this box are installed by the platform team");
  await more(page).click();
  const gpu = notice(page, "gpu");
  await gpu.getByRole("button", { name: "Update now" }).click();
  await expect(gpu).toHaveAttribute("data-state", "failed");
  await expect(gpu).toContainText("gpu: couldn't update Shipyard's skills");
  await expect(page.getByTestId("skills-notice-error")).toContainText("A hook said no. Skills on this box are installed by the platform team.");
  // Said in place, not in a toast.
  await expect(page.locator("[data-slot=toast-title]")).toHaveCount(0);
  // Still refused: it says so again.
  await gpu.getByRole("button", { name: "Retry" }).click();
  await expect(gpu).toHaveAttribute("data-state", "failed");
  // Settings opens on gpu's skills, not the first box's.
  await gpu.getByRole("button", { name: "Settings" }).click();
  const agents = page.getByTestId("settings-agents");
  await expect(agents.getByTestId("skills-reminder")).toContainText("Remind me about gpu's skills");
  await expect(agents.getByRole("button", { name: "Install all" })).toBeVisible();
  // Once the hook lets it through, Retry finishes the job.
  await mock(page, "allow", "gpu");
  // Settings has the window; the notice is back in the sidebar once it closes.
  await app.leaveSettings();
  await gpu.getByRole("button", { name: "Retry" }).click();
  await expect(gpu).toHaveCount(0);
  const again = await app.openSettings("agents");
  await again.getByRole("button", { name: "gpu", exact: true }).click();
  await expect(again.getByRole("button", { name: "All installed" })).toBeVisible();
});

test("a box that goes offline mid-install keeps its notice, saying it can't be reached", async ({ app }) => {
  const { page } = app;
  await app.open();
  await mock(page, "drop", "devl");
  const devl = notice(page, "devl");
  await devl.getByRole("button", { name: "Install now" }).click();
  await expect(devl).toHaveAttribute("data-state", "failed");
  await expect(devl).toContainText("devl: couldn't install Shipyard's skills");
  await expect(page.getByTestId("skills-notice-error")).toContainText("Can't reach devl. It may be asleep or offline.");
  await expect(devl.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(devl.getByRole("button", { name: "Settings" })).toBeVisible();
  // Still away: trying again keeps the notice where it is, and says so again.
  await devl.getByRole("button", { name: "Retry" }).click();
  await expect(devl).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("skills-notice-error")).toContainText("Can't reach devl.");
  // It can still be put away.
  await snooze(page, "devl", "Until tomorrow");
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// forward moves the page's clock on. The clock takes at most some 24 days
// at a time (a 32-bit count of milliseconds), so a month goes in steps.
async function forward(page: Page, ms: number) {
  for (let left = ms; left > 0; left -= 20 * DAY) await page.clock.fastForward(Math.min(left, 20 * DAY));
}

// Each choice: quiet until just before its time (tomorrow at nine is 17
// and a half hours off), back just after.
const CHOICES: [choice: string, quietFor: number][] = [
  ["Until tomorrow", 17 * HOUR],
  ["For a week", 7 * DAY - 30 * MINUTE],
  ["For a month", 30 * DAY - 30 * MINUTE],
];
for (const [choice, quietFor] of CHOICES) {
  test(`Snooze › ${choice} puts one box's notice away, and it returns once the time has passed`, async ({ app }) => {
    const { page } = app;
    await openAt(app);
    await snooze(page, "devl", choice);
    // The other box keeps its notice.
    await expect(notice(page, "gpu")).toBeVisible();
    await expect(more(page)).toHaveCount(0);
    await forward(page, quietFor);
    await expect(notice(page, "gpu")).toBeVisible();
    await expect(notice(page, "devl")).toHaveCount(0);
    await forward(page, 45 * MINUTE);
    await expect(notice(page, "devl")).toContainText("devl: Shipyard's skills aren't installed for Claude Code");
  });
}

test("a snooze made while skills were out of date holds through the next upgrade, then reminds again", async ({ app }) => {
  const { page } = app;
  await openAt(app);
  await more(page).click();
  await snooze(page, "gpu", "Until tomorrow");
  // gpu runs an older berthd; updating it leaves every skill it has older
  // than the new berthd ships.
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByText("gpu is up to date")).toBeVisible({ timeout: 20_000 });
  const agents = await app.openSettings("agents");
  await agents.getByRole("button", { name: "gpu", exact: true }).click();
  await expect(agents.getByRole("button", { name: "Update", exact: true }).first()).toBeVisible();
  await expect(agents.getByTestId("skills-reminder")).toContainText(/Snoozed until tomorrow at 9:00.*while its skills are out of date/);
  // Still snoozed.
  await app.leaveSettings();
  await expect(notice(page, "gpu")).toHaveCount(0);
  await expect(more(page)).toHaveCount(0);
  // The next morning it says so again, with what the upgrade left.
  await forward(page, 18 * HOUR);
  await expect(notice(page, "gpu")).toContainText("gpu: 7 skills are out of date");
  await expect(notice(page, "gpu").getByRole("button", { name: "Update now" })).toBeVisible();
});

test("Settings → Agents shows a snooze and ends it with Remind me now", async ({ app }) => {
  const { page } = app;
  await openAt(app);
  await snooze(page, "devl", "For a week");
  const agents = await app.openSettings("agents");
  const row = agents.getByTestId("skills-reminder");
  await expect(row).toContainText("Remind me about devl's skills");
  await expect(row).toContainText(/Snoozed until (19 October|October 19), while its skills aren't installed\./);
  await row.getByRole("button", { name: "Remind me now" }).click();
  await expect(row.getByRole("button", { name: "Remind me now" })).toHaveCount(0);
  await app.leaveSettings();
  await expect(notice(page, "devl")).toBeVisible();
});

test("Don't remind me for a box holds until Settings → Agents turns it back on", async ({ app }) => {
  const { page } = app;
  await openAt(app);
  await snoozeMenu(page, "devl").click();
  await page.getByRole("menuitem", { name: "Don't remind me for devl" }).click();
  await expect(notice(page, "devl")).toHaveCount(0);
  // Said once, with the way back.
  await expect(page.getByText("No more reminders about devl's skills")).toBeVisible();
  await expect(page.getByText("Settings → Agents turns them back on.")).toBeVisible();
  // No time brings it back.
  await forward(page, 90 * DAY);
  await expect(notice(page, "gpu")).toBeVisible();
  await expect(notice(page, "devl")).toHaveCount(0);
  const agents = await app.openSettings("agents");
  const row = agents.getByTestId("skills-reminder");
  const remind = row.getByRole("switch", { name: "Remind me about devl's skills" });
  await expect(remind).not.toBeChecked();
  await expect(row).toContainText("Off. The sidebar says nothing about devl's skills until you turn this back on.");
  // gpu's reminder is its own.
  await agents.getByRole("button", { name: "gpu", exact: true }).click();
  await expect(row.getByRole("switch", { name: "Remind me about gpu's skills" })).toBeChecked();
  await agents.getByRole("button", { name: "devl", exact: true }).click();
  await remind.click();
  await expect(remind).toBeChecked();
  await app.leaveSettings();
  await expect(notice(page, "devl")).toContainText("devl: Shipyard's skills aren't installed for Claude Code");
});

test("Don't remind me can be undone where it is said", async ({ app }) => {
  const { page } = app;
  await app.open();
  await snoozeMenu(page, "devl").click();
  await page.getByRole("menuitem", { name: "Don't remind me for devl" }).click();
  await expect(notice(page, "devl")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(notice(page, "devl")).toBeVisible();
});

test("the switch in Settings turns a box's reminder off, too", async ({ app }) => {
  const { page } = app;
  await app.open();
  await expect(notice(page, "devl")).toBeVisible();
  const agents = await app.openSettings("agents");
  const remind = agents.getByRole("switch", { name: "Remind me about devl's skills" });
  await expect(remind).toBeChecked();
  await remind.click();
  await expect(remind).not.toBeChecked();
  await app.leaveSettings();
  await expect(notice(page, "devl")).toHaveCount(0);
  await expect(notice(page, "gpu")).toBeVisible();
});

test("installing from Settings → Agents puts the sidebar's notice away", async ({ app }) => {
  const { page } = app;
  await app.open();
  await expect(notice(page, "devl")).toBeVisible();
  const agents = await app.openSettings("agents");
  await agents.getByRole("button", { name: "Install all" }).click();
  await expect(agents.getByRole("button", { name: "All installed" })).toBeVisible();
  await app.leaveSettings();
  await expect(notice(page, "devl")).toHaveCount(0);
  await expect(notice(page, "gpu")).toBeVisible();
});

test("the notice works from the keyboard", async ({ app }) => {
  const { page } = app;
  await app.open();
  const devl = notice(page, "devl");
  // Its buttons are named by their box for a screen reader.
  await expect(page.getByRole("group", { name: "devl: Shipyard's skills aren't installed for Claude Code" })).toBeVisible();
  await devl.getByRole("button", { name: "Install now" }).focus();
  await page.keyboard.press("Tab");
  await expect(snoozeMenu(page, "devl")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText(["Until tomorrow", "For a week", "For a month", "Don't remind me for devl"]);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "For a week" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(devl).toHaveCount(0);
  // The fold is a button too.
  await expect(notice(page, "gpu")).toBeVisible();
});

test("the folded sidebar keeps the notice as one quiet button that opens it", async ({ app }) => {
  const { page } = app;
  await app.open();
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  const rail = page.getByTestId("sidebar-rail");
  const button = rail.getByTestId("skills-notices-rail");
  await expect(button).toHaveAccessibleName("Shipyard's skills need installing or updating on 2 boxes");
  await button.click();
  const list = card(page);
  await expect(list.getByTestId("skills-notice")).toHaveCount(2);
  await expect(notice(page, "devl")).toContainText("devl: Shipyard's skills aren't installed for Claude Code");
  await expect(notice(page, "gpu")).toContainText("gpu: 3 skills are out of date");
  await notice(page, "devl").getByRole("button", { name: "Install now" }).click();
  await expect(notice(page, "devl")).toHaveCount(0);
  // One box left: the button says which.
  await expect(button).toHaveAccessibleName("gpu: 3 skills are out of date");
  await snoozeMenu(page, "gpu").click();
  await page.getByRole("menuitem", { name: "Until tomorrow" }).click();
  await expect(button).toHaveCount(0);
});

test("the folded sidebar's Settings goes to the box's skills after a refusal", async ({ app }) => {
  const { page } = app;
  await app.open();
  await mock(page, "refuse", "gpu");
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await page.getByTestId("skills-notices-rail").click();
  await notice(page, "gpu").getByRole("button", { name: "Update now" }).click();
  await expect(notice(page, "gpu")).toHaveAttribute("data-state", "failed");
  await notice(page, "gpu").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-agents").getByTestId("skills-reminder")).toContainText("Remind me about gpu's skills");
  // The notices close as Settings opens.
  await expect(card(page)).toHaveCount(0);
});
