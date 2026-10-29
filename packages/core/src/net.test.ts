// node --experimental-strip-types --test packages/core/src/net.test.ts (pnpm test in app/)
import assert from "node:assert/strict";
import { test } from "node:test";

import { awayFrom, coalesce, readTimeout, READ_TIMEOUT_MS, reconnectDelay, retryLine } from "./net.ts";

test("reads get a time limit; long polls, the event stream and writes don't", () => {
  assert.equal(readTimeout("GET", "/v1/boxes/devl/api/sessions"), READ_TIMEOUT_MS);
  assert.equal(readTimeout("GET", "/v1/boxes/devl/api/files?q=cart"), READ_TIMEOUT_MS);
  assert.equal(readTimeout("GET", "/v1/boxes/devl/api/sessions/fix/wait?for=finished&timeout=300"), undefined);
  assert.equal(readTimeout("GET", "/v1/boxes/devl/api/turns/fix%231/wait?until=done"), undefined);
  assert.equal(readTimeout("GET", "/v1/events"), undefined);
  assert.equal(readTimeout("POST", "/v1/boxes/devl/api/sessions/fix/send"), undefined);
  assert.equal(readTimeout("POST", "/v1/boxes/devl/api/tasks"), undefined);
});

test("reconnects back off to 10s, with jitter", () => {
  assert.equal(reconnectDelay(1, () => 0.5), 500);
  assert.equal(reconnectDelay(2, () => 0.5), 1000);
  assert.equal(reconnectDelay(5, () => 0.5), 8000);
  assert.equal(reconnectDelay(6, () => 0.5), 10_000);
  assert.equal(reconnectDelay(40, () => 0.5), 10_000);
  assert.equal(reconnectDelay(6, () => 0), 8000);
  assert.equal(reconnectDelay(6, () => 1), 12_000);
  const seen = new Set(Array.from({ length: 40 }, () => reconnectDelay(4)));
  assert.ok(seen.size > 10, "jittered");
});

test("overlapping refreshes run as one, then one more", async () => {
  let runs = 0;
  let release!: () => void;
  const job = coalesce(async () => {
    runs++;
    await new Promise<void>((r) => (release = r));
  });
  const first = job();
  const queued = [job(), job(), job(), job()];
  assert.equal(runs, 1);
  release();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs, 2, "the calls made while it ran cost one more run");
  release();
  await Promise.all(queued);
  assert.equal(runs, 2);
  // Later calls run again.
  const later = job();
  assert.equal(runs, 3);
  release();
  await later;
});

test("a refresh that fails doesn't stop the next", async () => {
  let runs = 0;
  const job = coalesce(async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 5));
    if (runs === 1) throw new Error("the box went away");
  });
  const first = job();
  const second = job();
  await assert.rejects(first);
  await second;
  assert.equal(runs, 2);
  await job();
  assert.equal(runs, 3);
});

test("an away box counts down to the agent's next try", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const st = { state: "offline", retry_at: "2026-10-07T12:00:06.200Z", attempts: 3, since: "2026-10-07T11:58:45Z" };
  const a = awayFrom(st, now);
  assert.deepEqual(a, { next: 7, attempts: 3, away: 75 });
  assert.equal(retryLine(a), "Next try in 7s · away 1m 15s");
  assert.equal(retryLine(awayFrom(st, Date.parse("2026-10-07T12:00:07Z"))), "Trying now… · away 1m 22s");
  assert.equal(retryLine(awayFrom({ state: "offline", since: "2026-10-07T11:59:58Z" }, now)), "");
  assert.deepEqual(awayFrom({ state: "online", retry_at: st.retry_at }, now), {});
  // An older agent says nothing of its next try: only how long.
  assert.equal(retryLine(awayFrom({ state: "offline", since: "2026-10-07T09:30:00Z" }, now)), "away 2h 30m");
});
