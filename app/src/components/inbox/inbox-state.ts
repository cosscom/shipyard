import { useMemo } from "react";
import { create } from "zustand";

import { useAllSessions } from "@/hooks/use-agent-counts";
import { agentOf, worktreeOf } from "@/lib/derive";
import { type Done, type InboxFilter, type InboxItem, NO_FILTER, sectionOf } from "@/lib/inbox";
import { usePrefs } from "@/lib/prefs";
import { useProjects } from "@/lib/project-groups";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { goHome, homeBox, refFor, selectWorktree, useWorkspaces } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";

// The inbox's own state: which row the cursor is on, what was marked done,
// the filter, and whether the list shows the inbox or the projects tree.
// Done, the filter and the tab are kept on this computer.

const KEY = "berth.inbox";

interface Saved {
  done: Done;
  filter: InboxFilter;
  tab: "inbox" | "projects";
}

interface InboxState extends Saved {
  cursor?: string;
  // Show rows marked done, greyed, until turned off.
  showDone: boolean;
  // Narrow windows: the list over the worktree, until a row is picked.
  peek: boolean;
  // Bumped to ask the list to take the keyboard (⌘J, the strip's button).
  focusAsk: number;
  // Bumped to ask the home composer to take the keyboard (c, New task).
  composeAsk: number;
  // The last row cleared, for undo (z).
  last?: { id: string; since: string };
  // The worktree before the one in front, for b (back).
  previous?: string;
}

const saved = load<Partial<Saved>>(KEY, {}) ?? {};

export const useInbox = create<InboxState>()(() => ({
  done: saved.done ?? {},
  filter: { ...NO_FILTER, ...saved.filter },
  tab: saved.tab === "projects" ? "projects" : "inbox",
  showDone: false,
  peek: false,
  focusAsk: 0,
  composeAsk: 0,
}));

useInbox.subscribe((s, prev) => {
  if (s.done !== prev.done || s.filter !== prev.filter || s.tab !== prev.tab) save(KEY, { done: s.done, filter: s.filter, tab: s.tab });
});

// The worktree before this one, as a browser's back remembers it.
useWorkspaces.subscribe((s, prev) => {
  if (s.current === prev.current || !prev.current || homeBox(prev.current)) return;
  if (s.current && homeBox(s.current)) return;
  useInbox.setState({ previous: prev.current });
});

// goBack opens the worktree that was in front before this one.
export function goBack(): boolean {
  const ref = refFor(useInbox.getState().previous);
  if (!ref) return false;
  selectWorktree(ref);
  return true;
}

export const inboxOn = () => {
  const p = usePrefs.getState();
  return p.labs && p.layout === "inbox";
};
export const useInboxOn = () => usePrefs((p) => p.labs && p.layout === "inbox");

// focusInbox brings the list back and gives it the keyboard (⌘J).
// Decided here, at once, not in an effect after the next paint: a row
// picked in between would have its choice undone.
export function focusInbox() {
  const narrow = window.matchMedia("(max-width: 1023px)").matches;
  const w = useWorkspaces.getState();
  const worktreeOpen = !!w.current && !homeBox(w.current) && useStore.getState().view.kind === "workspace";
  if (narrow && worktreeOpen) useInbox.setState({ peek: true });
  else if (usePrefs.getState().sidebarCollapsed) usePrefs.setState({ sidebarCollapsed: false });
  useInbox.setState((s) => ({ tab: "inbox", focusAsk: s.focusAsk + 1 }));
}

// compose starts new work: Home's composer, in front, with the keyboard.
export function compose() {
  goHome();
  useInbox.setState((s) => ({ peek: false, composeAsk: s.composeAsk + 1 }));
}

// useInboxItems is every agent on every online box, as inbox rows.
export function useInboxItems(): InboxItem[] {
  const all = useAllSessions();
  const data = useStore((s) => s.boxes);
  const { projects } = useProjects();
  return useMemo(() => {
    const projectOf = new Map<string, { name: string; boxes: number }>();
    for (const p of projects) {
      const boxes = new Set(p.members.map((m) => m.box.name)).size;
      for (const m of p.members) projectOf.set(`${m.box.name}/${m.loc.name}`, { name: p.name, boxes });
    }
    const out: InboxItem[] = [];
    for (const e of all) {
      const agent = agentOf(e.session);
      const section = sectionOf(e.state);
      if (!agent || !section || e.session.service) continue;
      const at = worktreeOf(data[e.box]?.locations, e.session);
      if (!at) continue;
      const p = projectOf.get(`${e.box}/${at.location.name}`);
      const wt = at.worktree.main ? "" : worktreeLabel(at.worktree);
      out.push({
        id: `${e.box}/${e.session.name}`,
        box: e.box,
        session: e.session,
        state: e.state,
        section,
        agent,
        title: e.session.title?.trim() || wt || p?.name || at.location.name,
        project: p?.name ?? at.location.name,
        worktree: wt,
        location: at.location.name,
        path: at.worktree.path,
        main: !!at.worktree.main,
        since: e.session.state_since ?? e.session.created,
        boxMatters: (p?.boxes ?? 1) > 1,
      });
    }
    return out;
  }, [all, data, projects]);
}
