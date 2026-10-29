// The sidebar's word that a box's Shipyard skills aren't installed or are out
// of date (lib/skills-notice.ts, components/sidebar/skills-notice.tsx): which
// boxes get one, what it says, and when a snooze holds. Kept apart so it
// tests without the app.

import type { SkillAgent, SkillsReport } from "./skills.ts";

// What a notice is about. "missing": an agent on the box has none of the
// skills, or some were never installed. "outdated": what is installed is
// older than this box's berthd ships, as after an upgrade.
export type NoticeKind = "missing" | "outdated";

export interface SkillsNotice {
  box: string;
  kind: NoticeKind;
  // The box's agents the skills are for: Claude Code, Codex or both.
  agents: SkillAgent[];
  // Of those, the ones with none of Shipyard's skills.
  without: SkillAgent[];
  // How many skills are not installed for one of the agents, and how many
  // are installed but older for one. A skill can be both: absent for Codex,
  // older for Claude Code.
  missing: number;
  outdated: number;
}

export const AGENT_NAMES: Record<SkillAgent, string> = { claude: "Claude Code", codex: "Codex" };

// noticeFor is the rule. A box gets a notice when it is online, has an agent
// the skills are for (Claude Code or Codex among the agents it can start),
// and its user's copy of any skill is missing or outdated for such an agent.
// Nothing for a box that is offline or still connecting, one whose agents
// aren't known yet, one with neither agent, or one that hasn't said where
// its skills are. Copies inside a project are that project's settings' own.
export function noticeFor(box: { name: string; state: string }, agents: string[] | undefined, report: SkillsReport | undefined): SkillsNotice | undefined {
  if (box.state !== "online" || !agents || !report) return undefined;
  const present = report.agents.filter((a) => agents.includes(a));
  if (!present.length || !report.skills.length) return undefined;
  let missing = 0;
  let outdated = 0;
  const installed = new Map<SkillAgent, number>(present.map((a) => [a, 0]));
  for (const s of report.skills) {
    const states = present.map((a) => s.user?.[a]);
    if (states.includes("missing")) missing++;
    if (states.includes("outdated")) outdated++;
    present.forEach((a, i) => states[i] && states[i] !== "missing" && installed.set(a, installed.get(a)! + 1));
  }
  if (!missing && !outdated) return undefined;
  const without = present.filter((a) => installed.get(a) === 0);
  // Out of date is the state only when every agent has its skills and
  // nothing is plainly absent: an agent with none says so first.
  const kind: NoticeKind = without.length || !outdated ? "missing" : "outdated";
  return { box: box.name, kind, agents: present, without, missing, outdated };
}

const names = (agents: SkillAgent[]) => agents.map((a) => AGENT_NAMES[a]).join(" or ");
const skills = (n: number) => (n === 1 ? "1 skill" : `${n} skills`);

// noticeText is what the notice says after the box's name: "Shipyard's
// skills aren't installed for Claude Code", "3 skills are out of date".
export function noticeText(n: SkillsNotice): string {
  if (n.without.length) return `Shipyard's skills aren't installed for ${names(n.without)}`;
  if (n.kind === "outdated") return `${skills(n.outdated)} ${n.outdated === 1 ? "is" : "are"} out of date`;
  return `${skills(n.missing)} ${n.missing === 1 ? "isn't" : "aren't"} installed`;
}

// noticeShort is the notice as the open sidebar's one line has room for it,
// whole at its narrowest: "Skills missing on devl", "Skills out of date on
// gpu", or after an install that didn't go through, "Couldn't install
// skills on devl". Its tip says the rest (noticeText).
export function noticeShort(n: Pick<SkillsNotice, "box" | "kind">, failed = false): string {
  if (failed) return `Couldn't ${n.kind === "outdated" ? "update" : "install"} skills on ${n.box}`;
  return n.kind === "outdated" ? `Skills out of date on ${n.box}` : `Skills missing on ${n.box}`;
}

// noticeDetail is the button's tooltip: what Install now does, and what
// else it brings that the notice's one line left out.
export function noticeDetail(n: SkillsNotice): string {
  const base = `${n.kind === "outdated" ? "Updates" : "Installs"} all of Shipyard's skills for ${n.box}'s user, for ${n.agents.map((a) => AGENT_NAMES[a]).join(" and ")}.`;
  if (n.kind === "outdated" && n.missing) return `${base} ${skills(n.missing)} ${n.missing === 1 ? "isn't" : "aren't"} installed yet.`;
  if (n.kind === "missing" && n.outdated) return `${base} ${skills(n.outdated)} ${n.outdated === 1 ? "is" : "are"} out of date, too.`;
  return base;
}

// actionLabel is the button: skills that are only older are updated.
export const actionLabel = (n: Pick<SkillsNotice, "kind">) => (n.kind === "outdated" ? "Update now" : "Install now");

// ---- Snoozes ---------------------------------------------------------------

// What the person chose, kept on the laptop agent (/v1/app/skills-notice).
export interface SkillsNoticePrefs {
  // By box: quiet about that state until a time. A snooze made while skills
  // were out of date says nothing of a box that later has none, and once
  // its time has passed the box reminds again, as after the next upgrade.
  snoozed: Record<string, { kind: NoticeKind; until: string }>;
  // Boxes never to remind about, until the person turns it back on.
  never: string[];
}

export const NO_PREFS: SkillsNoticePrefs = { snoozed: {}, never: [] };

// normalizePrefs reads a stored document, whatever shape an older or newer
// Shipyard left it in.
export function normalizePrefs(doc: Partial<SkillsNoticePrefs> | null | undefined): SkillsNoticePrefs {
  const snoozed: SkillsNoticePrefs["snoozed"] = {};
  for (const [box, s] of Object.entries(doc?.snoozed ?? {})) {
    if (s && (s.kind === "missing" || s.kind === "outdated") && typeof s.until === "string" && !Number.isNaN(Date.parse(s.until))) snoozed[box] = { kind: s.kind, until: s.until };
  }
  return { snoozed, never: Array.isArray(doc?.never) ? doc.never.filter((b): b is string => typeof b === "string") : [] };
}

export type SnoozeChoice = "tomorrow" | "week" | "month";

export const SNOOZE_CHOICES: { id: SnoozeChoice; label: string }[] = [
  { id: "tomorrow", label: "Until tomorrow" },
  { id: "week", label: "For a week" },
  { id: "month", label: "For a month" },
];

// The hour "tomorrow" starts at: the morning, not midnight.
const MORNING = 9;

// snoozeUntil is when a snooze made now ends. Tomorrow is the next day's
// morning by this computer's clock; a week and a month count days, so they
// end at the same time of day whatever the clocks did in between.
export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  const d = new Date(now);
  if (choice === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(MORNING, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() + (choice === "week" ? 7 : 30));
  return d;
}

// snoozedUntil is the end of the snooze that holds for a box in this state
// now, if one does.
export function snoozedUntil(prefs: SkillsNoticePrefs, box: string, kind: NoticeKind, now: number): number | undefined {
  const s = prefs.snoozed[box];
  if (!s || s.kind !== kind) return undefined;
  const until = Date.parse(s.until);
  return until > now ? until : undefined;
}

export const neverRemind = (prefs: SkillsNoticePrefs, box: string) => prefs.never.includes(box);

// shown says whether a box's notice shows now.
export function shown(prefs: SkillsNoticePrefs, n: Pick<SkillsNotice, "box" | "kind">, now: number): boolean {
  return !neverRemind(prefs, n.box) && snoozedUntil(prefs, n.box, n.kind, now) === undefined;
}

// nextWake is when the soonest snooze still holding ends, so whoever shows
// the notices looks again then.
export function nextWake(prefs: SkillsNoticePrefs, now: number): number | undefined {
  const ends = Object.values(prefs.snoozed)
    .map((s) => Date.parse(s.until))
    .filter((t) => t > now);
  return ends.length ? Math.min(...ends) : undefined;
}

// withSnooze, withoutSnooze and withNever are the prefs after a choice.
// Snoozes whose time has passed are dropped as the document is rewritten.
function live(prefs: SkillsNoticePrefs, now: number): SkillsNoticePrefs["snoozed"] {
  return Object.fromEntries(Object.entries(prefs.snoozed).filter(([, s]) => Date.parse(s.until) > now));
}

export function withSnooze(prefs: SkillsNoticePrefs, box: string, kind: NoticeKind, until: Date, now: number): SkillsNoticePrefs {
  return { never: prefs.never, snoozed: { ...live(prefs, now), [box]: { kind, until: until.toISOString() } } };
}

export function withoutSnooze(prefs: SkillsNoticePrefs, box: string, now: number): SkillsNoticePrefs {
  const { [box]: _gone, ...rest } = live(prefs, now);
  return { never: prefs.never, snoozed: rest };
}

// withNever turns a box's reminder off for good, or back on. Either way its
// snooze goes: off needs none, and on means now.
export function withNever(prefs: SkillsNoticePrefs, box: string, never: boolean, now: number): SkillsNoticePrefs {
  const rest = withoutSnooze(prefs, box, now);
  const others = prefs.never.filter((b) => b !== box);
  return { snoozed: rest.snoozed, never: never ? [...others, box] : others };
}

// untilText says when a snooze ends, for Settings: "tomorrow at 9:00",
// "Tuesday at 14:30", "12 November".
export function untilText(until: number, now: number, locale?: string): string {
  const d = new Date(until);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `${time} today`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${d.toLocaleDateString(locale, { weekday: "long" })} at ${time}`;
  return d.toLocaleDateString(locale, { day: "numeric", month: "long" });
}
