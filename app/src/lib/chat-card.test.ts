// node --experimental-strip-types --test src/lib/chat-card.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { chatCard, mergeTail, openingPrompt, shownPrompt } from "./chat-card.ts";
import type { TranscriptItem } from "./transcript.ts";

const YES_NO = [
  { key: "1", label: "Yes" },
  { key: "2", label: "Yes, and don't ask again this session" },
  { key: "3", label: "No" },
];

const reply: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "Speed up product search" },
  { kind: "tools", id: "t1", verb: "Read", done: true, items: [{ verb: "Read", target: "search.ts", file: true }] },
  { kind: "text", id: "x1", text: "## Result\n\nSearch is faster now:\n\n- p95 is **410 ms**, was 660 ms\n- all 214 tests pass\n\n```ts\nconst cache = new Map();\n```\n\nThe branch is ready for review." },
];

test("a permission it waits on shows the tool, its input and why, with its answers", () => {
  const card = chatCard({ tool: "Bash", input: "pnpm db:migrate --name add-key", why: "Create the migration", choices: YES_NO }, true, reply);
  assert.deepEqual(card, { tail: ["Create the migration", "$ pnpm db:migrate --name add-key"], choices: YES_NO });
  assert.deepEqual(chatCard({ tool: "Edit", input: "src/search.ts", choices: YES_NO }, true, reply)?.tail, ["Edit src/search.ts"]);
});

test("a question it waits on shows the question, or the message it showed", () => {
  assert.deepEqual(chatCard({ tool: "AskUserQuestion", input: "Which release window?" }, true, reply), { tail: ["Which release window?"], choices: [] });
  const plan = chatCard({ tool: "ExitPlanMode", message: "Claude has a plan and is ready to start", choices: YES_NO }, true, reply);
  assert.deepEqual(plan, { tail: ["Claude has a plan and is ready to start"], choices: YES_NO });
  assert.deepEqual(chatCard({ tool: "AskUserQuestion" }, true, [])?.tail, ["Asks you a question"]);
});

test("not waiting, it shows the last lines of its newest reply, without markdown's marks", () => {
  assert.deepEqual(chatCard(undefined, false, reply), { tail: ["- all 214 tests pass", "const cache = new Map();", "The branch is ready for review."], choices: [] });
  assert.deepEqual(chatCard(undefined, false, reply, 2)?.tail, ["const cache = new Map();", "The branch is ready for review."]);
  // An ask left over from a wait that ended is not shown.
  assert.deepEqual(chatCard({ tool: "Bash", input: "ls" }, false, reply)?.tail.at(-1), "The branch is ready for review.");
});

test("waiting with no ask (a question in its last message) shows that message", () => {
  const asked: TranscriptItem[] = [...reply.slice(0, 2), { kind: "text", id: "x2", text: "Two ways to do this.\n\nShould I start with the cache?" }];
  assert.deepEqual(chatCard(undefined, true, asked)?.tail, ["Two ways to do this.", "Should I start with the cache?"]);
});

test("a step newer than its last words is what it shows", () => {
  const working: TranscriptItem[] = [
    ...reply,
    { kind: "tools", id: "t2", verb: "Run", items: [{ verb: "Read", target: "search.test.ts", file: true }, { verb: "Run", target: "pnpm test search" }] },
    { kind: "thinking", id: "th", since: 0 },
  ];
  assert.deepEqual(chatCard(undefined, false, working)?.tail, ["Read search.test.ts", "Run pnpm test search"]);
  const edited: TranscriptItem[] = [...reply, { kind: "edit", id: "e1", file: "src/search.ts", added: 9, removed: 2 }];
  assert.deepEqual(chatCard(undefined, false, edited)?.tail, ["Edit src/search.ts +9 −2"]);
  assert.deepEqual(chatCard(undefined, false, [{ kind: "tools", id: "t3", verb: "Thinking" }])?.tail, ["Thinking"]);
});

test("nothing to show hides the box: no reply yet, or a prompt it hasn't answered", () => {
  assert.equal(chatCard(undefined, false, undefined), undefined);
  assert.equal(chatCard(undefined, false, []), undefined);
  assert.equal(chatCard(undefined, false, [{ kind: "user", id: "u1", text: "Fix the cart badge" }]), undefined);
  // A new prompt after a reply: the reply is the last turn's, not this one's.
  assert.equal(chatCard(undefined, false, [...reply, { kind: "user", id: "u2", text: "Now the tests" }, { kind: "thinking", id: "th", since: 0 }]), undefined);
  assert.equal(chatCard(undefined, false, [{ kind: "text", id: "x", text: "\n\n```\n```\n" }]), undefined);
});

test("a notice newer than its reply (a usage limit, an API error) is what it shows", () => {
  const limited: TranscriptItem[] = [...reply, { kind: "notice", id: "n", notice: "limit", level: "warning", text: "Usage limit reached. It resets at 3pm." }];
  assert.deepEqual(chatCard(undefined, false, limited)?.tail, ["Usage limit reached. It resets at 3pm."]);
});

test("the prompt shows unless it repeats the title, and only when there is one", () => {
  assert.equal(shownPrompt("/ship ACME-12", "Fix checkout webhook retries"), "/ship ACME-12");
  assert.equal(shownPrompt("/ship ACME-12", undefined), "/ship ACME-12");
  assert.equal(shownPrompt("Fix checkout webhook retries", "Fix checkout webhook retries"), undefined);
  // Titles are cut short with an ellipsis; the prompt it began is no news.
  assert.equal(shownPrompt("Pick up search-perf: read the issue and get it to green.", "Pick up search-perf: read the issue and get it…"), undefined);
  assert.equal(shownPrompt(undefined, "Fix checkout"), undefined);
  assert.equal(shownPrompt("   ", "Fix checkout"), undefined);
});

test("the prompt it started with is its first prompt, or the command typed as one", () => {
  assert.equal(openingPrompt(reply), "Speed up product search");
  assert.equal(openingPrompt([{ kind: "command", id: "c", command: "/ship", args: "ACME-12" }, ...reply]), "/ship ACME-12");
  assert.equal(openingPrompt([{ kind: "command", id: "c", command: "/clear" }]), "/clear");
  // Read from the middle of a long conversation, its start isn't there.
  assert.equal(openingPrompt(reply, true), undefined);
  assert.equal(openingPrompt([]), undefined);
  assert.equal(openingPrompt(undefined), undefined);
});

test("a question over several lines shows its first lines, one each", () => {
  const ask = { tool: "AskUserQuestion", input: "Yes, both, as two issues:\n1. **Shipyard**: shortcuts for your layout.\n2. Lookout: shorter descriptions.\n3. A third." };
  assert.deepEqual(chatCard(ask, true, [])?.tail, ["Yes, both, as two issues:", "1. Shipyard: shortcuts for your layout.", "2. Lookout: shorter descriptions."]);
  assert.deepEqual(chatCard({ tool: "Bash", input: "make test", why: "Run the tests\nall of them" }, true, [])?.tail, ["Run the tests", "$ make test"]);
});

test("a long or pasted opening prompt is its first line, cut short", () => {
  const pasted = `[scrawl 0:57 · Shipyard] ${"so right now here ".repeat(30)}\n#2 the second part`;
  const p = openingPrompt([{ kind: "user", id: "u", text: pasted }]);
  assert.ok(p && p.length <= 200 && p.endsWith("…") && !p.includes("#2"), String(p));
  assert.equal(openingPrompt([{ kind: "user", id: "u", text: "\n  Fix the cart badge\nand its test" }]), "Fix the cart badge");
});

test("a card's newest items: read again replace their old selves, new go after, the oldest go", () => {
  const open: TranscriptItem = { kind: "tools", id: "t", verb: "Run", items: [{ verb: "Run", target: "pnpm test" }] };
  const done: TranscriptItem = { ...open, done: true, items: [{ verb: "Run", target: "pnpm test" }, { verb: "Read", target: "a.ts" }] };
  const said: TranscriptItem = { kind: "text", id: "x", text: "Done." };
  assert.deepEqual(mergeTail([reply[0], open], [done, said], 3), [reply[0], done, said]);
  assert.deepEqual(mergeTail([reply[0], open], [done, said], 2), [done, said]);
  assert.deepEqual(mergeTail([], reply, 12), reply);
  assert.deepEqual(mergeTail(reply, [], 12), reply);
});
