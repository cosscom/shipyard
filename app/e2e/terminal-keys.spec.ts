import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// A terminal's keys send what they would in a Mac terminal (lib/terminal-keys):
// ⇧↵ as Shift and Enter (a newline in Claude Code), ⌥←/→ a word, ⌘←/→ the
// line's ends, ⌘⌫ the line back to its start. The mock records what each
// terminal sent (window.__berthSent).

async function openShell(page: Page) {
  await expect(page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
  await page.keyboard.press("Meta+KeyT");
  const picker = page.getByRole("dialog", { name: "New terminal on a box" });
  await expect(picker).toBeVisible();
  await page.keyboard.type("gpu");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(page.locator("[data-testid=pane][data-pane-kind=terminal]:visible")).toHaveCount(1);
  await expect.poll(() => screenText(page)).toContain("me@gpu:~$");
}

function screenText(page: Page) {
  return page.evaluate(() => {
    const pane = [...document.querySelectorAll<HTMLElement>("[data-testid=pane]")].find((p) => p.offsetParent && p.querySelector("[data-terminal]"));
    const host = pane?.querySelector("[data-terminal] > div") as (HTMLElement & { __berthTerm?: { buffer: { active: { length: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }) | null;
    const b = host?.__berthTerm?.buffer.active;
    if (!b) return "";
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
  });
}

const sent = (page: Page) => page.evaluate(() => ((window as { __berthSent?: string[] }).__berthSent ?? []).join(""));

for (const renderer of ["ghostty", "xterm"] as const) {
  test(`${renderer}: Mac terminal keys send what a Mac terminal sends`, async ({ app }) => {
    mockOnly("the mock records what a terminal sent");
    await app.open({ prefs: { terminal: { renderer } } });
    const page = app.page;
    await openShell(page);
    await page.evaluate(() => {
      (window as { __berthSent?: string[] }).__berthSent = [];
    });

    for (const key of ["Shift+Enter", "Alt+ArrowLeft", "Alt+ArrowRight", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+Backspace", "Enter"]) await page.keyboard.press(key);

    await expect.poll(() => sent(page)).toBe("\x1b[13;2u\x1bb\x1bf\x01\x05\x15\r");
  });
}

// ⌘A selects the terminal's text and ⌘C copies it. The selection is drawn
// by the terminal, not the page's, so the menu bar's Copy found nothing and
// macOS beeped; the terminal takes the keys now, and sends nothing for them.
for (const renderer of ["ghostty", "xterm"] as const) {
  test(`${renderer}: ⌘A and ⌘C copy the terminal's text`, async ({ app }) => {
    mockOnly("the shell is on the mock's gpu box");
    await app.open({ prefs: { terminal: { renderer } } });
    const page = app.page;
    await openShell(page);
    await page.evaluate(() => {
      const w = window as { __berthSent?: string[]; __copied?: string[] };
      w.__berthSent = [];
      w.__copied = [];
      navigator.clipboard.writeText = async (text: string) => void w.__copied!.push(text);
    });

    await page.keyboard.press("Meta+KeyA");
    await page.keyboard.press("Meta+KeyC");

    await expect.poll(() => page.evaluate(() => ((window as { __copied?: string[] }).__copied ?? []).join("\n"))).toContain("me@gpu:~$");
    expect(await sent(page)).toBe("");
  });
}

// Copy on select (Settings → Terminal) is off unless turned on: a selection
// made with the pointer leaves the clipboard alone, and turned on, it's
// copied once the pointer lets go.
for (const renderer of ["ghostty", "xterm"] as const) {
  for (const copyOnSelect of [false, true]) {
    test(`${renderer}: selecting with the pointer ${copyOnSelect ? "copies with" : "leaves the clipboard without"} Copy on select`, async ({ app }) => {
      mockOnly("the shell is on the mock's gpu box");
      await app.open({ prefs: { copyOnSelect, terminal: { renderer } } });
      const page = app.page;
      await openShell(page);
      await page.evaluate(() => {
        const w = window as { __copied?: string[] };
        w.__copied = [];
        navigator.clipboard.writeText = async (text: string) => void w.__copied!.push(text);
      });
      const box = await page.locator("[data-testid=pane]:visible [data-terminal]").locator(renderer === "ghostty" ? "canvas" : ".xterm-screen").first().boundingBox();
      if (!box) throw new Error("no terminal canvas");
      await page.mouse.move(box.x + 4, box.y + 6);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 8 });
      await page.mouse.up();

      const copied = () => page.evaluate(() => ((window as { __copied?: string[] }).__copied ?? []).join("\n"));
      if (copyOnSelect) await expect.poll(copied).toContain("Last login");
      else {
        await page.waitForTimeout(300);
        expect(await copied()).toBe("");
      }
    });
  }
}

// ghostty-web makes the terminal's host contenteditable and focuses it, so
// without caret-color the browser blinks its own caret, the canvas's height,
// at the left edge beside the terminal's cursor.
test("ghostty: a focused terminal shows no browser caret", async ({ app }) => {
  mockOnly("the shell is on the mock's gpu box");
  await app.open({ prefs: { terminal: { renderer: "ghostty" } } });
  const page = app.page;
  await openShell(page);
  const caret = () =>
    page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      const host = a?.closest<HTMLElement>("[contenteditable=true]");
      return host ? getComputedStyle(host).caretColor : "no editable host";
    });
  await expect.poll(caret).toBe("rgba(0, 0, 0, 0)");
});
