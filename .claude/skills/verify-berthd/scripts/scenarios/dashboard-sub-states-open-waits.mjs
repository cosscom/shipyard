// dashboard-sub-states-open-waits: an agent already waiting when the preset
// is turned on is sorted then, on a real box with a real Claude Code and the
// real turn check provider. Needs ../sub-states-box.sh up, and a fresh one:
// it starts from no set. A form asked with no set waits unsorted; turning on
// the preset in Settings places it in Needs you to act, untagged, with no
// second agent.waiting. See ../../features/dashboard-sub-states.md.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const live = true;
export const params = { sidebar: "list", labs: "0" };

const dir = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";

const FORM = {
  questions: [{ header: "API key", question: "I can't reach the acme mail provider's dashboard from here. Please open it, create a read-only API key, and store it by running scripts/set-key.sh in your terminal. Tell me when you've done it.", multiSelect: false, options: [{ label: "Done", description: "The key is stored." }, { label: "Stuck", description: "I couldn't do it." }] }],
};
const PROMPT = `Connect the acme shop to the acme mail provider. You can't reach its dashboard, so first have me make the key: use the AskUserQuestion tool exactly once with this input, before anything else: ${JSON.stringify(FORM)}. When it's answered, reply with one word and stop.`;

// The box's form window (settle + turn check's timeout + 2 s) and then some:
// past it, the wait is no longer the form's own placing's.
const FORM_WINDOW_MS = 16000;

export async function run({ page, shot, step, expect, call }) {
  const session = async () => (await call("/v1/boxes/devq/api/sessions")).find((s) => s.name === "ask");
  const board = page.getByTestId("dashboard-board");

  await step("With no sub-states, a real Claude asks for a key and waits");
  if ((await call("/v1/boxes/devq/api/substates")).states.length !== 0) throw new Error("start from a fresh sub-states-box.sh up: devq has a set");
  const before = (await session()).state_seq ?? 0;
  await call("/v1/boxes/devq/api/sessions/ask/send", { method: "POST", body: JSON.stringify({ text: PROMPT, when: "now" }) });
  await expect.poll(async () => { const s = await session(); return s.agent_state === "waiting" && (s.state_seq ?? 0) > before; }, { timeout: 120000, intervals: [200] }).toBe(true);
  await page.getByTestId("nav-home").click();
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/], { timeout: 30000 });
  await page.waitForTimeout(FORM_WINDOW_MS);
  if ((await session()).agent_sub_state !== undefined) throw new Error("placed with no set");

  await step("Turn on the preset in Settings");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-agents").click();
  const panel = page.getByTestId("substates");
  await panel.getByRole("button", { name: "Use Needs a decision and Needs you to act" }).click();
  await expect(panel.getByRole("textbox", { name: "Name of column 1" })).toHaveValue("Needs a decision");
  await page.getByRole("button", { name: "Back to app" }).click();

  await step("The wait that was already open is sorted into Needs you to act");
  await expect.poll(async () => (await session()).agent_sub_state, { timeout: 60000, intervals: [250] }).toBe("act");
  await page.getByTestId("nav-home").click();
  const act = board.getByRole("region", { name: "Needs you to act" });
  const card = act.locator("article");
  await expect(card).toHaveCount(1, { timeout: 30000 });
  await expect(act.getByTestId("not-sorted")).toHaveCount(0);
  await expect.poll(() => card.evaluate((el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; }), { timeout: 15000 }).toBe(1);
  await shot("open-wait-sorted");

  await step("No new wait: one agent.waiting for it, and an agent.substate about it");
  const events = globSync(join(dir, "box-home", "**", "journal", "*.jsonl")).flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  const mine = events.filter((e) => e.data?.session === "ask" && e.seq > before);
  const waits = mine.filter((e) => e.type === "agent.waiting");
  const placed = mine.filter((e) => e.type === "agent.substate" && e.data.sub_state === "act");
  if (placed.length !== 1) throw new Error(`agent.substate: ${JSON.stringify(mine.filter((e) => e.type === "agent.substate"))}`);
  if (waits.some((w) => w.seq > placed[0].seq)) throw new Error("a second agent.waiting after it was sorted");
  if ((await session()).agent_state !== "waiting") throw new Error("not waiting");
  await step(`${waits.length} agent.waiting before it, 1 agent.substate (${placed[0].data.sub_state})`);
}
