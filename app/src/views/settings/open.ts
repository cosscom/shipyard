import { type View, useStore } from "@/lib/store";

// Settings' sections and how to open one, apart from the view itself, which
// loads when it is first shown (App.tsx).
export type SettingsSectionId = "general" | "notifications" | "appearance" | "terminal" | "boxes" | "computers" | "phone" | "agents" | "integrations" | "secrets" | "plugins" | "shortcuts" | "labs" | "about" | "developer";

// openSettings shows Settings, on a section when given one.
export function openSettings(section?: SettingsSectionId) {
  useStore.getState().setView({ kind: "settings", section });
}

// Settings is a page of its own, so leaving it goes back to wherever it was
// opened from: the view before it, however it was opened.
let before: View = { kind: "workspace" };
useStore.subscribe((s, prev) => {
  if (s.view.kind === "settings" && prev.view.kind !== "settings") before = prev.view;
});

export function closeSettings() {
  useStore.getState().setView(before);
}
