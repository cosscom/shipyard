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

const HOST = "[data-testid=pane][data-pane-kind=terminal] [data-terminal] > div";
type Ghostty = Term & { renderer: NonNullable<Term["renderer"]> & { hoveredLinkRange: unknown } };

// The middle of the cell at column x of buffer row y, in the page's
// coordinates (ghostty-web, with no history above the screen).
function cellAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y, host }) => {
      const t = (document.querySelector(host) as HTMLElement & { __berthTerm: Ghostty }).__berthTerm;
      const rect = t.renderer.getCanvas().getBoundingClientRect();
      return { x: rect.left + (x + 0.5) * t.renderer.charWidth, y: rect.top + (y + 0.5) * t.renderer.charHeight };
    },
    { x, y, host: HOST },
  );
}

const cols = (page: Page) => page.evaluate((host) => (document.querySelector(host) as HTMLElement & { __berthTerm: Term }).__berthTerm.cols, HOST);

const write = (page: Page, out: string) => page.evaluate(({ out, host }) => (document.querySelector(host) as HTMLElement & { __berthTerm: Term }).__berthTerm.write(out), { out, host: HOST });

// The cells the link under the pointer covers, as ghostty-web underlines
// them.
const hovered = (page: Page) => page.evaluate((host) => (document.querySelector(host) as HTMLElement & { __berthTerm: Ghostty }).__berthTerm.renderer.hoveredLinkRange, HOST);

// A ChatGPT sign-in address as Codex prints it, long enough to take three
// rows or more of a pane `cols` wide after two spaces, ending short of a
// row's end.
function signIn(cols: number) {
  let url =
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_acme0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" +
    "&scope=openid%20profile%20email%20offline_access&code_challenge=Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg&code_challenge_method=S256" +
    "&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=c3RhdGVzdGF0ZXN0YXRlc3RhdGVzdGF0ZXN0YXRlcw";
  while (2 + url.length < cols * 2 + 10 || (2 + url.length) % cols === 0) url += "Q";
  return url;
}

const SCREEN = "\x1b[?1049h\x1b[H\x1b[2J";
const HEADING = "Sign in with ChatGPT. If your browser did not open, go to:";

// The address over its rows, as the terminal wraps it ("soft") or as tmux
// redraws it, each row put with the cursor so nothing is marked wrapped.
function signInScreen(url: string, cols: number, how: "soft" | "tmux") {
  const line = "  " + url;
  const rows = Math.ceil(line.length / cols);
  if (how === "soft") return { rows, out: `${SCREEN}${HEADING}\r\n${line}\r\n\r\nWaiting for sign-in` };
  let out = `${SCREEN}\x1b[?2026h\x1b[1;1H${HEADING}`;
  for (let i = 0; i < rows; i++) out += `\x1b[${i + 2};1H${line.slice(i * cols, (i + 1) * cols)}`;
  out += `\x1b[${rows + 3};1HWaiting for sign-in\x1b[?2026l`;
  return { rows, out };
}

for (const how of ["soft", "tmux"] as const) {
  test(`a sign-in address over several rows opens whole from any of them (${how === "soft" ? "wrapped by the terminal" : "redrawn by tmux"})`, async ({ app }) => {
    mockOnly("writes to the mock's terminal");
    const page = app.page;
    await recordOpens(page);
    await app.open();
    await openShell(page);
    const n = await cols(page);
    const url = signIn(n);
    const { rows, out } = signInScreen(url, n, how);
    expect(rows).toBeGreaterThanOrEqual(3);
    await write(page, out);
    await expect.poll(() => screenText(page)).toContain("Waiting for sign-in");
    const pane = page.locator("[data-testid=pane][data-pane-kind=terminal]:visible");
    const hint = pane.getByTestId("terminal-link-hint");

    // Resting on its second row: the whole address is the link, and the
    // hint says how to open it.
    const second = await cellAt(page, Math.floor(n / 2), 2);
    await page.mouse.move(second.x, second.y);
    await expect(hint).toHaveText("⌘-click to open");
    await expect.poll(() => hovered(page)).toEqual({ startX: 2, startY: 1, endX: (url.length + 1) % n, endY: rows });
    // A plain click opens nothing.
    await page.mouse.click(second.x, second.y);

    // ⌘-click on its third row opens all of it.
    const third = await cellAt(page, 1, 3);
    await page.mouse.move(third.x, third.y);
    await cmdClick(page, third);
    await expect.poll(() => opened(page)).toEqual([url]);

    // The rows around it are not part of it.
    await cmdClick(page, await cellAt(page, 3, 0));
    await cmdClick(page, await cellAt(page, 3, rows + 2));
    await cmdClick(page, await cellAt(page, 1, 3));
    await expect.poll(() => opened(page)).toEqual([url, url]);
  });
}

test("a device sign-in address wrapped in a narrow pane opens from both rows", async ({ app }) => {
  mockOnly("writes to the mock's terminal");
  const page = app.page;
  await page.setViewportSize({ width: 760, height: 700 });
  await recordOpens(page);
  await app.open();
  await openShell(page);
  const n = await cols(page);
  const url = "https://vercel.com/oauth/device?user_code=LNWD-GLJB";
  // The address crosses the right edge, 17 characters on the next row.
  const at = n - (url.length - 17);
  await write(page, `${SCREEN}${" ".repeat(at - 6)}Visit ${url} to sign in`);
  await expect.poll(() => screenText(page)).toContain("GLJB to sign in");
  expect(await screenText(page)).not.toContain(url);

  await cmdClick(page, await cellAt(page, 3, 1));
  await expect.poll(() => opened(page)).toEqual([url]);
  await cmdClick(page, await cellAt(page, at + 2, 0));
  await expect.poll(() => opened(page)).toEqual([url, url]);
});

test("an OSC 8 link whose text wraps opens its address from every row", async ({ app }) => {
  mockOnly("writes to the mock's terminal");
  const page = app.page;
  await recordOpens(page);
  await app.open();
  await openShell(page);
  const n = await cols(page);
  const uri = "https://example.com/acme/sign-in";
  const label = "Sign in to acme in your browser ".repeat(Math.ceil((n * 2) / 32)).trim();
  // As a program prints it, and as tmux redraws it: the hyperlink again on
  // each row it puts with the cursor.
  await write(page, `${SCREEN}\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\\r\n`);
  await expect.poll(() => screenText(page)).toContain("Sign in to acme");
  await cmdClick(page, await cellAt(page, 4, 1));
  await expect.poll(() => opened(page)).toEqual([uri]);
  await cmdClick(page, await cellAt(page, 4, 0));
  await expect.poll(() => opened(page)).toEqual([uri, uri]);

  const other = "https://example.com/acme/sign-in?via=tmux";
  const text = "Open the acme sign-in page here ".repeat(Math.ceil((n * 2) / 32)).trim();
  let tmux = SCREEN;
  for (let i = 0; i * n < text.length; i++) tmux += `\x1b[${i + 1};1H\x1b]8;id=tmux2;${other}\x1b\\${text.slice(i * n, (i + 1) * n)}`;
  await write(page, `${tmux}\x1b]8;;\x1b\\`);
  await expect.poll(() => screenText(page)).toContain("Open the acme");
  await cmdClick(page, await cellAt(page, 4, 1));
  await expect.poll(() => opened(page)).toEqual([uri, uri, other]);
  await cmdClick(page, await cellAt(page, 4, 0));
  await expect.poll(() => opened(page)).toEqual([uri, uri, other, other]);
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
