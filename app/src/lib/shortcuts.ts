import { layoutKeys } from "@/lib/key-layout";
import { keyLabels } from "@/lib/keyboard-layout";
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
  // A US keyboard's keys; keysOf shows them on the layout in use.
  keys: string;
  // The e.code the key handler matches its key by, when that is its place
  // and not its character (lib/key-layout.ts).
  code?: string;
  // Set when the item is in the menu bar, as a Tauri accelerator.
  accel?: string;
  count?: number;
  sep?: boolean;
  // How a list names it, when that differs from the menu's label.
  what?: string;
  // Only with Labs on.
  labs?: boolean;
}

export const SHORTCUTS = table.shortcuts as Shortcut[];

// The menu bar's order, which the lists follow too.
export const SHORTCUT_GROUPS: ShortcutGroup[] = ["File", "View", "Go", "Help"];

// describe is what a list of shortcuts calls one.
export const describe = (s: Shortcut) => s.what ?? s.label.replace(/…$/, "");

// keysOf is a shortcut's keys as they read on the keyboard layout in use:
// Back is ⌘[ on a US layout and ⌘Å on a Norwegian one. A component passes
// useKeyLabels()'s labels, so it shows them again when the layout changes.
export const keysOf = (s: Shortcut, labels = keyLabels()) => layoutKeys(s.keys, s.code, labels);

// keysFor is the keys of a shortcut, for a menu item or a hint to show
// ("" for an id the table hasn't).
export const keysFor = (id: string, labels = keyLabels()) => {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? keysOf(s, labels) : "";
};
