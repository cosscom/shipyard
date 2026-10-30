// node --experimental-strip-types --test src/lib/usage-plan.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Account } from "../../../plugins/usage/src/box.ts";
import { plan } from "../../../plugins/usage/src/data.ts";

const claude = (over: Partial<Account>): Account => ({ agent: "claude", id: "x", dir: "/x", exists: true, signed_in: true, billing: "stripe_subscription", ...over }) as Account;

test("a team seat is named by its organization, not the Max-like tier it records", () => {
  assert.equal(plan(claude({ tier: "default_claude_max_5x", org_type: "claude_team" }))?.label, "Claude Team");
  assert.equal(plan(claude({ tier: "default_claude_max_5x", org_type: "claude_enterprise" }))?.label, "Claude Enterprise");
});

test("a personal plan is named by its tier", () => {
  assert.equal(plan(claude({ tier: "default_claude_max_20x", org_type: "claude_max" }))?.label, "Claude Max 20x");
  assert.equal(plan(claude({ tier: "default_claude_max_5x" }))?.label, "Claude Max 5x");
  assert.equal(plan(claude({ tier: "default_claude_pro", org_type: "claude_pro" }))?.label, "Claude Pro");
});
