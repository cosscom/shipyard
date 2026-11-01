// node --experimental-strip-types --test src/lib/usage-summary.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Limits, Report, Window } from "../../../plugins/usage/src/box.ts";
import { summarizeUsage, windowName } from "../../../plugins/usage/src/summary.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const H = 3600;
const at = (iso: string) => iso;
const win = (used: number, minutes: number, resetsInHours: number | null, label?: string): Window => ({
  used_percent: used,
  window_minutes: minutes,
  resets_at: resetsInHours === null ? null : Math.round(NOW / 1000 + resetsInHours * H),
  ...(label ? { label } : {}),
});

function report(limits: Limits[]): Report {
  return { generated: "", days: 7, since: "2026-10-08", today: "2026-10-14", tz: "+07", partial: false, pending: 0, files: 0, daily: [], sessions: [], limits };
}

const claude = (account: string, readAt: string, session: number, week: number, fable?: Window | null, sessionResets: number | null = 2): Limits => ({
  agent: "claude",
  account,
  at: readAt,
  limits: { primary: win(session, 300, sessionResets), secondary: win(week, 10080, 72), ...(fable === undefined ? {} : { extra: fable ? [fable] : [] }) },
});

test("a login read on several boxes counts once, as most recently read", () => {
  const s = summarizeUsage(
    [
      { box: "devl", report: report([claude("default", at("2026-10-14T11:00:00Z"), 30, 60)]) },
      { box: "gpu", report: report([claude("default", at("2026-10-14T11:30:00Z"), 34, 61)]) },
      { box: "ci", report: report([claude("default", at("2026-10-14T10:00:00Z"), 20, 50)]) },
    ],
    [],
    NOW,
  );
  assert.deepEqual(
    s.limits.map((l) => [l.label, Math.round(l.used * 100)]),
    [
      ["Claude Code · week", 61],
      ["Claude Code · 5h", 34],
    ],
  );
});

test("boxes that read the same reset seconds apart agree on it", () => {
  const a = claude("default", at("2026-10-14T11:00:00Z"), 30, 60);
  const b = claude("default", at("2026-10-14T11:05:00Z"), 31, 60);
  b.limits.primary = { ...b.limits.primary!, resets_at: b.limits.primary!.resets_at! + 20 };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([b]) }], [], NOW);
  assert.deepEqual(
    s.limits.map((l) => [l.label, Math.round(l.used * 100)]),
    [
      ["Claude Code · week", 60],
      ["Claude Code · 5h", 31],
    ],
  );
});

test("one login printed a minute apart by two boxes (12:29 and 12:30) counts once", () => {
  // What two boxes on one login showed for real: their reads were half a
  // minute apart, and Claude Code prints resets to the minute.
  const a = claude("default", at("2026-10-14T11:00:00Z"), 94, 77);
  const b = claude("default", at("2026-10-14T10:15:00Z"), 88, 76);
  b.limits.primary = { ...b.limits.primary!, resets_at: a.limits.primary!.resets_at! + 60 };
  b.limits.secondary = { ...b.limits.secondary!, resets_at: a.limits.secondary!.resets_at! + 60 };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([b]) }], [], NOW);
  assert.deepEqual(
    s.limits.map((l) => [l.label, Math.round(l.used * 100)]),
    [
      ["Claude Code · 5h", 94],
      ["Claude Code · week", 77],
    ],
  );
});

test("two logins with their own windows both show, each named", () => {
  const work: Limits = { ...claude("work", at("2026-10-14T11:00:00Z"), 80, 10), limits: { primary: win(80, 300, 3), secondary: win(10, 10080, 100) } };
  const s = summarizeUsage([{ box: "devl", report: report([claude("default", at("2026-10-14T11:00:00Z"), 30, 60), work]) }], [], NOW);
  assert.equal(s.limits.length, 4);
  assert.equal(s.limits[0].label, "Claude Code · 5h · work");
  assert.equal(Math.round(s.limits[0].used * 100), 80);
});

test("two boxes' default logins are told apart by email, even with the same numbers", () => {
  // What the widget showed for real: "Claude Code · 5h 3%" twice, one per
  // login, with nothing to say which was which.
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 0), email: "ana@acme.test" };
  const b = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 0), email: "bo@acme.test" };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([b]) }], [], NOW);
  assert.deepEqual(s.limits.map((l) => l.label).sort(), ["Claude Code · 5h · ana", "Claude Code · 5h · bo", "Claude Code · week · ana", "Claude Code · week · bo"]);
});

test("one email on two boxes is one login, and needs no name", () => {
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "ana@acme.test" };
  const b = { ...claude("work", at("2026-10-14T11:30:00Z"), 4, 10), email: "ana@acme.test" };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([b]) }], [], NOW);
  assert.deepEqual(
    s.limits.map((l) => [l.label, Math.round(l.used * 100)]),
    [
      ["Claude Code · week", 10],
      ["Claude Code · 5h", 4],
    ],
  );
});

test("logins whose emails share a name show the whole email", () => {
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "ana@acme.test" };
  const b = { ...claude("default", at("2026-10-14T11:00:00Z"), 5, 10), email: "ana@example.test" };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([b]) }], [], NOW);
  assert.ok(s.limits.some((l) => l.label === "Claude Code · 5h · ana@example.test"));
});

test("a login whose windows have all reset doesn't make the others named", () => {
  const old = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "bo@acme.test" };
  old.limits = { primary: win(3, 300, -1), secondary: win(10, 10080, -2) };
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "ana@acme.test" };
  const s = summarizeUsage([{ box: "devl", report: report([a]) }, { box: "gpu", report: report([old]) }], [], NOW);
  assert.deepEqual(s.limits.map((l) => l.label).sort(), ["Claude Code · 5h", "Claude Code · week"]);
});

test("a model's week is named after the model; past and unreadable resets are left out", () => {
  const s = summarizeUsage(
    [
      { box: "devl", report: report([claude("default", at("2026-10-14T11:00:00Z"), 31, 64, win(32, 10080, 72, "Weekly limit (Fable)"), null)]) },
      { box: "gpu", report: report([{ agent: "codex", account: "default", at: at("2026-10-14T11:00:00Z"), limits: { primary: win(34, 300, -1), secondary: win(12, 10080, 90) } }]) },
    ],
    [],
    NOW,
  );
  assert.deepEqual(
    s.limits.map((l) => l.label),
    ["Claude Code · week", "Claude Code · week (Fable)", "Codex · week"],
  );
});

test("Claude and Codex default logins stay apart", () => {
  const codex: Limits = { agent: "codex", account: "default", at: at("2026-10-14T11:00:00Z"), limits: { primary: win(30, 300, 2), secondary: win(60, 10080, 72) } };
  const s = summarizeUsage([{ box: "devl", report: report([claude("default", at("2026-10-14T11:00:00Z"), 30, 60), codex]) }], [], NOW);
  assert.deepEqual(s.limits.map((l) => l.label).sort(), ["Claude Code · 5h", "Claude Code · week", "Codex · 5h", "Codex · week"]);
});

test("limits read before this week are left out", () => {
  const s = summarizeUsage([{ box: "devl", report: report([claude("default", at("2026-10-01T11:00:00Z"), 30, 60)]) }], [], NOW);
  assert.deepEqual(s.limits, []);
});

test("window names", () => {
  assert.equal(windowName(win(1, 300, 1)), "5h");
  assert.equal(windowName(win(1, 10080, 1)), "week");
  assert.equal(windowName(win(1, 1440, 1)), "day");
  assert.equal(windowName(win(1, 10080, 1, "Weekly limit (Fable)")), "week (Fable)");
});

// What the widget's limits say: each row's label and how much is used.
const rows = (reports: { box?: string; report: Report }[]) =>
  summarizeUsage(reports.map((r, i) => ({ box: r.box ?? `box${i}`, report: r.report })), [], NOW)
    .limits.map((l) => `${l.label} ${Math.round(l.used * 100)}`)
    .sort();

test("a login read on two boxes shows once, with each of its windows", () => {
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10, win(36, 10080, 50, "Weekly limit (Fable)")), email: "ana@acme.test" };
  const a2 = { ...claude("work", at("2026-10-14T11:30:00Z"), 4, 10), email: "ana@acme.test" };
  const b = { ...claude("default", at("2026-10-14T11:00:00Z"), 8, 0), email: "bo@acme.test" };
  const codex: Limits = { agent: "codex", account: "default", at: at("2026-10-14T11:00:00Z"), limits: { primary: win(30, 300, 2), secondary: win(60, 10080, 72) } };
  assert.deepEqual(rows([{ report: report([a, codex]) }, { report: report([a2, b]) }]), [
    "Claude Code · 5h · ana 4",
    "Claude Code · 5h · bo 8",
    "Claude Code · week (Fable) · ana 36",
    "Claude Code · week · ana 10",
    "Claude Code · week · bo 0",
    "Codex · 5h 30",
    "Codex · week 60",
  ]);
});

test("windows that have reset are left out, and a login with none left shows nothing", () => {
  const old = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "bo@acme.test" };
  old.limits = { primary: win(3, 300, -1), secondary: win(10, 10080, -2) };
  assert.deepEqual(rows([{ report: report([old]) }]), []);
});

test("one email signed in to two plans (a team seat and a personal Max) shows both, named by account", () => {
  // One row for the person, the team seat's numbers, and the personal
  // plan's 20% session gone: what merging by email alone gave.
  const team = { ...claude("ana-team", at("2026-10-14T11:00:00Z"), 0, 1, undefined, 4), email: "ana@acme.test", org: "org-team" };
  const max = { ...claude("ana-max", at("2026-10-14T11:00:00Z"), 20, 3, undefined, 2), email: "ana@acme.test", org: "org-max" };
  assert.deepEqual(rows([{ report: report([team, max]) }]), [
    "Claude Code · 5h · ana · ana-max 20",
    "Claude Code · 5h · ana · ana-team 0",
    "Claude Code · week · ana · ana-max 3",
    "Claude Code · week · ana · ana-team 1",
  ]);
});

test("one email in one organisation on two boxes is still one login", () => {
  const a = { ...claude("default", at("2026-10-14T11:00:00Z"), 3, 10), email: "ana@acme.test", org: "org-1" };
  const b = { ...claude("work", at("2026-10-14T11:30:00Z"), 4, 10), email: "ana@acme.test", org: "org-1" };
  assert.deepEqual(rows([{ report: report([a]) }, { report: report([b]) }]), ["Claude Code · 5h 4", "Claude Code · week 10"]);
});

test("a login Claude Code lost is named once, whose it was, however many boxes say so", () => {
  const out = { agent: "claude" as const, account: "ana-max", email: "ana@acme.test", org: "o1" };
  const a = { ...report([claude("default", at("2026-10-14T11:00:00Z"), 10, 20)]), signed_out: [out] };
  const b = { ...report([]), signed_out: [out, { agent: "claude" as const, account: "old", email: null, org: null }] };
  const s = summarizeUsage([{ box: "devl", report: a }, { box: "gpu", report: b }, { box: "older", report: report([]) }], [], NOW);
  assert.deepEqual(s.signedOut, ["ana-max (ana@acme.test)", "old"]);
  // It reads no limits: only the signed-in login's windows show.
  assert.deepEqual(s.limits.map((l) => l.label).sort(), ["Claude Code · 5h", "Claude Code · week"]);
});

test("a login whose session hasn't started still shows, unused", () => {
  // What a team seat nobody used lately printed: "Current session: 0% used", no reset time, no week.
  const idle: Limits = { agent: "claude", account: "default", at: at("2026-10-14T11:00:00Z"), email: "bo@acme.test", org: "o-b", limits: { primary: win(0, 300, null), secondary: null, extra: [] } };
  const busy: Limits = { agent: "claude", account: "default", at: at("2026-10-14T11:30:00Z"), email: "bo@acme.test", org: "o-b", limits: { primary: win(12, 300, 3), secondary: null, extra: [] } };
  assert.deepEqual(rows([{ report: report([idle]) }]), ["Claude Code · 5h 0"]);
  // Read again started elsewhere: one window, the newest.
  assert.deepEqual(rows([{ report: report([idle]) }, { report: report([busy]) }]), ["Claude Code · 5h 12"]);
  // A used window without a reset time is a broken read: left out.
  assert.deepEqual(rows([{ report: report([{ ...idle, limits: { primary: win(40, 300, null) } }]) }]), []);
});
