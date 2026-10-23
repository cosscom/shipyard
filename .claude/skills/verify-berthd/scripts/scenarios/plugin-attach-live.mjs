// A plugin's api.attach on a real box (features/plugins.md, plugin-attach):
// a file picked in a plugin's screen goes into a running session's
// worktree, and into a worktree an agent is about to start in, under
// .berth/attachments, byte for byte (the box puts a timestamp before the
// name); a pasted "image.png" is named for when it was pasted;
// a file over 20 MB is refused with the composer's words. A big screenshot
// attached with pasted: true goes up shrunk, as WebP. A path pasted as text
// (api.localPaths) is a file on this computer: on a box paired at 127.0.0.1
// it is the box's own and resolves as it is, with nothing uploaded; on a box
// at another address the laptop agent uploads it, and an aborted signal
// stops it before anything reaches the box.
//
// On a dev box of this checkout (../dev-box.sh, which exports
// VERIFY_WORKTREE and the token, and runs session "ask" in acme-shop), once
// as it starts and once at another address:
//
//   node drive.mjs plugin-attach-live --port $PORT --agent http://127.0.0.1:9378
//   VERIFY_BOX_ADDR=$(tailscale ip -4):7544 dev-box.sh up   # then the same
//
// It makes a worktree "attach-verify" in acme-shop and removes it after.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const live = true;

const WORKTREE = process.env.VERIFY_WORKTREE ?? "devq/acme-shop";
const [BOX, LOCATION] = WORKTREE.split("/");
const SESSION = process.env.VERIFY_SESSION ?? "ask";
const NEW_WT = "attach-verify";

export const plugins = [
  {
    id: "attach-check",
    name: "Attach check",
    source: `
import { createElement as h, useState } from "react";
export default function (berth) {
  const Screen = () => {
    const [file, setFile] = useState(null);
    const [lines, setLines] = useState([]);
    const say = (l) => setLines((ls) => [...ls, l]);
    const go = (target, label) => {
      let last = "";
      berth.api.attach(${JSON.stringify(BOX)}, target, file, { onProgress: (sent, total) => (last = sent + "/" + total) }).then(
        (a) => say(label + ": " + a.path + " (" + a.name + ", " + a.type + ", " + a.size + " bytes, progress " + last + ")"),
        (e) => say(label + " refused: " + e.message),
      );
    };
    const [text, setText] = useState("");
    const show = (label, a) => say(label + ": " + a.path + " (" + a.name + ", " + a.type + ", " + a.size + " bytes)");
    const paste = () => {
      const paths = berth.api.localPaths(text);
      say("localPaths: " + JSON.stringify(paths));
      for (const p of paths) berth.api.attach(${JSON.stringify(BOX)}, { session: ${JSON.stringify(SESSION)} }, p).then((a) => show("path", a), (e) => say("path refused: " + e.message));
    };
    const cancelled = () => {
      const stop = new AbortController();
      stop.abort();
      for (const p of berth.api.localPaths(text)) berth.api.attach(${JSON.stringify(BOX)}, { session: ${JSON.stringify(SESSION)} }, p, { signal: stop.signal }).then((a) => show("cancelled path", a), (e) => say("cancelled path refused: " + e.name));
    };
    // A retina-sized screenshot of noise: several MB of PNG, as a paste gives.
    const screenshot = async () => {
      const c = document.createElement("canvas");
      c.width = 2400;
      c.height = 1600;
      const g = c.getContext("2d");
      const img = g.createImageData(2400, 1600);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (i * 7) % 251; img.data[i + 1] = Math.random() * 255; img.data[i + 2] = (i >> 9) % 255; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      say("screenshot: a " + blob.size + " byte PNG, 2400x1600");
      berth.api.attach(${JSON.stringify(BOX)}, { session: ${JSON.stringify(SESSION)} }, new File([blob], "image.png", { type: "image/png" }), { pasted: true }).then((a) => show("pasted", a), (e) => say("pasted refused: " + e.message));
    };
    return h("div", { style: { padding: 16, display: "grid", gap: 8 } },
      h("p", null, "api.localPaths is a " + typeof berth.api.localPaths),
      h("textarea", { "aria-label": "Pasted text", value: text, onChange: (e) => setText(e.target.value) }),
      h("button", { onClick: paste }, "Attach the pasted paths"),
      h("button", { onClick: screenshot }, "Paste a screenshot"),
      h("button", { onClick: cancelled }, "Attach the pasted paths, cancelled"),
      h("p", null, "api.attach is a " + typeof berth.api.attach),
      h("input", { type: "file", "aria-label": "File to attach", onChange: (e) => setFile(e.target.files[0] ?? null) }),
      h("button", { onClick: () => go({ session: ${JSON.stringify(SESSION)} }, "session") }, "Attach to the session"),
      h("button", { onClick: () => go({ location: ${JSON.stringify(LOCATION)}, worktree: ${JSON.stringify(NEW_WT)} }, "worktree") }, "Attach to the new worktree"),
      h("ul", { "aria-label": "Results" }, lines.map((l, i) => h("li", { key: i }, l))),
    );
  };
  berth.addScreen({ id: "attach", title: "Attach check", Component: Screen });
  berth.addSidebarItem({ id: "attach", title: "Attach check", icon: "Paperclip", screen: "attach" });
}
`,
  },
];

export async function run({ page, shot, step, expect, call }) {
  const box = (path, init) => call(`/v1/boxes/${BOX}/api${path}`, init);
  const sessions = await box("/sessions");
  const session = sessions.find((s) => s.name === SESSION);
  if (!session) throw new Error(`no session ${SESSION} on ${BOX}`);
  const location = (await box("/locations")).find((l) => l.name === LOCATION);
  const mainPath = location.path;

  step(`make worktree ${NEW_WT} in ${LOCATION}, as a task would before its agent starts`);
  const wt = await box(`/locations/${LOCATION}/worktrees`, { method: "POST", body: JSON.stringify({ name: NEW_WT }) });
  try {
    step("open the plugin's screen from More");
    await page.getByTestId("nav-more").click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Attach check" }).click();
    await expect(page.getByText("api.attach is a function")).toBeVisible();
    const results = page.getByRole("list", { name: "Results" }).getByRole("listitem");
    const input = page.getByLabel("File to attach");

    step("pick notes.md and attach it to the running session");
    const notes = `# acme notes\n\nchecked at ${new Date().toISOString()}\n`;
    await input.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from(notes) });
    await page.getByRole("button", { name: "Attach to the session" }).click();
    // The box puts a timestamp before the name, so two of a name don't clash.
    await expect(results.nth(0)).toHaveText(new RegExp(`^session: ${mainPath}/\\.berth/attachments/(\\d{8}-\\d{6}-notes\\.md) \\(\\1, text/[a-z]+, ${notes.length} bytes, progress ${notes.length}/${notes.length}\\)$`));
    const sessionPath = (await results.nth(0).textContent()).match(/^session: (\S+)/)[1];

    step("pick a pasted image.png and attach it to the new worktree");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000502027fd2d1d4f30000000049454e44ae426082", "hex");
    await input.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Attach to the new worktree" }).click();
    await expect(results.nth(1)).toHaveText(new RegExp(`^worktree: ${wt.path}/\\.berth/attachments/(\\d{8}-\\d{6}-pasted-\\d{6}(-\\d+)?\\.png) \\(\\1, image/png, ${png.length} bytes`));
    const pastedName = (await results.nth(1).textContent()).match(/(\d{8}-\d{6}-pasted-[\d-]+\.png)/)[1];

    step("pick a 21 MB log: refused before it is sent");
    await input.setInputFiles({ name: "huge.log", mimeType: "text/plain", buffer: Buffer.alloc(21 << 20, 97) });
    await page.getByRole("button", { name: "Attach to the session" }).click();
    await expect(results.nth(2)).toHaveText("session refused: huge.log is 21 MB; attachments can be up to 20 MB.");
    await shot("1-plugin-attached");

    step("paste text that only mentions a path: localPaths finds none");
    await page.getByLabel("Pasted text").fill("see /tmp/shot.png");
    await page.getByRole("button", { name: "Attach the pasted paths", exact: true }).click();
    await expect(results.nth(3)).toHaveText("localPaths: []");

    const status = await call("/v1/status");
    const address = status.boxes.find((b) => b.name === BOX)?.address ?? "";
    const here = /^(127\.|localhost[:]|\[::1\])/.test(address);
    const dir = mkdtempSync(join(tmpdir(), "verify-attach-"));
    const laptopFile = join(dir, "shot.png");
    writeFileSync(laptopFile, png);
    const before = readdirSync(`${mainPath}/.berth/attachments`).length;
    step(`paste a path on this computer, ${laptopFile}, with ${BOX} at ${address} (${here ? "this computer" : "another computer"})`);
    await page.getByLabel("Pasted text").fill(`file://${laptopFile}`);
    await page.getByRole("button", { name: "Attach the pasted paths", exact: true }).click();
    await expect(results.nth(4)).toHaveText(`localPaths: ${JSON.stringify([laptopFile])}`);
    if (here) {
      await expect(results.nth(5)).toHaveText(`path: ${laptopFile} (shot.png, image/png, 0 bytes)`);
    } else {
      await expect(results.nth(5)).toHaveText(new RegExp(`^path: ${mainPath}/\\.berth/attachments/(\\d{8}-\\d{6}-shot\\.png) \\(\\1, image/png, ${png.length} bytes\\)$`));
      const uploaded = (await results.nth(5).textContent()).match(/^path: (\S+)/)[1];
      if (!readFileSync(uploaded).equals(png)) throw new Error(`${uploaded} differs from ${laptopFile}`);
      step(`${uploaded} on the box is ${laptopFile} byte for byte`);
      step("the same path with a signal already aborted: refused, and nothing reaches the box");
      await page.getByRole("button", { name: "Attach the pasted paths, cancelled" }).click();
      await expect(page.getByText("cancelled path refused: AbortError")).toBeVisible();
    }

    step("paste a 2400x1600 screenshot with pasted: true: it goes up shrunk, as WebP");
    await page.getByRole("button", { name: "Paste a screenshot" }).click();
    const shift = here ? 0 : 1;
    await expect(results.nth(6 + shift)).toHaveText(/^screenshot: a \d+ byte PNG, 2400x1600$/);
    await expect(results.nth(7 + shift)).toHaveText(new RegExp(`^pasted: ${mainPath}/\\.berth/attachments/(\\d{8}-\\d{6}-pasted-\\d{6}(-\\d+)?\\.webp) \\(\\1, image/webp, \\d+ bytes\\)$`), { timeout: 30_000 });
    const pngSize = Number((await results.nth(6 + shift).textContent()).match(/a (\d+) byte/)[1]);
    const webpSize = Number((await results.nth(7 + shift).textContent()).match(/, (\d+) bytes\)$/)[1]);
    if (!(webpSize < pngSize)) throw new Error(`the shrunk screenshot (${webpSize}) is no smaller than the PNG (${pngSize})`);
    step(`the ${pngSize} byte PNG went up as a ${webpSize} byte WebP`);
    await shot("2-paths-and-paste");
    const added = readdirSync(`${mainPath}/.berth/attachments`).length - before;
    if (added !== (here ? 1 : 2)) throw new Error(`${added} files arrived for the path and the screenshot; expected ${here ? 1 : 2}`);
    rmSync(dir, { recursive: true });

    step("second view: the box's disk has both files byte for byte, and git ignores them");
    if (readFileSync(sessionPath, "utf8") !== notes) throw new Error(`${sessionPath} differs from what was picked`);
    if (!readFileSync(`${wt.path}/.berth/attachments/${pastedName}`).equals(png)) throw new Error(`${pastedName} differs from what was picked`);
    for (const f of [sessionPath, `${wt.path}/.berth/attachments/${pastedName}`]) execFileSync("git", ["-C", f.replace(/\/\.berth\/.*/, ""), "check-ignore", "-q", f]);
    if (readdirSync(`${mainPath}/.berth/attachments`).some((n) => n.endsWith("huge.log"))) throw new Error("the refused file reached the box");
    step(`${sessionPath} and ${pastedName} are on disk as picked; git check-ignore says both are ignored; no huge.log there`);
  } finally {
    step(`remove worktree ${NEW_WT}`);
    await box(`/locations/${LOCATION}/worktrees/${NEW_WT}?force=1`, { method: "DELETE" }).catch((e) => step(`couldn't remove it: ${e.message}`));
  }
}
