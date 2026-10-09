import { create } from "zustand";

import { toastManager } from "@/components/ui/toast";
import type { Session } from "@/lib/api";
import { agentOf, sessionState } from "@/lib/derive";
import { usePrefs } from "@/lib/prefs";
import { useStore, type View } from "@/lib/store";
import { focusedPane, focusSession, goHome, homeBox, refFor, selectWorktree, useWorkspaces } from "@/lib/workspaces";
import { findLeaf } from "@/lib/layout";

// The command layout (Labs › Layout › Command): no sidebar, the worktree
// fills the window, and getting around is a keystroke. This is what its keys
// do: pinned worktrees (⌘1–9), back and forward (⌘[ ⌘]), and the next agent
// that needs you (⌘E). components/command draws the header and the hints.

export const commandLayoutOn = () => {
  const p = usePrefs.getState();
  return p.labs && p.layout === "command" && !p.zen;
};
export const useCommandLayout = () => usePrefs((p) => p.labs && p.layout === "command" && !p.zen);

// The keys below go somewhere: the switcher, if open, gets out of the way.
const closeSwitcher = () => useStore.getState().paletteOpen && useStore.getState().setPaletteOpen(false);

// The command line's middle, where a view's own header goes (views/
// view-header.tsx), so a view doesn't stack a second bar under it.
export const useViewSlot = create<{ el: HTMLElement | null }>()(() => ({ el: null }));
export const setViewSlot = (el: HTMLElement | null) => useViewSlot.getState().el !== el && useViewSlot.setState({ el });

// usedKey counts a use of a key; known says it's been used enough that its
// keycap can leave the top line.
export function usedKey(id: string) {
  usePrefs.setState((p) => ({ commandKeyUses: { ...p.commandKeyUses, [id]: (p.commandKeyUses[id] ?? 0) + 1 } }));
}
export const useKnown = (id: string) => usePrefs((p) => (p.commandKeyUses[id] ?? 0) >= 3);

// ---- Pins -------------------------------------------------------------------

export const MAX_PINS = 9;

export function isPinned(key: string) {
  return usePrefs.getState().pins.includes(key);
}

// togglePin pins a worktree to the next free number, or unpins it.
export function togglePin(key: string): boolean {
  const pins = usePrefs.getState().pins;
  if (pins.includes(key)) {
    usePrefs.setState({ pins: pins.filter((k) => k !== key) });
    return false;
  }
  if (pins.length >= MAX_PINS) {
    toastManager.add({ title: "Nine worktrees are pinned", description: "Unpin one first: ⌘↵ on it in the switcher." });
    return false;
  }
  usePrefs.setState({ pins: [...pins, key] });
  return true;
}

// goPin opens the nth pinned worktree (1-based). With none pinned it says
// how to pin one, once per press, rather than doing nothing.
export function goPin(n: number): boolean {
  closeSwitcher();
  const key = usePrefs.getState().pins[n - 1];
  if (!key) {
    if (!usePrefs.getState().pins.length) toastManager.add({ title: "Nothing pinned yet", description: "In the switcher (⌘K), ⌘↵ pins a worktree to ⌘1–9. ⌃1–9 picks a tab." });
    return true;
  }
  const ref = refFor(key);
  if (!ref) {
    toastManager.add({ title: "That worktree isn't here", description: "Its box may be away, or the worktree was removed." });
    return true;
  }
  selectWorktree(ref);
  return true;
}

// ---- Back and forward -------------------------------------------------------

// A place is what the window showed: a worktree, Home, or a view.
type Place = { kind: "wt"; key: string } | { kind: "home" } | { kind: "view"; view: View };

const idOf = (p: Place) => (p.kind === "wt" ? `wt:${p.key}` : p.kind === "home" ? "home" : `view:${JSON.stringify(p.view)}`);

function placeNow(): Place {
  const view = useStore.getState().view;
  if (view.kind !== "workspace") return { kind: "view", view };
  const current = useWorkspaces.getState().current;
  return current && !homeBox(current) ? { kind: "wt", key: current } : { kind: "home" };
}

interface NavState {
  back: Place[];
  forward: Place[];
}

export const useCommandNav = create<NavState>()(() => ({ back: [], forward: [] }));

let last: Place | undefined;
let moving = false;
const LIMIT = 50;

function record() {
  const now = placeNow();
  if (last && idOf(last) === idOf(now)) return;
  if (now.kind === "wt") visited(now.key);
  if (!moving && last) {
    const prev = last;
    useCommandNav.setState((s) => ({ back: [...s.back.filter((p) => idOf(p) !== idOf(prev)), prev].slice(-LIMIT), forward: [] }));
  }
  last = now;
}

// startCommandNav keeps the history while the command layout is up.
export function startCommandNav(): () => void {
  last = placeNow();
  const a = useStore.subscribe((s, prev) => s.view !== prev.view && record());
  const b = useWorkspaces.subscribe((s, prev) => s.current !== prev.current && record());
  return () => {
    a();
    b();
  };
}

function go(p: Place): boolean {
  if (p.kind === "wt") {
    const ref = refFor(p.key);
    if (!ref) return false;
    selectWorktree(ref);
  } else if (p.kind === "home") goHome();
  else useStore.getState().setView(p.view);
  return true;
}

// step goes back (-1) or forward (1), skipping places that are gone.
export function step(dir: -1 | 1): boolean {
  closeSwitcher();
  const from = dir < 0 ? "back" : "forward";
  const to = dir < 0 ? "forward" : "back";
  const s = useCommandNav.getState();
  const list = [...s[from]];
  while (list.length) {
    const p = list.pop()!;
    const here = placeNow();
    moving = true;
    const ok = go(p);
    moving = false;
    if (ok) {
      last = p;
      useCommandNav.setState({ [from]: list, [to]: [...s[to], here].slice(-LIMIT) } as Partial<NavState>);
      return true;
    }
  }
  useCommandNav.setState({ [from]: [] } as Partial<NavState>);
  return false;
}

// toggleLast flips to the place before this one (⌘K twice), as ⌃Tab does
// between two apps' windows: back, with forward cleared of the jump.
export function toggleLast(): boolean {
  const back = useCommandNav.getState().back;
  if (!back.length) return false;
  return step(-1);
}

// ---- Teaching as it goes -----------------------------------------------------

// visited counts visits to a worktree this session; the third visit to one
// that isn't pinned suggests pinning it, once per worktree.
const visits = new Map<string, number>();
const suggested = new Set<string>();
function visited(key: string) {
  const n = (visits.get(key) ?? 0) + 1;
  visits.set(key, n);
  const pins = usePrefs.getState().pins;
  if (n < 3 || pins.includes(key) || pins.length >= MAX_PINS || suggested.has(key)) return;
  suggested.add(key);
  const ref = refFor(key);
  if (!ref) return;
  let id = "";
  id = toastManager.add({
    title: `Pin ${ref.main ? ref.location : ref.worktree} to ⌘${pins.length + 1}?`,
    description: "You keep coming back to it. ⌘↵ in the switcher pins and unpins too.",
    actionProps: {
      children: "Pin",
      onClick: () => {
        toastManager.close(id);
        togglePin(key);
      },
    },
  });
}

// ---- Who needs you ----------------------------------------------------------

// Which agents that need you you've seen since they started waiting: by
// going to them or by opening the switcher. The top line stays lit until
// then, not for a moment that's easy to miss.
export const waitKey = (box: string, s: Pick<Session, "name" | "state_since">) => `${box}/${s.name}@${s.state_since ?? ""}`;
export const useSeen = create<{ keys: Set<string> }>()(() => ({ keys: new Set() }));
export function markSeen(keys: string[]) {
  const cur = useSeen.getState().keys;
  if (keys.every((k) => cur.has(k))) return;
  useSeen.setState({ keys: new Set([...cur, ...keys]) });
}

export interface Waiting {
  box: string;
  session: Session;
}

// waitingAgents lists the agents waiting for you on online boxes, the one
// waiting longest first.
export function waitingAgents(): Waiting[] {
  const st = useStore.getState();
  const online = new Set(st.status?.boxes.filter((b) => b.state === "online").map((b) => b.name));
  const out: Waiting[] = [];
  for (const [box, d] of Object.entries(st.boxes)) {
    if (!online.has(box)) continue;
    for (const s of d.sessions ?? []) if (agentOf(s) && sessionState(s, d.stats) === "waiting") out.push({ box, session: s });
  }
  return out.sort((a, b) => (a.session.state_since ?? "").localeCompare(b.session.state_since ?? "") || a.box.localeCompare(b.box) || a.session.name.localeCompare(b.session.name));
}

// nextWaiting goes to the next agent that needs you: after the one in
// front, if it is one of them, else the one waiting longest.
export function nextWaiting(): boolean {
  closeSwitcher();
  const list = waitingAgents();
  if (!list.length) {
    toastManager.add({ title: "Nobody needs you right now", description: "Agents that ask for something line up here: ⌘E goes to each in turn." });
    return true;
  }
  const f = focusedPane();
  const leaf = f && findLeaf(f.tab.root, f.leaf.id);
  const c = leaf?.content;
  const at = c?.kind === "terminal" ? list.findIndex((w) => w.box === c.box && w.session.name === c.session) : -1;
  const next = list[(at + 1) % list.length];
  void focusSession(next.box, next.session.name);
  return true;
}
