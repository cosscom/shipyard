// Shortcuts in the keyboard's layout (app/src/lib/key-layout.ts): Back and
// Forward are matched by the key's place, so on a Norwegian keyboard they
// read ⌘Å and ⌘¨ wherever keys are shown, and the keys still work. Every
// description fits its line in the Keyboard shortcuts sheet.
// features/navigation-history.md (history-layout). keyboard-layout-us.mjs
// runs the same on a US layout.

export const LAYOUTS = {
  no: { name: "Norwegian", map: { BracketLeft: "å", BracketRight: "¨", KeyD: "d" }, back: "⌘Å", forward: "⌘¨" },
  us: { name: "US", map: { BracketLeft: "[", BracketRight: "]", KeyD: "d" }, back: "⌘[", forward: "⌘]" },
};

// init stands in for Chromium's navigator.keyboard.getLayoutMap() with map.
export function init(map) {
  const layout = new Map(Object.entries(map));
  Object.defineProperty(navigator, "keyboard", { configurable: true, value: { getLayoutMap: async () => layout } });
}
export const initArg = LAYOUTS.no.map;

export function drive(l) {
  return async ({ page, shot, step, expect }) => {
    const back = page.getByTestId("history-back");
    const forward = page.getByTestId("history-forward");
    const tip = page.locator("[data-slot=tooltip-popup]");
    const dashboard = page.getByRole("heading", { name: "Agent Dashboard" });

    step(`${l.name} layout, ⌘J to the dashboard: Back's tooltip reads "Back (${l.back})"`);
    await page.keyboard.press("Meta+j");
    await expect(dashboard).toBeVisible();
    await back.hover();
    await expect(tip).toHaveText(`Back (${l.back})`);
    await shot("1-back-tooltip");

    step("the keys are as they were: ⌘ and the key right of P goes back, and Forward's tooltip reads its key");
    await page.keyboard.press("Meta+BracketLeft");
    await expect(dashboard).toBeHidden();
    await expect(back).toBeDisabled();
    await forward.hover();
    await expect(tip).toHaveText(`Forward (${l.forward})`);
    await shot("2-forward-tooltip");
    await page.keyboard.press("Meta+BracketRight");
    await expect(dashboard).toBeVisible();

    step(`⌘/ opens Keyboard shortcuts: Back is ${l.back}, Forward ${l.forward}, and no description is cut off`);
    await page.keyboard.press("Meta+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    const row = (text) => sheet.getByRole("listitem").filter({ hasText: text });
    await expect(row("Back to where you were")).toContainText(l.back);
    await expect(row("Forward again, after Back")).toContainText(l.forward);
    await expect(row("Search and commands")).toContainText("⌘K");
    const lines = await sheet.locator("li .truncate").evaluateAll((els) => els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth })));
    const cut = lines.filter((x) => x.cut || x.text.endsWith("…")).map((x) => x.text);
    if (lines.length < 30 || cut.length) throw new Error(`descriptions cut off (${lines.length} lines): ${JSON.stringify(cut)}`);
    step(`  ${lines.length} descriptions, none cut off; the longest: "${lines.map((x) => x.text).sort((a, b) => b.length - a.length)[0]}"`);
    await shot("3-shortcuts-sheet");
    await sheet.getByRole("region", { name: "Go" }).scrollIntoViewIfNeeded();
    await shot("4-shortcuts-sheet-go");

    step(`Search them in Settings: "${l.back.toLowerCase()}" finds Back, and "go to file" finds Go to file… by its menu name`);
    await sheet.getByRole("button", { name: "Search them in Settings" }).click();
    const settings = page.getByTestId("settings-shortcuts");
    const search = settings.getByRole("textbox", { name: "Search shortcuts" });
    await expect(search).toBeVisible();
    await search.fill(l.back.toLowerCase());
    await expect(settings.getByText("Back to where you were")).toBeVisible();
    await expect(settings.getByText("Forward again, after Back")).toHaveCount(0);
    await shot("5-settings-search-keys");
    await search.fill("go to file");
    await expect(settings.getByText("Find a file in the worktree")).toBeVisible();
    await shot("6-settings-search-label");

    step(`⌘K, "back": its Back item shows ${l.back}`);
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
    await page.keyboard.type("back");
    const item = palette.getByRole("option").filter({ hasText: /^Back/ }).first();
    await expect(item).toContainText(l.back);
    await shot("7-palette-back");
  };
}

export const run = drive(LAYOUTS.no);
