import type { Activate, BerthPluginContext, EventHandler, Project } from "@berth/plugin";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useProjects as useAppProjects } from "@/lib/projects";
import { useWidgetDataIn } from "@/lib/widget-data";
import { NONE, useStore } from "@/lib/store";
import { PaneContext } from "@/lib/pane-context";
import { useHereRef, useWorktreeRef } from "@/lib/workspaces";
import { PluginReactContext, pluginStorage } from "@/plugins/context";
import { contribute } from "@/plugins/registry";

// The runtime half of @berth/plugin: what `import { useBoxes } from
// "@berth/plugin"` resolves to inside a plugin. The types are in
// packages/plugin-sdk; these must match them.

export function definePlugin(activate: Activate): Activate {
  return activate;
}

export function useBerth(): BerthPluginContext {
  const ctx = useContext(PluginReactContext);
  if (!ctx) throw new Error("useBerth must be used in a plugin's component");
  return ctx;
}

export function useBoxes() {
  return useStore((s) => s.status?.boxes ?? NONE);
}

export function useLocations(box: string) {
  return useStore((s) => s.boxes[box]?.locations);
}

export function useSessions(box: string) {
  return useStore((s) => s.boxes[box]?.sessions);
}

// A stable snapshot of every box, for screens that span worktrees on more
// than one machine. Consumers derive sessions from it without dynamic hooks.
export function useFleetSessions() {
  const boxes = useStore((s) => s.boxes);
  return useMemo(() => Object.fromEntries(Object.entries(boxes).map(([name, box]) => [name, box.sessions ?? []])), [boxes]);
}

export function useStats(box: string) {
  return useStore((s) => s.boxes[box]?.stats);
}

// useEvent listens for events while the component is mounted; the latest
// handler is always the one called.
export function useEvent(type: string, handler: EventHandler) {
  const ctx = useContext(PluginReactContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(
    () => contribute("handlers", { plugin: ctx?.id ?? "app", item: { type, handler: (e) => latest.current(e) } }),
    [type, ctx?.id],
  );
}

// useCurrentWorktree is the worktree a plugin's UI is for: inside a pane,
// that pane's (a panel beside another worktree's shows its own); elsewhere,
// the one you are acting in (the focused pane's).
export function useCurrentWorktree() {
  const pane = useContext(PaneContext);
  const own = useWorktreeRef(pane?.worktree);
  const here = useHereRef();
  return pane ? own : here;
}

export function useStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const ctx = useContext(PluginReactContext);
  const store = pluginStorage(ctx?.id ?? "app");
  const [value, setValue] = useState<T>(() => store.get(key, initial));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      pluginStorage(ctx?.id ?? "app").set(key, v);
    },
    [key, ctx?.id],
  );
  return [value, set];
}

// useWidgetData is a Home widget's data, kept in the plugin's storage and
// read again only while the widget is visible (lib/widget-data.ts).
export function useWidgetData<T>(key: string, load: () => Promise<T>, opts: { every: number }) {
  const ctx = useContext(PluginReactContext);
  const id = ctx?.id ?? "app";
  return useWidgetDataIn(pluginStorage(id), id, key, load, opts);
}

// useProjects is the app's projects, trimmed to what plugins need.
export function useProjects(): Project[] {
  const { projects } = useAppProjects();
  return useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        remote: p.remote,
        defaultBox: p.defaultBox,
        members: p.members.map((m) => ({ box: m.box.name, online: m.box.state === "online", location: m.loc })),
      })),
    [projects],
  );
}

export function worktreeLocation(w: { location: string; worktree: string; main?: boolean }) {
  return w.main ? w.location : `${w.location}/${w.worktree}`;
}

// sessionName is what the app calls a session: its title ("Fix checkout
// webhook"), or "Claude Code", "Shell 2"; with place "shop / checkout-fix ·
// Codex". See lib/derive.ts.
export { sessionName } from "@/lib/derive";
