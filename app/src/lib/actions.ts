import { create } from "zustand";

import { confirm } from "@/components/sidebar/confirm";
import { serviceKeepsRunning } from "@/components/workspace/service-terminal";
import { toastManager } from "@/components/ui/toast";
import { usePrefs } from "@/lib/prefs";
import { offerAgentHooks } from "@/lib/agent-hooks";
import { type AgentPreset, boxApi, type Conversation, type Location, type Session, type Worktree } from "@/lib/api";
import { agentLabel, agentOf } from "@/lib/derive";
import { errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { findLeaf, type Leaf, leaves, type PaneContent, paneWorktree } from "@/lib/layout";
import { scheduleRefresh, useStore } from "@/lib/store";
import { resolveBrowserInput } from "@/lib/browser-url";
import { closeCompare, setCompareLane } from "@/lib/compare-actions";
import { currentSpace, focusSession, here, hereRef, homeBox, openTab, refFor, removePane, setPaneContent, showWorktree, splitPane, useWorkspaces, type WorktreeRef, wsKey } from "@/lib/workspaces";
import { refuseHome } from "@/lib/box-home";
import { structuredLaunch } from "@/lib/structured";

// Agents offered when a box does not list its own.
export const DEFAULT_AGENTS: AgentPreset[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  { id: "shell", name: "Terminal", command: "" },
];

// agentPresets is what can be started on a box: the repository's own agents
// first, when a location is given, then the box's.
export function agentPresets(box: string, loc?: Location | string): AgentPreset[] {
  const data = useStore.getState().boxes[box];
  const l = typeof loc === "string" ? data?.locations?.find((x) => x.name === loc) : loc;
  const fromBox = data?.info?.agents;
  const own = l?.agents ?? [];
  // An entry with only an id and lists gives a box's agent other models.
  const lists = (p: AgentPreset) => {
    const o = own.find((x) => x.id === p.id && !x.command);
    return o ? { ...p, models: o.models ?? p.models, efforts: o.efforts ?? p.efforts } : p;
  };
  const all = [...own, ...(fromBox?.length ? fromBox : DEFAULT_AGENTS.slice(0, 2))].filter((p) => p.command).map(lists);
  return all.filter((p, i) => all.findIndex((q) => q.id === p.id) === i);
}

// worktreeRef is how the box API names a worktree: "loc" for the
// repository's own checkout, "loc/name" for the others.
export const worktreeRef = (loc: Location | { name: string }, wt: Worktree | { name: string; main?: boolean }) => (wt.main ? loc.name : `${loc.name}/${wt.name}`);

const refLocation = (r: WorktreeRef) => (r.main ? r.location : `${r.location}/${r.worktree}`);

export type Target = { kind: "tab" } | { kind: "split"; tab: string; pane: string; dir: "row" | "col" } | { kind: "replace"; tab: string; pane: string };

// targetWorktree is the worktree what lands at target belongs to: beside
// or in place of a pane, that pane's (a guest's split is a guest too); as a
// tab, the one you are acting in.
function targetWorktree(target: Target): string | undefined {
  if (target.kind === "tab") return here();
  const { current, spaces } = useWorkspaces.getState();
  const l = current ? spaces[current]?.tabs.find((t) => t.id === target.tab)?.root : undefined;
  const p = l && findLeaf(l, target.pane);
  return current && p ? paneWorktree(current, p) : current;
}

// place puts content where target says, for worktree wt, and returns where
// it landed: in the tab showing, or a tab of wt's own, brought to the front.
function place(content: PaneContent, target: Target, wt: string): { key: string; tab: string; pane: string } | undefined {
  // A box's home holds terminals: a page or a panel needs a worktree.
  if (homeBox(wt) && !["terminal", "starting", "error"].includes(content.kind)) return undefined;
  const key = useWorkspaces.getState().current;
  if (target.kind === "tab") {
    if (!showWorktree(wt)) return undefined;
    const r = openTab(content, wt);
    return r && { key: wt, ...r };
  }
  if (!key) return undefined;
  if (target.kind === "split") return { key, tab: target.tab, pane: splitPane(key, target.tab, target.pane, target.dir, content, wt) };
  setPaneContent(key, target.tab, target.pane, content);
  return { key, tab: target.tab, pane: target.pane };
}

// listSession puts a session the box just started into its list at once.
// Until the next refresh its pane would find a session the box doesn't list,
// which reads as one that has ended ("Claude Code has ended", for a moment).
function listSession(box: string, s: Session) {
  useStore.setState((st) => {
    const b = st.boxes[box];
    if (!b?.sessions || b.sessions.some((x) => x.name === s.name)) return st;
    return { boxes: { ...st.boxes, [box]: { ...b, sessions: [...b.sessions, s] } } };
  });
}

// startSession runs a command (an agent, or a shell when empty) in the
// worktree you are acting in (or, beside a pane, that pane's; or the one
// given) and shows it in a new tab, a split, or an existing pane. It resolves to the new
// session's name, or undefined when it did not start.
export async function startSession(command: string, target: Target = { kind: "tab" }, label = command || "Terminal", worktree?: string): Promise<string | undefined> {
  const wt = worktree ?? targetWorktree(target);
  const ref = refFor(wt);
  // A box's home has no worktree: it starts in the box user's home folder.
  const home = homeBox(wt);
  const box = ref?.box ?? home;
  const client = useStore.getState().client;
  if (!wt || !box || !client || (home && refuseHome(home))) return;
  const at = place({ kind: "starting", label }, target, wt);
  if (!at) return;
  try {
    const s = await boxApi.startSession(client, box, ref ? { location: refLocation(ref), command: command || undefined } : { home: true, command: command || undefined });
    listSession(box, s);
    setPaneContent(at.key, at.tab, at.pane, { kind: "terminal", box, session: s.name });
    scheduleRefresh(box, ["sessions"]);
    if (command) void offerAgentHooks(box, command, s.name);
    return s.name;
  } catch (err) {
    setPaneContent(at.key, at.tab, at.pane, { kind: "error", message: plainError(err) });
  }
}

// resumeConversation carries a structured agent's conversation on in a tab
// of its worktree (or the pane target names): in its own session when that
// still runs (or only ended), else in a new one. The box starts its agent
// from what it keeps of the conversation, with --resume.
export async function resumeConversation(box: string, conv: Pick<Conversation, "id" | "agent">, worktree: string, target: Target = { kind: "tab" }): Promise<string | undefined> {
  const client = useStore.getState().client;
  if (!client) return;
  const at = place({ kind: "starting", label: agentLabel(conv.agent) }, target, worktree);
  if (!at) return;
  try {
    const s = await boxApi.resumeConversation(client, box, conv.id);
    listSession(box, s);
    setPaneContent(at.key, at.tab, at.pane, { kind: "terminal", box, session: s.name, agent: conv.agent });
    scheduleRefresh(box, ["sessions"]);
    return s.name;
  } catch (err) {
    setPaneContent(at.key, at.tab, at.pane, { kind: "error", message: plainError(err) });
  }
}

// resumeSession starts a structured agent that ended again, in its pane.
export async function resumeSession(box: string, session: string): Promise<void> {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    await boxApi.resumeSession(client, box, session);
    scheduleRefresh(box, ["sessions"]);
  } catch (err) {
    toastManager.add({ type: "error", title: "Couldn't resume it", description: errorMessage(err) });
  }
}

// startAgent starts preset p as an agent: through its structured driver
// when Labs runs it so (lib/structured.ts), else in its terminal as
// startSession would. A box's home has no worktree for an agent: there it
// is the preset's command in a terminal.
export async function startAgent(p: AgentPreset, target: Target = { kind: "tab" }, label = p.name, worktree?: string): Promise<string | undefined> {
  const wt = worktree ?? targetWorktree(target);
  const ref = refFor(wt);
  const client = useStore.getState().client;
  if (!ref) return startSession(p.command, target, label, worktree);
  if (!wt || !client) return;
  const at = place({ kind: "starting", label }, target, wt);
  if (!at) return;
  try {
    const s = await boxApi.startSession(client, ref.box, { location: refLocation(ref), agent: p.id, ...structuredLaunch(ref.box, p.id, p) });
    listSession(ref.box, s);
    setPaneContent(at.key, at.tab, at.pane, { kind: "terminal", box: ref.box, session: s.name, agent: p.id });
    scheduleRefresh(ref.box, ["sessions"]);
    void offerAgentHooks(ref.box, p.command, s.name);
    return s.name;
  } catch (err) {
    setPaneContent(at.key, at.tab, at.pane, { kind: "error", message: plainError(err) });
  }
}

export function openBrowserAt(url = "", target: Target = { kind: "tab" }, worktree?: string) {
  const wt = worktree ?? targetWorktree(target);
  if (wt) place({ kind: "browser", url }, target, wt);
}

// openPreviewAt opens a Preview tab: the page at several sizes at once. With
// no URL it starts on the worktree's dev server, as the Browser tab offers.
export function openPreviewAt(url = "", target: Target = { kind: "tab" }, worktree?: string) {
  const wt = worktree ?? targetWorktree(target);
  if (wt) place({ kind: "preview", url }, target, wt);
}

// A URL for what was typed: a port opens on the box of the worktree you are
// acting in, by the worktree's name when that is its dev server.
export function resolveUrl(input: string): string | undefined {
  const ref = hereRef();
  const st = useStore.getState();
  return resolveBrowserInput(input, { ref, services: ref ? st.boxes[ref.box]?.services : undefined, urlPort: st.status?.proxy.url_port });
}

// Closing never loses work without asking. A plain shell stops with its
// pane, so closing one asks first (unless the person turned that off). An
// agent, by default, stops too, with a few seconds to undo it from a toast;
// Settings → General can leave agents running when their tab closes, or ask
// each time. Either way the pane's session is marked closed, so the session
// list refreshing never brings it back as a tab.

interface Closing {
  key: string;
  tab: string;
  leaves: Leaf[];
}

interface Stop {
  box: string;
  session: string;
  command?: string;
  // Set when the session is an agent's.
  agent?: string;
}

// What closing these panes would stop on a box: shells, and agents too when
// agents stop with their panes.
function stopping(leavesToClose: Leaf[], agents: boolean): Stop[] {
  const boxes = useStore.getState().boxes;
  return leavesToClose.flatMap((l) => {
    if (l.content.kind !== "terminal") return [];
    const { box, session } = l.content;
    const s = boxes[box]?.sessions?.find((x) => x.name === session);
    // A service's terminal never stops with its pane.
    if (!s || s.exited || s.service) return [];
    const agent = agentOf(s);
    if (agent && !agents) return [];
    return [{ box, session, command: s.command?.trim() || undefined, agent }];
  });
}

// How long an agent closed with its tab has before it is stopped: the
// toast's life, which pauses while the pointer is on it.
const UNDO_MS = 6000;

// Agents closed with their tabs that are about to stop, for the launcher,
// which doesn't offer them to pick up again meanwhile.
export const usePendingStops = create<{ sessions: string[] }>()(() => ({ sessions: [] }));
const pendingStop = (names: string[], on: boolean) =>
  usePendingStops.setState((s) => ({ sessions: on ? [...new Set([...s.sessions, ...names])] : s.sessions.filter((n) => !names.includes(n)) }));

async function close({ key, tab, leaves: ls }: Closing, stopAgents: boolean) {
  const boxes = useStore.getState().boxes;
  const kept: { agent: string; box: string; session: string }[] = [];
  const stopped: { agent: string; box: string; session: string }[] = [];
  const shells: { box: string; session: string }[] = [];
  for (const l of ls) {
    if (l.content.kind !== "terminal") {
      removePane(key, tab, l.id);
      continue;
    }
    const { box, session } = l.content;
    const s = boxes[box]?.sessions?.find((x) => x.name === session);
    // Marked closed either way: until the stop lands, or for good when it
    // keeps running, a refresh must not give it its tab back.
    removePane(key, tab, l.id, session);
    if (s?.service) {
      serviceKeepsRunning(box, s);
      continue;
    }
    // A session too new to be listed yet goes by what its pane knows.
    const agent = s ? (s.exited ? undefined : agentOf(s)) : l.content.agent;
    if (agent) (stopAgents ? stopped : kept).push({ agent, box, session });
    else shells.push({ box, session });
  }
  for (const x of shells) await stopSession(x.box, x.session, true);
  if (stopped.length) stopWithUndo(stopped);
  if (kept.length) agentKeepsRunning(kept[0]);
}

// stopWithUndo stops agents closed with their tabs once the toast that says
// so goes, unless Undo brings them back first.
function stopWithUndo(agents: { agent: string; box: string; session: string }[]) {
  const names = agents.map((a) => a.session);
  pendingStop(names, true);
  let undone = false;
  const { agentCloseTips } = usePrefs.getState();
  const explain = agentCloseTips < 3;
  if (explain) usePrefs.setState({ agentCloseTips: agentCloseTips + 1 });
  const one = agents.length === 1;
  const id = toastManager.add({
    title: one ? `Stopped ${agentLabel(agents[0].agent)}` : `Stopped ${agents.length} agents`,
    description: explain ? "Closing a tab stops its agent. Settings → General can keep agents running instead." : undefined,
    type: "info",
    timeout: UNDO_MS,
    actionProps: {
      children: "Undo",
      onClick: () => {
        undone = true;
        toastManager.close(id);
        pendingStop(names, false);
        // Each comes back as a tab (no longer marked closed), the first in
        // front.
        for (const a of [...agents].reverse()) void focusSession(a.box, a.session);
      },
    },
    onClose: () => {
      if (undone) return;
      pendingStop(names, false);
      for (const a of agents) void stopSession(a.box, a.session, true);
    },
  });
}

// When an agent keeps running, Reopen brings its session back as a tab in
// its worktree (as the launcher's Resume does), not just the worktree.
function agentKeepsRunning({ agent, box, session }: { agent: string; box: string; session: string }) {
  const { agentCloseTips } = usePrefs.getState();
  if (agentCloseTips >= 3) return;
  usePrefs.setState({ agentCloseTips: agentCloseTips + 1 });
  const id = toastManager.add({
    title: `${agentLabel(agent)} keeps running`,
    description: "Closing a tab only hides an agent. Pick it up again from the worktree or the dashboard, or have closing stop agents in Settings → General.",
    type: "info",
    actionProps: {
      children: "Reopen",
      onClick: () => {
        toastManager.close(id);
        void focusSession(box, session);
      },
    },
  });
}

// ask confirms closing when it would stop a shell, then closes. Agents that
// stop with their tabs don't ask: the toast can undo it.
function ask(c: Closing) {
  const mode = usePrefs.getState().closeAgents;
  const agents = stopping(c.leaves, true).filter((x) => x.agent);
  if (agents.length && mode === "ask") return askAboutAgents(c, agents);
  const stopAgents = mode === "stop";
  const stops = stopping(c.leaves, false);
  if (!stops.length || !usePrefs.getState().confirmCloseShells) return void close(c, stopAgents);
  const box = stops[0].box;
  const one = stops.length === 1;
  const what = stops.map((x) => x.command).filter(Boolean) as string[];
  confirm({
    title: one ? "Close shell?" : `Close ${stops.length} shells?`,
    description: `This stops ${one ? "the shell" : "them"} on ${box}${what.length ? `, and what runs in ${one ? "it" : "them"}:` : `, and anything running in ${one ? "it" : "them"}.`}`,
    detail: what.length ? what.join("\n") : undefined,
    confirm: one ? "Close shell" : "Close shells",
    destructive: true,
    options: [{ id: "never", label: "Don't ask again", hint: "Settings → General turns it back on." }],
    repeatConfirms: true,
    run: async (checked) => {
      if (checked.never) usePrefs.setState({ confirmCloseShells: false });
      await close(c, stopAgents);
    },
  });
}

// askAboutAgents is closing with "ask each time": stop the agents with their
// panes, or leave them running on the box.
function askAboutAgents(c: Closing, agents: Stop[]) {
  const one = agents.length === 1;
  const name = one ? agentLabel(agents[0].agent!) : `${agents.length} agents`;
  const shells = stopping(c.leaves, false).length;
  const remember = { id: "remember", label: "Remember my choice", hint: "Settings → General changes it." };
  confirm({
    title: `Stop ${name} too?`,
    description: `${one ? `${name} is` : "They are"} still running on ${agents[0].box}. Stop ${one ? "it" : "them"}, or leave ${one ? "it" : "them"} running to pick up later from the worktree or the dashboard.${shells ? ` ${shells === 1 ? "The shell" : "Shells"} in here stop either way.` : ""}`,
    confirm: one ? "Stop agent" : "Stop agents",
    destructive: true,
    options: [remember],
    repeatConfirms: true,
    secondary: {
      label: "Keep running",
      run: async (checked) => {
        if (checked.remember) usePrefs.setState({ closeAgents: "keep", closeAgentsChosen: true, agentCloseTips: 3 });
        await close(c, false);
      },
    },
    run: async (checked) => {
      if (checked.remember) usePrefs.setState({ closeAgents: "stop", closeAgentsChosen: true });
      await close(c, true);
    },
  });
}

// closePane closes one pane (⌘W, its ×, "Close pane").
export function closePane(key: string, tab: string, pane: string) {
  const t = useWorkspaces.getState().spaces[key]?.tabs.find((x) => x.id === tab);
  // A Compare tab's panes are views of two worktrees: it closes whole, and
  // nothing in it stops.
  if (t?.compare) return closeCompare(key, tab);
  const l = t && findLeaf(t.root, pane);
  if (l) ask({ key, tab, leaves: [l] });
}

// closeTab closes every pane in a tab, asking once for all of them.
export function closeTab(key: string, tab: string) {
  const t = useWorkspaces.getState().spaces[key]?.tabs.find((x) => x.id === tab);
  if (t?.compare) return closeCompare(key, tab);
  if (t) ask({ key, tab, leaves: leaves(t.root) });
}

// For a tab that broke (components/workspace/pane-guard.tsx): resetTab
// shows it as plain terminals, an agent's chat as its terminal and a
// Compare tab in its Terminal lane; dropTab takes it away without the
// usual question, which may be what can't draw. Neither stops anything:
// its agents keep running, and the launcher has them.
export function resetTab(key: string, tab: string) {
  const t = useWorkspaces.getState().spaces[key]?.tabs.find((x) => x.id === tab);
  if (!t) return;
  if (t.compare) return setCompareLane(key, tab, "terminal");
  for (const l of leaves(t.root)) if (l.content.kind === "terminal" && l.content.view !== "terminal") setPaneContent(key, tab, l.id, { ...l.content, view: "terminal" });
}

export function dropTab(key: string, tab: string) {
  const t = useWorkspaces.getState().spaces[key]?.tabs.find((x) => x.id === tab);
  if (!t) return;
  if (t.compare) return closeCompare(key, tab);
  for (const l of leaves(t.root)) removePane(key, tab, l.id, l.content.kind === "terminal" ? l.content.session : undefined);
}

export async function stopSession(box: string, name: string, quiet = false) {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    await boxApi.stopSession(client, box, name);
    scheduleRefresh(box, ["sessions"]);
  } catch (err) {
    if (!quiet) toastManager.add({ title: "Could not stop the session", description: errorMessage(err), type: "error" });
  }
}

export const currentKey = () => {
  const ws = currentSpace();
  return ws ? wsKey(ws.ref.box, ws.ref.path) : undefined;
};
