import { type App, expect, mockOnly, test } from "./fixtures";

// A worktree that every agent starts in collects a tab for each session, and
// they outlive the sessions: hundreds of them, saved. Launching on that used
// to mount every tab's pane at once, each with its terminal and chat, which
// took the window to gigabytes and stalled it before anything drew. A pane
// mounts the first time it shows, and stays mounted from then on.

const A = "devl:/home/me/work/shop-checkout-fix";
const OLD = 150;

const tab = (i: number) => ({
  id: `old-${i}`,
  root: { kind: "leaf", id: `old-pane-${i}`, content: { kind: "terminal", box: "devl", session: `old-task-${i}`, agent: "claude", command: "claude", title: `Old task ${i}`, view: "conversation" } },
  focus: `old-pane-${i}`,
});

const saved = {
  current: A,
  shown: [A],
  folded: [],
  tones: {},
  recentUrls: [],
  spaces: {
    [A]: {
      ref: { box: "devl", location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix" },
      tabs: [
        ...Array.from({ length: OLD }, (_, i) => tab(i)),
        { id: "agent-tab", root: { kind: "leaf", id: "own", content: { kind: "terminal", box: "devl", session: "checkout-fix-claude", agent: "claude", command: "claude", view: "terminal" } }, focus: "own" },
      ],
      hidden: [],
      known: ["checkout-fix-claude", "svc-shop-checkout-fix-web", ...Array.from({ length: OLD }, (_, i) => `old-task-${i}`)],
      visitedAt: 1,
      active: "agent-tab",
    },
  },
};

async function openWith(app: App, ws: unknown) {
  await app.context.addInitScript((state) => {
    if (sessionStorage.getItem("e2e.seeded")) return;
    sessionStorage.setItem("e2e.seeded", "1");
    localStorage.setItem("berth.prefs", JSON.stringify({ whatsNewSeen: "999.0.0" }));
    localStorage.setItem("berth.workspaces", JSON.stringify(state));
  }, ws);
  await app.open();
}

// Panes whose content is mounted: a pane not yet shown is an empty box.
const drawn = (app: App) => app.page.locator('[data-testid="pane"]:has(> *)');

test.beforeEach(() => mockOnly("seeds a save of the mock's worktrees"));

test("a worktree with many saved tabs mounts only the one showing, and a tab once shown stays mounted", async ({ app }) => {
  await openWith(app, saved);
  await expect(app.page.getByRole("region", { name: "Claude Code, checkout-fix" })).toBeVisible();
  // Every tab is in the strip, but only the active one has its pane drawn.
  await expect(app.page.getByRole("tab", { name: /Old task 7\b/ })).toHaveCount(1);
  expect(await app.page.locator('[data-testid="pane"]').count()).toBeGreaterThan(OLD);
  await expect(drawn(app)).toHaveCount(1);

  // The active tab's own content, held on to: the same element when it
  // shows again means it stayed mounted (a remount draws a new one).
  const own = await drawn(app).locator('[role="region"]').first().elementHandle();
  if (!own) throw new Error("the active tab's pane drew nothing");

  await app.page.getByRole("tab", { name: /Old task 7\b/ }).click();
  await expect(app.page.getByRole("tab", { name: /Old task 7\b/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawn(app)).toHaveCount(2);
  expect(await own.isVisible()).toBe(false);

  await app.page.getByRole("tab", { name: /Old task 8\b/ }).click();
  await expect(drawn(app)).toHaveCount(3);

  await app.page.getByRole("tab", { name: /Old task 7\b/ }).click();
  await app.page.getByRole("tab", { name: /Fix checkout webhook retries/ }).click();
  await expect.poll(() => own.isVisible()).toBe(true);
  expect(await own.evaluate((el) => el.isConnected)).toBe(true);
  await expect(drawn(app)).toHaveCount(3);
});
