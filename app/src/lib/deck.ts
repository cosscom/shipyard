import { create } from "zustand";

import type { Session } from "@/lib/api";
import { agentOf, sessionState } from "@/lib/derive";
import { type Arrangement, leaf, leaves, neighbor, type Side, tile } from "@/lib/layout";
import { usePrefs } from "@/lib/prefs";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { bringSession, ensure, findSession, focusPane, leadAgent, paneBeside, paneToTab, parkPane, refFor, setSessionOpener, setTabRoot, setTabZoom, splitKey, useWorkspaces, type WsTab, wsKey } from "@/lib/workspaces";

// The workspace layout (Labs, Settings › Labs › Layout): instead of a
// sidebar, the window is named workspaces of live panes you arrange, as in
// tmux or Zellij. Each workspace is one tab of the pane machinery
// (lib/workspaces.ts), whose panes may belong to any worktree on any box
// (guests): this file only remembers which tab each workspace is, its name
// and how its panes are tiled. Agents not on screen wait in the strip along
// the bottom; opening one (from the strip, a notification, ⌘K, a new task)
// brings it into the workspace in front rather than switching worktree.

export interface Deck {
  id: string;
  name: string;
  // The tab it is: key is the workspace (worktree) that holds it. Unset
  // while it is empty.
  key?: string;
  tab?: string;
  arrange: Arrangement;
}

interface DeckState {
  decks: Deck[];
  // The workspace in front, or last in front.
  active?: string;
  // Home is showing instead (the harbour and its composer).
  home?: boolean;
}

// More than this many panes and a new one takes the focused one's place.
export const MAX_PANES = 4;

const saved = load<DeckState>("berth.decks", { decks: [] });
export const useDecks = create<DeckState>()(() => ({ decks: saved.decks ?? [], active: saved.active }));
useDecks.subscribe((s) => save("berth.decks", { decks: s.decks, active: s.active }));

export const deckOn = () => {
  const p = usePrefs.getState();
  return p.labs && p.layout === "workspace";
};
export const useDeckOn = () => usePrefs((p) => p.labs && p.layout === "workspace");

const newDeckId = () => Math.random().toString(36).slice(2, 10);

// deckTab is a workspace's tab, while it has one.
export function deckTab(d: Deck | undefined, spaces = useWorkspaces.getState().spaces): WsTab | undefined {
  return d?.key && d.tab ? spaces[d.key]?.tabs.find((t) => t.id === d.tab) : undefined;
}

export const activeDeck = (): Deck | undefined => {
  const s = useDecks.getState();
  return s.decks.find((d) => d.id === s.active) ?? s.decks[0];
};

function patch(id: string, p: Partial<Deck>) {
  useDecks.setState((s) => ({ decks: s.decks.map((d) => (d.id === id ? { ...d, ...p } : d)) }));
}

// frontDeck is the workspace showing now, if one is: its tab in front, or
// it is empty and nothing else shows.
export function frontDeck(s: { current?: string; spaces: ReturnType<typeof useWorkspaces.getState>["spaces"] } = useWorkspaces.getState(), d: DeckState = useDecks.getState(), view = useStore.getState().view.kind): Deck | undefined {
  if (view !== "workspace" || d.home) return undefined;
  const ws = s.current ? s.spaces[s.current] : undefined;
  if (ws) return d.decks.find((x) => x.key === s.current && x.tab === ws.active);
  const a = d.decks.find((x) => x.id === d.active);
  return a && !deckTab(a, s.spaces) ? a : undefined;
}

// showDeck puts a workspace in front.
export function showDeck(id: string) {
  const d = useDecks.getState().decks.find((x) => x.id === id);
  if (!d) return;
  useDecks.setState({ active: id, home: false });
  const t = deckTab(d);
  if (d.key && t) {
    const key = d.key;
    useWorkspaces.setState((s) => ({
      current: key,
      shown: [key],
      spaces: { ...s.spaces, [key]: { ...s.spaces[key], active: t.id, visitedAt: Date.now() } },
      mounted: s.mounted.includes(key) ? s.mounted : [...s.mounted, key],
    }));
  } else useWorkspaces.setState({ current: undefined, shown: [] });
  useStore.getState().setView({ kind: "workspace" });
}

// showHome shows the harbour (the composer and your agents) in place of a
// workspace.
export function showDeckHome() {
  useDecks.setState({ home: true });
  useWorkspaces.setState({ current: undefined, shown: [] });
  useStore.getState().setView({ kind: "workspace" });
}

// newDeck makes an empty workspace and puts it in front.
export function newDeck(name?: string): string {
  const taken = new Set(useDecks.getState().decks.map((d) => d.name));
  let n = useDecks.getState().decks.length + 1;
  while (!name && taken.has(`Workspace ${n}`)) n++;
  const d: Deck = { id: newDeckId(), name: name ?? `Workspace ${n}`, arrange: "auto" };
  useDecks.setState((s) => ({ decks: [...s.decks, d] }));
  showDeck(d.id);
  return d.id;
}

export function renameDeck(id: string, name: string) {
  if (name.trim()) patch(id, { name: name.trim() });
}

// closeDeck forgets a workspace. Nothing in it stops: its panes stay a tab
// of their worktree, and its agents wait in the strip.
export function closeDeck(id: string) {
  const s = useDecks.getState();
  const i = s.decks.findIndex((d) => d.id === id);
  if (i < 0) return;
  const decks = s.decks.filter((d) => d.id !== id);
  const wasFront = frontDeck()?.id === id;
  useDecks.setState({ decks, active: s.active === id ? decks[Math.min(i, decks.length - 1)]?.id : s.active });
  if (wasFront) {
    const next = useDecks.getState().active;
    if (next) showDeck(next);
    else showDeckHome();
  }
}

// keepAsDeck makes the tab showing (opened some other way: a worktree from
// ⌘K) a workspace of its own, named after its worktree.
export function keepAsDeck(name: string) {
  const { current, spaces } = useWorkspaces.getState();
  const tab = current ? spaces[current]?.active : undefined;
  if (!current || !tab) return;
  const d: Deck = { id: newDeckId(), name, key: current, tab, arrange: "auto" };
  useDecks.setState((s) => ({ decks: [...s.decks, d], active: d.id, home: false }));
}

// setArrange tiles the workspace in front's panes again, as how says.
export function setArrange(how: Arrangement) {
  const d = frontDeck() ?? activeDeck();
  if (!d) return;
  patch(d.id, { arrange: how });
  retile(d.id);
  const t = deckTab(d);
  if (d.key && t?.zoomed) setTabZoom(d.key, t.id, false);
}

function retile(id: string) {
  const d = useDecks.getState().decks.find((x) => x.id === id);
  const t = deckTab(d);
  if (!d?.key || !t) return;
  const root = tile(leaves(t.root), d.arrange);
  if (root) setTabRoot(d.key, t.id, root);
}

// toggleZoom fills the workspace with its focused pane, or lets the others
// back.
export function toggleZoom(): boolean {
  const d = frontDeck();
  const t = deckTab(d);
  if (!d?.key || !t) return false;
  setTabZoom(d.key, t.id, !t.zoomed);
  return true;
}

// swapFocused trades the focused pane with its neighbour in dir.
export function swapFocused(dir: "left" | "right" | "up" | "down"): boolean {
  const d = frontDeck();
  const t = deckTab(d);
  if (!d?.key || !t) return false;
  const other = neighbor(t.root, t.focus, dir);
  if (!other) return false;
  paneBeside(d.key, t.id, t.focus, other, "center");
  return true;
}

// park takes a pane out of the workspace in front: it keeps running, in the
// strip. The last pane leaves the workspace empty.
export function park(paneId: string) {
  const d = frontDeck();
  const t = deckTab(d);
  if (!d?.key || !t) return;
  if (!parkPane(d.key, t.id, paneId)) {
    patch(d.id, { key: undefined, tab: undefined });
    showDeck(d.id);
  }
}

// How opening an agent places it: beside the others (a new pane, or the
// focused one's place once the workspace is full), or in the focused one's
// place.
export type Placement = "auto" | "beside" | "replace";

// worktreeKey is the workspace key of the worktree a session runs in, if
// it runs in one.
function worktreeKey(box: string, session: string): string | undefined {
  const s = useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session);
  if (!s?.dir) return undefined;
  const key = wsKey(box, s.dir);
  return refFor(key) ? key : undefined;
}

// openInDeck brings a session into the workspace in front (or the last
// one, from another view). False when it is not a worktree's (a box's home
// terminal), so the usual way shows it.
export function openInDeck(box: string, session: string, how: Placement = "auto"): boolean {
  const key = worktreeKey(box, session);
  if (!key) return false;
  let d = frontDeck() ?? activeDeck();
  if (!d) d = useDecks.getState().decks.find((x) => x.id === newDeck())!;
  const t = deckTab(d);
  if (!t || !d.key) {
    claimFor(d.id, key, box, session);
    showDeck(d.id);
    return true;
  }
  showDeck(d.id);
  const on = leaves(t.root).find((l) => l.content.kind === "terminal" && l.content.box === box && l.content.session === session);
  if (on) {
    focusPane(d.key, t.id, on.id);
    return true;
  }
  const replace = how === "replace" || (how === "auto" && leaves(t.root).length >= MAX_PANES);
  const target = t.focus;
  bringSession(key, box, session, { tab: t.id, pane: target, side: "right" });
  if (replace) parkPane(d.key, t.id, target);
  retile(d.id);
  return true;
}

// claimFor gives an empty workspace its first pane: the session's own pane,
// taken out of wherever it shows, or a new one.
function claimFor(id: string, key: string, box: string, session: string) {
  const found = findSession(box, session);
  const decks = useDecks.getState().decks;
  if (found) {
    const ws = useWorkspaces.getState().spaces[found.key];
    const tab = ws?.tabs.find((x) => x.id === found.tab);
    if (tab && tab.root.kind === "leaf") {
      // A tab of its own already: that tab becomes the workspace (another
      // workspace it was gives it up).
      for (const o of decks) if (o.key === found.key && o.tab === found.tab) patch(o.id, { key: undefined, tab: undefined });
      patch(id, { key: found.key, tab: found.tab });
      return;
    }
    paneToTab(found.key, found.tab, found.pane.id);
    const now = useWorkspaces.getState().spaces[found.key];
    patch(id, { key: found.key, tab: now?.active });
    return;
  }
  ensure(key);
  const l = leaf({ kind: "terminal", box, session });
  const tab: WsTab = { id: Math.random().toString(36).slice(2, 10), root: l, focus: l.id };
  useWorkspaces.setState((s) => ({ spaces: { ...s.spaces, [key]: { ...s.spaces[key], tabs: [...s.spaces[key].tabs, tab], known: [...new Set([...(s.spaces[key].known ?? []), session])] } } }));
  patch(id, { key, tab: tab.id });
}

// dropSession lands an agent dragged from the strip: beside a pane (side),
// in its place (center, the pane it replaces going to the strip), or alone
// in an empty workspace.
export function dropSession(src: { key: string; box: string; session: string }, target: { tab: string; pane: string; side: Side | "center" }) {
  const { current } = useWorkspaces.getState();
  if (!target.tab || !current) {
    openInDeck(src.box, src.session);
    return;
  }
  const t = useWorkspaces.getState().spaces[current]?.tabs.find((x) => x.id === target.tab);
  const on = t && leaves(t.root).find((l) => l.content.kind === "terminal" && l.content.box === src.box && l.content.session === src.session);
  if (on) {
    if (on.id !== target.pane) paneBeside(current, target.tab, on.id, target.pane, target.side);
    return;
  }
  bringSession(src.key, src.box, src.session, { tab: target.tab, pane: target.pane, side: target.side === "center" ? "right" : target.side });
  if (target.side === "center") parkPane(current, target.tab, target.pane);
}

// openWorktreeInDeck brings a worktree in: its agent that needs you first,
// else false (the caller shows it the usual way).
export function openWorktreeInDeck(key: string, how: Placement = "auto"): boolean {
  const agent = leadAgent(key);
  return agent ? openInDeck(splitKey(key).box, agent, how) : false;
}

// jumpToWaiting brings in, or focuses, the agent that has waited longest
// for you. False when none is waiting.
export function jumpToWaiting(): boolean {
  const { boxes, status } = useStore.getState();
  const online = new Set(status?.boxes.filter((b) => b.state === "online").map((b) => b.name));
  const waiting = Object.entries(boxes)
    .filter(([b]) => online.has(b))
    .flatMap(([box, data]) => (data.sessions ?? []).filter((x: Session) => agentOf(x) && sessionState(x, data.stats) === "waiting").map((x: Session) => ({ box, s: x })))
    .sort((a, b) => (a.s.state_since ?? "").localeCompare(b.s.state_since ?? ""));
  const first = waiting[0];
  return first ? openInDeck(first.box, first.s.name) : false;
}

// Keeping workspaces true to their tabs: one whose tab went (its last pane
// closed) is empty again, and one whose number of panes changed is tiled
// again when one leaves, so closing the middle of three columns leaves two
// even ones. (A pane dropped on a side stays where it was dropped.)
const counts = new Map<string, number>();
useWorkspaces.subscribe((s) => {
  if (!deckOn()) return;
  for (const d of useDecks.getState().decks) {
    if (!d.key || !d.tab) continue;
    const t = deckTab(d, s.spaces);
    if (!t) {
      patch(d.id, { key: undefined, tab: undefined });
      counts.delete(d.id);
      continue;
    }
    const n = leaves(t.root).length;
    const was = counts.get(d.id);
    counts.set(d.id, n);
    if (was !== undefined && n < was) queueMicrotask(() => retile(d.id));
  }
});

// The first time the layout is on: one workspace, holding what shows now.
export function seedDecks() {
  if (useDecks.getState().decks.length) return;
  const { current, spaces } = useWorkspaces.getState();
  const tab = current ? spaces[current]?.active : undefined;
  const t = tab && current ? spaces[current].tabs.find((x) => x.id === tab) : undefined;
  const d: Deck = { id: newDeckId(), name: "Main", arrange: "auto", ...(t && current ? { key: current, tab: t.id } : {}) };
  useDecks.setState({ decks: [d], active: d.id });
}

// Everything that shows an agent (a notification, ⌘K, a new task, the
// dashboard) brings it here while the layout is on.
setSessionOpener((box, session) => (deckOn() ? openInDeck(box, session) : false));

// onDeck says whether a pane of the workspace in front shows the session.
export function onDeck(t: WsTab | undefined, box: string, session: string): boolean {
  return !!t && leaves(t.root).some((l) => l.content.kind === "terminal" && l.content.box === box && l.content.session === session);
}
