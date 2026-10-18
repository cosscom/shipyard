import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { Group, GroupSeparator } from "@/components/ui/group";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { load, save } from "@/lib/storage";
import { SYNC_MODES, type SyncMode } from "@/lib/worktrees";

// The mode the Sync button runs: the one picked last, here and in the bulk
// bar alike.
const useSyncMode = create<{ mode: SyncMode; set(m: SyncMode): void }>((set) => ({
  mode: load<SyncMode>("berth.worktrees.syncMode", "rebase"),
  set: (mode) => {
    save("berth.worktrees.syncMode", mode);
    set({ mode });
  },
}));

const short: Record<SyncMode, string> = { rebase: "Rebase", merge: "Merge", pull: "Fast-forward" };
const verb: Record<SyncMode, string> = { rebase: "by rebasing onto it", merge: "by merging it in", pull: "by fast-forwarding, if it has no commits of its own" };

// SyncButton syncs with the base in the mode its label names; the menu
// only picks the mode (and keeps it), so choosing one never runs a bulk git
// operation by itself: the button does. With paused, the menu also says
// whether paused worktrees take part.
export function SyncButton({
  disabled,
  onSync,
  size = "sm",
  count,
  base = "its base",
  paused,
}: {
  disabled?: boolean;
  onSync(mode: SyncMode): void;
  size?: "sm" | "xs";
  // How many it would sync, when not every selected worktree.
  count?: number;
  base?: string;
  paused?: { count: number; include: boolean; onChange(include: boolean): void };
}) {
  const { mode, set } = useSyncMode();
  return (
    <Group>
      <Tooltip>
        <TooltipTrigger render={<Button size={size} variant="outline" disabled={disabled || count === 0} onClick={() => onSync(mode)} />}>
          <RefreshCwIcon />
          {short[mode]}
          {count !== undefined && <span className="tabular-nums">{count}</span>}
        </TooltipTrigger>
        <TooltipPopup>
          Sync with {base} {verb[mode]}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger render={<Button size={size === "sm" ? "icon-sm" : "icon-xs"} variant="outline" disabled={disabled} aria-label="Sync with…" />}>
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-64">
          <MenuGroup>
            <MenuGroupLabel>Sync with the base by</MenuGroupLabel>
            <MenuRadioGroup value={mode} onValueChange={(v) => set(v as SyncMode)}>
              {SYNC_MODES.map((m) => (
                <MenuRadioItem key={m.value} value={m.value} closeOnClick>
                  <span className="flex flex-col">
                    <span>{m.label}</span>
                    <span className="text-muted-foreground text-meta">{m.hint}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {paused && paused.count > 0 && (
            <>
              <MenuSeparator />
              <MenuCheckboxItem checked={paused.include} onCheckedChange={(v) => paused.onChange(!!v)}>
                Include paused ({paused.count})
              </MenuCheckboxItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
