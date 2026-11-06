import assert from "node:assert/strict";
import { test } from "node:test";

import { howItEnded, peekRows, screenFoot, answerFor, choicesOnScreen, cleanTitle, denyChoice, didntLand, estimate, holdCurrent, inList, type Item, isRecommended, itemsOf, NO_MARKS, oneLine, openForm, openItems, permissionChoices, closeAnswers, CLOSE_LINE, closeKind, hasUnsaved, SENT_GRACE_MS, shownLabel, snoozeTimes, trackGone, walkOrder } from "./model.ts";

const waiting = (name: string, extra = {}) => ({ name, agent: "claude", agent_state: "waiting", state_since: "2026-01-01T10:00:00Z", turn: `${name}#1`, ...extra });

const one = (s: object) => itemsOf("acme", { sessions: [s as never] });

test("a waiting session is a decision, or an action by its sub-state", () => {
  assert.equal(one(waiting("a"))[0].group, "decision");
  assert.equal(one(waiting("a", { agent_sub_state: "decision" }))[0].group, "decision");
  assert.equal(one(waiting("a", { agent_sub_state: "act" }))[0].group, "action");
});

test("what doesn't need you stays out", () => {
  assert.equal(one({ name: "a", agent: "claude", agent_state: "running" }).length, 0);
  assert.equal(one({ name: "a", agent: "claude", agent_state: "finished", title: "✅ Shipped" }).length, 0);
  assert.equal(one(waiting("a", { parked: true })).length, 0);
  assert.equal(one(waiting("a", { queued: 2 })).length, 0);
  assert.equal(one({ name: "shell", exited: true }).length, 0);
});

test("a blocked or asking title on a finished turn is an item, and a live turn wins over its title", () => {
  assert.equal(one({ name: "a", agent: "claude", agent_state: "finished", title: "⛔ Needs creds" })[0].group, "blocked");
  assert.equal(one({ name: "a", agent: "claude", agent_state: "finished", title: "❓ Which one" })[0].group, "decision");
  assert.equal(one({ name: "a", agent: "claude", agent_state: "running", title: "⛔ Old title" }).length, 0);
});

test("an agent that exited is blocked", () => {
  const [it] = one({ name: "a", agent: "claude", exited: true });
  assert.equal(it.kind, "exited");
  assert.equal(it.group, "blocked");
});

test("run gates and secret requests are items", () => {
  const items = itemsOf("acme", {
    sessions: [],
    gates: [{ id: "r1", updated: "2026-01-01T10:00:00Z", gate: { path: "1", title: "Deploy to staging?" } }],
    secrets: [{ id: "s1", name: "ACME_KEY", reason: "To call the API" }],
  });
  assert.deepEqual(items.map((i) => [i.kind, i.group]), [["gate", "decision"], ["secret", "action"]]);
});

test("titles lose their marks", () => {
  assert.equal(cleanTitle("❓ → Pick a colour", "x"), "Pick a colour");
  assert.equal(cleanTitle(undefined, "x"), "x");
  assert.equal(cleanTitle("⛔", "x"), "x");
});

const item = (key: string, group: Item["group"], since: string): Item => ({ key, group, kind: "wait", box: "acme", title: key, since, source: { name: key } });

test("the list is oldest first in the groups you named, and the walk unblocks first", () => {
  const items = [item("r", "review", "2026-01-01T01:00:00Z"), item("b", "blocked", "2026-01-01T02:00:00Z"), item("new", "decision", "2026-01-01T09:00:00Z"), item("old", "decision", "2026-01-01T03:00:00Z"), item("a", "action", "2026-01-01T04:00:00Z")];
  assert.deepEqual(inList(items).map((g) => g.items.map((i) => i.key)), [["old", "new"], ["a"], ["r"], ["b"]]);
  assert.deepEqual(walkOrder(items).map((i) => i.key), ["old", "new", "a", "b", "r"]);
});

test("the count is the list: snoozed, resolved and just-sent items leave it", () => {
  const items = [item("a", "decision", ""), item("b", "decision", ""), item("c", "decision", ""), item("d", "decision", "")];
  const open = openItems(items, { snoozed: { a: 2000 }, resolved: { b: 1 }, sent: { c: 1000 } }, 1500);
  assert.deepEqual(open.map((i) => i.key), ["d"]);
});

test("a snooze runs out, and an answer that didn't land comes back saying so", () => {
  const items = [item("a", "decision", "")];
  assert.equal(openItems(items, { ...NO_MARKS, snoozed: { a: 1000 } }, 1000).length, 1);
  const marks = { ...NO_MARKS, sent: { a: 1000 } };
  assert.equal(openItems(items, marks, 1000 + SENT_GRACE_MS).length, 1);
  assert.equal(didntLand(items[0], marks, 1000 + SENT_GRACE_MS), true);
  assert.equal(didntLand(items[0], marks, 1000 + SENT_GRACE_MS - 1), false);
});

test("a new item never replaces the card you're on, and leaving goes to the next one", () => {
  const a = item("a", "decision", "2026-01-01T02:00:00Z");
  const b = item("b", "decision", "2026-01-01T03:00:00Z");
  const older = item("older", "decision", "2026-01-01T01:00:00Z");
  assert.equal(holdCurrent(walkOrder([a, b, older]), "a")?.key, "a");
  assert.equal(holdCurrent(walkOrder([older, b]), "a", walkOrder([a, b]))?.key, "b");
  assert.equal(holdCurrent([], "a"), undefined);
});

test("the estimate reads as people say it", () => {
  assert.equal(estimate([]), "0 left");
  assert.equal(estimate([item("a", "decision", "")]), "1 left, about 1 min");
  assert.equal(estimate(Array.from({ length: 7 }, (_, i) => item(String(i), "action", ""))), "7 left, about 14 min");
});

test("snooze times are in the future, in order", () => {
  const now = Date.parse("2026-01-07T15:00:00");
  const t = snoozeTimes(now).map((s) => s.until);
  assert.ok(now < t[0] && t[0] < t[1] && t[1] < t[2]);
});

test("recommended is read from the label and hidden from what's shown", () => {
  const o = { label: "Both (Recommended)" };
  assert.equal(isRecommended(o), true);
  assert.equal(shownLabel(o), "Both");
  assert.equal(isRecommended({ label: "Both" }), false);
});

const single = { question: "Who?", options: [{ label: "Sender (Recommended)" }, { label: "Admin" }] };

test("a single choice sends its exact label, so the box accepts it", () => {
  assert.deepEqual(answerFor(single, { picks: ["Sender (Recommended)"] }), { picks: ["Sender (Recommended)"] });
});

test("a single choice with a note goes as one answer naming the pick", () => {
  assert.deepEqual(answerFor(single, { picks: ["Sender (Recommended)"], note: "only for now" }), { other: "Sender. only for now" });
  assert.deepEqual(answerFor(single, { picks: [], note: "neither" }), { other: "neither" });
});

test("several picks keep their labels beside the note", () => {
  assert.deepEqual(answerFor({ ...single, multi: true }, { picks: ["Admin"], note: "and audit it" }), { picks: ["Admin"], other: "and audit it" });
});

test("notes become one line, and a double quote can't cut the answer short", () => {
  assert.equal(oneLine('  say "yes"\n\nplease '), "say ”yes” please");
  assert.equal(answerFor(single, { picks: [], note: 'a "b"' }).other, "a ”b”");
});

test("closing over a form answers every question with the line and the note", () => {
  const a = closeAnswers([single, single], "not needed");
  assert.equal(a.length, 2);
  assert.equal(a[0].other, `${CLOSE_LINE} Note: not needed`);
  assert.ok(!CLOSE_LINE.includes('"'), "a straight quote would cut it short on the chat driver");
  assert.ok(CLOSE_LINE.includes("$BERTH_SESSION"));
  assert.ok(!/\n/.test(CLOSE_LINE), "a box takes one line");
});

test("a session can be closed, and what has no session can only leave the list", () => {
  assert.equal(closeKind("wait"), "close");
  assert.equal(closeKind("marked"), "close");
  assert.equal(closeKind("exited"), "close");
  assert.equal(closeKind("secret"), "dismiss");
  assert.equal(closeKind("gone"), "dismiss");
  assert.equal(closeKind("gate"), undefined);
});

test("only an empty check counts as nothing to lose", () => {
  assert.equal(hasUnsaved(""), false);
  assert.equal(hasUnsaved("  \n"), false);
  assert.equal(hasUnsaved(undefined), false);
  assert.equal(hasUnsaved(" M src/a.ts\n"), true);
  assert.equal(hasUnsaved("abc123 feat: not pushed\n"), true);
});

test("an open form is the last question, unless you've spoken since", () => {
  const q = { kind: "question", id: "1", tool: "t", questions: [single] };
  assert.equal(openForm([q])?.id, "1");
  assert.equal(openForm([q, { kind: "text", id: "2", text: "hm" }])?.id, "1");
  assert.equal(openForm([q, { kind: "user", id: "2" }]), undefined);
  assert.equal(openForm([{ ...q, done: true }]), undefined);
});

test("permission options come off the screen, and read plainly", () => {
  const screen = "Bash command\n  pnpm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for pnpm\n   3. No, and tell Claude what to do differently\n";
  const raw = choicesOnScreen(screen);
  assert.deepEqual(raw.map((c) => c.key), ["1", "2", "3"]);
  const nice = permissionChoices(raw);
  assert.deepEqual(nice.map((c) => c.label), ["Allow", "Always allow", "Deny"]);
  assert.equal(denyChoice(nice)?.key, "3");
});

test("a session that vanishes while working is gone, unless it was stopped", () => {
  const known = { a: { name: "a", state: "running" }, b: { name: "b", state: "waiting" } };
  const r = trackGone(known, [], new Set(["b"]), "2026-01-01T00:00:00Z");
  assert.deepEqual(r.gone.map((g) => g.name), ["a"]);
  assert.deepEqual(r.known, {});
});

test("only sessions at work are tracked", () => {
  const r = trackGone({}, [{ name: "a", agent: "claude", agent_state: "running" }, { name: "b", agent: "claude", agent_state: "finished" }, { name: "c", agent_state: "running" }], new Set(), "x");
  assert.deepEqual(Object.keys(r.known), ["a"]);
});

test("a screen's foot drops rules and blank lines", () => {
  assert.equal(screenFoot("─────\n\n Is this a folder you trust?  \n ❯ No, exit\n"), " Is this a folder you trust?\n ❯ No, exit");
});

test("a form's question isn't repeated as the reason it asks, and a command is", () => {
  assert.equal(one(waiting("a", { ask: { tool: "AskUserQuestion", input: "Which?" } }))[0].why, undefined);
  assert.equal(one(waiting("a", { ask: { tool: "Bash", input: "pnpm test" } }))[0].why, "Bash: pnpm test");
});

test("how a turn ended counts only when it's the last thing, and the title can't claim otherwise", () => {
  assert.equal(howItEnded([{ kind: "text", id: "1", text: "hm" }, { kind: "notice", id: "2", notice: "interrupted", text: "Interrupted" }]), "It was interrupted, and waits for what to do instead.");
  assert.equal(howItEnded([{ kind: "notice", id: "1", notice: "interrupted" }, { kind: "text", id: "2", text: "back at it" }]), undefined);
  assert.equal(one({ name: "a", agent: "claude", agent_state: "finished", title: "❓ Old question" })[0].why, "Its title says it's asking");
});

test("the peek folds runs of work into one line, as the chat does", () => {
  const rows = peekRows([
    { kind: "user", id: "u" },
    { kind: "tools", id: "t1", verb: "Run", items: [{ verb: "Run", target: "ls" }, { verb: "Run", target: "pwd" }] },
    { kind: "tools", id: "t2", verb: "Read", items: [{ verb: "Read", target: "a.ts" }] },
    { kind: "edit", id: "e1", file: "a.ts" },
    { kind: "text", id: "x", text: "done" },
    { kind: "tools", id: "t3", verb: "Run" },
  ]);
  assert.deepEqual(rows.map((r) => (r.kind === "work" ? r.summary : r.item.kind)), ["user", "Worked · ran 2 commands, read 1 file, edited 1 file", "text", "Worked · ran 1 command"]);
});
