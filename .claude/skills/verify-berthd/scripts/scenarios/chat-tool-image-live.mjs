// chat-tool-image-live: a real Claude Code on a dev box (../dev-box.sh up)
// reads a picture outside its worktree, /tmp/acme-shot.png, drawn here.
// Its Read opens to the picture itself, read back from the conversation's
// record by the box (GET …/transcript/tool/{id}/image/0), and the picture
// opens at full size. Then the file is deleted and the call opened again:
// the picture still shows, so it never came from the file.
// See ../../features/chat-tool-calls.md.
//
// VERIFY_WORKTREE  the worktree row's box/name (devq/acme-shop).
// VERIFY_SESSION   its agent's session (ask).
// VERIFY_EXPECT    image (the default) or text: the build before, which
//                  shows the call's output as the text "[image]".
import { existsSync, rmSync, writeFileSync } from "node:fs";

export const live = true;
export const params = { view: "conversation", sidebar: "list" };

const SHOT = "/tmp/acme-shot.png";
const WIDTH = 480;
const HEIGHT = 300;

export async function run({ page, shot, step, expect, call }) {
  const expectNow = process.env.VERIFY_EXPECT ?? "image";
  const worktree = process.env.VERIFY_WORKTREE;
  if (!worktree) throw new Error("set VERIFY_WORKTREE to the worktree row's box/name");
  const [box] = worktree.split("/");

  step(`draw ${SHOT}: an acme checkout page, ${WIDTH}x${HEIGHT}`);
  const png = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#f8fafc";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#0f172a";
      g.fillRect(0, 0, w, 48);
      g.fillStyle = "#fff";
      g.font = "bold 20px sans-serif";
      g.fillText("acme shop", 18, 31);
      g.fillStyle = "#16a34a";
      g.beginPath();
      g.arc(w / 2, 130, 36, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#0f172a";
      g.font = "bold 24px sans-serif";
      g.textAlign = "center";
      g.fillText("Order confirmed", w / 2, 210);
      g.font = "16px sans-serif";
      g.fillStyle = "#475569";
      g.fillText("Order #1042 · 3 items · $84.00", w / 2, 240);
      return c.toDataURL("image/png").split(",")[1];
    },
    [WIDTH, HEIGHT],
  );
  const bytes = Buffer.from(png, "base64");
  writeFileSync(SHOT, bytes);

  step("open the agent's chat");
  await page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`).click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  const chat = pane.getByTestId("chat");
  await expect(chat).toBeVisible({ timeout: 30_000 });
  let reply = pane.getByRole("textbox", { name: "What should Claude Code do?", exact: true });
  try {
    await expect(reply).toBeEditable({ timeout: 15_000 });
  } catch {
    reply = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
  }
  const session = process.env.VERIFY_SESSION ?? "ask";
  const api = `/v1/boxes/${box}/api/sessions/${encodeURIComponent(session)}`;
  // Its Reads of the picture so far, so this run's is the one after them.
  const reads = async () => {
    const res = await call(`${api}/transcript?since=0`);
    return (res.items ?? []).flatMap((it) => (it.kind === "tools" ? (it.items ?? []) : [])).filter((c) => c.target?.includes("acme-shot.png") && c.id);
  };
  const before = (await reads()).length;
  step(`ask Claude to read ${SHOT}`);
  await reply.fill(`Use the Read tool on ${SHOT}, then say in one short sentence what it shows. Do nothing else.`);
  await reply.press("Enter");

  step("its Read of the picture is in the chat, answered");
  let id;
  await expect
    .poll(
      async () => {
        const all = await reads();
        if (all.length <= before) return "no read yet";
        id = all[all.length - 1].id;
        const d = await call(`${api}/transcript/tool/${encodeURIComponent(id)}`);
        return d.pending ? "pending" : JSON.stringify(d.images ?? []);
      },
      { timeout: 240_000, intervals: [3_000] },
    )
    .toBe(expectNow === "image" ? JSON.stringify([{ n: 0, line: 0, mediaType: "image/png" }]) : "[]");

  if (expectNow === "image") {
    step("second view: the box serves the very bytes Claude read, from its record");
    const got = await call(`${api}/transcript/tool/${encodeURIComponent(id)}/image/0`, { raw: true });
    if (got.type !== "image/png" || !got.bytes.equals(bytes)) throw new Error(`image 0 is ${got.type}, ${got.bytes.length} bytes; the file is ${bytes.length}`);
  }

  // The steps fold away once the turn ends: open them, then the Read.
  const row = chat.getByRole("button", { name: /^Read\b.*acme-shot\.png$/ }).last();
  const openRead = async () => {
    const fold = chat.getByRole("button", { name: /^Work(ed|ing)/ }).last();
    if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
    const group = chat.getByRole("button", { name: /^Read \d+ files?/ }).last();
    await expect(group).toBeVisible({ timeout: 30_000 });
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
    await expect(row).toBeVisible();
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
  };
  step("open the steps, then the Read");
  await openRead();

  if (expectNow === "text") {
    await expect(chat.getByText("[image]", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(chat.getByTestId("tool-image")).toHaveCount(0);
    await shot("1-read-shows-text");
    rmSync(SHOT, { force: true });
    return;
  }
  if (expectNow !== "image") throw new Error("set VERIFY_EXPECT to image or text");

  const thumb = chat.getByTestId("tool-image").last();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => thumb.locator("img").evaluate((el) => el.naturalWidth)).toBe(WIDTH);
  await expect(row.locator("xpath=..").getByText("[image]", { exact: true })).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shot("1-read-shows-picture");

  step("the picture opens at full size, and closes with Escape");
  await thumb.click();
  const full = page.getByTestId("tool-image-full");
  await expect(full).toBeVisible();
  await expect.poll(() => full.locator("img").evaluate((el) => el.naturalWidth)).toBe(WIDTH);
  await shot("2-full-size");
  await page.keyboard.press("Escape");
  await expect(full).toBeHidden();

  step(`delete ${SHOT}, close and open the Read again: the picture is the record's`);
  rmSync(SHOT, { force: true });
  if (existsSync(SHOT)) throw new Error(`${SHOT} is still there`);
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) === "true") await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await openRead();
  await expect.poll(() => chat.getByTestId("tool-image").last().locator("img").evaluate((el) => el.naturalWidth)).toBe(WIDTH);
  await shot("3-after-the-file-is-gone");
}
