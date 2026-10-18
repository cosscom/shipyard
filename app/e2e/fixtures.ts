import { type BrowserContext, expect, type Locator, type Page, test as base } from "@playwright/test";

// The smoke suite's shared setup. Every test opens the production build
// (vite preview) in its own browser context, so storage starts empty unless
// a test seeds it, and fails if the page throws (pageerror).
//
// Mock mode (the default) runs the app on its fixtures (?mock, src/lib/
// mock*.ts), which are fixed: tests wait on what they expect to see, never
// on time. BERTH_E2E_LIVE=1 (pnpm smoke:live, e2e/live.mjs) runs the same
// tests against the real laptop agent, read only: only GETs reach it,
// terminals don't attach, and tests that need a fixture or would write
// something skip themselves (mockOnly).
//
// Stable hooks, so tests never click text that moves: data-testid where
// nothing else was stable (worktree-row with data-worktree="box/name",
// nav-<id>, nav-more, nav-badge, pane with data-pane-kind, chat, chat-item with data-kind,
// composer, question-form, queued-reply, artifacts-chip/-popover,
// attachment-chip, panel with data-panel, browser-pane with data-mode,
// chat-background, header-picture with data-picture, header-picture-settings, settings-nav-<id>, settings-<id>, theme-option with
// data-theme-id, plugin-row and market-plugin with data-plugin,
// market-error, zoom-hud, leadline with data-leadline and data-state, and
// its leadline-row, -detail, -notice, -box, database with data-state, and
// its database-table, -row with data-row and cells with data-col, -notice,
// -lock with data-writes, -staged, -review, -console, -box, skills-notices
// and its skills-notice with data-box, data-kind and data-state,
// skills-notices-more and -rail, skills-reminder), and the attributes the
// app already keys on
// (data-tab, data-ws, data-group, data-tab-strip, data-pane-area).

export const live = process.env.BERTH_E2E_LIVE === "1";
const token = process.env.BERTH_E2E_TOKEN ?? "";
const agentUrl = process.env.BERTH_E2E_AGENT ?? "http://127.0.0.1:1378";

// The laptop agent's ports: the proxy (1377), the app's API (1378) and its
// spare (1379). A mock test must never reach them.
const AGENT = /^https?:\/\/(?:[^/]*\.)?(?:localhost|127\.0\.0\.1|\[::1\]):(?:1377|1378|1379)(?:\/|$)/;
// A worktree's page through the proxy (http://3001.checkout-fix.shop.devl.localhost:1377/):
// mock browser panes load a stand-in instead.
const PROXIED = /^https?:\/\/[^/]+\.localhost:1377(?:\/|$)/;
export const STUB_PAGE = "<!doctype html><title>stub</title><h1>Stub dev server</h1>";

export interface OpenOptions {
  // berth.prefs as an older Shipyard saved it (lib/prefs.ts), before the app starts.
  prefs?: Record<string, unknown>;
  // berth.ui's theme (lib/store.ts).
  theme?: string;
  // Extra query parameters: view=conversation, fresh, labs…
  params?: Record<string, string>;
  // A stand-in agent (e2e/fake-agent.ts) to connect to instead of the
  // mock fixtures.
  agent?: { url: string; token: string };
}

export interface App {
  page: Page;
  context: BrowserContext;
  open(opts?: OpenOptions): Promise<void>;
  // A worktree in the sidebar, as box/name (the main checkout by its project's name).
  worktree(boxAndName: string): Locator;
  openWorktree(boxAndName: string): Promise<void>;
  // The panes showing now, and the conversation in the one in front.
  panes: Locator;
  chat: Locator;
  composer: Locator;
  openSettings(section: string): Promise<Locator>;
  // What the app has saved, as JSON.
  stored(key: string): Promise<unknown>;
  // Back from Settings to the sidebar, when Settings is open.
  leaveSettings(): Promise<void>;
  // Requests that tried to reach the laptop agent from a mock test.
  agentCalls: string[];
}

export const test = base.extend<{ app: App }>({
  context: async ({ context }, use) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await use(context);
  },
  app: async ({ page, context }, use, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
    const agentCalls: string[] = [];
    const writes: string[] = [];
    if (live) {
      // Read only: the agent answers GETs; anything else is refused here,
      // so a smoke run never changes the person's boxes or settings. What
      // was refused is listed on the test (the app records small things on
      // its own, such as its terminal renderer, and carries on without).
      await context.route(AGENT, (route) => {
        const r = route.request();
        if (r.method() === "GET" || r.method() === "HEAD" || r.method() === "OPTIONS") return route.continue();
        writes.push(`${r.method()} ${r.url().replace(/token=[^&]+/, "token=…")}`);
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "the smoke suite is read only" }) });
      });
      // Terminals stay unattached: attaching resizes the person's sessions.
      await context.routeWebSocket(/\/attach(?:\?|$)/, (ws) => ws.close({ code: 1000, reason: "the smoke suite doesn't attach terminals" }));
    } else {
      await context.route(PROXIED, (route) => route.fulfill({ status: 200, contentType: "text/html", body: STUB_PAGE }));
      await context.route(AGENT, (route) => {
        if (PROXIED.test(route.request().url())) return route.fallback();
        agentCalls.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort();
      });
    }

    const app: App = {
      page,
      context,
      agentCalls,
      async open(opts = {}) {
        if (opts.prefs || opts.theme) {
          // Seeded once, before the app's own scripts, as storage left by
          // an earlier run would be; a reload keeps what the app saved.
          await context.addInitScript(
            ({ prefs, theme }) => {
              if (sessionStorage.getItem("e2e.seeded")) return;
              sessionStorage.setItem("e2e.seeded", "1");
              if (prefs) localStorage.setItem("berth.prefs", JSON.stringify(prefs));
              if (theme) localStorage.setItem("berth.ui", JSON.stringify({ themeId: theme }));
            },
            // Prefs an older Shipyard saved would get the What's new note
            // after an update; it stays away unless a test asks for it
            // (whats-new.spec.ts).
            { prefs: opts.prefs && { whatsNewSeen: "999.0.0", ...opts.prefs }, theme: opts.theme },
          );
        }
        const q = new URLSearchParams(opts.agent ? { token: opts.agent.token, agent: opts.agent.url } : live ? { token, agent: agentUrl } : { mock: "1" });
        for (const [k, v] of Object.entries(opts.params ?? {})) q.set(k, v);
        await page.goto(`/?${q}`);
        // Connected: the sidebar's places are there and not dimmed.
        await expect(page.getByTestId("nav-home")).toBeVisible();
        await expect(page.locator("[aria-disabled=true]:has([data-testid=nav-home])")).toHaveCount(0);
      },
      worktree: (w) => page.locator(`[data-testid=worktree-row][data-worktree="${w}"]`),
      async openWorktree(w) {
        await app.leaveSettings();
        const row = app.worktree(w);
        // A real fleet folds worktrees with nothing going on under
        // "Show N older" (smoke:live): unfold them to find this one.
        const more = page.getByText(/^Show \d+ older$/);
        // Both may show at once: the row, and a fold with others under it.
        await expect(row.or(more).first()).toBeVisible();
        if (!(await row.isVisible())) {
          while ((await more.count()) > 0 && !(await row.isVisible())) await more.first().click();
        }
        // On its title: a narrow row's middle can be under its + and ⋯.
        await row.click({ position: { x: 32, y: 12 } });
        await expect(row).toHaveAttribute("data-active", "true");
      },
      panes: page.locator("[data-testid=pane]:visible"),
      chat: page.locator("[data-testid=pane]:visible [data-testid=chat]"),
      composer: page.locator("[data-testid=pane]:visible [data-testid=composer]"),
      async openSettings(section) {
        // Already in Settings, its own nav has the section.
        if (await page.getByTestId("nav-settings").isVisible()) await page.getByTestId("nav-settings").click();
        await page.getByTestId(`settings-nav-${section}`).click();
        const body = page.getByTestId(`settings-${section}`);
        await expect(body).toBeVisible();
        return body;
      },
      stored: (key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key),
      // Settings draws its own nav where the sidebar is; Back to app brings
      // the sidebar back. Nothing happens when Settings isn't open.
      async leaveSettings() {
        const back = page.getByRole("button", { name: "Back to app" });
        if (await back.isVisible()) {
          await back.click();
          await expect(page.getByTestId("nav-home")).toBeVisible();
        }
      },
    };

    await use(app);

    if (errors.length) await info.attach("pageerrors", { body: errors.join("\n"), contentType: "text/plain" });
    expect(errors, "the page threw").toEqual([]);
    expect(agentCalls, "a mock test reached the laptop agent").toEqual([]);
    for (const w of writes) info.annotations.push({ type: "refused", description: w });
  },
});

// mockOnly skips a test that needs a fixture or would write to a box.
export const mockOnly = (why = "needs the mock fixtures") => test.skip(live, why);

export { expect };

// A worktree with an agent in it, for live runs: the first one the sidebar
// lists with an agent's glyph, unless BERTH_E2E_WORKTREE names one.
export async function agentWorktree(app: App, mock: string): Promise<string> {
  if (!live) return mock;
  if (process.env.BERTH_E2E_WORKTREE) return process.env.BERTH_E2E_WORKTREE;
  const rows = app.page.locator("[data-testid=worktree-row]");
  const more = app.page.getByText(/^Show \d+ older$/);
  await expect(rows.or(more).first()).toBeVisible();
  // Worktrees with nothing going on are folded away: unfold them all.
  while ((await more.count()) > 0) await more.first().click();
  for (const row of await rows.all()) {
    if (await row.locator("svg.lucide-asterisk, [role=img]").count()) return (await row.getAttribute("data-worktree")) ?? mock;
  }
  return (await rows.first().getAttribute("data-worktree")) ?? mock;
}
