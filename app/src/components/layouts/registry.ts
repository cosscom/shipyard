import type { ComponentType } from "react";

import { usePrefs } from "@/lib/prefs";

// The window's layouts (Labs). Settings › Labs › Layout lists them, prefs
// keep the one picked by its id (prefs.layout, ?layout=<id> in the mock),
// and App.tsx draws it. "sidebar" is the app as it is and the default.
//
// A layout is one entry here. It says what goes where around the window's
// main area; App keeps everything else (the tab strip, the panes, the
// views, the dialogs):
//
//   side    replaces the sidebar at the window's left. null: nothing there.
//   top     a bar across the window's top, over the tab strip and every
//           view. It leaves the macOS window buttons room itself.
//   bottom  replaces the status bar. null: no status bar.
//   overlay mounted once beside the dialogs: a switcher, its own keys.
//
// Omit side or bottom to keep the sidebar or the status bar. With no side
// and no top, App leaves the window buttons room over the strip itself.

export interface Layout {
  id: string;
  label: string;
  // One line for Settings: what it puts first.
  description: string;
  side?: ComponentType | null;
  top?: ComponentType;
  bottom?: ComponentType | null;
  overlay?: ComponentType;
}

export const DEFAULT_LAYOUT = "sidebar";

export const LAYOUTS: Layout[] = [
  { id: "sidebar", label: "Sidebar", description: "Places, then every project and its worktrees down the left. The app as it is." },
];

// layoutById is a layout by its id; one this Shipyard doesn't know (a
// newer one's, or one taken away) is the sidebar.
export function layoutById(id: string | undefined): Layout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS.find((l) => l.id === DEFAULT_LAYOUT)!;
}

export function useLayout(): Layout {
  return layoutById(usePrefs((p) => p.layout));
}
