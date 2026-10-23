// chat-structured-ask-live: a real Claude Code, structured on a dev box
// (VERIFY_DRIVER=claude ../dev-box.sh up), leaves four helpers reading in
// the background and asks two questions (AskUserQuestion) while they read.
// Their lines pile up in the session's log after the question, megabytes
// of them, and they report back. Then the box starts again (../dev-box.sh
// restart), so the chat's conversation is read afresh, as after a restart
// or a chat nobody had open for a while. See ../../features/chat-ask-card.md.
//
// VERIFY_PHASE=ask   sends the prompt from the chat and waits until the
//                    question waits, the helpers are back, and the question
//                    is more than the box's first read (4 MB) from the end
//                    (about two minutes).
// VERIFY_PHASE=look  opens the chat afresh and checks what it shows, by
//                    VERIFY_EXPECT:
//   form    the question's form, with its options: picks them and submits,
//           and Claude's record gets the answers.
//   reply   a card with nothing to pick that says to reply below, and a
//           reply box that takes the words: sends them, and Claude's
//           record gets them as the answer.
//   locked  (the bug, for a before) the bare card and a reply box that
//           takes nothing.
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const live = true;
export const params = { view: "conversation", sidebar: "list" };

const dir = process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box";
// Read keeps ~600 lines of a file: ~63 KB of log per read. Four helpers
// read 25 files each, ~6 MB.
const HELPERS = 4;
const EACH = 25;
const FILES = HELPERS * EACH;
const QUESTIONS = {
  questions: [
    { header: "Release", question: "Which release do the acme notes cover?", multiSelect: false, options: [{ label: "2.4", description: "The one out now." }, { label: "2.5", description: "The one going out Monday." }] },
    { header: "Readers", question: "Who reads them?", multiSelect: false, options: [{ label: "Customers", description: "Plain words, no internals." }, { label: "The team", description: "Internals welcome." }] },
  ],
};
const REPLY = "Cover 2.5, for customers";

// The session's log on the dev box: berthd agent-host's events.jsonl.
let path;
function log() {
  if (path) return path;
  const all = globSync(join(dir, "box-home", "**", "conversations", "*", "events.jsonl"));
  if (all.length !== 1) throw new Error(`expected one conversation log under ${dir}, found ${all.length}`);
  return (path = all[0]);
}
// Its entries, each with the byte offset its line starts at. The host
// appends as it goes: the last line, unless the file ends with one, isn't
// whole yet.
function entries() {
  const out = [];
  let off = 0;
  const lines = readFileSync(log(), "utf8").split("\n");
  lines.pop();
  for (const l of lines) {
    if (l) out.push({ off, ...JSON.parse(l) });
    off += Buffer.byteLength(l) + 1;
  }
  return out;
}
// The answers sent to Claude (control_response) after the first `from`,
// as text.
const answers = () => entries().filter((e) => e.dir === "in" && e.data?.type === "control_response");
const answeredSince = (from) => answers().slice(from).map((e) => JSON.stringify(e.data)).join("\n");
const name = (i) => `notes/part${String(i).padStart(3, "0")}.txt`;

// Synthetic files for the helpers to read.
function seedFiles() {
  mkdirSync(join(dir, "acme-shop", "notes"), { recursive: true });
  const line = "acme checkout keeps the basket when a payment retries, and the badge counts what is in it. ";
  for (let i = 1; i <= FILES; i++) {
    const p = join(dir, "acme-shop", name(i));
    if (!existsSync(p)) writeFileSync(p, Array.from({ length: 600 }, (_, n) => `${i}.${n} ${line}`).join("\n"));
  }
}

// Where the last question's line starts, as bytes from the log's end, and
// how many helpers are back since the prompt (its byte offset, `from`): one
// can be back before the question is.
function sinceAsked(from) {
  let at = -1;
  let back = 0;
  for (const e of entries()) {
    if (e.data?.type === "control_request" && e.data.request?.tool_name === "AskUserQuestion") at = e.off;
    else if (e.off >= from && e.data?.type === "system" && e.data.subtype === "task_notification") back++;
  }
  return { behind: at < 0 ? 0 : statSync(log()).size - at, back };
}

async function openChat(page, expect) {
  const worktree = process.env.VERIFY_WORKTREE;
  if (!worktree) throw new Error("set VERIFY_WORKTREE to the worktree row's box/name");
  await page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`).click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  await expect(pane.getByTestId("chat")).toBeVisible({ timeout: 30_000 });
  return pane;
}

export async function run({ page, shot, step, expect, call }) {
  const phase = process.env.VERIFY_PHASE;
  if (phase === "ask") {
    seedFiles();
    step("open the structured agent's chat");
    const pane = await openChat(page, expect);
    let reply = pane.getByRole("textbox", { name: "What should Claude Code do?", exact: true });
    try {
      await expect(reply).toBeEditable({ timeout: 15_000 });
    } catch {
      reply = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
    }
    step(`ask for ${HELPERS} helpers reading in the background, and two questions while they read`);
    const tasks = Array.from({ length: HELPERS }, (_, h) => `helper ${h + 1}: "Read each of the files ${name(h * EACH + 1)} to ${name((h + 1) * EACH)} with the Read tool, one call per file, in order, then reply with the single word done."`);
    await reply.fill(
      `First launch ${HELPERS} helpers in one message with the Agent tool, each with run_in_background true and subagent_type general-purpose, with these tasks: ${tasks.join("; ")}. ` +
        `Right after launching them, without waiting for them, call the AskUserQuestion tool once with exactly this input JSON: ${JSON.stringify(QUESTIONS)}. ` +
        "After I answer, repeat my answers back in one line and stop. Do nothing else.",
    );
    // A new session has no log until its first prompt.
    let from = 0;
    try {
      from = statSync(log()).size;
    } catch {}
    await reply.press("Enter");
    step("the question waits");
    await expect.poll(async () => (await call("/v1/boxes/devq/api/sessions")).find((s) => s.name === "ask")?.ask?.tool ?? "", { timeout: 240_000 }).toBe("AskUserQuestion");
    await shot("1-asked-live");
    step("the helpers read on, then report back, the question still waiting");
    let behind = 0;
    await expect
      .poll(
        () => {
          const now = sinceAsked(from);
          behind = now.behind;
          return now.back;
        },
        { timeout: 900_000, intervals: [5_000] },
      )
      .toBeGreaterThanOrEqual(HELPERS);
    step(`the question is ${(behind / 1048576).toFixed(1)} MB from the log's end`);
    if (behind <= 4 << 20) throw new Error(`the helpers wrote too little after the question (${behind} bytes): raise EACH`);
    await shot("2-helpers-back-live");
    return;
  }

  if (phase !== "look") throw new Error("set VERIFY_PHASE to ask or look");
  const expectNow = process.env.VERIFY_EXPECT;
  step(`open the chat afresh, expecting ${expectNow}`);
  const pane = await openChat(page, expect);
  const chat = pane.getByTestId("chat");
  const box = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
  const send = pane.getByTestId("composer").getByRole("button", { name: "Send" });

  if (expectNow === "form") {
    const form = chat.getByTestId("question-form");
    await expect(form).toContainText("Claude asks you 2 questions", { timeout: 30_000 });
    await expect(chat.locator("[data-testid=chat-item][data-kind=ask]")).toHaveCount(0);
    await shot("3-form");
    step("pick 2.5 and Customers, and submit");
    const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();
    const before = answers().length;
    await form.getByRole("radio", { name: /^2\.5/ }).click();
    await next.click();
    await form.getByRole("radio", { name: /^Customers/ }).click();
    await next.click();
    await expect(next).toHaveText(/Submit answers/);
    await next.click();
    step("Claude's record has the answers, and it goes on");
    await expect.poll(() => answeredSince(before), { timeout: 60_000, intervals: [2_000] }).toMatch(/2\.5[\s\S]*Customers/);
    await expect(chat.locator("[data-testid=chat-item][data-kind=question]").last()).toContainText("Answered 2 questions", { timeout: 60_000 });
    // Answered in the record before the box drops the wait: no bare card
    // meanwhile.
    await expect(chat.locator("[data-testid=chat-item][data-kind=ask]")).toHaveCount(0);
    await shot("4-answered");
    return;
  }

  const card = chat.locator("[data-testid=chat-item][data-kind=ask]");
  await expect(card).toContainText("Claude asks you", { timeout: 30_000 });
  await expect(chat.getByTestId("question-form")).toHaveCount(0);
  if (expectNow === "locked") {
    await expect(card).toContainText("answer it in the terminal");
    await expect(box).toHaveAttribute("placeholder", "Pick an answer above first");
    await box.fill(REPLY);
    await expect(send).toBeDisabled();
    await shot("3-locked");
    return;
  }
  if (expectNow !== "reply") throw new Error("set VERIFY_EXPECT to form, reply or locked");
  await expect(card).toContainText("Reply below to answer it.");
  await box.fill(REPLY);
  await expect(send).toBeEnabled();
  await shot("3-reply-below");
  step("send the reply");
  const before = answers().length;
  await send.click();
  step("Claude's record has the words as the answer, and it goes on");
  await expect.poll(() => answeredSince(before), { timeout: 60_000, intervals: [2_000] }).toContain(REPLY);
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await shot("4-replied");
}
