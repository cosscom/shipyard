import { create } from "zustand";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ZoomHud } from "@/components/zoom-hud";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { isTauri } from "@/lib/api";
import { IS_LINUX, LINUX_TERMINAL_KEYS } from "@/lib/platform";
import { usePrefs } from "@/lib/prefs";
import { useCommandLayout } from "@/lib/command-nav";
import { describe, SHORTCUT_GROUPS, SHORTCUTS } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";

// The Keyboard shortcuts sheet (Help → Keyboard shortcuts, ⌘/, or ⌘K): every
// shortcut, grouped as the menu bar groups them, from the same table.

const useShortcutsSheet = create<{ open: boolean }>()(() => ({ open: false }));
export const toggleShortcuts = () => useShortcutsSheet.setState((s) => ({ open: !s.open }));
export const openShortcuts = () => useShortcutsSheet.setState({ open: true });

export function ShortcutsSheet() {
  const open = useShortcutsSheet((s) => s.open);
  const labs = usePrefs((p) => p.labs);
  const command = useCommandLayout();
  const close = () => useShortcutsSheet.setState({ open: false });
  return (
    <Sheet open={open} onOpenChange={(o) => useShortcutsSheet.setState({ open: o })}>
      {/* The zoom HUD (⌘+, ⌘−, ⌘0) lives with the sheet that lists those keys. */}
      <ZoomHud />
      <SheetPopup className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>
            {IS_LINUX ? (
              LINUX_TERMINAL_KEYS
            ) : (
              <>
                They work everywhere in the window, terminals included.{" "}
                {isTauri() ? "You’ll find them in the menu bar too, under File, View, Go and Help." : "In the Mac app they’re in the menu bar too."}
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-1 font-medium text-muted-foreground text-xs">{group}</h3>
              <ul className="flex flex-col">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <li key={s.id} className="flex min-h-7.5 items-center gap-2 border-b border-dashed py-0.5 text-sm last:border-b-0">
                    <span className="min-w-0 flex-1 truncate">{describe(s)}</span>
                    {s.layout ? !command && <Badge variant="outline">Command layout</Badge> : s.labs && !labs && <Badge variant="outline">Labs</Badge>}
                    <Kbd className="text-foreground/80">{s.keys}</Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </SheetPanel>
        <SheetFooter>
          <Button
            variant="ghost"
            onClick={() => {
              close();
              useStore.getState().setView({ kind: "settings", section: "shortcuts" });
            }}
          >
            Search them in Settings
          </Button>
          <Button onClick={close}>Done</Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
