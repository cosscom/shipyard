// chat-questions-live: a real Claude Code, in its terminal on a dev box,
// asks three questions (AskUserQuestion) with lists in them; the chat's
// card answers them with long words of the person's own on two and an
// option on one, and the box fills in Claude's own form. With
// VERIFY_SURPRISE (a shell command that puts Claude's form in a state the
// box doesn't expect), the first submit fails: the card keeps every
// answer, Copy answers copies them, VERIFY_UNSURPRISE puts the form back,
// and Retry delivers them. The box's journal then holds the answer's
// session.sent (answer: true, the turn that asked, never the words), once.
// See ../../features/chat-questions.md.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const live = true;
// The forced failure's 409, as the browser logs it.
export const allowErrors = process.env.VERIFY_SURPRISE ? [/status of 409/] : [];
export const params = { view: "conversation", sidebar: "list" };

const QUESTIONS = {
  questions: [
    {
      header: "Rollout",
      question: "How should acme roll out the new checkout?\n1. The old flow stays behind a flag for a week.\n2. Support wants a heads-up before any change customers can see, and release notes go out on Mondays.\n3. Mobile ships on its own schedule.",
      multiSelect: false,
      options: [
        { label: "Flag first (Recommended)", description: "Ship behind the flag, turn it on for staff, then everyone." },
        { label: "All at once", description: "Turn it on for everyone on release day." },
        { label: "Wait", description: "Hold until mobile is ready too." },
      ],
    },
    {
      header: "Owner",
      question: "Who owns the rollout?\n1. Alex wrote most of the change.\n2. Sam is on call that week.",
      multiSelect: false,
      options: [
        { label: "Alex", description: "The author." },
        { label: "Sam", description: "The on-call engineer." },
      ],
    },
    {
      header: "Notes",
      question: "Anything else the team should know before starting?",
      multiSelect: false,
      options: [
        { label: "Nothing", description: "No further notes." },
        { label: "Later", description: "More notes will follow." },
      ],
    },
  ],
};

// The dev box's journal (dev-box.sh's VERIFY_BOX_DIR), read from disk: a
// second view of what the box announced, apart from the app.
const JOURNAL = join(process.env.VERIFY_BOX_DIR || "/tmp/verify-berthd-box", "box-home/box/journal");
const SESSION = process.env.VERIFY_SESSION || "ask";
function journal() {
  return readdirSync(JOURNAL).filter((f) => f.endsWith(".jsonl")).sort()
    .flatMap((f) => readFileSync(join(JOURNAL, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}
const sentHere = (from) => journal().filter((e) => e.seq > from && e.type === "session.sent" && e.data?.name === SESSION);

const WORDS_1 = "Flag first, but keep the flag on for staff only until the support team has had a full Monday with the new flow. If the error rate on payment confirmation goes above half a percent at any point, turn the flag off and tell the channel before anything else.";
const WORDS_3 = "The staging database was restored from last week's backup, so some fixtures may be stale. Release notes are drafted in the shared folder; please add a line about the flag and who to ask.";

export async function run({ page, shot, step, expect, call }) {
  const worktree = process.env.VERIFY_WORKTREE;
  if (!worktree) throw new Error("set VERIFY_WORKTREE to the worktree row's box/name");
  step(`open ${worktree}'s agent in chat`);
  const row = page.locator(`[data-testid=worktree-row][data-worktree="${worktree}"]`);
  await row.click({ position: { x: 32, y: 12 } });
  const pane = page.locator("[data-testid=pane]:visible").first();
  const chat = pane.getByTestId("chat");
  // A chat with nothing in it yet asks for a first task instead.
  let reply = pane.getByRole("textbox", { name: "What should Claude Code do?", exact: true });
  try {
    await expect(reply).toBeEditable({ timeout: 15_000 });
  } catch {
    reply = pane.getByTestId("composer").getByRole("textbox", { name: "Reply" });
  }

  const head = Math.max(0, ...journal().map((e) => e.seq));
  step("ask Claude for three questions from the reply box");
  await reply.fill(`Call the AskUserQuestion tool once with exactly this input JSON, copying every question, header and option verbatim (keep the newlines): ${JSON.stringify(QUESTIONS)}. After I answer, repeat each answer back verbatim, one per line, and stop.`);
  await reply.press("Enter");
  const form = chat.getByTestId("question-form");
  await expect(form).toBeVisible({ timeout: 180_000 });
  await expect(form).toContainText("Claude asks you 3 questions");
  const next = form.getByRole("button", { name: /^(Next|Review|Submit answers)$/ }).last();

  step("answer: long words on 1 and 3, Sam on 2");
  await form.getByRole("radio", { name: "Something else" }).click();
  await form.getByRole("textbox", { name: "Your own answer" }).fill(WORDS_1);
  await shot("1-card");
  await next.click();
  await form.getByRole("radio", { name: /^Sam/ }).click();
  await next.click();
  await form.getByRole("radio", { name: "Something else" }).click();
  await form.getByRole("textbox", { name: "Your own answer" }).fill(WORDS_3);
  await next.click();
  await expect(form).toContainText("Review your answers");
  await shot("2-review");

  if (process.env.VERIFY_SURPRISE) {
    step("put Claude's form in a state the box doesn't expect (VERIFY_SURPRISE)");
    execSync(process.env.VERIFY_SURPRISE, { stdio: "inherit" });
  }
  step("submit");
  await next.click();

  if (process.env.VERIFY_SURPRISE) {
    const failed = form.getByTestId("question-form-failed");
    await expect(failed).toBeVisible({ timeout: 60_000 });
    await expect(failed).toContainText("Your answers didn't reach Claude");
    await expect(form).toContainText(WORDS_1);
    await expect(form).toContainText(WORDS_3);
    await shot("3-failed-kept");
    step("Claude's own screen opens under the form, to finish there");
    const own = pane.getByRole("region", { name: "Claude Code's own screen" });
    await expect(own).toBeVisible({ timeout: 20_000 });
    await own.scrollIntoViewIfNeeded();
    await shot("3b-own-screen-below");
    step("Copy answers");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await failed.getByRole("button", { name: "Copy answers" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`Rollout: ${WORDS_1}\nOwner: Sam\nNotes: ${WORDS_3}`);
    step("put the form back (VERIFY_UNSURPRISE), then Retry");
    if (process.env.VERIFY_UNSURPRISE) execSync(process.env.VERIFY_UNSURPRISE, { stdio: "inherit" });
    await failed.getByRole("button", { name: "Retry" }).click();
  }

  step("Claude has the answers, word for word, and goes on");
  await expect(form).toHaveCount(0, { timeout: 60_000 });
  const answered = chat.locator("[data-testid=chat-item][data-kind=question]").last();
  await expect(answered).toContainText("Answered 3 questions", { timeout: 60_000 });
  await expect(answered).toContainText(WORDS_1);
  await expect(answered).toContainText(WORDS_3);
  await expect(answered).toContainText("Sam");
  await shot("4-answered");
  await expect(chat.locator("[data-testid=chat-item][data-kind=text]").last()).toContainText("who to ask", { timeout: 120_000 });
  await shot("5-claude-goes-on");

  step("the box's journal has the answer's session.sent, once, in the turn that asked");
  const [prompt, ...rest] = sentHere(head);
  if (!prompt || prompt.data.answer) throw new Error(`no prompt send in the journal after seq ${head}: ${JSON.stringify(prompt)}`);
  const answers = rest.filter((e) => e.data.answer === true);
  if (answers.length !== 1) throw new Error(`the journal has ${answers.length} answers, want 1: ${JSON.stringify(rest)}`);
  const [answer] = answers;
  const raw = JSON.stringify(answer);
  if (raw.includes("support team") || raw.includes("staging database") || raw.includes("Sam")) throw new Error(`the event carries the answers: ${raw}`);
  // The box's turns say which send opened the answer's turn: the prompt.
  if (!answer.data.turn) throw new Error(`the answer names no turn: ${raw}`);
  const box = process.env.VERIFY_WORKTREE.split("/")[0];
  const turn = await call(`/v1/boxes/${box}/api/turns/${encodeURIComponent(answer.data.turn)}`);
  if (turn.sent_seq !== prompt.seq) throw new Error(`the answer's turn ${answer.data.turn} was opened by seq ${turn.sent_seq}, the prompt is seq ${prompt.seq}`);
  step(`journal: ${raw}`);
}
