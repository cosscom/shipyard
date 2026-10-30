// node --experimental-strip-types --test src/lib/usage-limits.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Account, Limits, Report } from "../../../plugins/usage/src/box.ts";
import { dedupeLimits, type Source } from "../../../plugins/usage/src/data.ts";

const win = { used_percent: 10, window_minutes: 300, resets_at: 2_000_000_000 };
const limits = (account: string, at: string, org?: string): Limits => ({ agent: "claude", account, at, ...(org ? { org } : {}), limits: { primary: win, secondary: null } });
const report = (l: Limits[]): Report => ({ generated: "", days: 7, since: "2026-10-08", today: "2026-10-14", tz: "+00", partial: false, pending: 0, files: 0, daily: [], sessions: [], limits: l });
const source = (box: string, l: Limits[]) => ({ box, report: report(l) }) as unknown as Source;
const account = (id: string, email: string): Account => ({ agent: "claude", id, email }) as Account;

test("one email signed in to two plans shows both on the Usage screen, each named by its account", () => {
  const accounts = { devl: [account("ana-team", "ana@acme.test"), account("ana-max", "ana@acme.test")] };
  const got = dedupeLimits("claude", [source("devl", [limits("ana-team", "2026-10-14T10:00:00Z", "o-team"), limits("ana-max", "2026-10-14T10:00:00Z", "o-max")])], accounts, 7);
  assert.deepEqual(got.map((l) => l.label).sort(), ["ana@acme.test · ana-max", "ana@acme.test · ana-team"]);
  assert.equal(new Set(got.map((l) => l.key)).size, 2);
});

test("one login read on two boxes is one row, as most recently read", () => {
  const accounts = { devl: [account("default", "bo@acme.test")], gpu: [account("default", "bo@acme.test")] };
  const got = dedupeLimits("claude", [source("devl", [limits("default", "2026-10-14T10:00:00Z", "o-1")]), source("gpu", [limits("default", "2026-10-14T11:00:00Z", "o-1")])], accounts, 7);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].boxes, ["devl", "gpu"]);
  assert.equal(got[0].limits.at, "2026-10-14T11:00:00Z");
  // One login needs no name.
  assert.equal(got[0].label, undefined);
});
