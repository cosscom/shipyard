import type { Locator, Page } from "@playwright/test";

import { openBrowser } from "./a11y-scenes";
import { type App, agentWorktree, expect, live, mockOnly, test } from "./fixtures";

// The core flows with the keyboard alone: Tab and Shift-Tab, arrows, Enter,
// Esc and the documented shortcuts (lib/shortcuts.json). After every step
// the keyboard is somewhere (never on <body>), and where it is shows.
// Motion is reduced, so a focus ring is drawn at once.

test.use({ reducedMotion: "reduce" });

// focused says what has the keyboard, or null when it fell to <body>.
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || !a.isConnected) return null;
    return { tag: a.tagName.toLowerCase(), label: a.getAttribute("aria-label") ?? "", testid: a.closest("[data-testid]")?.getAttribute("data-testid") ?? "" };
  });

async function notLost(page: Page) {
  await expect.poll(() => focused(page), { message: "the keyboard fell to <body>" }).not.toBeNull();
}

// shows says focusing what has the keyboard changes how it, its parent or
// their ::before and ::after look: a ring, an outline, a border, a fill.
const shows = (page: Page) =>
  page.evaluate(async () => {
    const el = document.activeElement as HTMLElement;
    const chain = [el, el.parentElement, el.parentElement?.parentElement].filter((e): e is HTMLElement => !!e);
    const snap = () =>
      chain
        .flatMap((e) => [getComputedStyle(e), getComputedStyle(e, "::before"), getComputedStyle(e, "::after")])
        .map((c) => [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderColor, c.backgroundColor, c.opacity].join("|"))
        .join("#");
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    // A ring may fade in (a transition, even reduced, ends a frame or two on).
    await new Promise((r) => setTimeout(r, 200));
    const on = snap();
    el.blur();
    await new Promise((r) => setTimeout(r, 200));
    const off = snap();
    el.focus({ preventScroll: true });
    await frame();
    return on !== off;
  });

// press presses key until target has the keyboard, at most max times.
async function pressTo(page: Page, target: Locator, key = "Tab", max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`${key} never reached ${target}`);
}

const chat = async (app: App, wt: string) => {
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree(await agentWorktree(app, wt));
  await expect(app.chat).toBeVisible();
};

test("start a task from Home with the keyboard", async ({ app }) => {
  mockOnly("starts an agent");
  await app.open();
  const page = app.page;
  const box = page.getByTestId("task-composer").getByRole("textbox").first();
  await box.focus();
  await page.keyboard.type("Fix the flaky export test");
  // Tab walks the composer's choices to Start; each shows it has the keyboard.
  const start = page.getByTestId("task-composer").getByRole("button", { name: "Start" });
  for (let i = 0; i < 8 && !(await start.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
    expect(await shows(page), `focus shows on ${JSON.stringify(await focused(page))}`).toBe(true);
  }
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  // The new task's pane opens and has the keyboard.
  await expect(app.panes.first()).toBeVisible();
  await notLost(page);
});

test("Tab and Shift-Tab on Home: every stop shows, none is lost", async ({ app }) => {
  await app.open();
  const page = app.page;
  await page.getByTestId("sidebar-handle").focus();
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (!f) break; // past the window's last control
    seen.push(`${f.tag}:${f.label || f.testid}`);
    expect(await shows(page), `focus shows on ${seen.at(-1)}`).toBe(true);
  }
  expect(seen.length).toBeGreaterThan(10);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    await notLost(page);
  }
});

test("answer a question and reply in a chat with the keyboard", async ({ app }) => {
  mockOnly("answers a question on a box");
  await chat(app, "gpu/shop");
  const page = app.page;
  const form = app.chat.getByTestId("question-form");
  const reply = app.composer.getByRole("textbox", { name: "Reply" });
  await reply.focus();
  // Back from the reply box to the form's first choice; arrows pick.
  const first = form.getByRole("radio").first();
  await pressTo(page, first, "Shift+Tab");
  await page.keyboard.press("ArrowDown");
  await expect(form.getByRole("radio", { name: /Next minor/ })).toBeChecked();
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();
  await pressTo(page, next);
  await page.keyboard.press("Enter");
  await expect(form).toContainText("2 of 3");
  await notLost(page);
  // The reply box is still a Tab away, and Enter sends what is typed.
  await pressTo(page, reply);
  await expect(reply).toBeFocused();
});

test("allow a permission from the chat with the keyboard", async ({ app }) => {
  mockOnly("answers an agent");
  await chat(app, "devl/checkout-fix");
  const page = app.page;
  await app.composer.getByRole("textbox", { name: "Reply" }).focus();
  const allow = app.chat.getByRole("button", { name: "Allow", exact: true });
  await pressTo(page, allow, "Shift+Tab");
  expect(await shows(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(allow).toHaveCount(0);
  await notLost(page);
});

test("under a chat, the agent's terminal is out of the Tab order", async ({ app }) => {
  await chat(app, "gpu/shop");
  const page = app.page;
  await app.composer.getByRole("textbox", { name: "Reply" }).focus();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Shift+Tab");
    const f = await focused(page);
    expect(f?.label, "Shift-Tab landed in the hidden terminal").not.toBe("Terminal input");
  }
});

test("⌘P opens a file in the editor, which takes the keyboard, and ⌘S saves it", async ({ app }) => {
  mockOnly("writes a file on a box");
  await app.open();
  await app.openWorktree("devl/checkout-fix");
  const page = app.page;
  await page.keyboard.press("Meta+p");
  const picker = page.getByTestId("file-picker");
  await expect(picker.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("webhook.ts");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  const editor = page.locator("[data-testid=file-pane] .cm-content").first();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// read\n");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("file-saved")).toBeVisible();
  // Esc in the picker gives the keyboard back, not to <body>.
  await page.keyboard.press("Meta+p");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await notLost(page);
});

test("⌘⇧E puts the keyboard in the Files panel, and New file names one there", async ({ app }) => {
  mockOnly("writes a file on a box");
  await app.open();
  await app.openWorktree("devl/checkout-fix");
  const page = app.page;
  // From its terminal, which takes the keyboard as it attaches.
  await expect.poll(() => focused(page).then((f) => f?.label)).toBe("Terminal input");
  await page.keyboard.press("Meta+Shift+E");
  const panel = page.getByTestId("files-panel");
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-testid=files-panel]"))).toBe(true);
  await pressTo(page, panel.getByTestId("tree-new-file-button"));
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("tree-new-file")).toBeVisible();
  await page.keyboard.type("notes-from-keyboard.md");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid=file-pane][data-path$="notes-from-keyboard.md"] .cm-content')).toBeVisible();
  await notLost(page);
  // ⌘⇧E again hides it; the keyboard goes home.
  await panel.getByRole("tree").or(panel.getByTestId("file-tree")).first().focus().catch(() => {});
  await page.keyboard.press("Meta+Shift+E");
  await notLost(page);
});

test("split, switch tabs and move between panes with the keyboard", async ({ app }) => {
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree(await agentWorktree(app, "devl/checkout-fix"));
  const page = app.page;
  await page.keyboard.press("Meta+d");
  await expect(app.panes).toHaveCount(2);
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await notLost(page);
  // Tabs: the strip's arrows move between them, Enter shows one.
  const tabs = page.locator("[data-tab-strip] [role=tab]");
  const count = await tabs.count();
  await page.keyboard.press("Meta+1");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  if (count > 1) {
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  }
  // Shift-F10 on a tab opens its menu, whose Close tab is a keyboard away.
  await tabs.first().focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: /Close tab/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await notLost(page);
});

test("rename a worktree with F2; Enter and Esc give the row back the keyboard", async ({ app }) => {
  mockOnly("renames on a box");
  await app.open();
  const page = app.page;
  const row = app.worktree("devl/checkout-fix");
  await row.focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Display name for checkout-fix" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Webhook retries");
  await page.keyboard.press("Enter");
  await expect(row).toContainText("Webhook retries");
  await expect(row).toBeFocused();
  await page.keyboard.press("F2");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});

test("a project folds with ← and → on its row", async ({ app }) => {
  await app.open();
  const page = app.page;
  // A project's row (the More menu's button is expanded-able too, as a menu).
  const project = page.locator('[data-sidebar="menu-button"][aria-expanded]:not([aria-haspopup])').first();
  await project.focus();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(project).toHaveAttribute("aria-expanded", "true");
});

test("the sidebar's edge resizes from the keyboard, and shows it has it", async ({ app }) => {
  await app.open();
  const page = app.page;
  const handle = page.getByRole("separator", { name: "Resize the sidebar" });
  // Reached with the keyboard: the sidebar's first stop, before its top
  // row's buttons, New task, Search and Home.
  await page.getByTestId("nav-home").focus();
  await pressTo(page, handle, "Shift+Tab", 8);
  expect(await shows(page)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
});

test("⌘K reaches Settings and a theme is chosen with the keyboard", async ({ app }) => {
  await app.open();
  const page = app.page;
  await page.keyboard.press("Meta+k");
  const input = page.getByRole("combobox", { name: "Search sessions, worktrees and commands" });
  await expect(input).toBeFocused();
  // Esc closes it, and the keyboard isn't lost.
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await notLost(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Settings: Appearance");
  await page.keyboard.press("Enter");
  const appearance = page.getByTestId("settings-appearance");
  await expect(appearance).toBeVisible();
  await notLost(page);
  const light = appearance.locator('[data-testid=theme-option][data-theme-id="berth-light"]');
  await pressTo(page, light, "Tab", 60);
  expect(await shows(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("⌘K lists what the menus and shortcuts do", async ({ app }) => {
  await app.open();
  await app.openWorktree(await agentWorktree(app, "devl/checkout-fix"));
  const page = app.page;
  await page.keyboard.press("Meta+k");
  const list = page.getByRole("listbox");
  for (const [query, name] of [
    ["files panel", "Files panel"],
    ["go to file", "Go to file…"],
    ["split right", "Split right"],
    ["zoom in", "Zoom in"],
    ["sidebar", "Show or hide the sidebar"],
    ["review", "Review"],
    ["preview", "New Preview tab"],
    // Not for a main checkout, which a real fleet's first agent may be in.
    ...(live ? [] : [["rename", "Rename this worktree…"]]),
    ["settings: terminal", "Settings: Terminal"],
    ["do not disturb", "Turn on Do not disturb"],
  ]) {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(query);
    await expect(list.getByRole("option", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first(), query).toBeVisible();
  }
  // A shortcut's item runs it: Files panel opens.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("files panel");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("files-panel")).toBeVisible();
});

test("Team setup to its first step with the keyboard", async ({ app }) => {
  mockOnly("reads a team's setup");
  await app.open({ params: { team: "acme" } });
  const page = app.page;
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Team setup");
  await page.keyboard.press("Enter");
  const org = page.getByRole("textbox", { name: "GitHub org or link" });
  await expect(org).toBeFocused();
  await page.keyboard.type("acme");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("team-page")).toContainText(/acme/i);
  await notLost(page);
});

test("⌘⌥I puts the keyboard in the console drawer; arrows switch its tabs", async ({ app }) => {
  mockOnly("loads a page through the proxy");
  await app.open();
  const page = app.page;
  const pane = await openBrowser(app);
  await page.keyboard.press("Meta+Alt+KeyI");
  const drawer = pane.getByTestId("devtools-drawer");
  await expect(drawer).toBeVisible();
  const consoleTab = drawer.getByRole("tab", { name: /Console/ });
  await expect(consoleTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(drawer.getByRole("tab", { name: /Network/ })).toBeFocused();
  await expect(drawer.getByRole("tab", { name: /Network/ })).toHaveAttribute("aria-selected", "true");
  // Its edge sizes it from the keyboard too.
  const edge = drawer.getByRole("separator", { name: "Resize the drawer" });
  const before = Number(await edge.getAttribute("aria-valuenow"));
  await edge.focus();
  await page.keyboard.press("ArrowUp");
  await expect(edge).toHaveAttribute("aria-valuenow", String(before + 16));
  // ⌘⌥I again closes it and the keyboard goes home.
  await page.keyboard.press("Meta+Alt+KeyI");
  await expect(drawer).toHaveCount(0);
  await notLost(page);
});

test("the shortcuts sheet traps the keyboard while open, and Esc gives it back", async ({ app }) => {
  await app.open();
  const page = app.page;
  await page.getByTestId("nav-home").focus();
  await page.keyboard.press("Meta+Slash");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  // The trap's own guards sit just outside the popup and send the keyboard
  // round to its start; anything else outside is a leak. Focus settles a
  // moment after each key on a slow runner.
  const inside = () => page.evaluate(() => !!document.activeElement?.closest("[role=dialog], [data-floating-ui-focus-guard], [data-base-ui-focus-guard], span[aria-hidden=true]"));
  await expect.poll(inside, { message: "the sheet took the keyboard" }).toBe(true);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(inside, { message: "Tab left the open sheet", timeout: 2000 }).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("nav-home")).toBeFocused();
});
