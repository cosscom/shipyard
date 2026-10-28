// session-env-live: the chats of agents started with variables of their own
// (features/session-env.md), on the dev box ../session-env-live.sh left
// them on. Each chat shows Claude Code's Bash tool reading its own
// environment: the session's ACME_REGION and ACME_RUN over the project's
// and the box's, ACME_TICKET the project's over the box's, ACME_ACCOUNT the
// box's.
//
//   node drive.mjs session-env-live --port $PORT --agent http://127.0.0.1:9378
//
// The sessions are found on the box by where they run: env-mcp's worktree
// (berth_task_new) and env-task's (berthd task new).

export const live = true;
export const params = { view: "conversation", sidebar: "list" };

const BOX = (process.env.VERIFY_WORKTREE ?? "devq/acme-shop").split("/")[0];
const SAW = {
  "env-mcp": ["ACME_ACCOUNT=box", "ACME_REGION=ap-south", "ACME_RUN=mcp-43", "ACME_TICKET=repo"],
  "env-task": ["ACME_ACCOUNT=box", "ACME_REGION=eu-north", "ACME_RUN=task run 41", "ACME_TICKET=repo"],
};

export async function run({ page, shot, step, expect, call }) {
  const sessions = await call(`/v1/boxes/${BOX}/api/sessions`);
  const pane = page.locator("[data-testid=pane]:visible");
  const chat = pane.locator("[data-testid=chat]");
  for (const [wt, lines] of Object.entries(SAW)) {
    const sess = sessions.find((s) => s.location === `acme-shop/${wt}` && s.driver === "claude");
    if (!sess) throw new Error(`no chat session in acme-shop/${wt}: ${sessions.map((s) => `${s.name} ${s.location} ${s.driver}`).join(", ")}`);
    step(`${wt}: open ${sess.name}'s chat`);
    await page.locator(`[data-testid=worktree-row][data-worktree="${BOX}/${wt}"]`).click({ position: { x: 32, y: 12 } });
    const tab = pane.getByRole("tab").filter({ hasText: /claude/i });
    if (await chat.count() === 0 && await tab.count() > 0) await tab.first().click();
    await expect(chat).toBeVisible({ timeout: 30_000 });
    for (const line of lines) await expect(chat.getByText(line, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    step(`${wt}: the chat shows ${lines.join(", ")}`);
    await shot(`${wt}-chat`);
  }
}
