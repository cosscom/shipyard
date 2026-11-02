// dashboard-sub-states-live: the sub-states of Needs you on real boxes, with
// a real Claude Code and the real turn check provider. Needs a dev box with
// turn check on and a second box paired (../sub-states-box.sh up). An agent's
// edit over MCP shows in Settings and spreads to the second box; a real form
// lands in the default and moves when the answer arrives; the field reads the
// same through the API, `berthd sessions --json` and MCP; removing the set
// brings the four columns back. See ../../features/dashboard-sub-states.md.
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const live = true;
export const params = { sidebar: "list", labs: "0" };

const dir = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
const boxEnv = { ...process.env, BERTH_HOME: join(dir, "box-home"), BERTH_USER_DIR: join(dir, "box-user"), TMUX_TMPDIR: join(dir, "tmux") };
for (const k of ["BERTH_SESSION", "BERTH_DRIVER", "BERTH_LOCATION", "BERTH_WORKTREE_NAME"]) delete boxEnv[k];

// One MCP call, as an agent on the box makes it: `berthd mcp` on its socket.
function mcp(tool, args, caller) {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ];
  const out = execFileSync(join(root, "bin/berthd"), ["mcp"], { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", env: { ...boxEnv, ...(caller ? { BERTH_SESSION: caller } : {}) } }).toString();
  const answer = out.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const text = answer.result.content[0].text;
  if (answer.result.isError) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text);
}
const box = (...a) => JSON.parse(execFileSync(join(root, "bin/berthd"), a, { env: boxEnv }).toString());

const FORM = {
  questions: [{ header: "API key", question: "I can't reach the acme mail provider's dashboard from here. Please open it, create a read-only API key, and store it by running scripts/set-key.sh in your terminal. Tell me when you've done it.", multiSelect: false, options: [{ label: "Done", description: "The key is stored." }, { label: "Stuck", description: "I couldn't do it." }] }],
};
const PROMPT = `Connect the acme shop to the acme mail provider. You can't reach its dashboard, so first have me make the key: use the AskUserQuestion tool exactly once with this input, before anything else: ${JSON.stringify(FORM)}. When it's answered, reply with one word and stop.`;

export async function run({ page, shot, step, expect, call }) {
  const json = (path, init) => call(path, init);
  const sub = (b) => json(`/v1/boxes/${b}/api/substates`);
  const session = async () => (await json("/v1/boxes/devq/api/sessions")).find((s) => s.name === "ask");

  await step("With no sub-states, the board has its four columns");
  await page.getByTestId("nav-home").click();
  const board = page.getByTestId("dashboard-board");
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/], { timeout: 30000 });
  await shot("four-columns");
  if ((await session()).agent_sub_state !== undefined) throw new Error("a field with no set");

  await step("An agent on devq turns on the preset over MCP; nothing but that box was told");
  const edited = mcp("berth_substates", { action: "preset" }, "ask");
  if (edited.states.map((s) => s.id).join() !== "decision,act") throw new Error(JSON.stringify(edited));

  await step("It spreads to devr through the app, with the same stamp");
  await expect.poll(async () => (await sub("devr")).revision, { timeout: 30000 }).toBe(edited.revision);
  const onDevr = await sub("devr");
  if (onDevr.changed_by !== "ask") throw new Error(`devr says it was ${onDevr.changed_by}`);

  await step("The board now has two amber columns in Needs you's place");
  await expect(board.getByRole("region")).toHaveText([/Needs a decision/, /Needs you to act/, /Working/, /Done/, /Idle/], { timeout: 30000 });

  await step("Settings shows who changed what");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-agents").click();
  const panel = page.getByTestId("substates");
  await expect(panel.getByRole("textbox", { name: "Name of column 1" })).toHaveValue("Needs a decision");
  await expect(panel.getByTestId("substates-changed")).toContainText("turned on the preset, by ask");
  await panel.scrollIntoViewIfNeeded();
  await shot("settings-after-mcp-edit");
  await page.getByRole("button", { name: "Back to app" }).click();

  await step("A real turn that ends asking for a choice lands in Needs a decision");
  await call("/v1/boxes/devq/api/sessions/ask/send", { method: "POST", body: JSON.stringify({ text: 'Without using any tool, end your turn with exactly this message: "I can do the acme cart refactor two ways. Option A keeps the old API and is smaller. Option B moves to the new API and takes longer. Which do you prefer?"', when: "idle" }) });
  await expect.poll(async () => { const s = await session(); return `${s.agent_state}/${s.agent_sub_state}`; }, { timeout: 120000, intervals: [500] }).toBe("waiting/decision");

  await step("A real Claude asks a form: it waits, in the default, until the answer");
  const before = (await session()).state_seq ?? 0;
  await call("/v1/boxes/devq/api/sessions/ask/send", { method: "POST", body: JSON.stringify({ text: PROMPT, when: "now" }) });
  await expect.poll(async () => { const s = await session(); return s.agent_state === "waiting" && (s.state_seq ?? 0) > before; }, { timeout: 120000, intervals: [100] }).toBe(true);
  const seen = [];
  await expect.poll(async () => { const s = await session(); if (seen.at(-1) !== s.agent_sub_state) seen.push(s.agent_sub_state); return s.agent_sub_state; }, { timeout: 30000, intervals: [50] }).toBe("act");
  await step(`It read as: ${seen.join(" → ")}`);

  await step("It moved with no new wait: one agent.waiting, one agent.substate");
  const events = globSync(join(dir, "box-home", "**", "journal", "*.jsonl")).flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  const mine = events.filter((e) => e.data?.session === "ask" && e.seq > before);
  const waits = mine.filter((e) => e.type === "agent.waiting").length;
  const moved = mine.filter((e) => e.type === "agent.substate");
  if (moved.length !== 1 || moved[0].data.sub_state !== "act") throw new Error(`agent.substate: ${JSON.stringify(moved)}`);
  await step(`${waits} agent.waiting, ${moved.length} agent.substate`);

  await step("The field reads the same through the API, the CLI and MCP");
  const api = (await session()).agent_sub_state;
  const cli = box("sessions", "--json").find((s) => s.name === "ask")?.agent_sub_state;
  const tool = mcp("berth_sessions", {}).find((s) => s.name === "ask")?.sub_state;
  if (api !== "act" || cli !== "act" || tool !== "act") throw new Error(`api ${api}, cli ${cli}, mcp ${tool}`);

  await step("The card is in Needs you to act, untagged, and the state is still waiting");
  await page.getByTestId("nav-home").click();
  const act = board.getByRole("region", { name: "Needs you to act" });
  await expect(act.locator("article")).toHaveCount(1, { timeout: 30000 });
  await expect(act.getByTestId("not-sorted")).toHaveCount(0);
  if ((await session()).agent_state !== "waiting") throw new Error("not waiting");
  // Cards fade in as they arrive: the shot, and this check, wait for that.
  const card = act.locator("article");
  await expect.poll(() => card.evaluate((el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; }), { timeout: 15000 }).toBe(1);
  await expect(card).toContainText("acme");
  await shot("two-columns-real-form");

  await step("Removing the set brings the four columns back, on both boxes");
  mcp("berth_substates", { action: "clear" }, "ask");
  await expect(board.getByRole("region")).toHaveText([/Needs you/, /Working/, /Done/, /Idle/], { timeout: 30000 });
  await expect.poll(async () => (await sub("devr")).states.length, { timeout: 30000 }).toBe(0);
  await expect.poll(async () => (await session()).agent_sub_state, { timeout: 15000 }).toBeUndefined();
  await shot("four-columns-after");
}
