// node --experimental-strip-types --test src/lib/judge-evaluations.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunEvaluation } from "@berth/plugin";
import { changedSince, evaluationKind, previousOf, splitEvaluations, versionLabel, whatChanged } from "./judge-evaluations.ts";

const ev = (n: number, more: Partial<RunEvaluation> = {}): RunEvaluation => ({ n, status: "succeeded", by: "agent", started: "2026-10-18T10:00:00Z", ...more });

test("a verdict, the checks, a fallback and a failure each read as what they are", () => {
  assert.equal(evaluationKind(ev(1, { source: "judge", winner: 2 })), "verdict");
  assert.equal(evaluationKind(ev(1, { by: "check", source: "checks", winner: 1 })), "checks");
  assert.equal(evaluationKind(ev(2, { status: "failed", source: "checks", winner: 1, error: "the judge's reply was not valid (no JSON object in the reply)" })), "fallback");
  assert.equal(evaluationKind(ev(2, { status: "failed", error: "the judge's reply was not valid (no JSON object in the reply)" })), "failed");
  assert.equal(evaluationKind(ev(3, { status: "failed", error: "stopped before the judge answered" })), "stopped");
  assert.equal(evaluationKind(ev(3, { status: "failed", error: "berthd restarted before the judge answered" })), "stopped");
  assert.equal(evaluationKind(ev(3, { status: "running" })), "running");
});

test("Review shows the last evaluation that ended, a rerun in flight beside it, and the rest as earlier", () => {
  const s = splitEvaluations([ev(3, { status: "running" }), ev(1, { source: "judge", winner: 2 }), ev(2, { status: "failed", source: "checks", winner: 1 })]);
  assert.equal(s.current?.n, 2);
  assert.equal(s.running?.n, 3);
  assert.deepEqual(
    s.earlier.map((e) => e.n),
    [1],
  );
  assert.deepEqual(splitEvaluations(undefined), { current: undefined, running: undefined, earlier: [] });
  // Only a first one running: nothing to show as current yet.
  const first = splitEvaluations([ev(1, { status: "running" })]);
  assert.equal(first.current, undefined);
  assert.equal(first.running?.n, 1);
});

test("a version is its short commit, and says when the worktree had more", () => {
  assert.equal(versionLabel({ head: "9f8e7d6c5b4a", dirty: true }), "9f8e7d6 + uncommitted");
  assert.equal(versionLabel({ head: "9f8e7d6c5b4a" }), "9f8e7d6");
  assert.equal(versionLabel({ dirty: true }), "uncommitted changes");
  assert.equal(versionLabel(undefined), "unknown version");
});

test("a worktree changed since it was judged when its commit or its uncommitted state moved", () => {
  assert.equal(changedSince({ head: "a1", dirty: false }, { head: "a1", dirty: false }), false);
  assert.equal(changedSince({ head: "a1" }, { head: "b2" }), true);
  assert.equal(changedSince({ head: "a1", dirty: false }, { head: "a1", dirty: true }), true);
  // An evaluation from before versions were kept says nothing.
  assert.equal(changedSince({}, { head: "a1" }), false);
  assert.equal(changedSince({ head: "a1" }, undefined), false);
});

test("what changed between evaluations is said in a line", () => {
  const a = ev(1, { source: "judge", winner: 2, ranking: [2, 1, 0] });
  assert.equal(whatChanged(a, ev(2, { source: "judge", winner: 1, ranking: [1, 2, 0] })), "the winner changed from attempt 3 to attempt 2");
  assert.equal(whatChanged(a, ev(2, { source: "judge", winner: 2, ranking: [2, 0, 1] })), "the same winner, but the order behind it changed");
  assert.equal(whatChanged(a, ev(2, { status: "failed", source: "checks", winner: 2 })), "the same winner, now by the checks");
  assert.equal(whatChanged(a, ev(2, { status: "failed" })), "no winner, where attempt 3 won");
  assert.equal(whatChanged(ev(1, { status: "failed" }), a), "attempt 3 wins, where there was no winner");
  assert.equal(whatChanged(undefined, a), undefined);
  assert.equal(whatChanged(a, ev(2, { status: "running" })), undefined);
  assert.equal(previousOf([a, ev(2, { status: "running" }), ev(3)], ev(3))?.n, 1);
});
