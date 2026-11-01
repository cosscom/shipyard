import { answerChoices } from "./choices";
import { noticeKey, routeFor } from "./links";
import type { Box, PhoneSession } from "./types";

const session = (p: Partial<PhoneSession>): PhoneSession => ({ name: "acme-fix", dir: "/home/dev/acme", created: "", attached: 0, exited: false, agent: "claude", agent_state: "waiting", ...p });

const menu = " Do you want to make this edit to webhook.ts?\n ❯ 1. Yes\n   2. Yes, and don't ask again this session\n   3. No, and tell Claude what to do differently\n";

test("a permission menu on screen reads as Allow, Always allow and Deny, with its own numbers", () => {
  expect(answerChoices(session({}), menu)).toEqual([
    { key: "1", label: "Allow", title: "Yes" },
    { key: "2", label: "Always allow", title: "Yes, and don't ask again this session" },
    { key: "3", label: "Deny", title: "No, and tell Claude what to do differently" },
  ]);
});

test("what the hooks say it asks comes before the screen", () => {
  const s = session({ ask: { choices: [{ key: "1", label: "Use Postgres" }, { key: "2", label: "Use SQLite" }] } });
  expect(answerChoices(s, menu).map((c) => c.label)).toEqual(["Use Postgres", "Use SQLite"]);
});

test("a yes or no question gets Yes and No; anything else, nothing", () => {
  expect(answerChoices(session({}), "Overwrite acme.json? (y/n)")).toEqual([
    { key: "y", label: "Yes" },
    { key: "n", label: "No" },
  ]);
  expect(answerChoices(session({}), "Thinking…")).toEqual([]);
  expect(answerChoices(session({ agent_state: "running" }), menu)).toEqual([]);
  expect(answerChoices(session({ soft_wait: true }), menu)).toEqual([]);
  expect(answerChoices(session({ exited: true }), menu)).toEqual([]);
  expect(answerChoices(undefined, menu)).toEqual([]);
});

const boxes: Box[] = [
  { id: "100.64.0.7_1379", name: "devl", url: "http://100.64.0.7:1379", token: "t" },
  { id: "100.64.0.8_1379", name: "build", url: "http://100.64.0.8:1379", token: "t" },
];

test("a notification opens its session or run on the box that sent it", () => {
  expect(routeFor({ berth: { v: 1, box: "build", kind: "session", session: "acme fix" } }, boxes)).toBe("/s/100.64.0.8_1379/acme%20fix");
  expect(routeFor({ box: "devl", kind: "run", run: "r_1" }, boxes)).toBe("/r/100.64.0.7_1379/r_1");
  expect(routeFor({ berth: { box: "elsewhere", kind: "session", session: "x" } }, boxes)).toBe("/");
  expect(routeFor(undefined, boxes)).toBe("/");
  // With one box, a notice that doesn't name it is still its own.
  expect(routeFor({ kind: "session", session: "x" }, boxes.slice(0, 1))).toBe("/s/100.64.0.7_1379/x");
});

test("a notice names the session it's about, to stay quiet while that one shows", () => {
  expect(noticeKey({ berth: { box: "devl", kind: "session", session: "acme" } })).toBe("devl/acme");
  expect(noticeKey({ berth: { box: "devl", kind: "run", run: "r_1" } })).toBe("devl/run/r_1");
  expect(noticeKey({})).toBeUndefined();
});
