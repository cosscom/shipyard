// The sidebar's arrangement as data, and how it is read and saved: no app
// imports, so node's test runner loads it (nav-core.test.ts). lib/nav.ts
// wires it to the laptop agent and the app's store.

import { oneAtATime } from "./one-at-a-time.ts";

export type NavList = "pinned" | "more" | "hidden";

export interface NavLayout {
  // 2 since Home took the Agent Dashboard's place (see migrate).
  version?: number;
  pinned: string[];
  more: string[];
  hidden: string[];
  // Version 1 opened More in place in the sidebar. More is a menu now; the
  // field is kept as it was for older apps and otherwise ignored.
  moreOpen?: boolean;
}

export const DEFAULT_PINNED = ["home", "review", "worktrees", "automations"];
export const DEFAULT: NavLayout = { version: 2, pinned: DEFAULT_PINNED, more: [], hidden: [] };

// What a list reads as when the stored one isn't a list of names.
const names = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback);

// migrate brings a stored arrangement up to date. Version 1 had no Home: its
// first place was the Agent Dashboard, which Home now stands for (and opens,
// without Labs), so "dashboard" becomes "home" wherever the person put it.
// With Labs the dashboard is a place of its own again and, new to the
// arrangement, lands in More. Everything else the person arranged stays.
// Nothing stored (no file, or an empty one) is the default.
export function migrate(doc: unknown): NavLayout {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return DEFAULT;
  const d = doc as Partial<NavLayout>;
  let lists = { pinned: names(d.pinned, DEFAULT.pinned), more: names(d.more, []), hidden: names(d.hidden, []) };
  if ((d.version ?? 1) < 2) {
    const rename = (l: string[]) => l.map((id) => (id === "dashboard" ? "home" : id));
    lists = { pinned: rename(lists.pinned), more: rename(lists.more), hidden: rename(lists.hidden) };
  }
  return { ...d, ...lists, version: 2 };
}

// The order a place listed twice is taken in: its first list wins.
const ORDER: NavList[] = ["pinned", "hidden", "more"];

// arrange places the available ids into the three lists, in the stored
// order; ids the layout does not know yet go to More.
export function arrange(layout: NavLayout, ids: string[]): Record<NavList, string[]> {
  const have = new Set(ids);
  const seen = new Set<string>();
  const take = (list: string[]) =>
    list.filter((id) => {
      if (!have.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const pinned = take(layout.pinned);
  const hidden = take(layout.hidden);
  const more = take(layout.more);
  for (const id of ids) if (!seen.has(id)) more.push(id);
  return { pinned, more, hidden };
}

// keepAway is the arranged lists a change made, with the places that aren't
// available now (a plugin turned off, or not loaded yet) put back where they
// were stored, so a pinned plugin's place is still there when it returns.
function keepAway(l: NavLayout, a: Record<NavList, string[]>, ids: string[]): NavLayout {
  const have = new Set(ids);
  const seen = new Set<string>();
  const out = { pinned: [...a.pinned], more: [...a.more], hidden: [...a.hidden] };
  for (const k of ORDER) {
    l[k].forEach((id, i) => {
      if (have.has(id) || seen.has(id)) return;
      seen.add(id);
      out[k].splice(Math.min(i, out[k].length), 0, id);
    });
  }
  return { ...l, ...out };
}

// place puts id into list at index (the end when omitted). ids is every
// item available now, so items still unplaced keep their place in More.
export function place(l: NavLayout, id: string, list: NavList, index: number | undefined, ids: string[]): NavLayout {
  const a = arrange(l, ids);
  for (const k of Object.keys(a) as NavList[]) a[k] = a[k].filter((x) => x !== id);
  const i = index === undefined ? a[list].length : Math.max(0, Math.min(index, a[list].length));
  a[list].splice(i, 0, id);
  return keepAway(l, a, ids);
}

// move swaps id with its neighbour in its list.
export function move(l: NavLayout, id: string, dir: -1 | 1, ids: string[]): NavLayout {
  const a = arrange(l, ids);
  const k = ORDER.find((k) => a[k].includes(id));
  if (!k) return l;
  const i = a[k].indexOf(id);
  const j = i + dir;
  if (j >= 0 && j < a[k].length) [a[k][i], a[k][j]] = [a[k][j], a[k][i]];
  return keepAway(l, a, ids);
}

export interface NavState {
  layout: NavLayout;
  // The stored arrangement has been read. Until then the default shows and
  // nothing is saved: a save would write the default over it.
  loaded: boolean;
  error?: string;
}

export interface NavIO {
  get(): Promise<unknown>;
  put(layout: NavLayout): Promise<unknown>;
  describe(err: unknown): string;
}

// navSync reads the stored arrangement, and saves changes only once it has
// it. lib/nav.ts tries load again (lib/poll) until it returns true.
export function navSync(io: NavIO, st: { get(): NavState; set(p: Partial<NavState>): void }) {
  // Saves run in turn, each on the layout the last one left: a failed
  // write puts back only what it changed, never over a later one's.
  const inTurn = oneAtATime();
  return {
    async load(): Promise<boolean> {
      if (st.get().loaded) return true;
      try {
        st.set({ layout: migrate(await io.get()), loaded: true, error: undefined });
        return true;
      } catch (err) {
        st.set({ error: io.describe(err) });
        return false;
      }
    },
    // save applies fn and stores the result, after any save still under
    // way. Refused (false) before the stored arrangement is read; a failed
    // write puts the old one back.
    save: (fn: (l: NavLayout) => NavLayout): Promise<boolean> =>
      inTurn(async () => {
        const s = st.get();
        if (!s.loaded) return false;
        const before = s.layout;
        const next = fn(structuredClone(before));
        st.set({ layout: next });
        try {
          await io.put(next);
          return true;
        } catch (err) {
          st.set({ layout: before, error: io.describe(err) });
          return false;
        }
      }),
  };
}
