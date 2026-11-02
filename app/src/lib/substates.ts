import type { Client, Session } from "@/lib/api";

// Sub-states of Needs you (see internal/box/substates.go): an optional set of
// columns that replace Needs you on the board, each with a description turn
// check places a waiting agent by. agent_state stays "waiting" whatever the
// sub-state, and with no set the board is as it always was. Everything else
// that says Needs you keeps saying it.

export interface SubState {
  id: string;
  name: string;
  description: string;
  parent?: string;
}

export interface SubStateSet {
  states: SubState[];
  // Which edit this is: the newest wins across boxes.
  revision?: number;
  stamp?: string;
  // Who changed what last.
  changed_by?: string;
  change?: string;
  changed_at?: string;
}

export const SUB_STATE_MAX = 6;
export const SUB_STATE_NAME_MAX = 40;
export const SUB_STATE_DESCRIPTION_MAX = 300;
export const SUB_STATES_CAPABILITY = "substates";

export const subStatesApi = {
  get: (c: Client, box: string) => c.box<SubStateSet>(box, "GET", "substates"),
  // An edit: the box stamps it.
  edit: (c: Client, box: string, states: SubState[]) => c.box<SubStateSet>(box, "PUT", "substates", { states }),
  // A stamped set from another box: kept only if it is newer.
  spread: (c: Client, box: string, set: SubStateSet) => c.box<SubStateSet>(box, "PUT", "substates", set),
  preset: (c: Client, box: string) => c.box<SubStateSet>(box, "POST", "substates/preset", {}),
};

// isNewer says whether a is a later edit than b, the same way a box does:
// by revision, and by stamp for two in the same millisecond. It is a total
// order, so every laptop picks the same set, and none can flip a box back.
export function isNewer(a: SubStateSet, b: SubStateSet): boolean {
  const [ar, br] = [a.revision ?? 0, b.revision ?? 0];
  if (ar !== br) return ar > br;
  return (a.stamp ?? "") > (b.stamp ?? "");
}

// newestSet is the latest edit among what boxes hold, whichever box made it,
// or undefined when none has ever had one.
export function newestSet(sets: Iterable<SubStateSet | undefined>): SubStateSet | undefined {
  let best: SubStateSet | undefined;
  for (const s of sets) {
    if (!s?.revision) continue;
    if (!best || isNewer(s, best)) best = s;
  }
  return best;
}

// boxesBehind are the boxes to spread newest to, among those read.
export function boxesBehind(sets: Record<string, SubStateSet>, newest: SubStateSet): string[] {
  return Object.entries(sets)
    .filter(([, s]) => isNewer(newest, s))
    .map(([box]) => box);
}

// A box's read: which edit was last read ("revision:stamp", as editKey makes
// it), whether one is on its way, and when a failed one may try again.
export interface ReadState {
  edit?: string;
  reading?: boolean;
  retryAt?: number;
}

export const editKey = (revision?: number, stamp?: string) => `${revision ?? 0}:${stamp ?? ""}`;

// readDue says whether to read a box now that it says it holds edit.
export function readDue(st: ReadState | undefined, edit: string, now: number): boolean {
  if (st?.reading || (st?.retryAt ?? 0) > now) return false;
  return st?.edit !== edit;
}

export interface Placement {
  // The sub-state's ID: the one it says, else the default.
  column: string;
  // It couldn't be placed: no answer, or an ID not in the set (just removed,
  // or not synced yet). It never drops off the board.
  unsorted: boolean;
}

// placeSession is the column a waiting session goes in, given a set with at
// least one sub-state.
export function placeSession(session: Pick<Session, "agent_sub_state">, states: SubState[]): Placement {
  const id = session.agent_sub_state;
  if (id && states.some((s) => s.id === id)) return { column: id, unsorted: false };
  return { column: states[0].id, unsorted: true };
}
