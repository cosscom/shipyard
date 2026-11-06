// inbox-mock: the Inbox on Shipyard's mock fixtures (?mock=1, synthetic "acme"
// data) in a real browser: the sidebar count equals the list, the groups show,
// the walk-through steps one item at a time, a form is answered by keys, and the
// peek shows the session beside the card without losing a draft note.
import { readFileSync } from "node:fs";

const dist = new URL("../../../../../plugins/inbox/dist/index.js", import.meta.url);

// The mock box has no transcripts for a plugin's own requests, so this wraps the
// plugin's berth.api.request with synthetic ones and keeps what it's asked to send
// on window.__inboxSent. Real agents are inbox-live.mjs.
const stub = `
const FORM = [
  { kind: "user", id: "u1", text: "Plan the release of the checkout fix." },
  { kind: "tools", id: "t1", verb: "Read webhook.ts" },
  { kind: "text", id: "x1", text: "I read the **webhook** code. Two choices left." },
  { kind: "question", id: "q1", tool: "mock-tool", questions: [
    { question: "Which day should acme release?", options: [{ label: "Tuesday (Recommended)", description: "Quiet traffic." }, { label: "Friday", description: "Before the weekend." }] },
    { question: "Who should watch it?", options: [{ label: "On-call" }, { label: "Author" }] },
  ] },
];
const wrap = (plugin) => (berth) => {
  window.__inboxSent = [];
  const api = Object.create(berth.api);
  api.request = (box, method, path, body) => {
    if (method === "GET" && path === "sessions/shop-claude/transcript") return Promise.resolve({ source: "mock", items: FORM });
    if (method === "GET" && path === "sessions/old-q/transcript") return Promise.resolve({ source: "mock", items: [
      { kind: "user", id: "u1", text: "Pick a colour for acme." },
      { kind: "question", id: "q1", tool: "t", done: true, questions: [{ question: "Which colour?", options: [{ label: "Blue" }] }], answers: ["Blue"] },
      { kind: "tools", id: "t1", verb: "Run", items: [{ verb: "Run", target: "pnpm build" }] },
      { kind: "text", id: "x1", text: "Now the docs." },
      { kind: "notice", id: "n1", notice: "interrupted", text: "Interrupted" },
    ] });
    if (method === "GET" && path.endsWith("/transcript")) return Promise.resolve({ source: "mock", items: [{ kind: "text", id: "m", text: "Should acme keep the old flag?" }] });
    if (method === "DELETE" && path.startsWith("sessions/")) { window.__inboxSent.push({ method, path }); return Promise.resolve({}); }
    if (method === "POST" && path.endsWith("/answer")) { window.__inboxSent.push({ path, body }); return Promise.resolve({ answered: [] }); }
    return berth.api.request(box, method, path, body);
  };
  // A session interrupted earlier, whose title still asks. Its time is fixed, as
  // a real session's is: an item's identity follows it.
  const stoppedAt = new Date(Date.now() - 30_000).toISOString();
  api.sessions = async (box) => {
    const list = await berth.api.sessions(box);
    return box === "devl" ? [...list, { name: "old-q", agent: "claude", agent_state: "finished", title: "❓ Pick a colour", location: "shop", state_since: stoppedAt }] : list;
  };
  // Nothing unsaved anywhere, as far as the check can tell.
  const orchestrate = Object.create(berth.orchestrate);
  orchestrate.exec = () => Promise.resolve({ exit_code: 0, output: "" });
  const ctx = new Proxy(berth, { get: (t, k) => (k === "api" ? api : k === "orchestrate" ? orchestrate : t[k]) });
  return plugin(ctx);
};
`;
const source = readFileSync(dist, "utf8").replace(/export \{\s*(\w+) as default\s*\};?/, (_, name) => `${stub}\nexport default wrap(${name});`);
if (!source.includes("export default wrap")) throw new Error("can't find the plugin's default export in dist/index.js");

export const plugins = [{ id: "inbox", name: "Inbox", source }];
export const params = { labs: "0", sidebar: "list", structured: "1" };

export async function run({ page, shot, step, expect }) {
  step("open the Inbox from More");
  await page.getByTestId("nav-more").click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Inbox/ }).click();
  const screen = page.getByTestId("inbox-screen");
  await expect(screen).toBeVisible();
  const left = page.getByTestId("inbox-left");
  await expect(left).toContainText(" left");
  await shot("1-list");

  step("the count is the length of the list");
  const n = Number((await left.innerText()).split(" ")[0]);
  await expect(page.getByTestId("inbox-item")).toHaveCount(n);
  if (n < 2) throw new Error(`the fixtures should leave at least 2 items, got ${n}`);
  console.log("items:", await page.getByTestId("inbox-item").allInnerTexts());

  step("j moves to the next card, k back");
  const title = page.getByTestId("inbox-card-title");
  const current = page.locator('[data-testid=inbox-item][aria-current]');
  const first = await current.textContent();
  await page.keyboard.press("j");
  await expect(current).not.toHaveText(first);
  await page.keyboard.press("k");
  await expect(current).toHaveText(first);

  step("walk-through hides the list and says where you are");
  await page.keyboard.press("w");
  await expect(page.getByTestId("inbox-list")).toBeHidden();
  await expect(page.getByTestId("inbox-position")).toHaveText(`1 of ${n}`);
  await shot("2-walk");
  await page.keyboard.press("w");
  await expect(page.getByTestId("inbox-list")).toBeVisible();

  step("snooze takes a card off, and the count follows");
  await page.keyboard.press("h");
  await expect(page.getByTestId("inbox-snooze")).toBeVisible();
  await shot("3-snooze");
  await page.keyboard.press("1");
  await expect(left).toContainText(`${n - 1} left`);
  await expect(page.getByTestId("inbox-item")).toHaveCount(n - 1);
  await expect(page.getByTestId("inbox-snoozed-count")).toHaveText("1 snoozed");

  step("a session's form shows on its card, with its options and number keys");
  await page.getByTestId("inbox-item").filter({ hasText: "Plan the checkout release" }).click();
  await expect(title).toHaveText("Plan the checkout release");
  const questions = page.getByTestId("inbox-question");
  await expect(questions.first()).toBeVisible({ timeout: 15_000 });
  const asked = await questions.count();
  await expect(page.getByTestId("inbox-recommended")).toHaveText("Recommended");
  await expect(page.getByTestId("inbox-option").first()).toContainText("Tuesday");
  await expect(page.getByTestId("inbox-option").first()).not.toContainText("(Recommended)");
  await shot("4-form");

  step("typing a note presses nothing");
  const note = page.getByTestId("inbox-note");
  await note.click();
  await page.keyboard.type("hjkwpx 12");
  await expect(note).toHaveValue("hjkwpx 12");
  await expect(title).toHaveText("Plan the checkout release");
  await page.keyboard.press("Escape");

  step("the peek opens beside the card, with the session's own words, and the draft stays");
  await page.keyboard.press("p");
  const peek = page.getByTestId("inbox-peek");
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId("peek-user").first()).toContainText("Plan the release of the checkout fix.");
  await expect(note).toHaveValue("hjkwpx 12");
  await shot("5-peek");
  await page.keyboard.press("p");
  await expect(peek).toBeHidden();
  await expect(note).toHaveValue("hjkwpx 12");

  step("work folds into one line that opens on a click");
  await page.keyboard.press("p");
  const work = page.getByTestId("inbox-peek").getByTestId("peek-work").first();
  await expect(work).toContainText("Worked · read 1 file");
  await expect(page.getByTestId("inbox-peek")).not.toContainText("Read webhook.ts");
  await work.getByRole("button").click();
  await expect(page.getByTestId("inbox-peek")).toContainText("Read webhook.ts");
  await page.keyboard.press("p");

  step("walking away and back keeps the draft");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(note).toHaveValue("hjkwpx 12");
  await note.fill("");
  await page.keyboard.press("Escape");

  step("number keys answer every question, Enter sends, and the card leaves");
  const send = page.getByTestId("inbox-send");
  await expect(send).toBeDisabled();
  for (let i = 0; i < asked; i++) await page.keyboard.press("1");
  await expect(send).toBeEnabled();
  await shot("6-picked");
  const was = Number((await left.innerText()).split(" ")[0]);
  await page.keyboard.press("Enter");
  await expect(left).toContainText(`${was - 1} left`);
  await expect(page.getByTestId("inbox-item").filter({ hasText: "Plan the checkout release" })).toHaveCount(0);
  const sent = await page.evaluate(() => window.__inboxSent);
  const want = JSON.stringify([{ path: "sessions/shop-claude/answer", body: { tool: "mock-tool", answers: [{ picks: ["Tuesday (Recommended)"] }, { picks: ["On-call"] }] } }]);
  if (JSON.stringify(sent) !== want) throw new Error(`answer sent: ${JSON.stringify(sent)}`);
  await shot("7-answered-next");

  step("a stale asking title doesn't claim a question: the card says it was interrupted, and so does the peek");
  await page.getByTestId("inbox-item").filter({ hasText: "Pick a colour" }).click();
  await expect(title).toHaveText("Pick a colour");
  await expect(page.getByTestId("inbox-why")).toHaveText("It was interrupted, and waits for what to do instead.");
  await page.keyboard.press("p");
  await expect(page.getByTestId("peek-notice")).toHaveText("It was interrupted, and waits for what to do instead.");
  await shot("7b-interrupted");
  await page.keyboard.press("p");

  step("close session can be undone, and the card comes back");
  await page.getByTestId("inbox-close").click();
  const undo = page.getByTestId("inbox-undo");
  await expect(undo).toBeVisible();
  await expect(left).toContainText(`${was - 2} left`);
  await shot("8-undo");
  // The mock's running loop card floats over the bar's right end, where Undo
  // is, so it's pressed from the keyboard (features/inbox.md, Gotchas).
  await undo.getByRole("button", { name: "Undo" }).press("Enter");
  await expect(undo).toBeHidden();
  await expect(left).toContainText(`${was - 1} left`);
  await expect(page.getByTestId("inbox-item").filter({ hasText: "Pick a colour" })).toHaveCount(1);

  step("with nothing unsaved it stops the session, after the few seconds");
  await page.getByTestId("inbox-item").filter({ hasText: "Pick a colour" }).click();
  await page.getByTestId("inbox-close").click();
  await expect(undo).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__inboxSent.some((c) => c.method === "DELETE" && c.path === "sessions/old-q"))).toBe(true);
  await expect(page.getByTestId("inbox-item").filter({ hasText: "Pick a colour" })).toHaveCount(0);
  await shot("9-closed");
}
