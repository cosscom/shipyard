// node --experimental-strip-types --test src/lib/background-work.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundLabel, jobBadge, jobTook, type Job } from "./background-work.ts";

const now = 1_000_000_000;
const shell = (state: Job["state"], extra: Partial<Job> = {}): Job => ({ kind: "shell", state, since: now - 90_000, ...extra });

test("the chip counts only what is still running", () => {
  assert.equal(backgroundLabel([shell("running"), shell("done", { until: now - 1000, exit: 0 })], now), "1 shell running");
  assert.equal(backgroundLabel([shell("running"), shell("starting"), shell("failed", { until: now - 1000, exit: 3 })], now), "2 shells running");
  assert.equal(backgroundLabel([shell("running"), { kind: "monitor", state: "running", since: now }], now), "2 tasks running");
});

test("with nothing running the chip no longer says running, and goes once the ends are old", () => {
  const ended = [shell("done", { until: now - 1000, exit: 0 }), shell("failed", { until: now - 2000, exit: 3 })];
  assert.equal(backgroundLabel(ended, now), "2 finished");
  assert.doesNotMatch(backgroundLabel(ended, now) ?? "", /running/);
  assert.equal(backgroundLabel([shell("done", { until: now - 10 * 60_000 })], now), null);
  assert.equal(backgroundLabel([], now), null);
});

test("a finished shell's badge names its exit code", () => {
  assert.deepEqual(jobBadge(shell("done", { exit: 0 })), { text: "Done · exit 0", tone: "done" });
  assert.deepEqual(jobBadge(shell("failed", { exit: 3 })), { text: "Failed · exit 3", tone: "failed" });
  assert.deepEqual(jobBadge(shell("stopped")), { text: "Stopped", tone: "stopped" });
  assert.deepEqual(jobBadge(shell("running")), { text: "Running", tone: "running" });
  // A box that doesn't say the code yet.
  assert.deepEqual(jobBadge(shell("done")), { text: "Done", tone: "done" });
  assert.deepEqual(jobBadge(shell("failed")), { text: "Failed", tone: "failed" });
});

test("a finished shell's duration is frozen at its end", () => {
  const done = shell("done", { until: now - 30_000, exit: 0 });
  assert.equal(jobTook(done, now), "1m");
  assert.equal(jobTook(done, now + 60 * 60_000), "1m");
  assert.equal(jobTook(shell("running"), now), "1m");
  assert.equal(jobTook(shell("running"), now + 60 * 60_000), "1h 1m");
});
