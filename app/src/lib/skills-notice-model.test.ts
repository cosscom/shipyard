// node --experimental-strip-types --test src/lib/skills-notice-model.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SkillAgent, SkillsReport, SkillState } from "./skills.ts";
import {
  actionLabel,
  neverRemind,
  nextWake,
  NO_PREFS,
  normalizePrefs,
  noticeDetail,
  noticeFor,
  noticeShort,
  noticeText,
  shown,
  snoozedUntil,
  snoozeUntil,
  untilText,
  withNever,
  withoutSnooze,
  withSnooze,
} from "./skills-notice-model.ts";

const NAMES = ["berth", "berth-artifacts", "berth-browser", "berth-hooks", "berth-orchestrate", "berth-preview", "berth-visual-diff"];

// report builds a box's answer: every skill in the state given per agent,
// except the ones named in `over`.
function report(all: Record<SkillAgent, SkillState>, over: Record<string, Partial<Record<SkillAgent, SkillState>>> = {}): SkillsReport {
  return {
    agents: ["claude", "codex"],
    user_dirs: { claude: "/home/me/.claude/skills", codex: "/home/me/.agents/skills" },
    skills: NAMES.map((name) => ({ name, description: "", version: "abc", user: { ...all, ...over[name] } })),
  };
}

const online = { name: "devl", state: "online" };
const both = ["claude", "codex", "shell"];
const current = report({ claude: "installed", codex: "installed" });
const none = report({ claude: "missing", codex: "missing" });

test("a box whose skills are all installed and current gets no notice", () => {
  assert.equal(noticeFor(online, both, current), undefined);
});

test("only an online box gets a notice: not one that is offline or still connecting", () => {
  assert.equal(noticeFor({ name: "devl", state: "offline" }, both, none), undefined);
  assert.equal(noticeFor({ name: "devl", state: "connecting" }, both, none), undefined);
  assert.equal(noticeFor({ name: "devl", state: "untrusted" }, both, none), undefined);
  assert.ok(noticeFor(online, both, none));
});

test("no notice before the box has said which agents it has, or where its skills are", () => {
  assert.equal(noticeFor(online, undefined, none), undefined);
  assert.equal(noticeFor(online, both, undefined), undefined);
});

test("a box with neither Claude Code nor Codex gets no notice, whatever its skills", () => {
  assert.equal(noticeFor(online, [], none), undefined);
  assert.equal(noticeFor(online, ["gemini", "opencode", "shell"], none), undefined);
});

test("skills an absent agent lacks don't count", () => {
  // Codex isn't on the box: its missing copies are nobody's.
  const r = report({ claude: "installed", codex: "missing" });
  assert.equal(noticeFor(online, ["claude"], r), undefined);
  const n = noticeFor(online, both, r)!;
  assert.deepEqual([n.kind, n.agents, n.without, n.missing], ["missing", ["claude", "codex"], ["codex"], 7]);
  assert.equal(noticeText(n), "Shipyard's skills aren't installed for Codex");
});

test("nothing installed says which agents have none", () => {
  const n = noticeFor(online, both, none)!;
  assert.equal(n.kind, "missing");
  assert.equal(noticeText(n), "Shipyard's skills aren't installed for Claude Code or Codex");
  assert.equal(actionLabel(n), "Install now");
  const one = noticeFor(online, ["claude"], none)!;
  assert.deepEqual(one.agents, ["claude"]);
  assert.equal(noticeText(one), "Shipyard's skills aren't installed for Claude Code");
});

test("older copies are out of date, counted once per skill", () => {
  const r = report({ claude: "installed", codex: "installed" }, { berth: { claude: "outdated", codex: "outdated" }, "berth-hooks": { claude: "outdated" }, "berth-preview": { codex: "outdated" } });
  const n = noticeFor(online, both, r)!;
  assert.deepEqual([n.kind, n.outdated, n.missing, n.without], ["outdated", 3, 0, []]);
  assert.equal(noticeText(n), "3 skills are out of date");
  assert.equal(actionLabel(n), "Update now");
  const single = noticeFor(online, both, report({ claude: "installed", codex: "installed" }, { berth: { claude: "outdated" } }))!;
  assert.equal(noticeText(single), "1 skill is out of date");
});

test("after an upgrade, a skill that is new counts beside the ones that are older", () => {
  const r = report({ claude: "outdated", codex: "outdated" }, { "berth-visual-diff": { claude: "missing", codex: "missing" } });
  const n = noticeFor(online, both, r)!;
  assert.deepEqual([n.kind, n.outdated, n.missing], ["outdated", 6, 1]);
  assert.equal(noticeText(n), "6 skills are out of date");
  assert.equal(noticeDetail(n), "Updates all of Shipyard's skills for devl's user, for Claude Code and Codex. 1 skill isn't installed yet.");
});

test("the button's tooltip says what it does, for the agents the box has", () => {
  assert.equal(noticeDetail(noticeFor(online, ["claude"], none)!), "Installs all of Shipyard's skills for devl's user, for Claude Code.");
  const older = report({ claude: "installed", codex: "installed" }, { berth: { claude: "outdated" } });
  assert.equal(noticeDetail(noticeFor(online, both, older)!), "Updates all of Shipyard's skills for devl's user, for Claude Code and Codex.");
});

test("some skills never installed, none older, is not installed", () => {
  const r = report({ claude: "installed", codex: "installed" }, { "berth-hooks": { claude: "missing" }, "berth-browser": { codex: "missing" } });
  const n = noticeFor(online, both, r)!;
  assert.deepEqual([n.kind, n.missing, n.without], ["missing", 2, []]);
  assert.equal(noticeText(n), "2 skills aren't installed");
  assert.equal(noticeText(noticeFor(online, both, report({ claude: "installed", codex: "installed" }, { berth: { codex: "missing" } }))!), "1 skill isn't installed");
});

test("an agent with none comes before another's older copies", () => {
  const r = report({ claude: "outdated", codex: "missing" });
  const n = noticeFor(online, both, r)!;
  assert.deepEqual([n.kind, n.missing, n.outdated], ["missing", 7, 7]);
  assert.equal(noticeText(n), "Shipyard's skills aren't installed for Codex");
  assert.equal(noticeDetail(n), "Installs all of Shipyard's skills for devl's user, for Claude Code and Codex. 7 skills are out of date, too.");
});

test("the sidebar's one line names the box and what is wrong, short enough to show whole", () => {
  assert.equal(noticeShort(noticeFor(online, both, none)!), "Skills missing on devl");
  const older = noticeFor(online, both, report({ claude: "installed", codex: "installed" }, { berth: { claude: "outdated" } }))!;
  assert.equal(noticeShort(older), "Skills out of date on devl");
  assert.equal(noticeShort(noticeFor(online, both, none)!, true), "Couldn't install skills on devl");
  assert.equal(noticeShort(older, true), "Couldn't update skills on devl");
});

test("copies inside a project never count", () => {
  const r = report({ claude: "installed", codex: "installed" });
  for (const s of r.skills) s.project = { claude: "missing", codex: "outdated" };
  assert.equal(noticeFor(online, both, r), undefined);
});

// ---- Snoozes ---------------------------------------------------------------

// A Monday afternoon, by this computer's clock.
const now = new Date(2026, 9, 12, 15, 30, 0);
const t = now.getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("until tomorrow ends the next morning at nine, however late it is now", () => {
  assert.deepEqual(snoozeUntil("tomorrow", now), new Date(2026, 9, 13, 9, 0, 0));
  assert.deepEqual(snoozeUntil("tomorrow", new Date(2026, 9, 12, 23, 59, 30)), new Date(2026, 9, 13, 9, 0, 0));
  // In the small hours, tomorrow is still the day after this one.
  assert.deepEqual(snoozeUntil("tomorrow", new Date(2026, 9, 12, 1, 0, 0)), new Date(2026, 9, 13, 9, 0, 0));
  // Over the end of a month.
  assert.deepEqual(snoozeUntil("tomorrow", new Date(2026, 9, 31, 18, 0, 0)), new Date(2026, 10, 1, 9, 0, 0));
});

test("a week and a month end at the same time of day", () => {
  assert.deepEqual(snoozeUntil("week", now), new Date(2026, 9, 19, 15, 30, 0));
  assert.deepEqual(snoozeUntil("month", now), new Date(2026, 10, 11, 15, 30, 0));
});

test("a snooze hides the notice until its time, then it shows again", () => {
  const until = snoozeUntil("tomorrow", now);
  const prefs = withSnooze(NO_PREFS, "gpu", "outdated", until, t);
  const n = { box: "gpu", kind: "outdated" as const };
  assert.equal(shown(NO_PREFS, n, t), true);
  assert.equal(shown(prefs, n, t), false);
  assert.equal(shown(prefs, n, until.getTime() - 1), false);
  assert.equal(shown(prefs, n, until.getTime()), true);
  assert.equal(shown(prefs, n, until.getTime() + DAY), true);
  assert.equal(snoozedUntil(prefs, "gpu", "outdated", t), until.getTime());
  assert.equal(snoozedUntil(prefs, "gpu", "outdated", until.getTime()), undefined);
});

test("a snooze is for one box", () => {
  const prefs = withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("week", now), t);
  assert.equal(shown(prefs, { box: "devl", kind: "outdated" }, t), true);
  assert.equal(shown(prefs, { box: "gpu", kind: "outdated" }, t), false);
});

test("a snooze is for the state it was made in", () => {
  // Snoozed as out of date; the box then has none (its skills were removed).
  const prefs = withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("week", now), t);
  assert.equal(shown(prefs, { box: "gpu", kind: "missing" }, t + HOUR), true);
  assert.equal(shown(prefs, { box: "gpu", kind: "outdated" }, t + HOUR), false);
});

test("out of date again after the next upgrade reminds once the snooze has passed", () => {
  const until = snoozeUntil("week", now);
  const prefs = withSnooze(NO_PREFS, "gpu", "outdated", until, t);
  const n = { box: "gpu", kind: "outdated" as const };
  // Updated on day two (no notice to show), upgraded on day three: still
  // inside the week, so still quiet.
  assert.equal(shown(prefs, n, t + 3 * DAY), false);
  // Upgraded again a fortnight on: nothing holds it back.
  assert.equal(shown(prefs, n, t + 14 * DAY), true);
});

test("a later snooze replaces the earlier one, and passed ones are dropped", () => {
  let prefs = withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("tomorrow", now), t);
  prefs = withSnooze(prefs, "devl", "missing", snoozeUntil("week", now), t);
  prefs = withSnooze(prefs, "gpu", "missing", snoozeUntil("month", now), t + 2 * DAY);
  assert.deepEqual(prefs.snoozed, {
    devl: { kind: "missing", until: snoozeUntil("week", now).toISOString() },
    gpu: { kind: "missing", until: snoozeUntil("month", now).toISOString() },
  });
  // devl's week is over by the time gpu's is undone.
  assert.deepEqual(withoutSnooze(prefs, "gpu", t + 8 * DAY).snoozed, {});
});

test("don't remind me holds for every state, until it is turned back on", () => {
  const prefs = withNever(withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("tomorrow", now), t), "gpu", true, t);
  assert.deepEqual(prefs, { snoozed: {}, never: ["gpu"] });
  assert.equal(neverRemind(prefs, "gpu"), true);
  for (const kind of ["missing", "outdated"] as const) assert.equal(shown(prefs, { box: "gpu", kind }, t + 400 * DAY), false);
  assert.equal(shown(prefs, { box: "devl", kind: "missing" }, t), true);
  // Twice is once.
  assert.deepEqual(withNever(prefs, "gpu", true, t).never, ["gpu"]);
  const back = withNever(prefs, "gpu", false, t);
  assert.deepEqual(back, NO_PREFS);
  assert.equal(shown(back, { box: "gpu", kind: "outdated" }, t), true);
});

test("turning a reminder back on ends its snooze too", () => {
  const prefs = withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("month", now), t);
  assert.equal(shown(withNever(prefs, "gpu", false, t), { box: "gpu", kind: "outdated" }, t), true);
});

test("the next look is when the soonest snooze ends", () => {
  assert.equal(nextWake(NO_PREFS, t), undefined);
  let prefs = withSnooze(NO_PREFS, "gpu", "outdated", snoozeUntil("week", now), t);
  prefs = withSnooze(prefs, "devl", "missing", snoozeUntil("tomorrow", now), t);
  assert.equal(nextWake(prefs, t), snoozeUntil("tomorrow", now).getTime());
  assert.equal(nextWake(prefs, t + 2 * DAY), snoozeUntil("week", now).getTime());
  assert.equal(nextWake(prefs, t + 8 * DAY), undefined);
});

test("a stored document is read whatever shape it has", () => {
  assert.deepEqual(normalizePrefs(null), NO_PREFS);
  assert.deepEqual(normalizePrefs({}), NO_PREFS);
  const until = snoozeUntil("week", now).toISOString();
  const doc = { snoozed: { gpu: { kind: "outdated", until }, bad: { kind: "later", until }, worse: { kind: "missing", until: "soon" }, gone: null }, never: ["devl", 3] };
  assert.deepEqual(normalizePrefs(doc as never), { snoozed: { gpu: { kind: "outdated", until } }, never: ["devl"] });
});

test("Settings says when a snooze ends in plain words", () => {
  const at = (d: Date) => untilText(d.getTime(), t, "en-GB");
  assert.equal(at(new Date(2026, 9, 12, 18, 0)), "18:00 today");
  assert.equal(at(snoozeUntil("tomorrow", now)), "tomorrow at 9:00");
  assert.equal(at(new Date(2026, 9, 15, 15, 30)), "Thursday at 15:30");
  assert.equal(at(snoozeUntil("week", now)), "19 October");
  assert.equal(at(snoozeUntil("month", now)), "11 November");
});
