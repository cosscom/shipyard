// node --experimental-strip-types --test src/lib/session-account.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { accountChip } from "./session-account.ts";

const work = { agent: "claude", name: "work", dir: "/home/me/.berth/accounts/claude/work", count: 2 };

test("a box with two accounts names the one a session runs on", () => {
  assert.deepEqual(accountChip(work), { label: "work", tip: "Claude Code account in /home/me/.berth/accounts/claude/work" });
  assert.equal(accountChip({ ...work, name: "default", dir: "/home/me/.claude" })?.label, "default");
  assert.equal(accountChip({ agent: "codex", name: "default", dir: "/home/me/.codex", count: 2 })?.tip, "Codex account in /home/me/.codex");
});

test("one account, or a box that doesn't say, shows no account", () => {
  assert.equal(accountChip({ ...work, name: "default", dir: "/home/me/.claude", count: 1 }), undefined);
  assert.equal(accountChip(undefined), undefined);
  assert.equal(accountChip({ ...work, name: "" }), undefined);
});

test("a session on a folder other than the default shows it, whatever the count", () => {
  assert.equal(accountChip({ ...work, name: "/srv/claude/shared", dir: "/srv/claude/shared", count: 1 })?.label, "/srv/claude/shared");
});
