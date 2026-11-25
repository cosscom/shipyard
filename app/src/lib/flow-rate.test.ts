// node --experimental-strip-types --test src/lib/flow-rate.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { maxRunsPerHour, rateWarning, refusedLabel } from "./flows.ts";

const flow = { id: "every-minute", name: "Every minute", enabled: true, trigger: { schedule: "* * * * *" }, steps: [] };

test("a flow without a limit has the box's default", () => {
  assert.equal(maxRunsPerHour(flow), 20);
  assert.equal(maxRunsPerHour({ ...flow, max_runs_per_hour: 0 }), 20);
  assert.equal(maxRunsPerHour({ ...flow, max_runs_per_hour: 90 }), 90);
});

test("a schedule over its limit says how many starts it loses, in the box's words", () => {
  assert.equal(rateWarning(60, 20), "This schedule fires up to 60 times an hour; the limit is 20, so about 40 starts an hour will be refused.");
  assert.equal(rateWarning(36, 20, true), "This schedule fires up to 36 times an hour across its worktrees, which share the limit; the limit is 20, so about 16 starts an hour will be refused.");
});

test("a schedule that fits says nothing", () => {
  assert.equal(rateWarning(12, 20), undefined);
  assert.equal(rateWarning(20, 20), undefined);
});

test("the badge counts what the limit refused", () => {
  assert.equal(refusedLabel(3), "Limit reached · 3 refused in the last hour");
});
