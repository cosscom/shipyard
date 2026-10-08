import type { BerthEvent, Location, Worktree } from "@/lib/api";
import { agentOf, sessionName } from "@/lib/derive";
import { leaves } from "@/lib/layout";
import { route } from "@/lib/notifications";
import { useStore } from "@/lib/store";
import { activateTab, findSession, focusPane, openTab, refOf, removePane, selectWorktree, splitPane, useWorkspaces, wsKey } from "@/lib/workspaces";

// An agent on a box runs `berthd session new … --open split` (or a task with
// --open tab) to put what it started in front of the person: a split beside
// their focused pane, or a new tab. That happens only when they are looking at
// that worktree, and never takes the keyboard from them; otherwise a
// notification offers to open it.

const agentNames: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", cursor: "Cursor", grok: "Grok CLI" };

function agentLabel(box: string, agent?: string): string {
  if (!agent) return "A terminal";
  const preset = useStore.getState().boxes[box]?.info?.agents?.find((a) => a.id === agent);
  return preset?.name ?? agentNames[agent] ?? agent;
}

function find(box: string, path?: string, location?: string): { loc: Location; wt: Worktree } | undefined {
  const [locName, wtName] = (location ?? "").split("/");
  for (const loc of useStore.getState().boxes[box]?.locations ?? []) {
    const wt = loc.worktrees?.find((w) => w.path === path) ?? (loc.name === locName ? loc.worktrees?.find((w) => (wtName ? w.name === wtName : w.main)) : undefined);
    if (wt) return { loc, wt };
  }
  return undefined;
}

// place shows the session in the worktree's workspace, as a split or a tab.
// focus moves to it only when asked: from the toast's Open, not on arrival.
function place(box: string, loc: Location, wt: Worktree, session: string, how: "split" | "tab", takeFocus: boolean) {
  const key = wsKey(box, wt.path);
  if (useWorkspaces.getState().current !== key || useStore.getState().view.kind !== "workspace") selectWorktree(refOf(box, loc, wt));
  const ws = useWorkspaces.getState().spaces[key];
  const active = ws?.tabs.find((t) => t.id === ws.active);
  const existing = findSession(box, session);
  if (existing && existing.key === key) {
    // A tab of its own, made when the session list refreshed, folds into the
    // split that was asked for; anything else is left where it is.
    const own = ws?.tabs.find((t) => t.id === existing.tab);
    const alone = own && leaves(own.root).length === 1 && own.id !== active?.id;
    if (!(how === "split" && alone && active)) {
      if (takeFocus) focusPane(key, existing.tab, existing.pane.id);
      return;
    }
    removePane(key, existing.tab, existing.pane.id);
  }
  const content = { kind: "terminal" as const, box, session };
  if (how === "split" && active) {
    const before = active.focus;
    const pane = splitPane(key, active.id, before, "row", content);
    focusPane(key, active.id, takeFocus ? pane : before);
    return;
  }
  const keep = useWorkspaces.getState().spaces[key]?.active;
  openTab(content, key);
  if (!takeFocus && keep) activateTab(key, keep);
}

export function handleSessionOpen(e: BerthEvent) {
  if (!e.box || !e.data) return;
  const box = e.box;
  const d = e.data as { name?: string; location?: string; path?: string; open?: string; agent?: string };
  if (!d.name) return;
  const how = d.open === "tab" ? "tab" : "split";
  // The pane needs the session in the store, or it reads as ended.
  void useStore
    .getState()
    .refreshBox(box, ["sessions", "locations"])
    .then(() => {
      const hit = find(box, d.path, d.location);
      if (!hit) return;
      const here = useWorkspaces.getState().current === wsKey(box, hit.wt.path) && useStore.getState().view.kind === "workspace";
      if (here) {
        place(box, hit.loc, hit.wt, d.name!, how, false);
        return;
      }
      // Named as the app names it once listed ("Claude Code 2"), so a second
      // agent in the same worktree reads as a different one.
      const data = useStore.getState().boxes[box];
      const listed = data?.sessions?.find((s) => s.name === d.name);
      const who = listed && agentOf(listed) ? sessionName(listed, { sessions: data?.sessions }) : agentLabel(box, d.agent);
      route({
        category: "opened",
        title: `${who} started in ${hit.wt.main ? hit.loc.name : hit.wt.name}`,
        detail: how === "split" ? "It asked to open beside your terminal." : "It asked to open in a new tab.",
        box,
        path: hit.wt.path,
        session: d.name,
        action: { kind: "session", box, session: d.name! },
        label: "Open",
        run: () => place(box, hit.loc, hit.wt, d.name!, how, true),
        key: `opened|${box}|${d.name}`,
      });
    });
}
