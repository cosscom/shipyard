import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { isTauri } from "@/lib/api";
import { IS_LINUX, LINUX_TERMINAL_KEYS, platformKeys } from "@/lib/platform";
import { usePrefs } from "@/lib/prefs";
import { useCommandLayout } from "@/lib/command-nav";
import { describe, SHORTCUT_GROUPS, SHORTCUTS } from "@/lib/shortcuts";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Every shortcut, searchable, grouped as the menu bar groups them; the same
// table as the Keyboard shortcuts sheet (lib/shortcuts.json).
export function ShortcutsSection() {
  const [query, setQuery] = useState("");
  const labs = usePrefs((p) => p.labs);
  const command = useCommandLayout();
  const q = query.trim().toLowerCase();
  const grouped = SHORTCUT_GROUPS.map((title) => ({
    title,
    items: SHORTCUTS.filter((s) => s.group === title && (!q || describe(s).toLowerCase().includes(q) || platformKeys(s.keys).toLowerCase().includes(q))),
  })).filter((g) => g.items.length > 0);

  return (
    <SettingsPage
      title="Shortcuts"
      description={IS_LINUX ? LINUX_TERMINAL_KEYS : `They work everywhere in the window, terminals included: the app sees them first.${isTauri() ? " Most are in the menu bar too." : ""}`}
    >
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input size="sm" className="ps-7" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts" />
      </div>
      {grouped.length === 0 && <p className="text-muted-foreground text-sm">No shortcut matches “{query}”.</p>}
      {grouped.map((g) => (
        <SettingsGroup key={g.title} title={g.title}>
          {g.items.map((s) => (
            <SettingsRow key={s.id} label={describe(s)} className="min-h-10 py-2">
              <span className="flex items-center gap-2">
                {s.layout ? !command && <Badge variant="outline">Command layout</Badge> : s.labs && !labs && <Badge variant="outline">Labs</Badge>}
                <Kbd>{s.keys}</Kbd>
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
    </SettingsPage>
  );
}
