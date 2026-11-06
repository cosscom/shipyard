// inbox-live: real Claude Code on a dev box asks with AskUserQuestion. The Inbox
// brings it up, a pick with a note goes back and lands in the agent's own record,
// the peek shows the real session beside the card, and Close session stops a clean
// session at once or has one with unsaved work close itself. Run it once per
// driver: VERIFY_INBOX_DRIVER=terminal (the default) and VERIFY_INBOX_DRIVER=claude
// (chat). See ../../features/inbox.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const dist = new URL("../../../../../plugins/inbox/dist/index.js", import.meta.url);

export const live = true;
// The Inbox lists a box's secret requests when the box has them
// (GET secrets/requests). A box without that route answers 404, which the
// plugin reads as none; the browser still logs each one.
export const allowErrors = [/^Failed to load resource: .*404.*\/secrets\/requests\)$/];
export const params = { labs: "0", sidebar: "list" };
export const plugins = [{ id: "inbox", name: "Inbox", source: readFileSync(dist, "utf8") }];

const form = (question, a, b) => ({ questions: [{ header: "Pick", question, multiSelect: false, options: [{ label: `${a} (Recommended)`, description: "The usual one." }, { label: b, description: "The other one." }] }] });

const prompt = (f, then) => `Call the AskUserQuestion tool once with exactly this input JSON: ${JSON.stringify(f)}. ${then}`;

export async function run({ page, shot, step, expect, call }) {
  const box = (process.env.VERIFY_WORKTREE ?? "devq/acme-shop").split("/")[0];
  const api = `/v1/boxes/${box}/api`;
  const json = { "Content-Type": "application/json" };
  const driver = process.env.VERIFY_INBOX_DRIVER ?? "terminal";
  // Each session names its driver and mode. The box's defaults aren't the
  // scenario's to set: the app puts its own on the box when it connects.
  // On the terminal the box starts `claude '<prompt>'` whatever the mode, and
  // Claude takes its permission mode from the machine's own settings (bypass
  // on many), so a session whose mode matters says it on its command line.
  const shq = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
  const flag = { default: "--permission-mode default", bypassPermissions: "--dangerously-skip-permissions" };
  const start = (name, title, text, mode) => {
    const body = driver === "terminal" && mode ? { command: `claude ${flag[mode]} ${shq(text)}` } : { agent: "claude", prompt: text, driver, mode: mode ?? "bypassPermissions" };
    return call(`${api}/sessions`, { method: "POST", headers: json, body: JSON.stringify({ location: "acme-shop", name, title, ...body }) });
  };
  const lastQuestion = async (name) => {
    const t = await call(`${api}/sessions/${name}/transcript?since=0`);
    return { items: t.items ?? [], q: (t.items ?? []).filter((i) => i.kind === "question").pop() };
  };
  const row = (title) => page.getByTestId("inbox-item").filter({ hasText: title });

  const A = { name: "inbox-live-a", title: "Inbox live: header colour" };
  const B = { name: "inbox-live-b", title: "Inbox live: footer colour" };

  // The dev box's repo, on this machine: what the commands did is read from
  // its files. The Inbox counts uncommitted files and commits on no remote as
  // unsaved, so the run starts with both at nothing: a local remote, and
  // whatever an earlier run left committed and pushed there.
  const repo = `${process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box"}/acme-shop`;
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=acme", "-c", "user.email=acme@example.com", ...args], { encoding: "utf8" });
  if (!existsSync(`${repo}.git`)) execFileSync("git", ["init", "-q", "--bare", `${repo}.git`]);
  if (!git("remote").includes("origin")) git("remote", "add", "origin", `${repo}.git`);
  git("add", "-A");
  if (git("status", "--porcelain")) git("commit", "-qm", "left by an earlier run");
  git("push", "-q", "origin", "HEAD:main");
  if (git("status", "--porcelain") || git("log", "--oneline", "HEAD", "--not", "--remotes")) throw new Error("acme-shop should start with nothing unsaved");

  step("two real agents start, and each asks with a form");
  for (const s of [A, B]) await call(`${api}/sessions/${s.name}`, { method: "DELETE" }).catch(() => {});
  await start(A.name, A.title, prompt(form('Which colour should the acme "header" use?', "Blue harbour", "Red lighthouse"), "After I answer, repeat my answer back word for word on its own line, then stop."));
  await start(B.name, B.title, prompt(form("Which colour should the acme footer use?", "Green quay", "Grey pier"), "After I answer, repeat it back and stop."));

  const started = (await call(`${api}/sessions`)).find((x) => x.name === A.name);
  if ((started.driver === "claude") !== (driver !== "terminal")) throw new Error(`wanted the ${driver} driver, the session has ${started.driver}`);

  step("the Inbox brings them up by itself, under decisions");
  await page.getByTestId("nav-more").click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Inbox/ }).click();
  await expect(row(A.title)).toHaveCount(1, { timeout: 180_000 });
  await expect(row(B.title)).toHaveCount(1, { timeout: 180_000 });
  await expect(page.getByTestId("inbox-group-decision")).toContainText(A.title);

  step("the real form shows, with its recommended option marked");
  await row(A.title).click();
  const title = page.getByTestId("inbox-card-title");
  await expect(title).toHaveText(A.title);
  await expect(page.getByTestId("inbox-question")).toContainText("Which colour should the acme", { timeout: 120_000 });
  await expect(page.getByTestId("inbox-recommended")).toHaveText("Recommended");
  await shot("1-real-form");

  step("the peek shows the real session beside the card");
  await page.keyboard.press("p");
  const peek = page.getByTestId("inbox-peek");
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId("peek-user").first()).toContainText("AskUserQuestion", { timeout: 30_000 });
  await shot("2-peek");

  step("pick with a number key, add a note with a double quote in it, and send");
  await page.keyboard.press("1");
  const note = page.getByTestId("inbox-note");
  await note.fill('keep it "calm" please');
  await note.press("Control+Enter");
  await expect(row(A.title)).toHaveCount(0, { timeout: 30_000 });
  await shot("3-sent");

  step("second view: the agent gets the whole answer, not cut at the quote, and says it back");
  const wanted = "Blue harbour. keep it ”calm” please";
  await expect.poll(async () => { const { items } = await lastQuestion(A.name); const at = items.findLastIndex((i) => i.kind === "question"); return items.slice(at + 1).some((i) => i.kind === "text" && i.text.includes(wanted)); }, { timeout: 180_000, intervals: [2000] }).toBe(true);
  await expect.poll(async () => (await lastQuestion(A.name)).q?.done, { timeout: 30_000 }).toBe(true);

  const alive = async (name) => (await call(`${api}/sessions`)).some((x) => x.name === name);

  step("Close session with nothing unsaved stops it at once, and the agent takes no turn");
  await row(B.title).click();
  await expect(title).toHaveText(B.title);
  await expect(page.getByTestId("inbox-question")).toContainText("footer", { timeout: 120_000 });
  const before = (await lastQuestion(B.name)).items.length;
  await page.getByTestId("inbox-close").click();
  await expect(page.getByTestId("inbox-undo")).toBeVisible();
  await shot("4-undo");
  await expect(page.getByTestId("inbox-undo")).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => alive(B.name), { timeout: 30_000 }).toBe(false);
  await expect(row(B.title)).toHaveCount(0, { timeout: 60_000 });
  if (before < 1) throw new Error("the form's session had no record to compare");
  await shot("5-closed-clean");

  // A real permission prompt, allowed from the card and then resolved from it.
  const allow = { name: "inbox-live-c", title: "Inbox live: allow a command" };
  const deny = { name: "inbox-live-d", title: "Inbox live: leave a command" };
  const dirty = { name: "inbox-live-e", title: "Inbox live: unsaved form" };
  const run = `${driver}-${Date.now()}`;
  const allowFile = `inbox-allow-${run}.txt`;
  const denyFile = `inbox-deny-${run}.txt`;
  const unsaved = () => git("status", "--porcelain");
  // What the Inbox tells an agent with unsaved work, as an answer or a message.
  const toldToClose = async (name) => JSON.stringify((await call(`${api}/sessions/${name}/transcript?since=0`).catch(() => ({}))).items ?? []).includes("being closed from the Inbox");
  const askRun = (file) => `Use the Bash tool to run exactly this command: python3 -c "open('${file}','w').write('ok')" Then say DONE and stop.`;
  for (const s of [allow, deny, dirty]) await call(`${api}/sessions/${s.name}`, { method: "DELETE" }).catch(() => {});

  step("a real permission prompt comes up with plain choices");
  await start(allow.name, allow.title, askRun(allowFile), "default");
  await expect(row(allow.title)).toHaveCount(1, { timeout: 180_000 });
  await row(allow.title).click();
  await expect(title).toHaveText(allow.title);
  const choices = page.getByTestId("inbox-choices");
  await expect(choices).toContainText("Allow", { timeout: 60_000 });
  await expect(choices).toContainText("Deny");
  await shot("6-permission");

  step("Allow from the card, and the command runs");
  await choices.getByRole("button", { name: /^Allow/ }).first().click();
  await expect(row(allow.title)).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => { const { items } = await lastQuestion(allow.name); return items.some((i) => i.kind === "text" && i.text.includes("DONE")); }, { timeout: 180_000, intervals: [2000] }).toBe(true);
  if (readFileSync(`${repo}/${allowFile}`, "utf8") !== "ok") throw new Error(`the allowed command didn't write ${allowFile}`);

  step("the allowed command left an unsaved file: Close over a form has the agent close itself");
  await start(dirty.name, dirty.title, prompt(form("Which colour should the acme sidebar use?", "Teal dock", "Plum buoy"), "Then do what my answer says."), "bypassPermissions");
  await expect(row(dirty.title)).toHaveCount(1, { timeout: 180_000 });
  await row(dirty.title).click();
  await expect(title).toHaveText(dirty.title);
  await expect(page.getByTestId("inbox-question")).toContainText("sidebar", { timeout: 120_000 });
  if (!unsaved().includes(allowFile)) throw new Error(`${allowFile} should be unsaved before the close: ${unsaved()}`);
  await page.getByTestId("inbox-close").click();
  await expect(page.getByTestId("inbox-undo")).toBeHidden({ timeout: 15_000 });
  // Second view: the agent itself was told to save and close, not just stopped.
  let told = false;
  await expect.poll(async () => { told ||= await toldToClose(dirty.name); return alive(dirty.name); }, { timeout: 240_000, intervals: [3000] }).toBe(false);
  if (!told) throw new Error("the session ended without being told to save its work");
  await expect(row(dirty.title)).toHaveCount(0, { timeout: 60_000 });
  await shot("7-closed-itself");

  step(driver === "terminal" ? "Close on a permission prompt denies it (the agent closing itself isn't checked on the terminal: features/inbox.md, Gotchas)" : "Close on a permission prompt denies it, and the agent closes itself");
  await start(deny.name, deny.title, askRun(denyFile), "default");
  await expect(row(deny.title)).toHaveCount(1, { timeout: 180_000 });
  await row(deny.title).click();
  await expect(title).toHaveText(deny.title);
  await expect(page.getByTestId("inbox-choices")).toContainText("Deny", { timeout: 60_000 });
  await page.getByTestId("inbox-close").click();
  await expect(page.getByTestId("inbox-undo")).toBeHidden({ timeout: 15_000 });
  if (driver === "terminal") {
    // The deny key goes; the close message after it waits for an idle the box
    // doesn't see on the terminal after an interrupt, so it isn't checked here.
    await expect.poll(async () => (await lastQuestion(deny.name)).items.some((i) => i.kind === "notice" && i.notice === "interrupted"), { timeout: 60_000, intervals: [2000] }).toBe(true);
  } else {
    // In this mode the agent has to ask to run its own close, and that's a new card.
    await expect
      .poll(
        async () => {
          if (!(await alive(deny.name))) return "closed";
          if ((await row(deny.title).count()) > 0) {
            await row(deny.title).click();
            const yes = page.getByTestId("inbox-choices").getByRole("button", { name: /^Allow/ }).first();
            if (await yes.isVisible().catch(() => false)) await yes.click();
          }
          return "open";
        },
        { timeout: 240_000, intervals: [4000] },
      )
      .toBe("closed");
  }
  if (existsSync(`${repo}/${denyFile}`)) throw new Error(`the denied command ran: ${denyFile} exists`);
  await shot("8-permission-closed");

  step("clean up the test sessions");
  for (const s of [A, B, allow, deny, dirty]) await call(`${api}/sessions/${s.name}`, { method: "DELETE" }).catch(() => {});
}
