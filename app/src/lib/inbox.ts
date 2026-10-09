import type { Session } from "@/lib/api";
import type { SessionState } from "@/lib/derive";

// The inbox (Labs › Layout › Inbox): every agent on every box as one list,
// by what it needs from you. Needs you on top, then Working, then Recent
// (done and idle agents, newest first). Marking a row done ("e") puts it
// away until its agent's state changes, so an agent that asks again comes
// back on its own, as a reply brings a thread back in a mail inbox.
//
// This file is the list's model with no React in it (lib/inbox.test.ts);
// components/inbox draws it.

export type InboxSection = "needs" | "working" | "recent";
export const SECTIONS: InboxSection[] = ["needs", "working", "recent"];
export const SECTION_WORDS: Record<InboxSection, string> = { needs: "Needs you", working: "Working", recent: "Recent" };

// sectionOf is where a session's state puts it; nothing for a plain shell
// or an agent whose program ended.
export function sectionOf(state: SessionState): InboxSection | undefined {
  if (state === "waiting") return "needs";
  if (state === "running") return "working";
  if (state === "finished" || state === "ready") return "recent";
  return undefined;
}

export interface InboxItem {
  // box/session
  id: string;
  box: string;
  session: Session;
  state: SessionState;
  section: InboxSection;
  agent: string;
  // What the work is called, else its worktree.
  title: string;
  project: string;
  // The worktree's display name; empty for a project's main checkout.
  worktree: string;
  location: string;
  path: string;
  main: boolean;
  // When its state last changed.
  since: string;
  // Its project lives on more than one box, so which box is worth saying.
  boxMatters: boolean;
}

// Done is what was marked done: a row's id and the state_since it had then.
export type Done = Record<string, string>;

export const doneMark = (it: Pick<InboxItem, "since">) => it.since;
export const isDone = (done: Done, it: Pick<InboxItem, "id" | "since">) => done[it.id] !== undefined && done[it.id] === doneMark(it);

// markDone and undone return a new Done; prune drops marks for rows that
// moved on, so the record never grows.
export function markDone(done: Done, it: Pick<InboxItem, "id" | "since">): Done {
  return { ...done, [it.id]: doneMark(it) };
}
export function undone(done: Done, id: string): Done {
  const { [id]: _gone, ...rest } = done;
  return rest;
}
export function prune(done: Done, items: Pick<InboxItem, "id" | "since">[]): Done {
  const live = new Map(items.map((i) => [i.id, i.since]));
  const out: Done = {};
  for (const [id, at] of Object.entries(done)) if (live.get(id) === at) out[id] = at;
  return out;
}

export interface InboxFilter {
  // Boxes left out; a new box shows up on its own.
  hiddenBoxes: string[];
  // One project, or all of them.
  project?: string;
}

export const NO_FILTER: InboxFilter = { hiddenBoxes: [] };

export function filterOn(f: InboxFilter): boolean {
  return f.hiddenBoxes.length > 0 || !!f.project;
}

// Hold is where each row was while the person points at or types in the
// list: rows keep those places until they leave it, so nothing jumps from
// under the cursor. A row new since then goes at the end of its section.
export type Hold = Map<string, { section: InboxSection; index: number }>;

export function holdOf(order: Pick<InboxItem, "id" | "section">[]): Hold {
  return new Map(order.map((it, index) => [it.id, { section: it.section, index }]));
}

// arrange sorts, filters and splits the rows into sections. Needs you is
// oldest first (whoever has waited longest is on top), Working and Recent
// newest first. Inside a tie, by place, so a row only moves when its agent
// changes state.
export function arrange(items: InboxItem[], opts: { done: Done; filter: InboxFilter; showDone?: boolean; hold?: Hold }): { sections: { section: InboxSection; items: InboxItem[] }[]; hidden: number; order: InboxItem[] } {
  const { done, filter } = opts;
  let hidden = 0;
  const kept = items.filter((it) => {
    if (filter.hiddenBoxes.includes(it.box)) return false;
    if (filter.project && it.project !== filter.project) return false;
    if (isDone(done, it)) {
      hidden++;
      return !!opts.showDone;
    }
    return true;
  });
  const place = (a: InboxItem, b: InboxItem) => a.project.localeCompare(b.project) || a.worktree.localeCompare(b.worktree) || a.box.localeCompare(b.box) || a.session.name.localeCompare(b.session.name);
  const hold = opts.hold;
  const sectionOfIt = (it: InboxItem) => hold?.get(it.id)?.section ?? it.section;
  const sections = SECTIONS.map((section) => {
    const list = kept.filter((it) => sectionOfIt(it) === section);
    const natural = (a: InboxItem, b: InboxItem) => (section === "needs" ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since)) || place(a, b);
    list.sort((a, b) => {
      const ha = hold?.get(a.id);
      const hb = hold?.get(b.id);
      if (ha && hb) return ha.index - hb.index;
      // A new row goes after the held ones, so none of them moves.
      if (ha || hb) return ha ? -1 : 1;
      return natural(a, b);
    });
    return { section, items: list };
  }).filter((s) => s.items.length);
  return { sections, hidden, order: sections.flatMap((s) => s.items) };
}

// step moves the cursor by delta through order, staying at the ends; with
// no cursor (or one whose row went away) it starts at the top.
export function step(order: Pick<InboxItem, "id">[], cursor: string | undefined, delta: number): string | undefined {
  if (!order.length) return undefined;
  const i = order.findIndex((it) => it.id === cursor);
  if (i < 0) return order[0].id;
  return order[Math.max(0, Math.min(order.length - 1, i + delta))].id;
}

// afterDone is where the cursor goes once the row under it is put away: the
// next row, else the one before, as a mail client does.
export function afterDone(order: Pick<InboxItem, "id">[], id: string): string | undefined {
  const i = order.findIndex((it) => it.id === id);
  if (i < 0) return order[0]?.id;
  return order[i + 1]?.id ?? order[i - 1]?.id;
}
