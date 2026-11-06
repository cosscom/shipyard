// Asking without stopping, with real Claude Code on a dev box
// (features/plugins.md, plugin-ask): an agent posts an ask with the
// berth_ask tool and one with `berthd ask`, each ends its turn without
// waiting, the asks show in a plugin through berth.attention, and what the
// person does there (an answer, a close) reaches each agent as its next
// prompt, which it writes to a file with its own Bash tool.
//
//   ../dev-box.sh up && eval "$(../dev-box.sh env)"   # every BERTH_* unset
//   node drive.mjs ask-live --port $PORT --agent http://127.0.0.1:9378
//
// dev-box.sh's session "ask" (Claude Code in its terminal, with the
// machine's own MCP servers) runs this checkout's bin/berthd for the CLI.
// The scenario starts a second Claude Code, "asker", whose only MCP server
// is this checkout's `berthd mcp`. Run it once per `up`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const live = true;
export const params = { labs: "0" };

const BOX = "devq";
const dir = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";
const root = execFileSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"]).toString().trim();
const berthd = join(root, "bin", "berthd");
const repo = join(dir, "acme-shop");
// The dev box's own state, and nothing of the session this runs from.
const boxEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BERTH_")));
Object.assign(boxEnv, { BERTH_HOME: `${dir}/box-home`, BERTH_USER_DIR: `${dir}/box-user`, TMUX_TMPDIR: `${dir}/tmux` });
const bd = (...args) => execFileSync(berthd, args, { env: boxEnv }).toString();
const tmux = (...args) => execFileSync("tmux", ["-L", "berth", ...args], { env: boxEnv }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}
const file = (name) => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8").trim() : "");

const MCP_ASK = "Ship the acme release notes on Friday?";
const CLI_ASK = "PR #12 is ready to merge";

export const plugins = [
  {
    id: "ask-check",
    name: "Ask check",
    source: `
import { createElement as h, useEffect, useState } from "react";
export default function (berth) {
  const BOX = ${JSON.stringify(BOX)};
  const Screen = () => {
    const [items, setItems] = useState(null);
    const [error, setError] = useState("");
    const load = () => berth.attention.list(BOX).then(setItems, (e) => setError(e.message));
    useEffect(() => {
      load();
      return berth.on("attention.*", load);
    }, []);
    const act = (it, change) => berth.attention.update(BOX, it.key, { revision: it.revision, ...change }).then(load, (e) => setError(e.message));
    // An agent's words are drawn as text, and only a decision gets its
    // options as buttons; every other kind gets this plugin's own verb.
    return h("div", { style: { padding: 16, display: "grid", gap: 12 } },
      error && h("p", { role: "alert" }, error),
      h("ul", { "aria-label": "Asks", style: { display: "grid", gap: 12 } }, (items ?? []).filter((it) => it.kind !== "mark").map((it) =>
        h("li", { key: it.key, "data-testid": "ask-" + it.session },
          h("p", { "data-testid": "ask-row" }, it.session + " · " + it.kind + " · " + it.status + (it.answer ? " (" + it.answer + ")" : "") + (it.closed_reason ? " (" + it.closed_reason + ")" : "") + " · rev " + it.revision + " · by " + it.by),
          h("p", { style: { fontWeight: 600 } }, it.title),
          it.details && h("p", null, it.details),
          it.status === "open" && h("div", { style: { display: "flex", gap: 8 } },
            it.kind === "decision"
              ? (it.options ?? []).map((o) => h("button", { key: o.label, onClick: () => act(it, { answer: o.label }) }, o.label + (o.label === it.recommended ? " (recommended)" : "") + (o.description ? ": " + o.description : "")))
              : h("button", { onClick: () => act(it, { status: "closed" }) }, "Close")),
        ))),
    );
  };
  berth.addScreen({ id: "ask-check", title: "Ask check", Component: Screen });
  berth.addSidebarItem({ id: "ask-check", title: "Ask check", icon: "Bell", screen: "ask-check" });
}
`,
  },
];

export async function run({ page, shot, step, expect, call, out }) {
  const box = (path, init) => call(`/v1/boxes/${BOX}/api${path}`, init);
  const open = async (session) => (await box(`/attention?session=${session}&open=1`)).find((i) => i.kind !== "mark");
  const idle = async (session) => ["idle", "finished"].includes((await box("/sessions")).find((s) => s.name === session)?.agent_state);

  step("start Claude Code session asker in acme-shop, whose only MCP server is this build's `berthd mcp`");
  const cfg = join(dir, "ask-mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { berth: { command: berthd, args: ["mcp"], env: { BERTH_HOME: boxEnv.BERTH_HOME, BERTH_USER_DIR: boxEnv.BERTH_USER_DIR } } } }));
  bd("session", "new", "acme-shop", "--name", "asker", "--", "claude", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", cfg);
  // A folder it hasn't seen asks to be trusted first (dev-box.sh's way).
  await sleep(8000);
  tmux("send-keys", "-t", "asker", "Up");
  await sleep(500);
  tmux("send-keys", "-t", "asker", "Enter");
  await until("asker at its prompt", async () => /bypass permissions/i.test(bd("session", "screen", "asker")), 60_000);

  step("asker: post a decision with berth_ask, and end the turn without waiting");
  await box("/sessions/asker/send", {
    method: "POST",
    body: JSON.stringify({
      when: "now",
      text: `Call the berth_ask tool once, with kind "decision", title "${MCP_ASK}", details "The freeze starts Monday.", options [{"label":"Friday"},{"label":"Monday","description":"after the freeze"}] and recommended "Friday". Don't wait for an answer: right after the call, write the tool's result to mcp-posted.txt with your Bash tool, then end your turn with one short line. Later a message will give you my answer. When it does, write only the answer, one word, to mcp-answer.txt with your Bash tool, and end your turn.`,
    }),
  });
  const mcpItem = await until("asker's ask on the box", () => open("asker"));
  if (mcpItem.kind !== "decision" || mcpItem.title !== MCP_ASK || mcpItem.by !== "mcp" || mcpItem.recommended !== "Friday" || mcpItem.options?.length !== 2) throw new Error(`asker posted ${JSON.stringify(mcpItem)}`);
  await until("asker to carry on and write mcp-posted.txt", async () => file("mcp-posted.txt").includes("session:asker"));
  await until("asker's turn to end", () => idle("asker"));
  step(`asker's ask is on the box (key ${mcpItem.key}, by mcp), and its turn ended without an answer; mcp-posted.txt: ${file("mcp-posted.txt")}`);

  step("ask (dev-box.sh's Claude Code): post a ready with this build's `berthd ask`, and end the turn");
  await until("ask at its prompt", () => idle("ask"), 60_000);
  await box("/sessions/ask/send", {
    method: "POST",
    body: JSON.stringify({
      when: "now",
      text: `Run this with your Bash tool, exactly as it is: ${berthd} ask --kind ready --title "${CLI_ASK}" --details "The acme checks pass." Then end your turn with one short line; don't wait. Later a message will come about it. When it does, write that message's whole text to cli-answer.txt with your Bash tool, and end your turn.`,
    }),
  });
  const cliItem = await until("ask's ask on the box", () => open("ask"));
  if (cliItem.kind !== "ready" || cliItem.title !== CLI_ASK || cliItem.options) throw new Error(`ask posted ${JSON.stringify(cliItem)}`);
  await until("ask's turn to end", () => idle("ask"));

  step("the app: open the plugin's screen; both asks show, the decision with its options, the ready with only the plugin's own Close");
  await page.getByTestId("nav-more").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Ask check" }).click();
  const mcpRow = page.getByTestId("ask-asker");
  const cliRow = page.getByTestId("ask-ask");
  await expect(mcpRow.getByTestId("ask-row")).toHaveText(`asker · decision · open · rev ${mcpItem.revision} · by mcp`);
  await expect(mcpRow.getByText(MCP_ASK)).toBeVisible();
  await expect(mcpRow.getByRole("button")).toHaveText(["Friday (recommended)", "Monday: after the freeze"]);
  await expect(cliRow.getByTestId("ask-row")).toHaveText(new RegExp(`^ask · ready · open · rev ${cliItem.revision} · by `));
  await expect(cliRow.getByText(CLI_ASK)).toBeVisible();
  await expect(cliRow.getByRole("button")).toHaveText(["Close"]);
  await shot("1-two-asks");

  step("answer asker's decision with Monday, and close ask's ready");
  await mcpRow.getByRole("button", { name: "Monday: after the freeze" }).click();
  await expect(mcpRow.getByTestId("ask-row")).toHaveText(`asker · decision · answered (Monday) · rev ${mcpItem.revision + 1} · by app`);
  await cliRow.getByRole("button", { name: "Close" }).click();
  await expect(cliRow.getByTestId("ask-row")).toHaveText(`ask · ready · closed (resolved) · rev ${cliItem.revision + 1} · by app`);
  await shot("2-answered-and-closed");

  step("each agent gets it as its next prompt, and writes it down with its own Bash tool");
  const answer = await until("asker to write mcp-answer.txt", async () => file("mcp-answer.txt"));
  if (answer !== "Monday") throw new Error(`asker wrote ${JSON.stringify(answer)}`);
  const closed = await until("ask to write cli-answer.txt", async () => file("cli-answer.txt"));
  if (!closed.includes("closed your ask") || !closed.includes(CLI_ASK)) throw new Error(`ask wrote ${JSON.stringify(closed)}`);
  step(`mcp-answer.txt: ${answer}; cli-answer.txt: ${closed}`);

  step("second view: each session's turns, where the last was prompted by the person's laptop, under the ask's idempotency key");
  for (const [session, item] of [["asker", mcpItem], ["ask", cliItem]]) {
    const turns = await box(`/sessions/${session}/turns?limit=5`);
    const told = turns.find((t) => t.idem_key?.startsWith(`attention:${item.key}@`));
    if (!told || !told.origin?.startsWith("laptop:")) throw new Error(`${session}'s turns: ${JSON.stringify(turns)}`);
    step(`${session}: turn ${told.id}, origin ${told.origin}, idem_key ${told.idem_key}, ${told.state}`);
  }
  writeFileSync(join(out, "asker-screen.txt"), bd("session", "screen", "asker", "--history", "80"));
  writeFileSync(join(out, "ask-screen.txt"), bd("session", "screen", "ask", "--history", "80"));
  bd("session", "kill", "asker");
}
