import { useMemo } from "react";
import { create } from "zustand";

import type { Location, Session, Worktree } from "@/lib/api";
import { type Compare, rehomeCompares } from "@/lib/compare";
import { agentOf, sessionState } from "@/lib/derive";
import { findLeaf, type Leaf, leaf, leaves, mapLeaf, moveBetween, movePane, neighbor, newId, type PaneContent, type PaneNode, paneWorktree, place, remove, sessionsShown, setRatio, type Side, split, swap, worktreesOf } from "@/lib/layout";
import { foldedOf, groupsOf, NARROW, stepGroup, stripTabs, withGroup, withoutGroup } from "@/lib/groups";
import { usePrefs } from "@/lib/prefs";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";

// A workspace is one worktree's tabs, as in Orca: selecting a worktree in the
// sidebar swaps the tab strip to its tabs. Each tab is a tree of split panes.
// Workspaces persist on this computer, layout and all.

export interface WorktreeRef {
  box: string;
  location: string;
  worktree: string;
  path: string;
  main?: boolean;
}

export interface WsTab {
  id: string;
  root: PaneNode;
  focus: string;
  // A Compare tab's two worktrees and lanes (lib/compare.ts).
  compare?: Compare;
  // The workspace layout (Labs, lib/deck.ts): only the focused pane shows,
  // filling the tab; the others stay mounted behind it.
  zoomed?: boolean;
}

export interface Workspace {
  ref: WorktreeRef;
  tabs: WsTab[];
  active?: string;
  // Sessions the person closed. An agent may keep running on the box (the
  // dashboard and the launcher still show it), but none comes back as a tab
  // on its own.
  hidden: string[];
  // Sessions in this worktree the workspace has already seen, tab or not.
  // Only sessions it hasn't seen yet open as tabs by themselves; one seen
  // before without a tab is picked up again from the launcher. Unset until
  // the first look, which takes every session in.
  known?: string[];
  // When it was last opened, for "recent" lists.
  visitedAt?: number;
}

interface State {
  // The worktree in front: its tabs' group has the keyboard, and its active
  // tab is the one showing.
  current?: string;
  // Tab groups (Labs): the worktrees whose tabs share the strip, in order.
  // Unset or without current, the strip is current's alone, as it always
  // was (lib/groups.ts groupsOf).
  shown?: string[];
  // Groups folded to their label.
  folded?: string[];
  // A worktree's colour, when the person picked one (lib/groups.ts tones).
  tones?: Record<string, string>;
  spaces: Record<string, Workspace>;
  // Workspaces opened since launch: their panes stay mounted, so switching
  // back is instant and nothing reconnects.
  mounted: string[];
  recentUrls: string[];
}

export const wsKey = (box: string, path: string) => `${box}:${path}`;

export const refOf = (box: string, loc: Location, wt: Worktree): WorktreeRef => ({ box, location: loc.name, worktree: wt.name, path: wt.path, main: wt.main });

// splitKey is a workspace key's box and path.
export function splitKey(key: string): { box: string; path: string } {
  const i = key.indexOf(":");
  return { box: key.slice(0, i), path: key.slice(i + 1) };
}

// A box's home: terminals on a box that belong to no worktree, shown over
// Home (lib/box-home.ts). Their workspace is keyed by the box and "~" and
// has no worktree: refFor is undefined for it, so nothing that acts on a
// worktree (Run, its services, its agents, a page on its port) acts there.
export const HOME_PATH = "~";
export const homeKey = (box: string) => wsKey(box, HOME_PATH);

// homeBox is the box whose home a workspace key is, else undefined.
export function homeBox(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const { box, path } = splitKey(key);
  return path === HOME_PATH ? box : undefined;
}

// lookupRef finds a worktree by its key in what its box lists.
function lookupRef(box: string, path: string, locations?: Location[]): WorktreeRef | undefined {
  for (const loc of locations ?? []) {
    const wt = loc.worktrees?.find((w) => w.path === path);
    if (wt) return refOf(box, loc, wt);
  }
  return undefined;
}

// refFor is a worktree's ref by its key: its workspace's, else its box's
// listing (a pane can belong to a worktree that has no workspace yet).
export function refFor(key: string | undefined): WorktreeRef | undefined {
  if (!key || homeBox(key)) return undefined;
  const own = useWorkspaces.getState().spaces[key]?.ref;
  if (own) return own;
  const { box, path } = splitKey(key);
  return lookupRef(box, path, useStore.getState().boxes[box]?.locations);
}

// useWorktreeRef is refFor, kept current.
export function useWorktreeRef(key: string | undefined): WorktreeRef | undefined {
  const own = useWorkspaces((s) => (key && !homeBox(key) ? s.spaces[key]?.ref : undefined));
  const { box, path } = key ? splitKey(key) : { box: "", path: "" };
  const locations = useStore((s) => (own || !key ? undefined : s.boxes[box]?.locations));
  return useMemo(() => own ?? (key ? lookupRef(box, path, locations) : undefined), [own, key, box, path, locations]);
}

// Panes that were starting when the app closed did not finish; drop them.
function sanitize(spaces: Record<string, Workspace>): Record<string, Workspace> {
  const out: Record<string, Workspace> = {};
  for (const [k, ws] of Object.entries(spaces)) {
    const tabs: WsTab[] = [];
    for (const t of ws.tabs) {
      let root: PaneNode | undefined = t.root;
      // A Compare tab keeps its two sides: one that was starting is empty.
      if (t.compare) root = mapLeaves(t.root, (l) => (l.content.kind === "starting" || l.content.kind === "error" ? { ...l, content: { kind: "empty", label: "Agent" } } : l));
      else for (const l of leaves(t.root)) if (l.content.kind === "starting" || l.content.kind === "error") root = root && remove(root, l.id);
      if (root) tabs.push({ ...t, root, focus: leaves(root).some((l) => l.id === t.focus) ? t.focus : leaves(root)[0].id });
    }
    out[k] = { ...ws, tabs, active: tabs.some((t) => t.id === ws.active) ? ws.active : tabs[0]?.id, hidden: ws.hidden ?? [] };
  }
  return out;
}

const saved = load<Partial<State>>("berth.workspaces", {});

const savedSpaces = sanitize(saved.spaces ?? {});
const savedShown = groupsOf(saved.shown, saved.current, (k) => !!savedSpaces[k]);

export const useWorkspaces = create<State>()(() => ({
  current: saved.current,
  shown: savedShown,
  folded: saved.folded ?? [],
  tones: saved.tones ?? {},
  spaces: savedSpaces,
  // Every group's panes are mounted from the start, so any of them can
  // show at once.
  mounted: savedShown,
  recentUrls: saved.recentUrls ?? [],
}));

useWorkspaces.subscribe((s) => save("berth.workspaces", { current: s.current, shown: s.shown, folded: s.folded, tones: s.tones, spaces: s.spaces, recentUrls: s.recentUrls }));

const mapLeaves = (n: PaneNode, fn: (l: Leaf) => Leaf): PaneNode => (n.kind === "leaf" ? fn(n) : { ...n, a: mapLeaves(n.a, fn), b: mapLeaves(n.b, fn) });

function update(key: string, fn: (ws: Workspace) => Workspace) {
  useWorkspaces.setState((s) => (s.spaces[key] ? { spaces: { ...s.spaces, [key]: fn(s.spaces[key]) } } : s));
}

function updateTab(key: string, tabId: string, fn: (t: WsTab) => WsTab | undefined) {
  update(key, (ws) => {
    const tabs: WsTab[] = [];
    for (const t of ws.tabs) {
      if (t.id !== tabId) tabs.push(t);
      else {
        const next = fn(t);
        if (next) tabs.push(next);
      }
    }
    const i = ws.tabs.findIndex((t) => t.id === tabId);
    const active = tabs.some((t) => t.id === ws.active) ? ws.active : tabs[Math.min(i, tabs.length - 1)]?.id;
    return { ...ws, tabs, active };
  });
}

export function currentSpace(): Workspace | undefined {
  const s = useWorkspaces.getState();
  return s.current ? s.spaces[s.current] : undefined;
}

// focusedOf is the focused pane of the tab showing, and its tab.
function focusedOf(s: Pick<State, "current" | "spaces">): { key: string; tab: WsTab; leaf: Leaf } | undefined {
  const ws = s.current ? s.spaces[s.current] : undefined;
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  const l = tab && findLeaf(tab.root, tab.focus);
  return s.current && tab && l ? { key: s.current, tab, leaf: l } : undefined;
}

export const focusedPane = () => focusedOf(useWorkspaces.getState());

// hereOf is the worktree you are acting in: the focused pane's
// (paneWorktree), which in a tab that mixes worktrees need not be the
// tab's. The breadcrumb, Run, the + menu, ⌘T and ⌘⇧B, the palette and
// plugins act in it. Without a tab it is the worktree showing.
export function hereOf(s: Pick<State, "current" | "spaces">): string | undefined {
  const f = focusedOf(s);
  return f ? paneWorktree(f.key, f.leaf) : s.current;
}

// onScreenOf lists the worktrees on screen, in the strip's order: its
// groups, then any other whose pane is in the tab showing.
export function onScreenOf(s: Pick<State, "current" | "shown" | "spaces">): string[] {
  const ws = s.current ? s.spaces[s.current] : undefined;
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  return [...new Set([...groupKeys(s), ...(tab && s.current ? worktreesOf(tab.root, s.current) : [])])];
}

export const here = () => hereOf(useWorkspaces.getState());
export const hereRef = () => refFor(here());
export const useHereKey = () => useWorkspaces(hereOf);
export const useHereRef = () => useWorktreeRef(useHereKey());

// selectWorktree makes a worktree's workspace the one shown. When its tabs
// are a group in the strip, that group comes to the front; otherwise it
// shows alone, as a plain click in the sidebar always has.
export function selectWorktree(ref: WorktreeRef) {
  const key = wsKey(ref.box, ref.path);
  const keep = isShown(key) ? groupKeys() : [key];
  useWorkspaces.setState((s) => ({
    current: key,
    shown: keep,
    folded: (s.folded ?? []).filter((k) => k !== key && keep.includes(k)),
    spaces: { ...s.spaces, [key]: s.spaces[key] ? { ...s.spaces[key], ref, visitedAt: Date.now() } : { ref, tabs: [], hidden: [], visitedAt: Date.now() } },
    mounted: s.mounted.includes(key) ? s.mounted : [...s.mounted, key],
  }));
  useStore.getState().setView({ kind: "workspace" });
  reconcile(key);
}

// Tab groups (Labs): the strip holds the tabs of every worktree in shown,
// each run of them a group in that worktree's colour. A plain click on a
// worktree in the sidebar fronts its group when it has one, and otherwise
// shows it alone, as always; ⌥-click, a drag or "Add to tabs" adds a group.
// Closing a group only takes its tabs off the strip: the worktree and its
// agents carry on, and its tabs come back with it.

const groupsOn = () => usePrefs.getState().labs;

// groupKeys is the groups in the strip: shown, or with Labs off just the
// worktree in front.
export function groupKeys(s: Pick<State, "current" | "shown" | "spaces"> = useWorkspaces.getState()): string[] {
  return groupsOn() ? groupsOf(s.shown, s.current, (k) => !!s.spaces[k]) : s.current ? [s.current] : [];
}

export const isShown = (key: string) => groupKeys().includes(key);

// ensure makes a workspace for a worktree that has none yet, mounted.
export function ensure(key: string): boolean {
  const ref = refFor(key);
  if (!ref) return false;
  useWorkspaces.setState((st) => ({
    spaces: { ...st.spaces, [key]: st.spaces[key] ?? { ref, tabs: [], hidden: [], visitedAt: Date.now() } },
    mounted: st.mounted.includes(key) ? st.mounted : [...st.mounted, key],
  }));
  return true;
}

// front puts a group in front, unfolded.
function front(key: string, shown: string[]) {
  useWorkspaces.setState((st) => ({
    current: key,
    shown,
    folded: (st.folded ?? []).filter((k) => k !== key),
    spaces: st.spaces[key] ? { ...st.spaces, [key]: { ...st.spaces[key], visitedAt: Date.now() } } : st.spaces,
    mounted: st.mounted.includes(key) ? st.mounted : [...st.mounted, key],
  }));
  useStore.getState().setView({ kind: "workspace" });
}

// addGroup adds a worktree's tabs to the strip as a group, in front: after
// the others, or at index at.
export function addGroup(key: string, at?: number): boolean {
  if (!ensure(key)) return false;
  const s = useWorkspaces.getState();
  // A box's home terminals are never a group: from them, the worktree shows alone.
  const from = homeBox(s.current) ? { shown: [], current: undefined } : { shown: groupKeys(s), current: s.current };
  front(key, groupsOn() ? withGroup(from, key, at).shown : [key]);
  reconcile(key);
  return true;
}

// focusGroup fronts a group already in the strip.
export function focusGroup(key: string) {
  if (isShown(key)) front(key, groupKeys());
}

// closeGroup takes a group's tabs off the strip; its worktree and agents
// carry on. The last group stays.
export function closeGroup(key: string): boolean {
  const s = useWorkspaces.getState();
  const shown = groupKeys(s);
  if (shown.length < 2 || !shown.includes(key)) return false;
  const next = withoutGroup({ shown, current: s.current }, key);
  useWorkspaces.setState((st) => ({ shown: next.shown, current: next.current, folded: (st.folded ?? []).filter((k) => k !== key && k !== next.current) }));
  return true;
}

// nextGroup fronts the group after (1) or before (-1) the one in front.
export function nextGroup(dir: 1 | -1): boolean {
  const s = useWorkspaces.getState();
  const shown = groupKeys(s);
  const to = stepGroup({ shown, current: s.current }, dir);
  if (!to || to === s.current) return false;
  front(to, shown);
  return true;
}

// foldGroup folds a group to its label, or unfolds it. The group in front
// hands the front to the next unfolded one first; with none, it stays.
export function foldGroup(key: string, fold: boolean) {
  const s = useWorkspaces.getState();
  const shown = groupKeys(s);
  if (!shown.includes(key)) return;
  const folded = new Set(s.folded ?? []);
  if (!fold) {
    folded.delete(key);
    useWorkspaces.setState({ folded: [...folded] });
    return;
  }
  if (key === s.current) {
    const open = shown.filter((k) => k !== key && !folded.has(k));
    const i = shown.indexOf(key);
    const to = open.find((k) => shown.indexOf(k) > i) ?? open[open.length - 1];
    if (!to) return;
    useWorkspaces.setState({ current: to });
  }
  folded.add(key);
  useWorkspaces.setState({ folded: [...folded] });
}

// stripTab is the nth tab (from 1) across the strip, as ⌘1–9 count them:
// every unfolded group's tabs, in order.
export function stripTab(n: number): { key: string; tab: WsTab } | undefined {
  const s = useWorkspaces.getState();
  const shown = groupKeys(s);
  const narrow = typeof window !== "undefined" && window.matchMedia(NARROW).matches;
  const folded = foldedOf({ shown, current: s.current }, s.folded, narrow);
  return stripTabs(shown.map((key) => ({ key, tabs: s.spaces[key]?.tabs ?? [], folded: folded.includes(key) })))[n - 1];
}

// setTone gives a worktree a colour of the person's choosing; unset goes
// back to its own.
export function setTone(key: string, tone?: string) {
  useWorkspaces.setState((s) => {
    const { [key]: _old, ...rest } = s.tones ?? {};
    return { tones: tone ? { ...rest, [key]: tone } : rest };
  });
}

// showWorktree brings a worktree's tabs to the front: what acting in a
// worktree that is not the one showing does (⌘T in a guest pane opens the
// terminal in a tab of the guest's worktree). With Labs on it joins the
// strip as a group, beside what was showing. False when nothing knows the
// worktree.
export function showWorktree(key: string): boolean {
  if (homeBox(key)) return showHome(key);
  const s = useWorkspaces.getState();
  if (s.current === key) return true;
  if (isShown(key)) {
    focusGroup(key);
    return true;
  }
  if (groupsOn()) return addGroup(key);
  if (!ensure(key)) return false;
  useWorkspaces.setState({ current: key, shown: [key] });
  reconcile(key);
  return true;
}

// showHome brings a box's home terminals to the front, over Home. It never
// joins the strip's groups (those are worktrees), and is no recent worktree.
export function showHome(key: string): boolean {
  const box = homeBox(key);
  if (!box) return false;
  useWorkspaces.setState((s) => ({
    current: key,
    spaces: s.spaces[key] ? s.spaces : { ...s.spaces, [key]: { ref: { box, location: "", worktree: HOME_PATH, path: HOME_PATH }, tabs: [], hidden: [] } },
    mounted: s.mounted.includes(key) ? s.mounted : [...s.mounted, key],
  }));
  useStore.getState().setView({ kind: "workspace" });
  return true;
}

// Home shows a box's terminals while it has some: closing the last one goes
// back to plain Home.
useWorkspaces.subscribe((s, prev) => {
  const key = s.current;
  if (key && key === prev.current && homeBox(key) && prev.spaces[key]?.tabs.length && !s.spaces[key]?.tabs.length) useWorkspaces.setState({ current: undefined });
});

// openHomeSession shows a session that belongs to no worktree (a box's
// home terminal): its pane where it is, else a tab over Home.
function openHomeSession(box: string, session: string) {
  const found = findSession(box, session);
  const key = found?.key ?? homeKey(box);
  if (!showWorktree(key)) return;
  if (found) {
    activateTab(found.key, found.tab);
    focusPane(found.key, found.tab, found.pane.id);
  } else openTab({ kind: "terminal", box, session }, key);
}

// forgetWorktree drops a removed worktree's workspace and its group. If it
// was in front, the next group comes forward, else home.
export function forgetWorktree(box: string, path: string) {
  const key = wsKey(box, path);
  useWorkspaces.setState((s) => {
    // Its Compare tabs move to the other side's workspace, to show that one.
    const { [key]: _gone, ...spaces } = rehomeCompares(s.spaces, key);
    const groups = withoutGroup({ shown: groupKeys(s), current: s.current }, key);
    const { [key]: _tone, ...tones } = s.tones ?? {};
    return { spaces, tones, mounted: s.mounted.filter((k) => k !== key), current: s.current === key ? groups.current : s.current, shown: groups.shown, folded: (s.folded ?? []).filter((k) => k !== key) };
  });
}

// goHome leaves every worktree for the workspace's home (no worktree open).
export function goHome() {
  useWorkspaces.setState({ current: undefined });
  useStore.getState().setView({ kind: "workspace" });
}

// How many closed and seen session names a workspace keeps. Names are not
// dropped when a session leaves the box's list: a list fetched before it
// stopped can still arrive after, and must not bring it back.
const REMEMBER = 200;
const cap = (names: string[]) => (names.length > REMEMBER ? names.slice(-REMEMBER) : names);

// reconcile gives a tab to every session new in the worktree (made by the
// CLI, an agent, a task, another laptop), unless it is already in a pane or
// was closed by the person. A pane anywhere counts: one of this worktree's
// sessions may show in another worktree's tab, beside its panes. A session
// it has seen before is never adopted again: a new tab is always a new
// session, and one left without a tab is picked up from the launcher. While
// a pane is starting a session, it waits: that pane will show the new
// session itself.
export function reconcile(key: string) {
  const { spaces } = useWorkspaces.getState();
  const ws = spaces[key];
  if (!ws) return;
  const sessions = useStore.getState().boxes[ws.ref.box]?.sessions;
  if (!sessions) return;
  // A Compare tab's parked panes count too.
  const all = Object.entries(spaces).flatMap(([k, w]) => w.tabs.flatMap((t) => [t.root, ...(t.compare?.parked ?? [])].map((root) => ({ k, root }))));
  // A pane starting one of this worktree's sessions, here or as a guest.
  if (all.some(({ k, root }) => leaves(root).some((l) => l.content.kind === "starting" && paneWorktree(k, l) === key))) return;
  const roots = all.map((x) => x.root);
  const here = sessions.filter((s) => s.dir === ws.ref.path);
  const known = new Set(ws.known ?? []);
  const fresh = here.filter((s) => !known.has(s.name));
  // A service's terminal has its tab whenever its worktree is open, unless
  // the person closed it.
  const services = here.filter((s) => s.service && known.has(s.name));
  if (!fresh.length && !services.length && ws.known) return;
  const shown = sessionsShown(roots, ws.ref.box);
  const missing = [...fresh, ...services].filter((s) => !shown.has(s.name) && !ws.hidden.includes(s.name));
  if (!fresh.length && !missing.length && ws.known) return;
  update(key, (w) => {
    const added = missing.map(newSessionTab(w.ref.box));
    return { ...w, known: cap([...(w.known ?? []), ...fresh.map((s) => s.name)]), tabs: [...w.tabs, ...added], active: w.active ?? added[0]?.id };
  });
}

const newSessionTab = (box: string) => (s: Session): WsTab => {
  const l = leaf({ kind: "terminal", box, session: s.name });
  return { id: newId(), root: l, focus: l.id };
};

// openTab adds a tab showing content to the current workspace.
export function openTab(content: PaneContent, key = useWorkspaces.getState().current): { tab: string; pane: string } | undefined {
  if (!key) return undefined;
  const l = leaf(content);
  const tab = { id: newId(), root: l, focus: l.id };
  update(key, (ws) => ({ ...ws, tabs: [...ws.tabs, tab], active: tab.id }));
  useStore.getState().setView({ kind: "workspace" });
  return { tab: tab.id, pane: l.id };
}

// splitPane puts content beside a pane. wt is the worktree it belongs to,
// when that is not the tab's (a guest pane).
export function splitPane(key: string, tabId: string, paneId: string, dir: "row" | "col", content: PaneContent, wt?: string): string {
  const l = leaf(content, wt && wt !== key ? wt : undefined);
  updateTab(key, tabId, (t) => ({ ...t, root: split(t.root, paneId, dir, l), focus: l.id }));
  return l.id;
}

export function setPaneContent(key: string, tabId: string, paneId: string, content: PaneContent) {
  updateTab(key, tabId, (t) => ({ ...t, root: mapLeaf(t.root, paneId, (l) => ({ ...l, content })) }));
}

// removePane takes a pane out of its tab, and the tab out when it was the
// last one. hide marks a session that keeps running on the box.
export function removePane(key: string, tabId: string, paneId: string, hide?: string) {
  updateTab(key, tabId, (t) => {
    const root = remove(t.root, paneId);
    if (!root) return undefined;
    return { ...t, root, focus: t.focus === paneId ? leaves(root)[0].id : t.focus };
  });
  if (hide) update(key, (ws) => ({ ...ws, hidden: cap([...ws.hidden.filter((h) => h !== hide), hide]) }));
}

export function resizeSplit(key: string, tabId: string, splitId: string, ratio: number) {
  updateTab(key, tabId, (t) => ({ ...t, root: setRatio(t.root, splitId, ratio) }));
}

export function focusPane(key: string, tabId: string, paneId: string) {
  update(key, (ws) => ({ ...ws, active: tabId, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, focus: paneId } : t)) }));
}

export function moveFocus(dir: "left" | "right" | "up" | "down") {
  const s = useWorkspaces.getState();
  const ws = currentSpace();
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  if (!s.current || !tab) return;
  const next = neighbor(tab.root, tab.focus, dir);
  if (next) focusPane(s.current, tab.id, next);
}

export function activateTab(key: string, tabId: string) {
  update(key, (ws) => ({ ...ws, active: tabId }));
  useStore.getState().setView({ kind: "workspace" });
}

export function moveTab(key: string, from: number, to: number) {
  update(key, (ws) => {
    const tabs = [...ws.tabs];
    const [t] = tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    return { ...ws, tabs };
  });
}

// Moving tabs and panes (dragging them, or the tabs' and panes' menus) only
// rearranges the trees: every pane keeps its id, so PaneLayer never remounts
// it and its terminal, agent or page carries on as it was.

// tabIntoPane moves every pane of tab from into tab to, on one side of pane,
// and closes the tab it left.
export function tabIntoPane(key: string, from: string, to: string, pane: string, side: Side) {
  if (from === to) return;
  update(key, (ws) => {
    const src = ws.tabs.find((t) => t.id === from);
    const dst = ws.tabs.find((t) => t.id === to);
    if (!src || !dst || !findLeaf(dst.root, pane)) return ws;
    const root = place(dst.root, pane, side, src.root);
    const tabs = ws.tabs.filter((t) => t.id !== from).map((t) => (t.id === to ? { ...t, root, focus: src.focus } : t));
    return { ...ws, tabs, active: to };
  });
}

// moveInto moves a tab, or one pane of it, beside a pane of a tab in any
// workspace (moveBetween): into another worktree's tab, its panes become
// guests there. The receiving tab comes to the front.
export function moveInto(src: { key: string; tab: string; pane?: string }, dst: { key: string; tab: string; pane: string; side: Side }) {
  useWorkspaces.setState((s) => {
    const spaces = moveBetween(s.spaces, src, dst);
    return spaces ? { spaces, current: dst.key, mounted: s.mounted.includes(dst.key) ? s.mounted : [...s.mounted, dst.key] } : s;
  });
  useStore.getState().setView({ kind: "workspace" });
}

// bringSession shows a worktree's session beside a pane of the tab showing:
// moved from wherever a pane shows it (it keeps running and nothing
// remounts), or in a new pane when none does. The pane belongs to its
// worktree, key.
export function bringSession(key: string, box: string, session: string, dst: { tab: string; pane: string; side: Side }) {
  const s = useWorkspaces.getState();
  if (!s.current) return;
  const found = findSession(box, session);
  if (found && found.key === s.current && found.tab === dst.tab) return focusPane(s.current, dst.tab, found.pane.id);
  if (found) return moveInto({ key: found.key, tab: found.tab, pane: found.pane.id }, { key: s.current, ...dst });
  const l = leaf({ kind: "terminal", box, session }, key !== s.current ? key : undefined);
  updateTab(s.current, dst.tab, (t) => ({ ...t, root: place(t.root, dst.pane, dst.side, l), focus: l.id }));
}

// leadAgent is the agent a worktree is known by: the one that needs you,
// else one working, else any.
export function leadAgent(key: string): string | undefined {
  const { box, path } = splitKey(key);
  const data = useStore.getState().boxes[box];
  const live = (data?.sessions ?? []).filter((x) => x.dir === path && !x.exited && agentOf(x));
  const rank = (x: Session) => ({ waiting: 0, running: 1 })[sessionState(x, data?.stats) as string] ?? 2;
  return [...live].sort((a, b) => rank(a) - rank(b))[0]?.name;
}

// tabBeside is the tab menu's Split right and Split down: the tab joins the
// one showing (or, for the one showing, its neighbour), beside its focused
// pane.
export function tabBeside(key: string, from: string, dir: "row" | "col") {
  const ws = useWorkspaces.getState().spaces[key];
  if (!ws) return;
  const i = ws.tabs.findIndex((t) => t.id === from);
  const to = ws.active !== from ? ws.tabs.find((t) => t.id === ws.active) : (ws.tabs[i - 1] ?? ws.tabs[i + 1]);
  if (i < 0 || !to) return;
  tabIntoPane(key, from, to.id, to.focus, dir === "row" ? "right" : "bottom");
}

// paneBeside moves a pane next to another in its tab, or with "center"
// swaps the two.
export function paneBeside(key: string, tab: string, pane: string, target: string, side: Side | "center") {
  updateTab(key, tab, (t) => ({ ...t, root: side === "center" ? swap(t.root, pane, target) : movePane(t.root, pane, target, side), focus: pane }));
}

// paneToTab takes a pane out of a split into a tab of its own, at index in
// the strip (just after its tab when unset). The split it leaves collapses.
export function paneToTab(key: string, tab: string, pane: string, index?: number) {
  update(key, (ws) => {
    const i = ws.tabs.findIndex((t) => t.id === tab);
    const t = ws.tabs[i];
    const l = t && findLeaf(t.root, pane);
    const rest = t && remove(t.root, pane);
    if (!l || !rest) return ws;
    const fresh: WsTab = { id: newId(), root: l, focus: l.id };
    const tabs = ws.tabs.map((x) => (x.id === tab ? { ...x, root: rest, focus: x.focus === pane ? leaves(rest)[0].id : x.focus } : x));
    tabs.splice(index ?? i + 1, 0, fresh);
    return { ...ws, tabs, active: fresh.id };
  });
}

// unsplitTab gives each pane of a split tab a tab of its own, in place.
export function unsplitTab(key: string, tab: string) {
  update(key, (ws) => {
    const i = ws.tabs.findIndex((t) => t.id === tab);
    const t = ws.tabs[i];
    if (!t || t.root.kind === "leaf") return ws;
    const parts = leaves(t.root).map((l, n): WsTab => ({ id: n === 0 ? t.id : newId(), root: l, focus: l.id }));
    const tabs = [...ws.tabs];
    tabs.splice(i, 1, ...parts);
    return { ...ws, tabs, active: ws.active === tab ? (parts.find((p) => p.focus === t.focus)?.id ?? t.id) : ws.active };
  });
}

// findSession locates the pane showing a session, in any workspace.
export function findSession(box: string, session: string): { key: string; tab: string; pane: Leaf } | undefined {
  for (const [key, ws] of Object.entries(useWorkspaces.getState().spaces)) {
    if (ws.ref.box !== box) continue;
    for (const t of ws.tabs) {
      if (t.compare) continue;
      const l = leaves(t.root).find((x) => x.content.kind === "terminal" && x.content.session === session);
      if (l) return { key, tab: t.id, pane: l };
    }
  }
  return undefined;
}

// openSession shows a session: its worktree's workspace, then its pane,
// adding a tab for it when it has none.
export function openSession(box: string, session: Session) {
  // The workspace layout (lib/deck.ts) brings it into the panes on screen.
  if (opener?.(box, session.name)) return;
  const locations = useStore.getState().boxes[box]?.locations ?? [];
  const loc = locations.find((l) => l.worktrees?.some((w) => w.path === session.dir));
  const wt = loc?.worktrees?.find((w) => w.path === session.dir);
  if (!loc || !wt) return session.location ? undefined : openHomeSession(box, session.name);
  const ref = refOf(box, loc, wt);
  const key = wsKey(box, wt.path);
  update(key, (ws) => ({ ...ws, hidden: ws.hidden.filter((h) => h !== session.name) }));
  // Its pane is where it is: in a group in the strip (perhaps a guest in
  // another worktree's tab) it is focused in place; otherwise that pane's
  // worktree is shown, as a plain click would, rather than a second pane
  // opened on the same session.
  const found = findSession(box, session.name);
  if (found && isShown(found.key)) {
    focusGroup(found.key);
    activateTab(found.key, found.tab);
    focusPane(found.key, found.tab, found.pane.id);
    return;
  }
  if (found && found.key !== key) {
    const at = useWorkspaces.getState().spaces[found.key]?.ref;
    if (at) selectWorktree(at);
    focusPane(found.key, found.tab, found.pane.id);
    return;
  }
  selectWorktree(ref);
  // Selecting the worktree reconciles its tabs, which gives a session new
  // to it a tab of its own: use that one rather than opening a second (a
  // new task's session showed twice, attached at two sizes).
  const now = found ?? findSession(box, session.name);
  if (now) {
    activateTab(now.key, now.tab);
    focusPane(now.key, now.tab, now.pane.id);
  } else openTab({ kind: "terminal", box, session: session.name }, key);
}

// opener, when set, gets first say in showing a session: true when it did.
let opener: ((box: string, session: string) => boolean) | undefined;
export const setSessionOpener = (fn: typeof opener) => {
  opener = fn;
};

// setTabZoom zooms a tab's focused pane to fill it, or lets the others back.
export function setTabZoom(key: string, tabId: string, zoomed: boolean) {
  updateTab(key, tabId, (t) => ({ ...t, zoomed: zoomed || undefined }));
}

// setTabRoot replaces a tab's whole tree (a new arrangement of the same
// leaves: none of them remounts).
export function setTabRoot(key: string, tabId: string, root: PaneNode) {
  updateTab(key, tabId, (t) => ({ ...t, root, focus: findLeaf(root, t.focus) ? t.focus : leaves(root)[0].id }));
}

// parkPane takes a pane off a tab and gives it a tab of its own in its own
// worktree, behind whatever shows there: it keeps running and stays mounted,
// so bringing it back is instant. False when it is the tab's only pane.
export function parkPane(key: string, tabId: string, paneId: string): boolean {
  const s = useWorkspaces.getState();
  const t = s.spaces[key]?.tabs.find((x) => x.id === tabId);
  const l = t && findLeaf(t.root, paneId);
  const rest = t && remove(t.root, paneId);
  if (!l || !rest) return false;
  const owner = paneWorktree(key, l);
  if (owner !== key && !ensure(owner)) return false;
  const { wt: _wt, ...alone } = l;
  updateTab(key, tabId, (x) => ({ ...x, root: rest, focus: x.focus === paneId ? leaves(rest)[0].id : x.focus }));
  update(owner, (ws) => ({ ...ws, tabs: [...ws.tabs, { id: newId(), root: alone, focus: alone.id }] }));
  return true;
}

export function rememberUrl(url: string) {
  useWorkspaces.setState((s) => ({ recentUrls: [url, ...s.recentUrls.filter((u) => u !== url)].slice(0, 20) }));
}

// New sessions on a box get tabs in every open workspace they belong to.
useStore.subscribe((s, prev) => {
  if (s.boxes === prev.boxes) return;
  for (const key of useWorkspaces.getState().mounted) reconcile(key);
});

// The pane API other parts of the app (dashboard, orchestration, plugins)
// use. They never touch the tree directly.

// focusSession shows a session: its worktree's workspace, then its pane,
// adding a tab for it when it has none. openTerminal is the same.
export async function focusSession(box: string, session: string) {
  let s = useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session);
  if (!s) {
    await useStore.getState().refreshBox(box, ["locations", "sessions"]);
    s = useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session);
  }
  if (s) openSession(box, s);
}

export const openTerminal = focusSession;

// openFor shows content for the worktree you are acting in (here): with
// split, beside the focused pane, as a guest when that pane is another
// worktree's; else as a tab of here's own, brought to the front.
export function openFor(content: PaneContent, opts: { split?: "row" | "col" } = {}): { key: string; tab: string; pane: string } | undefined {
  const wt = here();
  const f = focusedPane();
  if (!wt) return undefined;
  useStore.getState().setView({ kind: "workspace" });
  if (opts.split && f) return { key: f.key, tab: f.tab.id, pane: splitPane(f.key, f.tab.id, f.leaf.id, opts.split, content, wt) };
  if (!showWorktree(wt)) return undefined;
  const r = openTab(content, wt);
  return r && { key: wt, ...r };
}

// openBrowser opens a page in the worktree you are acting in: a new tab, or
// with split, beside the focused pane.
export function openBrowser(url: string, opts: { split?: "row" | "col" } = {}) {
  openFor({ kind: "browser", url }, opts);
}

// openPanel opens a plugin's worktree panel for the worktree you are acting
// in: the pane that already shows it if there is one (in the tab showing,
// then in that worktree's tabs), else a new tab, or with split, beside the
// focused pane.
export function openPanel(plugin: string, panel: string, title: string, opts: { split?: "row" | "col" } = {}) {
  const wt = here();
  if (!wt) return;
  const isIt = (k: string, l: Leaf) => l.content.kind === "panel" && l.content.plugin === plugin && l.content.panel === panel && paneWorktree(k, l) === wt;
  const f = focusedPane();
  const near = f && leaves(f.tab.root).find((l) => isIt(f.key, l));
  if (f && near) {
    focusPane(f.key, f.tab.id, near.id);
    useStore.getState().setView({ kind: "workspace" });
    return;
  }
  for (const t of useWorkspaces.getState().spaces[wt]?.tabs ?? []) {
    const hit = leaves(t.root).find((l) => isIt(wt, l));
    if (hit && showWorktree(wt)) {
      activateTab(wt, t.id);
      focusPane(wt, t.id, hit.id);
      return;
    }
  }
  openFor({ kind: "panel", plugin, panel, title }, opts);
}

// recentWorktrees lists workspaces by when they were last opened.
export function recentWorktrees(spaces: Record<string, Workspace>, n = 3): Workspace[] {
  return Object.values(spaces)
    .filter((w) => w.visitedAt)
    .sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0))
    .slice(0, n);
}

if (import.meta.env.DEV) Object.assign(window as unknown as Record<string, unknown>, { __berthWorkspaces: { useWorkspaces, selectWorktree, goHome, focusSession } });

// ---- Helpers' tabs ----

// A helper as its opener names it: by its id, the call that started it, or
// its name ("Sent out 2 helpers" knows only names in older records).
export interface HelperRef {
  box: string;
  session: string;
  ref: string;
}

const isHelper = (l: Leaf, h: HelperRef) =>
  l.content.kind === "helper" && l.content.box === h.box && l.content.session === h.session && (l.content.helper === h.ref || l.content.title === h.ref.replace(/^Explore:\s*/, ""));

// findHelper locates the pane showing a helper's conversation, in any
// workspace.
export function findHelper(h: HelperRef): { key: string; tab: string; pane: Leaf } | undefined {
  for (const [key, ws] of Object.entries(useWorkspaces.getState().spaces)) {
    for (const t of ws.tabs) {
      if (t.compare) continue;
      const l = leaves(t.root).find((x) => isHelper(x, h));
      if (l) return { key, tab: t.id, pane: l };
    }
  }
  return undefined;
}

// openHelperPane shows a helper's conversation beside the chat of the agent
// that sent it out (from, the pane it was opened from, else wherever that
// chat shows): as a tab just after the chat's (after any of its helpers
// already there), or with split, beside the chat in its tab. A helper
// already open is brought to the front instead; with split, one open in a
// tab of its own moves in beside the chat. Without the chat on screen it
// opens in the worktree you are acting in.
export function openHelperPane(h: HelperRef & { title?: string }, how: "tab" | "split" = "tab", from?: { wsKey: string; tab: string; pane: string }) {
  const s = useWorkspaces.getState();
  const fromLeaf = from && s.spaces[from.wsKey]?.tabs.find((t) => t.id === from.tab && findLeaf(t.root, from.pane));
  const found = findSession(h.box, h.session);
  const parent = fromLeaf && from ? { key: from.wsKey, tab: from.tab, pane: findLeaf(fromLeaf.root, from.pane)! } : found;
  const content: PaneContent = { kind: "helper", box: h.box, session: h.session, helper: h.ref, title: h.title?.replace(/^Explore:\s*/, "") };
  const open = findHelper(h);
  useStore.getState().setView({ kind: "workspace" });
  if (open && (how === "tab" || !parent || (open.key === parent.key && open.tab === parent.tab))) {
    if (!isShown(open.key)) showWorktree(open.key);
    else focusGroup(open.key);
    activateTab(open.key, open.tab);
    focusPane(open.key, open.tab, open.pane.id);
    return;
  }
  if (open && parent) {
    moveInto({ key: open.key, tab: open.tab, pane: open.pane.id }, { key: parent.key, tab: parent.tab, pane: parent.pane.id, side: "right" });
    return;
  }
  if (!parent) {
    openFor(content, how === "split" ? { split: "row" } : {});
    return;
  }
  // The helper belongs to its chat's worktree.
  const wt = paneWorktree(parent.key, parent.pane);
  if (isShown(parent.key)) focusGroup(parent.key);
  else showWorktree(parent.key);
  if (how === "split") {
    splitPane(parent.key, parent.tab, parent.pane.id, "row", content, wt);
    return;
  }
  const l = leaf(content, wt !== parent.key ? wt : undefined);
  const tab: WsTab = { id: newId(), root: l, focus: l.id };
  update(parent.key, (ws) => {
    const tabs = [...ws.tabs];
    let i = tabs.findIndex((t) => t.id === parent.tab);
    // After the chat's helpers already open beside it, in the order opened.
    while (i >= 0 && i + 1 < tabs.length && leaves(tabs[i + 1].root).every((x) => x.content.kind === "helper" && x.content.box === h.box && x.content.session === h.session)) i++;
    tabs.splice(i < 0 ? tabs.length : i + 1, 0, tab);
    return { ...ws, tabs, active: tab.id };
  });
}

// openArtifactPane shows an artifact of worktree wt (or with no id, wt's
// board): the pane already showing it is brought forward; otherwise beside
// from (the chat a card is in) with split, or as a tab just after from's,
// or with no from, in wt's workspace. A board already open takes focus.
export function openArtifactPane(content: Extract<PaneContent, { kind: "artifact" }>, wt: string, how: "tab" | "split" = "tab", from?: { wsKey: string; tab: string; pane: string }) {
  const s = useWorkspaces.getState();
  const same = (key: string, l: Leaf) => l.content.kind === "artifact" && (l.content.id ?? "") === (content.id ?? "") && paneWorktree(key, l) === wt;
  let open: { key: string; tab: string; pane: Leaf } | undefined;
  for (const [key, ws] of Object.entries(s.spaces)) {
    for (const t of ws.tabs) {
      const l = leaves(t.root).find((x) => same(key, x));
      if (l && !open) open = { key, tab: t.id, pane: l };
    }
  }
  const fromTab = from && s.spaces[from.wsKey]?.tabs.find((t) => t.id === from.tab);
  const fromLeaf = fromTab && from ? findLeaf(fromTab.root, from.pane) : undefined;
  // A Compare tab keeps its two sides: from one, an artifact opens as a tab.
  if (fromTab?.compare) how = "tab";
  useStore.getState().setView({ kind: "workspace" });
  if (open && (how === "tab" || !fromLeaf || (open.key === from?.wsKey && open.tab === from?.tab))) {
    if (!isShown(open.key)) showWorktree(open.key);
    else focusGroup(open.key);
    activateTab(open.key, open.tab);
    focusPane(open.key, open.tab, open.pane.id);
    if (content.focus !== undefined && open.pane.content.kind === "artifact") setPaneContent(open.key, open.tab, open.pane.id, { ...open.pane.content, focus: content.focus });
    return;
  }
  if (open && fromLeaf && from) {
    moveInto({ key: open.key, tab: open.tab, pane: open.pane.id }, { key: from.wsKey, tab: from.tab, pane: from.pane, side: "right" });
    return;
  }
  if (!fromLeaf || !from) {
    if (!showWorktree(wt)) return;
    if (how === "split") {
      const f = focusedPane();
      if (f && f.key === wt) {
        splitPane(f.key, f.tab.id, f.leaf.id, "row", content, wt);
        return;
      }
    }
    openTab(content, wt);
    return;
  }
  if (isShown(from.wsKey)) focusGroup(from.wsKey);
  else showWorktree(from.wsKey);
  if (how === "split") {
    splitPane(from.wsKey, from.tab, from.pane, "row", content, wt);
    return;
  }
  const l = leaf(content, wt !== from.wsKey ? wt : undefined);
  const tab: WsTab = { id: newId(), root: l, focus: l.id };
  update(from.wsKey, (ws) => {
    const tabs = [...ws.tabs];
    let i = tabs.findIndex((t) => t.id === from.tab);
    // After the artifacts already opened from this chat.
    while (i >= 0 && i + 1 < tabs.length && leaves(tabs[i + 1].root).every((x) => x.content.kind === "artifact")) i++;
    tabs.splice(i < 0 ? tabs.length : i + 1, 0, tab);
    return { ...ws, tabs, active: tab.id };
  });
}
