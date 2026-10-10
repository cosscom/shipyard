import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// Links in a terminal open in your browser with ⌘-click, as in Terminal,
// iTerm2 and Ghostty: a web address in the text, and an OSC 8 hyperlink
// (text a program links somewhere). The output comes the way a box's tmux
// draws it, on its alternate screen with mouse reporting on. In the browser
// build openUrl opens a link with window.open, which records it here.

// The tmux of a box attaching: alternate screen, a scroll region, mouse
// reporting and synchronized output (captured from tmux 3.7, OSC 8 passed
// through with its hyperlinks terminal feature).
const OUTPUT =
  "\x1b[?1049h\x1b[H\x1b[2J\x1b[?69h\x1b[1;24r\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[?2026h\x1b[H" +
  "\x1b[2mOpened\x1b[0m https://example.com/acme/pull/47.\x1b[K\r\n" +
  "  ⎿  \x1b]8;id=tmux1;https://example.com/acme/docs\x1b\\the acme docs\x1b]8;;\x1b\\ for more\x1b[K\r\n" +
  "\x1b[?2026l";

async function openShell(page: Page) {
  await expect(page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
  await page.keyboard.press("Meta+KeyT");
  const picker = page.getByRole("dialog", { name: "New terminal on a box" });
  await expect(picker.locator("[data-box=gpu]")).toBeVisible();
  await page.keyboard.type("gpu");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect.poll(() => screenText(page)).toContain("me@gpu:~$");
}

type Term = {
  cols: number;
  rows: number;
  write(d: string): void;
  buffer: { active: { length: number; viewportY?: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } };
  renderer?: { getCanvas(): HTMLCanvasElement; charWidth: number; charHeight: number };
};

function screenText(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector("[data-testid=pane][data-pane-kind=terminal] [data-terminal] > div") as (HTMLElement & { __berthTerm?: Term }) | null;
    const b = host?.__berthTerm?.buffer.active;
    if (!b) return "";
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
  });
}

// The middle of the cell `into` characters into `text` on the screen, in
// the page's coordinates. The screen here is the alternate one, with no
// history: a buffer row is a screen row.
function cellOf(page: Page, text: string, into = 2) {
  return page.evaluate(
    ({ text, into }) => {
      const host = document.querySelector("[data-testid=pane][data-pane-kind=terminal] [data-terminal] > div") as HTMLElement & { __berthTerm: Term };
      const t = host.__berthTerm;
      const b = t.buffer.active;
      for (let y = 0; y < b.length; y++) {
        const col = b.getLine(y)?.translateToString(true).indexOf(text) ?? -1;
        if (col < 0) continue;
        let rect: DOMRect, w: number, h: number;
        if (t.renderer) {
          rect = t.renderer.getCanvas().getBoundingClientRect();
          w = t.renderer.charWidth;
          h = t.renderer.charHeight;
        } else {
          rect = host.querySelector(".xterm-screen")!.getBoundingClientRect();
          w = rect.width / t.cols;
          h = rect.height / t.rows;
        }
        return { x: rect.left + (col + into + 0.5) * w, y: rect.top + (y - (b.viewportY ?? 0) + 0.5) * h };
      }
      throw new Error(`${text} is not on the screen`);
    },
    { text, into },
  );
}

async function cmdClick(page: Page, at: { x: number; y: number }) {
  await page.keyboard.down("Meta");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Meta");
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

async function recordOpens(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (url?: string | URL) => {
      w.__opened.push(String(url));
      return null;
    };
  });
}

async function draw(page: Page) {
  await page.evaluate((out) => (document.querySelector("[data-testid=pane][data-pane-kind=terminal] [data-terminal] > div") as HTMLElement & { __berthTerm: Term }).__berthTerm.write(out), OUTPUT);
  await expect.poll(() => screenText(page)).toContain("the acme docs for more");
}

test("⌘-click opens a web address and an OSC 8 link in a terminal; resting on one says so", async ({ app }) => {
  mockOnly("writes to the mock's terminal");
  const page = app.page;
  await recordOpens(page);
  await app.open();
  await openShell(page);
  await draw(page);
  const pane = page.locator("[data-testid=pane][data-pane-kind=terminal]:visible");
  const canvas = pane.locator("canvas").first();
  const hint = pane.getByTestId("terminal-link-hint");

  // Resting on an address says how to open it, with no pointing hand, and
  // a plain click is the terminal's (focus, selection): nothing opens.
  const url = await cellOf(page, "https://example.com/acme/pull/47");
  await page.mouse.move(url.x, url.y);
  await expect(hint).toHaveText("⌘-click to open");
  await expect(canvas).toHaveCSS("cursor", "text");
  await page.mouse.click(url.x, url.y);

  // ⌘ held: the hand, and no hint.
  await page.keyboard.down("Meta");
  await page.mouse.move(url.x + 1, url.y);
  await expect(canvas).toHaveCSS("cursor", "pointer");
  await expect(hint).toBeHidden();
  await page.mouse.click(url.x + 1, url.y);
  await page.keyboard.up("Meta");
  // Without the full stop after it.
  await expect.poll(() => opened(page)).toEqual(["https://example.com/acme/pull/47"]);

  // An OSC 8 link opens its own address, not its text.
  const link = await cellOf(page, "the acme docs", 4);
  await page.mouse.move(link.x, link.y);
  await expect(hint).toBeVisible();
  await cmdClick(page, link);
  await expect.poll(() => opened(page)).toEqual(["https://example.com/acme/pull/47", "https://example.com/acme/docs"]);

  // Off the links, the hint goes and ⌘-click opens nothing.
  const plain = await cellOf(page, "for more", 1);
  await page.mouse.move(plain.x, plain.y);
  await expect(hint).toBeHidden();
  await cmdClick(page, plain);
  await page.mouse.click(url.x, url.y);
  await expect(hint).toBeVisible();
  expect(await opened(page)).toHaveLength(2);
});

test("in xterm.js, a web address and an OSC 8 link open too", async ({ app }) => {
  mockOnly("writes to the mock's terminal");
  const page = app.page;
  await recordOpens(page);
  await app.open({ prefs: { terminal: { renderer: "xterm" } } });
  await openShell(page);
  await draw(page);
  const url = await cellOf(page, "https://example.com/acme/pull/47");
  await page.mouse.move(url.x, url.y);
  await cmdClick(page, url);
  await expect.poll(() => opened(page)).toEqual(["https://example.com/acme/pull/47"]);
  const link = await cellOf(page, "the acme docs", 4);
  await page.mouse.move(link.x, link.y);
  await cmdClick(page, link);
  await expect.poll(() => opened(page)).toEqual(["https://example.com/acme/pull/47", "https://example.com/acme/docs"]);
});
