import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { Theme } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { setWindowAppearance } from "@/lib/vibrancy";
import { useRegistry } from "@/plugins/registry";
import { applyTheme } from "@/themes/apply";
import { berthDark, builtinThemes } from "@/themes/builtin";

// useThemes lists every theme: built-in, then ~/.berth/themes, then plugins'.
// A later one with the same id replaces an earlier one.
export function useThemes(): Theme[] {
  const server = useStore((s) => s.serverThemes);
  const fromPlugins = useRegistry((s) => s.themes);
  return useMemo(() => {
    const byId = new Map<string, Theme>();
    for (const t of [...builtinThemes, ...server, ...fromPlugins.map((c) => c.item)]) {
      if (t?.id && t.colors && t.terminal) byId.set(t.id, t);
    }
    return [...byId.values()];
  }, [server, fromPlugins]);
}

// SYSTEM_THEME follows the computer's light or dark appearance, with a
// theme for each (Settings › Appearance; Shipyard Light and Shipyard Dark unless
// chosen).
export const SYSTEM_THEME = "system";

const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;

function useSystemDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      darkQuery?.addEventListener("change", onChange);
      return () => darkQuery?.removeEventListener("change", onChange);
    },
    () => darkQuery?.matches ?? true,
  );
}

export function useActiveTheme(): Theme {
  const themes = useThemes();
  const id = useStore((s) => s.themeId);
  const dark = useSystemDark();
  const system = usePrefs((p) => p.systemThemes);
  if (id !== SYSTEM_THEME) return themes.find((t) => t.id === id) ?? berthDark;
  // A pick that has gone (a theme file removed) falls back to Shipyard's own.
  const want = dark ? system.dark : system.light;
  return themes.find((t) => t.id === want) ?? themes.find((t) => t.id === (dark ? "berth-dark" : "berth-light")) ?? berthDark;
}

// useApplyTheme keeps the document's colors in step with the chosen theme.
export function useApplyTheme() {
  const theme = useActiveTheme();
  const following = useStore((s) => s.themeId) === SYSTEM_THEME;
  useEffect(() => applyTheme(theme), [theme]);
  // The Mac window's material, light or dark with the theme (lib/vibrancy).
  const appearance = following ? null : theme.appearance === "dark" ? "dark" : "light";
  useEffect(() => setWindowAppearance(appearance), [appearance]);
}
