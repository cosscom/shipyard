import { useStore } from "@/lib/store";

// Settings' sections and how to open one, apart from the view itself, which
// loads when it is first shown (App.tsx).
export type SettingsSectionId = "general" | "notifications" | "appearance" | "terminal" | "boxes" | "computers" | "phone" | "agents" | "plugins" | "shortcuts" | "labs" | "about" | "developer";

// openSettings shows Settings, on a section when given one.
export function openSettings(section?: SettingsSectionId) {
  useStore.getState().setView({ kind: "settings", section });
}
