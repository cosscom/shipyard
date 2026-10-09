import table from "@/lib/shortcuts.json";

// The app's keyboard shortcuts, from shortcuts.json: the one table the key
// handler (hooks/use-shortcuts), the Keyboard shortcuts sheet, Settings →
// Shortcuts and the Mac app's menu bar (src-tauri/src/lib.rs) all read.

export type ShortcutGroup = "File" | "View" | "Go" | "Help";

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  // The menu item's name; with count, {n} is each item's number.
  label: string;
  keys: string;
  // Set when the item is in the menu bar, as a Tauri accelerator.
  accel?: string;
  count?: number;
  sep?: boolean;
  // How a list names it, when that differs from the menu's label.
  what?: string;
  // Only with Labs on.
  labs?: boolean;
  // Only in that layout (Labs › Layout).
  layout?: "command";
}

export const SHORTCUTS = table.shortcuts as Shortcut[];

// The menu bar's order, which the lists follow too.
export const SHORTCUT_GROUPS: ShortcutGroup[] = ["File", "View", "Go", "Help"];

// describe is what a list of shortcuts calls one.
export const describe = (s: Shortcut) => s.what ?? s.label.replace(/…$/, "");

// keysFor is the keys of a shortcut, for a menu item or a hint to show.
export const keysFor = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys;

// shortcutLive says whether a shortcut does something with these prefs.
export const shortcutLive = (s: Shortcut, p: { labs: boolean; layout: string; zen: boolean }) => (!s.labs || p.labs) && (!s.layout || (p.labs && !p.zen && p.layout === s.layout));
