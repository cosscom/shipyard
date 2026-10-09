// A tab's panes are a binary tree of splits. Leaves hold what a pane shows;
// a split divides its rectangle between two children at ratio. These are
// pure functions over that tree.

// What a pane shows. Other parts of the app make these through the actions
// in lib/workspaces (openTerminal, openBrowser, focusSession).
export type PaneContent =
  // agent and command are remembered from the session, so a pane can say
  // what ended and start it again after the session is gone.
  // view: an agent's pane shown as its terminal or as a conversation (Labs);
  // unset follows the person's default.
  // title: the session's title while it ran, so an ended pane keeps its name.
  | { kind: "terminal"; box: string; session: string; agent?: string; command?: string; title?: string; view?: "terminal" | "conversation" }
  | { kind: "browser"; url: string }
  // The same page at several sizes at once (components/preview-pane).
  | { kind: "preview"; url: string }
  | { kind: "log"; box: string; location: string; worktree: string; service: string }
  // A file of the pane's worktree, in the File tab's editor (lib/files.ts).
  | { kind: "file"; path: string }
  // A helper's own conversation (a subagent its agent sent out), read-only
  // (components/conversation/helper-pane.tsx). helper is its id once known
  // (the call's id or its name until then); title is its name, kept so the
  // tab is named before the box answers, and after a restart.
  | { kind: "helper"; box: string; session: string; helper: string; title?: string }
  // A plugin's worktree panel, shown for the pane's worktree (paneWorktree).
  | { kind: "panel"; plugin: string; panel: string; title: string }
  // An artifact an agent made in the pane's worktree (components/art): one
  // by id, or without one the worktree's board, focus the one it leads with.
  // title is its title, kept so the tab is named before the box answers.
  // art: the artifact's kind, for the tab's icon.
  | { kind: "artifact"; id?: string; title?: string; focus?: string; art?: string }
  | { kind: "starting"; label: string }
  // Nothing yet: a Compare tab's side whose worktree runs no agent. It
  // offers to start one there.
  | { kind: "empty"; label: string }
  | { kind: "error"; message: string };

export type Pane = PaneContent;

export type PaneNode =
  // wt is the worktree (its workspace key, box:path) the pane belongs to,
  // set only when that is not its tab's: a tab can hold panes of more than
  // one worktree side by side. Unset, the pane is its tab's (paneWorktree).
  | { kind: "leaf"; id: string; content: PaneContent; wt?: string }
  | { kind: "split"; id: string; dir: "row" | "col"; ratio: number; a: PaneNode; b: PaneNode };

export type Leaf = Extract<PaneNode, { kind: "leaf" }>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export const leaf = (content: PaneContent, wt?: string): Leaf => (wt ? { kind: "leaf", id: newId(), content, wt } : { kind: "leaf", id: newId(), content });

// paneWorktree is the worktree a pane belongs to: its own, else its tab's
// (key, the workspace that holds the tab). What the pane shows, a plugin's
// panel or a typed port, is for this worktree.
export const paneWorktree = (key: string, l: Leaf): string => l.wt ?? key;

// worktreesOf lists the worktrees a tab's panes belong to, its own first.
export function worktreesOf(node: PaneNode, key: string): string[] {
  const all = [...new Set(leaves(node).map((l) => paneWorktree(key, l)))];
  return all.includes(key) ? [key, ...all.filter((k) => k !== key)] : all;
}

// mixed says a tab in workspace key shows a pane of another worktree.
export const mixed = (node: PaneNode, key: string): boolean => leaves(node).some((l) => paneWorktree(key, l) !== key);

// adopt moves a tree from workspace from into a tab of workspace to: each
// leaf keeps the worktree it belonged to, written down only when that is
// not to's. Ids are kept, so nothing is remounted.
export function adopt(node: PaneNode, from: string, to: string): PaneNode {
  if (from === to) return node;
  if (node.kind === "split") return { ...node, a: adopt(node.a, from, to), b: adopt(node.b, from, to) };
  const owner = paneWorktree(from, node);
  const { wt: _wt, ...rest } = node;
  return owner === to ? rest : { ...rest, wt: owner };
}

// sessionsShown is the sessions on box that panes of these trees show.
export function sessionsShown(roots: PaneNode[], box: string): Set<string> {
  const out = new Set<string>();
  for (const r of roots) for (const l of leaves(r)) if (l.content.kind === "terminal" && l.content.box === box) out.add(l.content.session);
  return out;
}

export function leaves(node: PaneNode): Leaf[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export function findLeaf(node: PaneNode, id: string): Leaf | undefined {
  return leaves(node).find((l) => l.id === id);
}

// mapLeaf replaces the leaf with id by fn(leaf).
export function mapLeaf(node: PaneNode, id: string, fn: (l: Leaf) => PaneNode): PaneNode {
  if (node.kind === "leaf") return node.id === id ? fn(node) : node;
  return { ...node, a: mapLeaf(node.a, id, fn), b: mapLeaf(node.b, id, fn) };
}

// split puts next beside (row) or below (col) the leaf with id.
export function split(node: PaneNode, id: string, dir: "row" | "col", next: Leaf): PaneNode {
  return mapLeaf(node, id, (l) => ({ kind: "split", id: newId(), dir, ratio: 0.5, a: l, b: next }));
}

// remove drops a leaf; its sibling takes the parent's place. Undefined when
// the tree was that one leaf.
export function remove(node: PaneNode, id: string): PaneNode | undefined {
  if (node.kind === "leaf") return node.id === id ? undefined : node;
  const a = remove(node.a, id);
  const b = remove(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

export interface Divider {
  id: string;
  dir: "row" | "col";
  // The split's whole rectangle, to turn a pointer position into a ratio.
  area: Rect;
  // Where the line is: x for a row split, y for a column split.
  at: number;
}

// layout places every leaf and divider inside rect (fractions of the pane
// area, 0 to 1).
export function layout(node: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = { leaves: [] as { leaf: Leaf; rect: Rect }[], dividers: [] as Divider[] }) {
  if (node.kind === "leaf") {
    out.leaves.push({ leaf: node, rect });
    return out;
  }
  if (node.dir === "row") {
    const w = rect.w * node.ratio;
    layout(node.a, { ...rect, w }, out);
    layout(node.b, { ...rect, x: rect.x + w, w: rect.w - w }, out);
    out.dividers.push({ id: node.id, dir: "row", area: rect, at: rect.x + w });
  } else {
    const h = rect.h * node.ratio;
    layout(node.a, { ...rect, h }, out);
    layout(node.b, { ...rect, y: rect.y + h, h: rect.h - h }, out);
    out.dividers.push({ id: node.id, dir: "col", area: rect, at: rect.y + h });
  }
  return out;
}

// neighbor finds the pane next to from in a direction, by their centres.
export function neighbor(node: PaneNode, from: string, dir: "left" | "right" | "up" | "down"): string | undefined {
  const all = layout(node).leaves;
  const me = all.find((l) => l.leaf.id === from);
  if (!me) return undefined;
  const cx = me.rect.x + me.rect.w / 2;
  const cy = me.rect.y + me.rect.h / 2;
  let best: { id: string; d: number } | undefined;
  for (const { leaf: l, rect: r } of all) {
    if (l.id === from) continue;
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    const ok = dir === "left" ? x < cx && r.x + r.w <= me.rect.x + 1e-6 : dir === "right" ? x > cx && r.x >= me.rect.x + me.rect.w - 1e-6 : dir === "up" ? y < cy && r.y + r.h <= me.rect.y + 1e-6 : y > cy && r.y >= me.rect.y + me.rect.h - 1e-6;
    if (!ok) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { id: l.id, d };
  }
  return best?.id;
}

// Where a moved pane or tab lands beside another pane.
export type Side = "left" | "right" | "top" | "bottom";

// place halves the leaf with id and puts sub on one side of it: a whole tab's
// tree, or a single pane. Leaves keep their ids, so what they show is never
// remounted.
export function place(node: PaneNode, id: string, side: Side, sub: PaneNode): PaneNode {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const first = side === "left" || side === "top";
  return mapLeaf(node, id, (l) => ({ kind: "split", id: newId(), dir, ratio: 0.5, a: first ? sub : l, b: first ? l : sub }));
}

// movePane takes a leaf out of where it is (its sibling closes the gap) and
// places it beside target in the same tree.
export function movePane(node: PaneNode, id: string, target: string, side: Side): PaneNode {
  const moving = findLeaf(node, id);
  if (!moving || id === target || !findLeaf(node, target)) return node;
  const rest = remove(node, id);
  return rest ? place(rest, target, side, moving) : node;
}

// swap trades two leaves' places.
export function swap(node: PaneNode, x: string, y: string): PaneNode {
  const lx = findLeaf(node, x);
  const ly = findLeaf(node, y);
  if (!lx || !ly || x === y) return node;
  const go = (n: PaneNode): PaneNode => (n.kind === "leaf" ? (n.id === x ? ly : n.id === y ? lx : n) : { ...n, a: go(n.a), b: go(n.b) });
  return go(node);
}

// bounds is the rectangle the leaves with ids fill together, in fractions of
// the pane area: where a drop will land, worked out on the tree it makes.
export function bounds(node: PaneNode, ids: string[]): Rect | undefined {
  const rects = layout(node).leaves.filter((l) => ids.includes(l.leaf.id)).map((l) => l.rect);
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
  return { x, y, w, h };
}

// sideAt says which part of a pane a point is over (u, v from 0 to 1 across
// and down it): the nearest edge, or with centre, the middle fifth each way
// first.
export function sideAt(u: number, v: number, centre = false): Side | "center" {
  if (centre && Math.abs(u - 0.5) < 0.2 && Math.abs(v - 0.5) < 0.2) return "center";
  const d = { left: u, right: 1 - u, top: v, bottom: 1 - v };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

// A workspace as moveBetween needs it: its tabs, and the one showing.
export interface TabLike {
  id: string;
  root: PaneNode;
  focus: string;
}
export interface SpaceLike {
  tabs: TabLike[];
  active?: string;
}

// moveBetween moves a whole tab, or with pane one pane of it, out of
// workspace src.key and beside dst.pane (on side) in a tab of workspace
// dst.key: the same workspace, or another, where each moved pane keeps the
// worktree it belongs to (adopt). Leaves keep their ids. The tab it leaves
// closes when nothing is left in it. Undefined when the move makes no sense.
export function moveBetween<S extends SpaceLike>(
  spaces: Record<string, S>,
  src: { key: string; tab: string; pane?: string },
  dst: { key: string; tab: string; pane: string; side: Side },
): Record<string, S> | undefined {
  const from = spaces[src.key];
  const t = from?.tabs.find((x) => x.id === src.tab);
  const sub = t && (src.pane ? findLeaf(t.root, src.pane) : t.root);
  if (!from || !t || !sub || (src.key === dst.key && src.tab === dst.tab)) return undefined;
  if (src.pane === dst.pane) return undefined;
  const rest = src.pane ? remove(t.root, src.pane) : undefined;
  const i = from.tabs.indexOf(t);
  const tabs = rest
    ? from.tabs.map((x) => (x === t ? { ...x, root: rest, focus: findLeaf(rest, x.focus) ? x.focus : leaves(rest)[0].id } : x))
    : from.tabs.filter((x) => x !== t);
  const out: Record<string, S> = { ...spaces, [src.key]: { ...from, tabs, active: tabs.some((x) => x.id === from.active) ? from.active : tabs[Math.min(i, tabs.length - 1)]?.id } };
  const to = out[dst.key];
  const d = to?.tabs.find((x) => x.id === dst.tab);
  if (!to || !d || !findLeaf(d.root, dst.pane)) return undefined;
  const moved = adopt(sub, src.key, dst.key);
  const focus = src.pane ?? t.focus;
  out[dst.key] = { ...to, tabs: to.tabs.map((x) => (x === d ? { ...x, root: place(d.root, dst.pane, dst.side, moved), focus } : x)), active: d.id };
  return out;
}

// How a workspace's panes are tiled (lib/deck.ts): side by side in equal
// columns, or as a grid (two beside each other; three as one beside two
// stacked; four as two over two). auto is columns up to three, then a grid:
// four columns are too narrow to read a chat in.
export type Arrangement = "auto" | "columns" | "grid";

// arranged is what auto comes to for n panes.
export const arranged = (how: Arrangement, n: number): "columns" | "grid" => (how === "auto" ? (n >= 4 ? "grid" : "columns") : how);

const node = (dir: "row" | "col", ratio: number, a: PaneNode, b: PaneNode): PaneNode => ({ kind: "split", id: newId(), dir, ratio, a, b });

// evenly lays nodes out one after another in dir, each the same size.
function evenly(nodes: PaneNode[], dir: "row" | "col"): PaneNode {
  if (nodes.length === 1) return nodes[0];
  return node(dir, 1 / nodes.length, nodes[0], evenly(nodes.slice(1), dir));
}

// tile arranges leaves, in order, as how says. Leaves keep their ids, so
// nothing they show is remounted; only the splits are new.
export function tile(ls: Leaf[], how: Arrangement): PaneNode | undefined {
  if (!ls.length) return undefined;
  if (ls.length === 1) return ls[0];
  if (arranged(how, ls.length) === "columns" || ls.length === 2) return evenly(ls, "row");
  if (ls.length === 3) return node("row", 0.5, ls[0], node("col", 0.5, ls[1], ls[2]));
  const cols = Math.ceil(Math.sqrt(ls.length));
  const rows: PaneNode[] = [];
  for (let i = 0; i < ls.length; i += cols) rows.push(evenly(ls.slice(i, i + cols), "row"));
  return evenly(rows, "col");
}
