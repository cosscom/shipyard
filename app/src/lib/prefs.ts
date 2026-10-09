import { create } from "zustand";

import { type ChatBackground, DEFAULT_CHAT_BACKGROUND, normalizeChatBackground } from "@/lib/chat-background";
import type { HomeLayout } from "@/lib/home-layout";
import { clampWidth, SIDEBAR_DEFAULT } from "@/lib/sidebar-width";
import { load, save } from "@/lib/storage";
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from "@/lib/terminal";

// The person's preferences, kept on this computer.

export interface Prefs {
  terminal: TerminalPrefs;
  notify: { waiting: boolean; finished: boolean; setupFailed: boolean; sound: boolean };
  density: "compact" | "comfortable";
  uiFontSize: number;
  copyOnSelect: boolean;
  // Built-in plugins turned off. The agent's "disabled" marker only covers
  // plugins in ~/.berth/plugins.
  disabledPlugins: string[];
  // Built-in plugins that are off until turned on ("defaultEnabled": false)
  // and have been turned on.
  enabledPlugins: string[];
  // The sidebar folded to a rail of icons (⌘\).
  sidebarCollapsed: boolean;
  // How wide the open sidebar is, dragged by its edge (lib/sidebar-width).
  sidebarWidth: number;
  // Ask before closing a pane or tab stops a shell on its box.
  confirmCloseShells: boolean;
  // What closing an agent's pane or tab does to the agent: stop it (with a
  // moment to undo), leave it running on its box, or ask each time.
  closeAgents: "keep" | "stop" | "ask";
  // Set once the person picks closeAgents themselves (Settings, or "Remember
  // my choice"), so a change of default never overrides them.
  closeAgentsChosen: boolean;
  // How many times closing explained itself ("keeps running", "stopped"); it
  // stops after a few.
  agentCloseTips: number;
  // Labs: the harbour home (no worktree open) and the Terminal |
  // Conversation switch on agent panes. On by default since version 3.
  labs: boolean;
  // Set once the person turns Labs on or off in Settings, so a change of
  // default never overrides them.
  labsChosen: boolean;
  // Labs: how an agent's pane opens, until switched.
  agentView: "terminal" | "conversation";
  // Labs: zen (⌘.): no sidebar or status bar, a switcher for a tab strip,
  // agents as conversations.
  zen: boolean;
  // Labs: how the window is laid out. "sidebar" is the sidebar and tab
  // strip; "workspace" is named workspaces of live agent panes you arrange,
  // with everything else in a strip along the bottom (lib/deck.ts).
  layout: "sidebar" | "workspace";
  // Update a box's berthd as soon as Shipyard ships a newer one
  // (lib/outdated.ts). Off: the status bar offers it instead.
  autoUpdateBoxes: boolean;
  // The picture behind conversations and its effects (Settings ›
  // Appearance › Chat background); none by default.
  chatBackground: ChatBackground;
  // How wide the conversation's column is (Settings › Appearance › Chat).
  chatWidth: ChatWidth;
  // Show the reply Claude is writing as it grows (lib/draft), read from its
  // screen. Off: replies appear once written (Settings › Appearance › Chat).
  chatDrafts: boolean;
  // The Files panel beside the worktree's tabs (⌘⇧E), for every worktree.
  filesPanel: boolean;
  // The themes "Match system" uses by day and when macOS is dark.
  systemThemes: { light: string; dark: string };
  // Home's widgets, in order and size (lib/home-layout.ts). Null until the
  // person customises Home: they get the default layout, which can change.
  home: HomeLayout | null;
  // The agent CLIs the guided install last put on a box (Add a box ›
  // Agents); null until the person chooses, when Claude Code is ticked.
  installAgents: string[] | null;
  // The newest version whose What's new card was shown, or that was
  // running when the card had nothing to show (lib/whats-new.ts).
  whatsNewSeen: string | null;
}

export type ChatWidth = "narrow" | "default" | "wide" | "xwide" | "full";
// The column's widest, as CSS; full is the pane's width less its gutters.
export const CHAT_WIDTHS: Record<ChatWidth, string> = { narrow: "640px", default: "680px", wide: "860px", xwide: "1080px", full: "100%" };

const DEFAULTS: Prefs = {
  terminal: DEFAULT_TERMINAL_PREFS,
  notify: { waiting: true, finished: true, setupFailed: true, sound: false },
  density: "compact",
  uiFontSize: 13,
  copyOnSelect: false,
  disabledPlugins: [],
  enabledPlugins: [],
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT,
  confirmCloseShells: true,
  closeAgents: "stop",
  closeAgentsChosen: false,
  agentCloseTips: 0,
  labs: true,
  labsChosen: false,
  agentView: "terminal",
  zen: false,
  layout: "sidebar",
  autoUpdateBoxes: false,
  chatBackground: DEFAULT_CHAT_BACKGROUND,
  chatWidth: "default",
  chatDrafts: true,
  filesPanel: false,
  systemThemes: { light: "berth-light", dark: "berth-dark" },
  home: null,
  installAgents: null,
  whatsNewSeen: null,
};

// PREFS_VERSION counts changes of default that saved prefs are moved to
// once. 2: closing an agent's tab stops it ("keep" was the default before).
const PREFS_VERSION = 3;

type Saved = Partial<Prefs> & { version?: number };

// migrate brings prefs saved by an older Shipyard up to date. Prefs are saved
// whole, so a "keep" saved before version 2 is only the old default unless
// the person chose it, which closeAgentsChosen records from now on.
export function migratePrefs(saved: Saved): Saved {
  const out = { ...saved };
  if ((saved.version ?? 1) < 2 && Object.keys(saved).length) {
    if ((saved.closeAgents ?? "keep") === "keep" && !saved.closeAgentsChosen) {
      out.closeAgents = "stop";
      out.agentCloseTips = 0;
    }
  }
  // Version 3 turns Labs on: off was only the old default.
  if ((saved.version ?? 1) < 3 && !saved.labsChosen) out.labs = true;
  out.version = PREFS_VERSION;
  return out;
}

const stored = load<Saved>("berth.prefs", {});
// Nothing saved before: a new install (or storage that was cleared), which
// has nothing to catch up on (lib/whats-new.ts).
export const firstRun = !stored || !Object.keys(stored).length;
const saved = migratePrefs(stored ?? {});
const { version: _version, ...savedPrefs } = saved;

export const usePrefs = create<Prefs>()(() => ({
  ...DEFAULTS,
  ...savedPrefs,
  terminal: { ...DEFAULTS.terminal, ...saved.terminal },
  notify: { ...DEFAULTS.notify, ...saved.notify },
  systemThemes: { ...DEFAULTS.systemThemes, ...saved.systemThemes },
  chatBackground: normalizeChatBackground(saved.chatBackground),
  sidebarWidth: clampWidth(saved.sidebarWidth ?? SIDEBAR_DEFAULT),
}));

usePrefs.subscribe((p) => save("berth.prefs", { ...p, version: PREFS_VERSION }));
// The migration is kept at once, not only on the next change.
save("berth.prefs", { ...usePrefs.getState(), version: PREFS_VERSION });

// ?labs=1 turns Labs on, ?zen=1 zen, ?layout=workspace the workspace layout, and ?view=conversation opens agents
// as conversations, for the demo.
{
  const q = new URLSearchParams(location.search);
  if (q.has("labs")) usePrefs.setState({ labs: q.get("labs") !== "0" });
  if (q.has("zen")) usePrefs.setState({ zen: q.get("zen") !== "0" });
  const l = q.get("layout");
  if (l === "sidebar" || l === "workspace") usePrefs.setState({ layout: l });
  const v = q.get("view");
  if (v === "terminal" || v === "conversation") usePrefs.setState({ agentView: v });
}

// The interface's text size scales everything sized in rem, from 13px as
// designed; density is left to styles that read data-density.
function applyUiPrefs(p: Prefs) {
  const root = document.documentElement;
  root.style.fontSize = p.uiFontSize === 13 ? "" : `${(16 * p.uiFontSize) / 13}px`;
  root.dataset.density = p.density;
  // Every chat column reads its width from here (components/conversation).
  root.style.setProperty("--berth-chat-w", CHAT_WIDTHS[p.chatWidth] ?? CHAT_WIDTHS.default);
  // The sidebar reads its width from here; a drag sets it as it goes
  // (components/sidebar/resize-handle.tsx) and saves it here at the end.
  root.style.setProperty("--sidebar-w", `${p.sidebarWidth}px`);
}
applyUiPrefs(usePrefs.getState());
usePrefs.subscribe((p, prev) => {
  if (p.uiFontSize !== prev.uiFontSize || p.density !== prev.density || p.chatWidth !== prev.chatWidth || p.sidebarWidth !== prev.sidebarWidth) applyUiPrefs(p);
});

// useTerminalPrefs is what a terminal needs to draw itself; it changes only
// when one of those settings does.
export function useTerminalPrefs(): TerminalPrefs {
  return usePrefs((p) => p.terminal);
}

export function setPrefs(patch: Partial<Prefs>) {
  usePrefs.setState(patch);
}

export function setChatBackground(patch: Partial<ChatBackground>) {
  usePrefs.setState((p) => ({ chatBackground: { ...p.chatBackground, ...patch } }));
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>) {
  usePrefs.setState((p) => ({ terminal: { ...p.terminal, ...patch } }));
}

// builtinOn says whether a built-in plugin runs: one that is on by default
// until turned off, or off by default until turned on.
export function builtinOn(p: { id: string; defaultEnabled?: boolean }, prefs: Pick<Prefs, "disabledPlugins" | "enabledPlugins"> = usePrefs.getState()): boolean {
  return p.defaultEnabled === false ? (prefs.enabledPlugins ?? []).includes(p.id) : !(prefs.disabledPlugins ?? []).includes(p.id);
}

// setBuiltinOn turns a built-in plugin on or off, against its default.
export function setBuiltinOn(p: { id: string; defaultEnabled?: boolean }, on: boolean) {
  const key = p.defaultEnabled === false ? "enabledPlugins" : "disabledPlugins";
  const list = new Set(usePrefs.getState()[key] ?? []);
  if (on === (key === "enabledPlugins")) list.add(p.id);
  else list.delete(p.id);
  usePrefs.setState({ [key]: [...list] } as Partial<Prefs>);
}
