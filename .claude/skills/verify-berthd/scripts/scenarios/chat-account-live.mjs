// The chat's foot names the account each agent runs on, on a real box
// (features/chat-account.md), read back from the box's own session list and
// from the agent process's environment.
//
// On a dev box of this checkout, structured (`ask` is Claude Code on the
// box's default account, in chat), every BERTH_* unset:
//
//   VERIFY_DRIVER=claude ../dev-box.sh up && eval "$(../dev-box.sh env)"
//   node drive.mjs chat-account-live --port $PORT --agent http://127.0.0.1:9378
//
// It makes two synthetic account folders in the dev box's own folder
// (VERIFY_BOX_DIR), outside ~/.berth/accounts, so the chip names them by
// path; the dev box's HOME is the real one, so its count includes that
// machine's own accounts. It changes the dev box's env.json and nothing
// outside VERIFY_BOX_DIR.
//
// 1. `ask`, on the default: its chip says default (when the machine has
//    more than one account).
// 2. `on-work`, started with env.json on the work folder (in its terminal:
//    the folder has no sign-in, so Claude Code waits at its first screen):
//    its chip names the work folder.
// 3. env.json on the personal folder, and `ask` switched to its terminal
//    (its agent starts again in its pane): its chip names personal, as its
//    claude process's environment does, though tmux's session environment
//    never had it.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const live = true;
export const params = { view: "conversation", sidebar: "list" };

const WORKTREE = process.env.VERIFY_WORKTREE ?? "devq/acme-shop";
const BOX = WORKTREE.split("/")[0];
const dir = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";
const WORK = join(dir, "accounts", "acme-work");
const PERSONAL = join(dir, "accounts", "acme-personal");

// The CLAUDE_CONFIG_DIR a session's claude process really has: the
// processes under its pane, by the dev box's own tmux server.
function processAccount(session) {
  const pane = execFileSync("tmux", ["-L", "berth", "display-message", "-p", "-t", `=${session}:`, "#{pane_pid}"], { env: { ...process.env, TMUX_TMPDIR: join(dir, "tmux") } }).toString().trim();
  const kids = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const all = [];
  for (const queue = [pane]; queue.length; ) {
    const pid = queue.shift();
    all.push(pid);
    queue.push(...kids(pid));
  }
  for (const pid of all) {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!/(^|\/)claude\0|claude-code|\/claude\/|\0claude\0/.test(cmd)) continue;
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const v = env.find((kv) => kv.startsWith("CLAUDE_CONFIG_DIR="));
    return v ? v.slice("CLAUDE_CONFIG_DIR=".length) : "";
  }
  throw new Error(`no claude process under ${session}'s pane (${all.join(" ")})`);
}

export async function run({ page, shot, step, expect, call }) {
  const api = (path, init) => call(`/v1/boxes/${BOX}/api/${path}`, init);
  const account = async (name) => (await api("sessions")).find((s) => s.name === name)?.account;
  const pane = page.locator("[data-testid=pane]:visible");
  const foot = pane.locator("[data-chat-controls]");
  const chip = foot.getByTestId("chat-account");
  const open = async (title) => {
    await page.locator(`[data-testid=worktree-row][data-worktree="${WORKTREE}"]`).click({ position: { x: 32, y: 12 } });
    await page.locator("[data-tab-strip] [data-tab]", { hasText: title }).click();
    await expect(foot).toBeVisible({ timeout: 30_000 });
  };
  mkdirSync(WORK, { recursive: true });
  mkdirSync(PERSONAL, { recursive: true });
  const before = await api("env");
  try {
    step("ask runs on the box's default account");
    await api("sessions/ask", { method: "PATCH", body: JSON.stringify({ title: "On the default" }) });
    const def = await account("ask");
    if (def?.name !== "default") throw new Error(`ask's account: ${JSON.stringify(def)}`);
    step(`the box lists ${def.count} Claude Code accounts`);
    await open("On the default");
    if (def.count > 1) await expect(chip).toHaveText("default");
    else await expect(chip).toHaveCount(0);
    await shot("1-default");

    step("env.json picks the work folder; a new session starts on it");
    await api("env", { method: "PUT", body: JSON.stringify({ env: { ...before.env, CLAUDE_CONFIG_DIR: WORK } }) });
    await api("sessions", { method: "POST", body: JSON.stringify({ name: "on-work", location: WORKTREE.split("/").slice(1).join("/") || "acme-shop", agent: "claude", title: "On the work folder" }) });
    await expect.poll(async () => (await account("on-work"))?.dir, { timeout: 20_000 }).toBe(WORK);
    await expect.poll(() => processAccount("on-work"), { timeout: 30_000, intervals: [1_000] }).toBe(WORK);
    await open("On the work folder");
    await expect(chip).toHaveText(WORK);
    await chip.hover();
    await expect(page.locator("[data-slot=tooltip-popup]")).toHaveText(`Claude Code account in ${WORK}`);
    await page.waitForTimeout(300);
    await shot("2-work-folder");
    await page.mouse.move(10, 890);

    step("env.json picks the personal folder; ask starts again in its terminal");
    await api("env", { method: "PUT", body: JSON.stringify({ env: { ...before.env, CLAUDE_CONFIG_DIR: PERSONAL } }) });
    await api("sessions/ask/send", { method: "POST", body: JSON.stringify({ text: "Reply with exactly: ok" }) });
    await expect.poll(async () => (await api("sessions")).find((s) => s.name === "ask")?.agent_state, { timeout: 120_000, intervals: [2_000] }).toBe("finished");
    await api("sessions/ask/switch", { method: "POST", body: JSON.stringify({ to: "terminal" }) });
    await expect.poll(async () => (await account("ask"))?.dir, { timeout: 20_000 }).toBe(PERSONAL);
    await expect.poll(() => processAccount("ask"), { timeout: 30_000, intervals: [1_000] }).toBe(PERSONAL);
    await open("On the default");
    await expect(chip).toHaveText(PERSONAL);
    await shot("3-follows-respawn");
    // The work session is where it was.
    if ((await account("on-work"))?.dir !== WORK) throw new Error("on-work moved");
  } finally {
    await api("env", { method: "PUT", body: JSON.stringify({ env: before.env ?? {} }) });
  }
}
