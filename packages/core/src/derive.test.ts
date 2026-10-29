// node --experimental-strip-types --test packages/core/src/derive.test.ts (pnpm test in app/)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Session } from "../../plugin-sdk/src/types.ts";

import { allOnItsWork, chatState, firstPrompt, offBoard, onItsWork, replyMode, restartCommand, sessionState } from "./derive.ts";

test("a finished turn turn check read as working is on its work, a live turn is not", () => {
  const s = { name: "a", dir: "/w", created: "2026-10-12T10:00:00Z", attached: 0, exited: false, agent: "claude", agent_state: "finished", unfinished: true } as Session;
  // Still running to everything that counts or groups it.
  assert.equal(sessionState(s), "running");
  assert.equal(onItsWork(s), true);
  const live: Session = { ...s, name: "b", agent_state: "running", unfinished: false };
  assert.equal(sessionState(live), "running");
  assert.equal(onItsWork(live), false);
  // A later turn started, or it ended: back to how it reads anyway.
  assert.equal(onItsWork({ ...s, agent_state: "running" }), false);
  assert.equal(onItsWork({ ...s, unfinished: false }), false);
  assert.equal(onItsWork({ ...s, exited: true }), false);
  assert.equal(onItsWork(undefined), false);
  // A row sums its sessions up: the hourglass only with no live turn there.
  assert.equal(allOnItsWork([s]), true);
  assert.equal(allOnItsWork([s, live]), false);
  assert.equal(allOnItsWork([s, { ...s, name: "c", agent_state: "finished", unfinished: false }]), true);
  assert.equal(allOnItsWork([{ ...s, unfinished: false }]), false);
  assert.equal(allOnItsWork([]), false);
});

test("a preset session's first prompt is read back from its command", () => {
  assert.equal(firstPrompt({ preset: "claude", command: "claude --model haiku 'fix the flaky test'" }), "fix the flaky test");
  assert.equal(firstPrompt({ preset: "claude", command: `claude 'it'\\''s "done"
next line'` }), `it's "done"\nnext line`);
  assert.equal(firstPrompt({ preset: "opencode", command: "opencode --prompt 'add a health check'" }), "add a health check");
  assert.equal(firstPrompt({ preset: "claude", command: "claude --resume 0d1e 'go on'" }), "go on");
  // No prompt, or a command berth didn't write.
  assert.equal(firstPrompt({ preset: "claude", command: "claude --model haiku" }), undefined);
  assert.equal(firstPrompt({ command: "claude 'typed by hand'" }), undefined);
  assert.equal(firstPrompt(undefined), undefined);
  // What restartCommand drops is the same prompt.
  assert.equal(restartCommand("claude --model haiku 'fix it'"), "claude --model haiku");
});

test("a session is off the board when its location, on its box, is hidden", () => {
  const locations = [
    { name: "ops", path: "/home/me/ops", repo: true, scripts: {}, worktrees: [{ name: "ops", path: "/home/me/ops", main: true }, { name: "go-live", path: "/home/me/ops-go-live" }] },
    { name: "shop", path: "/home/me/shop", repo: true, scripts: {}, worktrees: [{ name: "shop", path: "/home/me/shop", main: true }] },
  ];
  const at = (dir: string) => ({ name: "s", dir, created: "", attached: 0, exited: false });
  const hidden = new Set(["devl/ops"]);
  // The main checkout and its worktrees alike.
  assert.equal(offBoard(locations, "devl", at("/home/me/ops"), hidden), true);
  assert.equal(offBoard(locations, "devl", at("/home/me/ops-go-live"), hidden), true);
  assert.equal(offBoard(locations, "devl", at("/home/me/shop"), hidden), false);
  // The same name on another box is another location.
  assert.equal(offBoard(locations, "gpu", at("/home/me/ops"), hidden), false);
  // Somewhere no location knows, or nothing hidden.
  assert.equal(offBoard(locations, "devl", at("/tmp"), hidden), false);
  assert.equal(offBoard(locations, "devl", at("/home/me/ops"), new Set()), false);
});

test("a finished turn whose work goes on without the agent shows as working, not done", () => {
  const s = { name: "a", dir: "/w", created: "2026-10-12T10:00:00Z", attached: 0, exited: false, agent: "claude", agent_state: "finished" } as Session;
  assert.equal(sessionState(s), "finished");
  assert.equal(sessionState({ ...s, unfinished: true }), "running");
  // Only a finished turn: a question still needs you.
  assert.equal(sessionState({ ...s, agent_state: "waiting", unfinished: true }), "waiting");
});

test("a chat whose turn ended while its work runs on takes a new turn, with the hourglass and Send", () => {
  const s = { name: "a", dir: "/w", created: "2026-10-12T10:00:00Z", attached: 0, exited: false, agent: "claude", agent_state: "finished", unfinished: true } as Session;
  // Running on the board, between turns in its chat.
  assert.equal(sessionState(s), "running");
  assert.equal(onItsWork(s), true);
  assert.equal(chatState(s), "finished");
  assert.equal(replyMode(chatState(s)), "send");
  // A live turn: the spinner, Stop and a queued message.
  const live: Session = { ...s, agent_state: "running", unfinished: false };
  assert.equal(onItsWork(live), false);
  assert.equal(chatState(live), "running");
  assert.equal(replyMode(chatState(live)), "queue");
  // Its next turn starts afresh, and a question still needs you.
  assert.equal(chatState({ ...s, agent_state: "running" }), "running");
  assert.equal(replyMode(chatState({ ...s, agent_state: "waiting" })), "answer");
  // Ended, or a service's terminal: never on its work.
  assert.equal(onItsWork({ ...s, exited: true }), false);
  assert.equal(onItsWork({ ...s, service: "web" } as Session), false);
  assert.equal(onItsWork(undefined), false);
});

test("a finished turn parked until a reply or a later time shows as idle, not done or working", () => {
  const s = { name: "a", dir: "/w", created: "2026-10-12T10:00:00Z", attached: 0, exited: false, agent: "claude", agent_state: "finished", parked: true } as Session;
  assert.equal(sessionState(s), "ready");
  assert.equal(sessionState({ ...s, agent_state: "waiting" }), "waiting");
  assert.equal(sessionState({ ...s, agent_state: "running" }), "running");
});
