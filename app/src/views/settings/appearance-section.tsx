import { CheckIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { SimpleSelect } from "@/components/simple-select";
import { Input } from "@/components/ui/input";
import { SYSTEM_THEME, useActiveTheme, useThemes } from "@/hooks/use-theme";
import type { Theme } from "@/lib/api";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { berthThemes } from "@/themes/builtin";
import { ChatBackgroundSettings, ChatWidthSettings } from "@/views/settings/chat-background-section";
import { Segmented } from "@/views/settings/controls";
import { HeaderPictureSettings } from "@/views/settings/header-picture-section";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";
import { Dots, Preview } from "@/views/settings/theme-preview";
import { IS_LINUX } from "@/lib/platform";

const BERTH = new Set(berthThemes.map((t) => t.id));

export function AppearanceSection() {
  const themes = useThemes();
  const themeId = useStore((s) => s.themeId);
  const density = usePrefs((p) => p.density);
  const uiFontSize = usePrefs((p) => p.uiFontSize);
  const [query, setQuery] = useState("");

  const [all, setAll] = useState(false);
  const system = themeId === SYSTEM_THEME;
  const active = useActiveTheme();
  const selectedId = system ? active.id : themeId;

  // Shipyard's own, then every other theme (built-in ports, yours, plugins')
  // by appearance, the best-known first; a search narrows them by name.
  // Unsearched, each group shows a row of four, plus the chosen theme, until
  // Show more.
  const q = query.trim().toLowerCase();
  const shown = q ? themes.filter((t) => t.name.toLowerCase().includes(q) || t.id.includes(q)) : themes;
  const groups = [
    { title: "Shipyard", themes: byFirst(shown.filter((t) => BERTH.has(t.id)), SHIPYARD_FIRST) },
    { title: "Light", themes: byFirst(shown.filter((t) => !BERTH.has(t.id) && t.appearance !== "dark"), LIGHT_FIRST) },
    { title: "Dark", themes: byFirst(shown.filter((t) => !BERTH.has(t.id) && t.appearance === "dark"), DARK_FIRST) },
  ]
    .filter((g) => g.themes.length)
    .map((g) => {
      if (q || all || g.title === "Shipyard") return { ...g, hidden: [] as Theme[] };
      const keep = g.themes.filter((t, i) => i < ROW || t.id === selectedId);
      return { ...g, themes: keep, hidden: g.themes.filter((t) => !keep.includes(t)) };
    });
  const hidden = groups.flatMap((g) => g.hidden);
  const picks = usePrefs((p) => p.systemThemes);
  const mode = system ? "system" : active.appearance === "dark" ? "dark" : "light";
  // Light or Dark keeps the theme when it already is one, else takes the one
  // Match system would use for it.
  const pickMode = (m: "light" | "dark" | "system") => {
    const set = useStore.getState().setTheme;
    if (m === "system") return set(SYSTEM_THEME);
    if (!system && (active.appearance === "dark") === (m === "dark")) return;
    const want = m === "dark" ? picks.dark : picks.light;
    set(themes.some((t) => t.id === want) ? want : m === "dark" ? "berth-dark" : "berth-light");
  };

  return (
    <SettingsPage title="Appearance" description="How Shipyard looks. A theme colours the terminal too.">
      <SettingsGroup
        title="Theme"
        actions={
          <span className="text-desc text-muted-foreground">
            {themes.length} themes · add your own in <span className="font-mono text-mono">~/.berth/themes</span>
          </span>
        }
      >
        <SettingsRow label="Light or dark" description={system ? <SystemNote themes={themes} /> : "Pick a theme below, or follow the computer."}>
          <Segmented
            value={mode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Match system" },
            ]}
            onChange={pickMode}
          />
        </SettingsRow>
        {system && <SystemPicks themes={themes} />}
      </SettingsGroup>
      <section className="-mt-[27px]">
        {groups.map((g, i) => (
          <div key={g.title} className="mt-5 first:mt-0">
            <div className="mb-1 flex h-6 items-center gap-3">
              <h3 className="flex-1 text-desc text-muted-foreground">{g.title}</h3>
              {i === 0 && (
                <div className="relative w-44 shrink-0">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input size="sm" type="search" value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Find a theme" aria-label="Find a theme" className="[&_input]:h-6 [&_input]:pl-7.5 [&_input]:text-meta" />
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-x-3 gap-y-3.5 max-[1100px]:grid-cols-3 max-[800px]:grid-cols-2">
              {g.themes.map((t) => (
                <ThemeCard key={t.id} theme={t} selected={t.id === selectedId} following={system} onSelect={() => useStore.getState().setTheme(t.id)} />
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="text-muted-foreground text-meta">No theme is called “{query.trim()}”.</p>}
        {(hidden.length > 0 || all) && !q && (
          <button type="button" onClick={() => setAll((v) => !v)} className="mt-4 flex max-w-full items-baseline gap-2 text-left text-desc">
            <span className="shrink-0 font-medium">{all ? "Show fewer" : `Show ${hidden.length} more`}</span>
            {!all && <span className="truncate text-muted-foreground">{hidden.map((t) => t.name).join(", ")}</span>}
          </button>
        )}
      </section>

      <HeaderPictureSettings />

      <ChatWidthSettings />

      <ChatBackgroundSettings />

      <SettingsGroup title="Interface">
        <SettingsRow label="Text size" description="Everything outside the terminal. ⌘+ and ⌘− step it from 11 to 20px.">
          <Segmented
            value={String(uiFontSize)}
            options={[
              { value: "12", label: "Small" },
              { value: "13", label: "Default" },
              { value: "14", label: "Large" },
              // A size zoomed to (⌘+, ⌘−) that none of these is.
              ...(uiFontSize < 12 || uiFontSize > 14 ? [{ value: String(uiFontSize), label: `${uiFontSize}px` }] : []),
            ]}
            onChange={(v) => setPrefs({ uiFontSize: Number(v) })}
          />
        </SettingsRow>
        <SettingsRow label="Density" description="How tightly the sidebar and lists are packed.">
          <Segmented
            value={density}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
            onChange={(density) => setPrefs({ density })}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

// The themes each group leads with, the rest after them in the list's order.
const ROW = 4;
const SHIPYARD_FIRST = ["berth-light", "berth-dark", "midnight", "paper"];
const LIGHT_FIRST = ["github-light", "one-light", "catppuccin-latte", "solarized-light"];
const DARK_FIRST = ["dracula", "tokyo-night", "catppuccin-mocha", "nord"];

function byFirst(list: Theme[], first: string[]): Theme[] {
  const rank = (t: Theme) => {
    const i = first.indexOf(t.id);
    return i < 0 ? first.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

// Match system follows the computer's appearance: one theme by day, another
// when macOS is dark (Shipyard Light and Shipyard Dark unless picked here).
function useSystemPair(themes: Theme[]) {
  const picks = usePrefs((p) => p.systemThemes);
  const light = themes.find((t) => t.id === picks.light) ?? themes.find((t) => t.id === "berth-light");
  const dark = themes.find((t) => t.id === picks.dark) ?? themes.find((t) => t.id === "berth-dark");
  return { picks, light, dark };
}

function SystemNote({ themes }: { themes: Theme[] }) {
  const { light, dark } = useSystemPair(themes);
  return (
    <>
      {light?.name ?? "A light theme"} by day, {dark?.name ?? "a dark one"} when {IS_LINUX ? "your desktop" : "macOS"} is dark.
    </>
  );
}

// SystemPicks chooses the pair Match system switches between.
function SystemPicks({ themes }: { themes: Theme[] }) {
  const { picks, light, dark } = useSystemPair(themes);
  if (!light || !dark) return null;
  const pick = (side: "light" | "dark", id: string) => {
    setPrefs({ systemThemes: { ...picks, [side]: id } });
    useStore.getState().setTheme(SYSTEM_THEME);
  };
  const options = (appearance: "light" | "dark") => themes.filter((t) => (t.appearance === "dark") === (appearance === "dark")).map((t) => ({ value: t.id, label: t.name }));
  return (
    <SettingsRow label="By day, and when it's dark" description={IS_LINUX ? "Follows your desktop." : "Follows macOS."}>
      <SimpleSelect size="sm" className="w-40" aria-label="Theme by day" value={light.id} options={options("light")} onChange={(id) => id && pick("light", id)} />
      <SimpleSelect size="sm" className="w-40" aria-label={IS_LINUX ? "Theme when your desktop is dark" : "Theme when macOS is dark"} value={dark.id} options={options("dark")} onChange={(id) => id && pick("dark", id)} />
    </SettingsRow>
  );
}

// ThemeCard previews a theme with its own colors: a sidebar beside a
// terminal, whatever theme the app itself is in. Under Match system the
// theme showing now is ringed more quietly, since it isn't picked itself.
function ThemeCard({ theme, selected, following, onSelect }: { theme: Theme; selected: boolean; following?: boolean; onSelect(): void }) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected && !following} data-testid="theme-option" data-theme-id={theme.id} className="group flex flex-col gap-2 text-left outline-none">
      {/* A picture of the theme (its name says which): its sample text is in
          the theme's terminal colours, which the axe spec leaves out. */}
      <div
        aria-hidden
        data-a11y-skip
        className={cn(
          "relative h-[76px] w-full overflow-hidden rounded-xl border transition-[box-shadow,border-color] group-focus-visible:ring-2 group-focus-visible:ring-ring",
          selected ? "border-transparent ring-2 ring-offset-2 ring-offset-background" : "group-hover:border-foreground/25",
          selected && (following ? "ring-foreground/30" : "ring-foreground"),
        )}
      >
        <Preview theme={theme} />
        <Dots theme={theme} />
      </div>
      <div className="flex items-center gap-2 px-0.5 text-desc">
        <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>{theme.name}</span>
        {selected && (following ? <span className="shrink-0 text-muted-foreground text-meta">Now</span> : <CheckIcon className="size-3.5 shrink-0" />)}
      </div>
    </button>
  );
}
