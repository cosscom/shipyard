import { useSyncExternalStore } from "react";

import { usePrefs } from "@/lib/prefs";

// The Mac app's window is see-through, with macOS's sidebar material (as in
// Finder) behind the webview: src-tauri/tauri.macos.conf.json. native-vibrancy
// on <html> lets it show: the window's backdrop paints the theme's sidebar
// colour part-way see-through and the sidebar paints nothing over it
// (--window and --sidebar-surface in index.css), and the content's card is
// a darker glass on it (--content).
// A page in a browser and the Linux app have an opaque window and never get
// the class. Settings › Appearance › Translucent sidebar turns it off.
export const NATIVE_VIBRANCY = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Mac/.test(`${navigator.platform} ${navigator.userAgent}`);

function apply(on: boolean) {
  document.documentElement.classList.toggle("native-vibrancy", on);
}

if (NATIVE_VIBRANCY) {
  apply(usePrefs.getState().translucentSidebar);
  usePrefs.subscribe((p, prev) => {
    if (p.translucentSidebar !== prev.translucentSidebar) apply(p.translucentSidebar);
  });
}

// useVibrancy is whether native-vibrancy is on <html> now: for what CSS
// can't reach, as a terminal's canvas (TerminalView). It reads the class
// itself, so it follows the setting and whatever else puts it there.
const onClass = (fn: () => void) => {
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
};
export function useVibrancy(): boolean {
  return useSyncExternalStore(
    onClass,
    () => document.documentElement.classList.contains("native-vibrancy"),
    () => false,
  );
}

// The material is light or dark by the window's appearance, not the page's,
// so the window takes the theme's: a dark theme on a light Mac gets dark
// glass. Null (Match system) gives it back to macOS; pinning it there would
// also pin the page's prefers-color-scheme, which Match system reads.
export function setWindowAppearance(appearance: "light" | "dark" | null) {
  if (!NATIVE_VIBRANCY) return;
  void import("@tauri-apps/api/window").then((w) => w.getCurrentWindow().setTheme(appearance)).catch(() => {});
}
