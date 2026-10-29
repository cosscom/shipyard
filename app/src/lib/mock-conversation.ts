import { ART_BOX, ART_SESSION, artChat } from "@/lib/art/mock-chat";
import type { Artifact, ToolDetail, CrewMember, TranscriptItem } from "@/lib/transcript";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { mockNotice } from "@/lib/chat-controls";
import { useMockDrafts } from "@/lib/draft";
import type { DraftRead } from "@/lib/draft-text";
import { type Question, type QuestionAnswer, shownAnswer } from "@/lib/questions";
import { mockReports } from "@/lib/mock-reports";
import { MESSAGES_SESSION, messagesChat } from "@/lib/mock-agent-messages";
import { benchToolDetail } from "@/lib/mock-bench";

// The demo's stand-in for berthd's transcript stream: a short scripted turn
// played into the conversation store, so the view can be tried with ?mock=1.

let n = 0;
const id = () => `m${++n}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What the demo agent's screen shows it writing (lib/draft).
const showDraft = (key: string, read: DraftRead | undefined) => useMockDrafts.setState((s) => ({ reads: { ...s.reads, [key]: read } }));

// Text arrives a few words at a time, as a streamed reply does: on the
// agent's screen first (a draft), then in its record, whose message takes
// the draft's place; the screen still shows it a moment after.
async function stream(key: string, text: string) {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i += 3) {
    await wait(70);
    showDraft(key, { text: words.slice(0, i + 3).join(" ") });
  }
  useConversations.getState().push(key, { kind: "text", id: id(), text });
  await wait(400);
  showDraft(key, undefined);
}

// An item of any kind without its id, which the demo gives it.
type Unsaved<T> = T extends unknown ? Omit<T, "id"> : never;

// The demo's screen, for the app's tests and screenshots (app/e2e): show
// what an agent is writing, land its message (or any other step: an edit,
// a command) in its record, or clear it.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock")) {
  // In the record above the demo's own "thinking" row, as a real record
  // has none.
  const put = (box: string, session: string, item: TranscriptItem) =>
    useConversations.setState((s) => {
      const all = s.items[keyOf(box, session)] ?? [];
      let at = all.length;
      while (at > 0 && all[at - 1].kind === "thinking") at--;
      return { items: { ...s.items, [keyOf(box, session)]: [...all.slice(0, at), item, ...all.slice(at)] } };
    });
  (window as unknown as { __berthDraft: unknown }).__berthDraft = {
    show: (box: string, session: string, text: string, clipped?: boolean) => showDraft(keyOf(box, session), { text, clipped }),
    land: (box: string, session: string, text: string) => put(box, session, { kind: "text", id: id(), text }),
    record: (box: string, session: string, item: Unsaved<TranscriptItem>) => put(box, session, { ...item, id: id() } as TranscriptItem),
    clear: (box: string, session: string) => showDraft(keyOf(box, session), undefined),
  };
  // An agent's crew: helpers started `ago` seconds back, and back `back`
  // seconds ago once finished.
  type Hired = Omit<CrewMember, "since" | "until" | "kind" | "agent"> & { kind?: CrewMember["kind"]; ago: number; back?: number };
  (window as unknown as { __berthCrew: unknown }).__berthCrew = {
    set: (box: string, session: string, members: Hired[]) => {
      const t = Date.now();
      crew(
        keyOf(box, session),
        members.map(({ ago, back, ...m }) => ({ kind: "subagent", agent: "claude", ...m, since: t - ago * 1000, until: back === undefined ? undefined : t - back * 1000 })),
      );
    },
  };
}

async function think(key: string, ms: number) {
  const t = { kind: "thinking" as const, id: id(), since: Date.now() };
  useConversations.getState().push(key, t);
  await wait(ms);
  useConversations.getState().remove(key, t.id);
}

async function tools(key: string, verb: string, calls: { verb: string; target: string; file?: boolean; id?: string }[]) {
  const t = { kind: "tools" as const, id: id(), verb, items: [] as typeof calls, done: false };
  useConversations.getState().push(key, t);
  for (const c of calls) {
    await wait(420);
    t.items = [...t.items, c];
    useConversations.getState().update(key, t.id, { items: t.items });
  }
  useConversations.getState().update(key, t.id, { done: true });
}

function crew(key: string, members: CrewMember[]) {
  useConversations.getState().setCrew(key, members);
}

// playTurn plays a believable turn for a prompt: read, search, two helpers,
// an edit, a question for the person, then a short answer.
export async function playTurn(box: string, session: string, prompt: string) {
  const key = keyOf(box, session);
  const s = useConversations.getState();
  s.push(key, { kind: "user", id: id(), text: prompt });
  await think(key, 900);
  await stream(key, "I’ll trace how a payment webhook reaches the order, then make retries safe to repeat.");
  await tools(key, "Read", [
    { verb: "Read", target: "webhook.ts", file: true, id: "mock-read-1" },
    { verb: "Read", target: "createOrder.ts", file: true, id: "mock-read-2" },
    { verb: "Read", target: "payments.test.ts", file: true, id: "mock-read-3" },
  ]);
  const start = Date.now();
  useConversations.getState().push(key, { kind: "crew", id: id(), names: ["Explore: retry paths", "Explore: idempotency in tests"] });
  crew(key, [
    { id: "c1", name: "Explore: retry paths", kind: "subagent", agent: "claude", state: "running", doing: "Reading retry.ts", since: start },
    { id: "c2", name: "Explore: idempotency in tests", kind: "subagent", agent: "claude", state: "running", doing: "Searching for idempotency", since: start },
  ]);
  await think(key, 2200);
  const back1 = Date.now();
  crew(key, [
    { id: "c1", name: "Explore: retry paths", kind: "subagent", agent: "claude", state: "finished", doing: "Found 3 retry paths", since: start, until: back1 },
    { id: "c2", name: "Explore: idempotency in tests", kind: "subagent", agent: "claude", state: "running", doing: "Reading payments.test.ts", since: start },
  ]);
  await tools(key, "Search", [
    { verb: "Search", target: "idempotencyKey", id: "mock-search-1" },
    { verb: "Search", target: "retryWebhook", id: "mock-search-2" },
  ]);
  crew(key, [
    { id: "c1", name: "Explore: retry paths", kind: "subagent", agent: "claude", state: "finished", doing: "Found 3 retry paths", since: start, until: back1 },
    { id: "c2", name: "Explore: idempotency in tests", kind: "subagent", agent: "claude", state: "finished", doing: "No test covers a repeat", since: start, until: Date.now() },
  ]);
  useConversations.getState().push(key, { kind: "edit", id: id(), file: "apps/web/lib/payments/webhook.ts", added: 9, removed: 2, tool: "mock-edit-1" });
  await wait(500);
  useConversations.getState().push(key, { kind: "ask", id: id(), tool: "Bash", detail: "pnpm test payments", why: "Run the payment tests", structured: true, choices: PERMISSION });
}

// Claude Code's permission menu, matched to the three answers.
const PERMISSION = [
  { key: "1", label: "Allow", title: "Yes" },
  { key: "2", label: "Always allow", title: "Yes, and don't ask again for pnpm test commands in /home/me/work/shop" },
  { key: "3", label: "Deny", title: "No, and tell Claude what to do differently (esc)" },
];

// After the person answers the question: run the tests and finish.
export async function finishTurn(box: string, session: string) {
  const key = keyOf(box, session);
  await tools(key, "Run", [{ verb: "Run", target: "pnpm test payments", id: "mock-run-1" }]);
  await stream(
    key,
    "Done. A repeated webhook now finds the order by its **idempotency key** and returns it instead of charging twice.\n\n| | Before | After |\n|---|---|---|\n| Duplicate charge on retry | yes | **no** |\n| Retries | unlimited | 5 over 10 minutes |\n\n**What changed:**\n- `createOrder` looks the key up before charging.\n- Retries back off and stop after five.\n- A test sends the same event twice (`pnpm test payments` passes).",
  );
}

// The questions gpu's shop agent asks (Claude Code's AskUserQuestion): one
// pick, several picks, and one for the person's own words. Fixed, like the
// reply before it, so the app's tests (app/e2e) can walk the form.
const RELEASE_QUESTIONS: Question[] = [
  { header: "Release", question: "Which release should the checkout fix go out in?", options: [{ label: "This week's patch", description: "Ships Thursday with the usual checks" }, { label: "Next minor", description: "Two weeks out, with the export work" }, { label: "Hold for QA" }] },
  { header: "Checks", question: "Which checks should run before it ships?", multi: true, options: [{ label: "Unit tests" }, { label: "E2E on staging" }, { label: "Load test" }, { label: "Manual QA" }] },
  { header: "Reviewer", question: "Who should review the change?", options: [{ label: "bailey" }, { label: "me" }] },
];

// ?scene=question-links: questions with long addresses in them, as a
// sign-in page's (made up), and one the box cut short (its "…"), which
// is shown but not linked.
const LINK_URL = "https://shop.example.com/admin/oauth/authorize?client_id=0000example0000example&scope=read_products,write_products,read_orders&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&state=mock-state-1234567890abcdef";
const CUT_URL = "https://logs.example.com/explorer?query=resource.type%3D%22cloud_run_revision%22%20severity%3E%3DERROR&cursorTimestamp=2026-10-27T15:00:00Z&duration=PT1H&project=acme-shop&";
const LINK_QUESTIONS: Question[] = [
  {
    header: "Connect",
    question: `Approve the app for the shop at ${LINK_URL} and pick how it went.`,
    options: [{ label: "Approved", description: `If it asks again, open ${LINK_URL}&grant_options%5B%5D=per-user instead.` }, { label: "It failed" }],
  },
  { header: "Logs", question: "Did the errors stop?", options: [{ label: "Yes" }, { label: "No", description: `The log the box cut short: ${CUT_URL}…` }] },
];

const RELEASE_PLAN = `## The fix, in short

Webhook retries now reuse the order the first delivery made:

\`\`\`ts
export async function handleWebhook(event: PaymentEvent): Promise<Order> {
  const existing = await orders.byIdempotencyKey(event.idempotencyKey);
  if (existing) return existing;
  return createOrder(event, { idempotencyKey: event.idempotencyKey });
}
\`\`\`

- \`createOrder\` takes the key and stores it.
- Retries stop after **five** tries over ten minutes.

Before I plan the release, a few questions.`;

const TABLE_REPORT = `The latest checks show the search and checkout paths improving:

| Endpoint | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Search | 1,240 | 410 |
| Checkout | 880 | 520 |
| Cart | 630 | 280 |

The checks behind those numbers:

| Check | Status | Time (ms) |
| --- | --- | ---: |
| Search index | pass | 18 |
| Retry webhook | fail | 42 |
| Checkout page | pass | 31 |
| Duplicate order | fail | 27 |`;

const TEST_REPORT = `I ran the checkout tests. One retry case still needs attention:

\`\`\`text
 RUN  v3.2.1 /work/shop
 ❯ apps/web/lib/checkout/createOrder.test.ts (5 tests | 1 failed) 18ms
   × reuses an order when a webhook retries 8ms
     apps/web/lib/checkout/createOrder.test.ts:42:11
 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 8 passed (9)
\`\`\``;

function releaseChat(): TranscriptItem[] {
  const picture = new URLSearchParams(location.search).get("scene") === "chat-image" ? "\n\nThe checkout screenshot shows the confirmed order:\n\n![Checkout result](screenshots/checkout-result.png)" : "";
  const tables = new URLSearchParams(location.search).get("scene") === "chat-tables";
  const testReport = new URLSearchParams(location.search).get("scene") === "chat-tests";
  const links = new URLSearchParams(location.search).get("scene") === "question-links";
  return [
    { kind: "user", id: "rq-u1", text: "Plan the release of the checkout fix." },
    { kind: "tools", id: "rq-t1", verb: "Read", done: true, items: [{ verb: "Read", target: "webhook.ts", file: true, id: "mock-read-1" }, { verb: "Read", target: "createOrder.ts", file: true, id: "mock-read-2" }] },
    { kind: "text", id: "rq-x1", text: RELEASE_PLAN + picture },
    ...(tables ? [{ kind: "text" as const, id: "rq-x2", text: TABLE_REPORT }] : []),
    ...(testReport ? [{ kind: "text" as const, id: "rq-x2", text: TEST_REPORT }] : []),
    { kind: "question", id: "rq-q1", tool: "mock-ask-release", questions: links ? LINK_QUESTIONS : RELEASE_QUESTIONS },
  ];
}

// ?scene=answer-stuck: the box can't fill in the form the first time, as
// when the agent's screen is too short for it, and can when tried again.
let answerStuck = new URLSearchParams(location.search).get("scene") === "answer-stuck";

// mockAnswer is the box filling in the form (POST …/answer): the question
// shows its answers, and the agent goes on.
export function mockAnswer(box: string, session: string, req: { tool: string; answers: QuestionAnswer[] }): { answered: string[] } {
  if (answerStuck) {
    answerStuck = false;
    throw new Error("Claude's screen doesn't show its questions: finish in Claude's screen");
  }
  const key = keyOf(box, session);
  const q = useConversations.getState().items[key]?.find((it) => it.kind === "question" && it.tool === req.tool);
  if (!q || q.kind !== "question") throw new Error("no question waits for that answer");
  const answered = q.questions.map((x, i) => shownAnswer(x, req.answers[i]));
  useConversations.getState().update(key, q.id, { done: true, answers: answered });
  useConversations.getState().push(key, { kind: "text", id: id(), text: `Thanks. I'll plan it for **${answered[0]}**, with ${answered[1]} first.` });
  return { answered };
}

// seedTranscript gives an agent that is already working something to show
// when it is opened.
export function seedTranscript(box: string, session: string, state: string, worktree: string): TranscriptItem[] {
  // ?scene=first-prompt: an agent at rest hasn't been asked anything yet,
  // so it opens to the start of a chat (the header picture, the composer).
  if (new URLSearchParams(location.search).get("scene") === "first-prompt" && state !== "running" && state !== "waiting") {
    useConversations.setState((s) => (s.items[keyOf(box, session)] ? s : { items: { ...s.items, [keyOf(box, session)]: [] } }));
    return [];
  }
  // Messages from other agents and Claude Code (agent-message): a story, or
  // with ?scene=busy a teammate on a busy team.
  if (box === "gpu" && session === MESSAGES_SESSION) {
    const key = keyOf(box, session);
    const { items, crew } = messagesChat(new URLSearchParams(location.search).get("scene"));
    if (!useConversations.getState().crew[key]) useConversations.getState().setCrew(key, crew);
    useConversations.setState((s) => (s.items[key] ? s : { items: { ...s.items, [key]: items } }));
    return useConversations.getState().items[key] ?? items;
  }
  if (box === "gpu" && session === "shop-claude") {
    const chat = releaseChat();
    useConversations.setState((s) => (s.items[keyOf(box, session)] ? s : { items: { ...s.items, [keyOf(box, session)]: chat } }));
    return chat;
  }
  const items: TranscriptItem[] = [
    { kind: "user", id: id(), text: `Pick up ${worktree}: read the issue and get it to green.` },
    { kind: "text", id: id(), text: `I’ll start from the failing test in ${worktree} and work outwards.` },
    { kind: "tools", id: id(), verb: "Read", done: true, items: [{ verb: "Read", target: "README.md", file: true }, { verb: "Read", target: "package.json", file: true }] },
  ];
  if (state === "waiting") {
    items.push({ kind: "edit", id: id(), file: "apps/web/lib/payments/webhook.ts", added: 9, removed: 2, tool: "mock-edit-1" });
    items.push({ kind: "edit", id: id(), file: "services/payments/retry.go", added: 14, removed: 3, tool: "mock-edit-go" });
    items.push({ kind: "edit", id: id(), file: "apps/web/lib/checkout/createOrder.ts", added: 3, removed: 2, tool: "mock-multi-1" });
    items.push({ kind: "edit", id: id(), file: "apps/web/lib/payments/webhook.test.ts", added: 45, removed: 0, tool: "mock-write-1" });
    items.push({ kind: "ask", id: id(), tool: "Bash", detail: "pnpm db:migrate --name add-idempotency-key", why: "Create the migration for the new idempotency_key column", structured: true, choices: PERMISSION });
  }
  if (state === "running") {
    // ?structured: the judge's Claude, in chat, has said what it found.
    if (session === "judge-v2-claude" && new URLSearchParams(location.search).has("structured"))
      items.push({ kind: "text", id: id(), text: "The judge over-scores short answers on the hard set.\n\n- **0.82** agreement with the labels, was 0.74\n- Next: rerun the hard set with a length penalty." });
    items.push({ kind: "crew", id: id(), names: ["Explore: failing tests", "Explore: fixtures"] });
    items.push({ kind: "thinking", id: id(), since: Date.now() - 12_000 });
    const t = Date.now();
    useConversations.getState().setCrew(keyOf(box, session), [
      { id: "s1", name: "Explore: failing tests", kind: "subagent", agent: "claude", state: "running", doing: "Reading checkout.test.ts", since: t - 41_000 },
      { id: "s2", name: "Explore: fixtures", kind: "subagent", agent: "claude", state: "finished", doing: "Found 2 stale fixtures", since: t - 64_000, until: t - 18_000 },
    ]);
  }
  // Two finished sessions published pages on claude.ai: one, and eight.
  const pages = MOCK_ARTIFACTS[session];
  if (pages) {
    const t = Date.now();
    const list: Artifact[] = [];
    for (const [i, p] of pages.entries()) {
      const at = t - p.ago * 60_000;
      const tool = `mock-artifact-${session}-${i}`;
      const url = `https://claude.ai/artifact/${p.slug}`;
      const before = list.findIndex((a) => a.url === url);
      const updated = before >= 0;
      if (updated) list.splice(before, 1);
      list.push({ url, title: p.title, description: p.description ?? (updated ? pages.find((x) => x.slug === p.slug)?.description : undefined), file: "index.html", at, tool, updated });
      if (p.said) items.push({ kind: "text", id: id(), text: p.said });
      items.push({ kind: "tools", id: id(), verb: "Run", done: true, items: [{ verb: "Run", target: p.run ?? "pnpm bench search", id: `mock-run-${i}` }] });
      items.push({ kind: "artifact", id: id(), tool, text: p.title, url, description: list[list.length - 1].description, file: "index.html", done: true, updated });
    }
    const key = keyOf(box, session);
    useConversations.setState((s) => (s.artifacts[key] ? s : { artifacts: { ...s.artifacts, [key]: list } }));
  }
  if (state === "finished") items.push({ kind: "text", id: id(), text: pages ? `All green. ${pages.length === 1 ? "The page above has the coverage" : "The pages above have the numbers and screenshots"}; the branch is ready for review.` : "All green. The branch is ready for review." });
  // The search-perf agent then made artifacts here (components/art).
  if (box === ART_BOX && session === ART_SESSION) items.push(...artChat());
  // ?structured: search-perf's Claude then loaded a skill; the chat shows
  // the step, not the skill's instructions.
  if (session === "search-perf-claude" && new URLSearchParams(location.search).has("structured")) {
    items.push({ kind: "user", id: id(), text: "Check the change against our perf budget." });
    items.push({ kind: "tools", id: id(), verb: "Skill", done: true, items: [{ verb: "Skill", target: "acme-perf-budget", id: "mock-skill-1" }] });
    items.push({ kind: "text", id: id(), text: "Within budget: /search p95 is 410 ms against 500 ms." });
  }
  // One finished session shows a notice card (chat-controls).
  const notice = mockNotice(session);
  if (notice) items.push(notice);
  // One heard back from the agents it started (report-card).
  items.push(...mockReports(session));
  const key = keyOf(box, session);
  useConversations.setState((s) => (s.items[key] ? s : { items: { ...s.items, [key]: items } }));
  return items;
}

// The demo's published pages, oldest first: a slug published twice is
// updated. ago is in minutes.
const MOCK_ARTIFACTS: Record<string, { slug: string; title: string; description?: string; ago: number; said?: string; run?: string }[]> = {
  "order-export-claude-3": [{ slug: "ExampleExportTests", title: "Export job test coverage", description: "Which export paths the new tests cover, with the two still missing", ago: 82, said: "I’ll put the coverage in a page you can share.", run: "pnpm test export --coverage" }],
  "search-perf-claude": [
    { slug: "ExampleSearchBaseline", title: "Search latency baseline", description: "p50 and p95 for the ten slowest queries before any change", ago: 92, said: "First, a baseline to compare against." },
    { slug: "ExampleQueryPlans", title: "Query plans, before", description: "EXPLAIN ANALYZE for each slow query, with the sequential scans marked", ago: 86, run: "pnpm db:explain search" },
    { slug: "ExampleIndexOptions", title: "Index options compared", description: "Trigram, full-text and a covering index, side by side", ago: 71, said: "Three ways to index it; here they are side by side." },
    { slug: "ExampleSearchBaseline", title: "Search latency: before and after", ago: 54, said: "With the trigram index the baseline page now has both runs." },
    { slug: "ExampleCacheHits", title: "Result cache hit rate", description: "Hit rate by query shape over a replayed hour of traffic", ago: 47, run: "pnpm replay traffic --hour" },
    { slug: "ExampleTypeahead", title: "Typeahead debounce trial", description: "How often typeahead queries fire at 80, 150 and 250 ms", ago: 40 },
    { slug: "ExampleSearchScreens", title: "Search page screenshots", description: "Desktop and phone, light and dark, before and after", ago: 33, run: "pnpm e2e search --screenshots" },
    { slug: "ExampleRollout", title: "Rollout checklist", description: "Migration order, the flag, and what to watch on the dashboard", ago: 29 },
    { slug: "ExampleSlowLog", title: "Slow query log, last 24 hours", description: "Every search query over 200 ms since the index went in", ago: 24, said: "Last, the slow log since the change.", run: "pnpm db:slowlog --since 24h" },
  ],
};

// The demo's webhook fix, before and after.
const WEBHOOK_OLD = "  const payment = await payments.find(event.paymentId);\n  if (!payment) throw new NotFound(event.paymentId);\n  const order = await createOrder(payment);\n  return order;";
const WEBHOOK_NEW =
  "  const payment = await payments.find(event.paymentId);\n  if (!payment) throw new NotFound(event.paymentId);\n  // A provider retries a webhook it thinks failed: find the order the\n  // first delivery made instead of charging again.\n  const existing = await orders.byIdempotencyKey(event.idempotencyKey);\n  if (existing) return existing;\n  const order = await createOrder(payment, {\n    idempotencyKey: event.idempotencyKey,\n  });\n  await retries.schedule(event, { max: 5, within: \"10m\" });\n  return order;";

// A new test file, long enough to fold.
export const WEBHOOK_TEST = `import { beforeEach, describe, expect, test, vi } from "vitest";

import { handleWebhook } from "./webhook";
import { orders } from "../orders";
import { payments } from "./client";
import { retries } from "./retries";

const event = {
  id: "evt_test_1",
  paymentId: "pay_1",
  idempotencyKey: "idem_1",
  amount: 4200,
};

describe("handleWebhook", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(payments, "find").mockResolvedValue({ id: "pay_1", amount: 4200 });
    vi.spyOn(retries, "schedule").mockResolvedValue(undefined);
  });

  test("creates an order for a new event", async () => {
    vi.spyOn(orders, "byIdempotencyKey").mockResolvedValue(null);
    const order = await handleWebhook(event);
    expect(order.idempotencyKey).toBe("idem_1");
  });

  test("returns the same order for a repeated event", async () => {
    const first = await handleWebhook(event);
    vi.spyOn(orders, "byIdempotencyKey").mockResolvedValue(first);
    const again = await handleWebhook(event);
    expect(again.id).toBe(first.id);
    expect(payments.find).toHaveBeenCalledTimes(2);
  });

  test("stops after five retries", async () => {
    await handleWebhook(event);
    expect(retries.schedule).toHaveBeenCalledWith(event, { max: 5, within: "10m" });
  });

  test("rejects an unknown payment", async () => {
    vi.spyOn(payments, "find").mockResolvedValue(null);
    await expect(handleWebhook(event)).rejects.toThrow("pay_1");
  });
});
`;

// What the demo's tool calls show when opened, as a box would send them.
const DETAILS: Record<string, ToolDetail> = {
  "mock-read-1": { id: "mock-read-1", name: "Read", file: "apps/web/lib/payments/webhook.ts", output: "     1\timport { createOrder } from \"../checkout/createOrder\";\n     2\timport { verify } from \"./signature\";\n     3\t\n     4\texport async function handleWebhook(req: Request) {\n     5\t  const event = await verify(req);\n     6\t  return createOrder(event.data);\n     7\t}" },
  "mock-read-2": { id: "mock-read-2", name: "Read", file: "apps/web/lib/checkout/createOrder.ts", output: "     1\texport async function createOrder(data: OrderInput) {\n     2\t  const charge = await payments.charge(data.amount);\n     3\t  return db.order.create({ data: { ...data, chargeId: charge.id } });\n     4\t}" },
  "mock-read-3": { id: "mock-read-3", name: "Read", file: "apps/web/lib/payments/payments.test.ts", output: "     1\tdescribe(\"webhook\", () => {\n     2\t  test(\"creates an order\", async () => { … });\n     3\t});" },
  "mock-search-1": { id: "mock-search-1", name: "Grep", pattern: "idempotencyKey", output: "apps/web/lib/payments/stripe.ts:41:  idempotencyKey: event.id,\napps/web/lib/payments/types.ts:12:  idempotencyKey?: string;" },
  "mock-search-2": { id: "mock-search-2", name: "Grep", pattern: "retryWebhook", output: "No matches found" },
  "mock-run-1": { id: "mock-run-1", name: "Bash", command: "pnpm test payments", output: " ✓ webhook › creates an order (12 ms)\n ✓ webhook › returns the same order for a repeated event (9 ms)\n ✓ webhook › stops after five retries (4 ms)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  1.21s" },
  // The demo's edits, as a current box sends them: with their hunks, so
  // they are numbered by the file's own lines.
  "mock-edit-1": {
    id: "mock-edit-1",
    name: "Edit",
    file: "apps/web/lib/payments/webhook.ts",
    old: WEBHOOK_OLD,
    new: WEBHOOK_NEW,
    hunks: [
      {
        oldStart: 12,
        oldLines: 7,
        newStart: 12,
        newLines: 14,
        lines: [
          "   const payment = await payments.find(event.paymentId);",
          "   if (!payment) throw new NotFound(event.paymentId);",
          "-  const order = await createOrder(payment);",
          "-  return order;",
          "+  // A provider retries a webhook it thinks failed: find the order the",
          "+  // first delivery made instead of charging again.",
          "+  const existing = await orders.byIdempotencyKey(event.idempotencyKey);",
          "+  if (existing) return existing;",
          "+  const order = await createOrder(payment, {",
          "+    idempotencyKey: event.idempotencyKey,",
          "+  });",
          "+  await retries.schedule(event, { max: 5, within: \"10m\" });",
          "+  return order;",
          " }",
          " ",
          " export function verifySignature(body: string, signature: string) {",
        ],
      },
    ],
    output: "The file apps/web/lib/payments/webhook.ts has been updated.",
  },
  "mock-edit-go": {
    id: "mock-edit-go",
    name: "Edit",
    file: "services/payments/retry.go",
    old: "\tfor attempt := 0; ; attempt++ {\n\t\tif err := send(ctx, ev); err == nil {\n\t\t\treturn nil\n\t\t}\n\t\ttime.Sleep(time.Second)\n\t}",
    new: "\tdelay := 500 * time.Millisecond\n\tfor attempt := 1; attempt <= maxAttempts; attempt++ {\n\t\terr := send(ctx, ev)\n\t\tif err == nil {\n\t\t\treturn nil\n\t\t}\n\t\tif !retryable(err) {\n\t\t\treturn fmt.Errorf(\"send %s: %w\", ev.ID, err)\n\t\t}\n\t\tselect {\n\t\tcase <-ctx.Done():\n\t\t\treturn ctx.Err()\n\t\tcase <-time.After(delay):\n\t\t}\n\t\tdelay = min(delay*2, 30*time.Second)\n\t}\n\treturn ErrGaveUp",
    hunks: [
      {
        oldStart: 38,
        oldLines: 12,
        newStart: 38,
        newLines: 23,
        lines: [
          " // Deliver sends an event to its endpoint, retrying while it fails.",
          " func Deliver(ctx context.Context, ev Event) error {",
          "-\tfor attempt := 0; ; attempt++ {",
          "-\t\tif err := send(ctx, ev); err == nil {",
          "+\tdelay := 500 * time.Millisecond",
          "+\tfor attempt := 1; attempt <= maxAttempts; attempt++ {",
          "+\t\terr := send(ctx, ev)",
          "+\t\tif err == nil {",
          " \t\t\treturn nil",
          " \t\t}",
          "-\t\ttime.Sleep(time.Second)",
          "+\t\tif !retryable(err) {",
          "+\t\t\treturn fmt.Errorf(\"send %s: %w\", ev.ID, err)",
          "+\t\t}",
          "+\t\tselect {",
          "+\t\tcase <-ctx.Done():",
          "+\t\t\treturn ctx.Err()",
          "+\t\tcase <-time.After(delay):",
          "+\t\t}",
          "+\t\tdelay = min(delay*2, 30*time.Second)",
          " \t}",
          "+\treturn ErrGaveUp",
          " }",
          " ",
          " // retryable says whether a failed send is worth another try.",
          " func retryable(err error) bool {",
        ],
      },
    ],
    output: "The file services/payments/retry.go has been updated.",
  },
  "mock-multi-1": {
    id: "mock-multi-1",
    name: "MultiEdit",
    file: "apps/web/lib/checkout/createOrder.ts",
    old: "export async function createOrder(data: OrderInput) {\n⋯\n  return db.order.create({ data: { ...data, chargeId: charge.id } });",
    new: "export async function createOrder(data: OrderInput, opts: { idempotencyKey?: string } = {}) {\n⋯\n  return db.order.create({ data: { ...data, chargeId: charge.id, idempotencyKey: opts.idempotencyKey } });",
    hunks: [
      {
        oldStart: 3,
        oldLines: 6,
        newStart: 3,
        newLines: 6,
        lines: [
          ' import { payments } from "../payments/client";',
          " ",
          "-export async function createOrder(data: OrderInput) {",
          "+export async function createOrder(data: OrderInput, opts: { idempotencyKey?: string } = {}) {",
          "   const charge = await payments.charge(data.amount);",
          '   log.info("charged", { amount: data.amount });',
          " ",
        ],
      },
      {
        oldStart: 24,
        oldLines: 5,
        newStart: 24,
        newLines: 6,
        lines: [
          "   }",
          " ",
          "-  return db.order.create({ data: { ...data, chargeId: charge.id } });",
          "+  const idempotencyKey = opts.idempotencyKey ?? null;",
          "+  return db.order.create({ data: { ...data, chargeId: charge.id, idempotencyKey } });",
          " }",
          " ",
        ],
      },
    ],
    output: "Applied 2 edits to apps/web/lib/checkout/createOrder.ts",
  },
  "mock-write-1": {
    id: "mock-write-1",
    name: "Write",
    file: "apps/web/lib/payments/webhook.test.ts",
    new: WEBHOOK_TEST,
    output: "File created successfully at: apps/web/lib/payments/webhook.test.ts",
  },
};

// The demo's change to a file, for its uncommitted diff to agree with it.
export const mockToolDetailSync = (file: string): ToolDetail | undefined => Object.values(DETAILS).find((d) => d.file === file && d.hunks);

export const mockToolDetail = async (id: string): Promise<ToolDetail> => {
  await wait(250);
  const d = DETAILS[id] ?? benchToolDetail(id);
  if (!d) throw new Error("That step isn't in the demo.");
  return d;
};
