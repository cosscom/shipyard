// chat-background-shells-live: the chat's background-work chip and panel on
// a real box (features/chat-background-shells.md). Claude Code starts two
// shells in the background, one that says hi after 20 seconds and one that
// exits with code 3. The panel shows the first Running, the second
// `Failed · exit 3`, then the first `Done · exit 0` within seconds of its
// exit, each with a duration that no longer grows, and the chip stops
// saying "running". The box's own transcript signals say the same.
//
// On a dev box of this checkout, its agent structured (the way the app
// starts agents, and where the bug was):
//
//   VERIFY_DRIVER=claude ../dev-box.sh up
//   eval "$(../dev-box.sh env)"
//   node drive.mjs chat-background-shells-live --port $PORT --agent http://127.0.0.1:9378
//
// Without VERIFY_DRIVER it drives Claude in its terminal, which reads its
// own transcript file instead: the same assertions hold.

export const live = true;
export const params = { view: "conversation", sidebar: "list", labs: "0" };

const WORKTREE = process.env.VERIFY_WORKTREE ?? "devq/acme-shop";
const BOX = WORKTREE.split("/")[0];
const SESSION = process.env.VERIFY_SESSION ?? "ask";
const HI = "Say hi after 20 seconds";
const BAD = "Exit with code 3";

export async function run({ page, shot, step, expect, call }) {
  const signals = async () => (await call(`/v1/boxes/${BOX}/api/sessions/${SESSION}/transcript`)).signals?.background ?? [];
  const job = async (label) => (await signals()).find((j) => j.label === label) ?? {};
  const pane = page.locator("[data-testid=pane]:visible").first();

  step("open the agent's chat");
  await page.locator(`[data-testid=worktree-row][data-worktree="${WORKTREE}"]`).click({ position: { x: 32, y: 12 } });
  // A new agent opens on its first-task box; one with a conversation, on
  // its chat.
  let reply = pane.getByRole("textbox", { name: "What should Claude Code do?", exact: true });
  try {
    await expect(reply).toBeEditable({ timeout: 30_000 });
  } catch {
    reply = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
  }

  step("ask for two shells in the background: one that says hi after 20 seconds, one that exits with code 3");
  await reply.fill(
    "In one message, call the Bash tool twice, both with run_in_background true: " +
      `first command \`sleep 20; echo hi\` with description "${HI}", then command \`sleep 6; exit 3\` with description "${BAD}". ` +
      "Don't wait for them and don't read their output: reply with the single word started and end your turn. When one finishes later, reply with one word.",
  );
  await reply.press("Enter");

  step("the chip says both run");
  const chip = pane.getByRole("button", { name: /^Background work: / });
  await expect(chip).toHaveAccessibleName("Background work: 2 shells running", { timeout: 120_000 });
  const started = Date.now();
  await chip.click();
  const row = (label) => page.getByRole("button", { name: new RegExp(label) });
  const state = (label) => row(label).getByTestId("job-state");
  const took = (label) => row(label).getByTestId("job-took");
  await expect(state(HI)).toHaveText("Running");
  await shot("1-both-running");

  step("the one that exits with code 3 shows Failed · exit 3, the other still runs");
  await expect(state(BAD)).toHaveText("Failed · exit 3", { timeout: 30_000 });
  await expect(state(HI)).toHaveText("Running");
  await expect(chip).toHaveAccessibleName("Background work: 1 shell running");
  await shot("2-failed-exit-3");

  step("within seconds of its exit, the other shows Done · exit 0");
  await expect(state(HI)).toHaveText("Done · exit 0", { timeout: 60_000 });
  const late = (Date.now() - started) / 1000;
  step(`Done showed ${late.toFixed(0)}s after the chip first said both ran (the shell sleeps 20s)`);
  if (late > 45) throw new Error(`Done came ${late.toFixed(0)}s after the shells started: more than ~10s after the exit`);
  await expect(chip).toHaveAccessibleName(/^Background work: \d+ finished$/);
  await shot("3-done-exit-0");

  step("its output stays readable");
  await row(HI).click();
  await expect(page.locator("pre").filter({ hasText: /\bhi\b/ })).toBeVisible({ timeout: 15_000 });
  await shot("4-done-output");

  step("the durations no longer grow");
  const before = [await took(HI).innerText(), await took(BAD).innerText()];
  await page.waitForTimeout(20_000); // the chip's clock ticks every 15s
  await expect(took(HI)).toHaveText(before[0]);
  await expect(took(BAD)).toHaveText(before[1]);
  step(`durations stay ${before.join(" and ")}`);

  step("the box's transcript says the same (a second view)");
  const hi = await job(HI);
  const bad = await job(BAD);
  if (hi.state !== "done" || hi.exit !== 0 || !hi.until) throw new Error(`box signals for "${HI}": ${JSON.stringify(hi)}`);
  if (bad.state !== "failed" || bad.exit !== 3 || !bad.until) throw new Error(`box signals for "${BAD}": ${JSON.stringify(bad)}`);
  step(`box: ${HI} ${hi.state} exit ${hi.exit}, ${BAD} ${bad.state} exit ${bad.exit}`);

  step("closed, the chip no longer says running");
  await page.keyboard.press("Escape");
  await expect(chip).not.toHaveAccessibleName(/running/);
  await shot("5-chip-finished");
}
