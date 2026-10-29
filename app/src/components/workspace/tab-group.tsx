import { CloudOffIcon, FoldHorizontalIcon, PaletteIcon, PencilIcon, UnfoldHorizontalIcon, XIcon } from "lucide-react";

import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import { Tip } from "@/components/tip";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubPopup, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { MenuRadioGroup, MenuRadioItem } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { armDrag } from "@/components/workspace/tab-drag";
import { TabButton } from "@/components/workspace/tab-strip";
import { useLabel, useTone } from "@/components/workspace/worktree-tone";
import { closeTab } from "@/lib/actions";
import { TONES, toneVar } from "@/lib/groups";
import { removalLabel, useRemoval } from "@/lib/removing";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { findWorktree } from "@/lib/worktree-names";
import { activateTab, closeGroup, focusGroup, foldGroup, setTone, tabBeside, unsplitTab, useWorkspaces } from "@/lib/workspaces";

// TabGroup (Labs) is one worktree's run of tabs in a strip shared with
// others: its name in its colour, then its tabs, underlined in that colour.
// The group in front has the solid label; any tab of another brings that
// one forward, and with it the breadcrumb, Run, ⌘T and the palette. The
// label folds the group to its name and tab count; its menu folds, colours
// and closes it (the worktree and its agents carry on).
// compact: a narrow window's chip for a group not in front, its dot and
// name only.
export function TabGroup({ wsKey, front, folded, many, compact }: { wsKey: string; front: boolean; folded: boolean; many: boolean; compact?: boolean }) {
  const ws = useWorkspaces((s) => s.spaces[wsKey]);
  const tone = useTone(wsKey);
  if (!ws || !tone) return null;
  const go = (tab: string) => {
    if (!front) focusGroup(wsKey);
    activateTab(wsKey, tab);
  };
  return (
    // Not positioned: the strip measures its tabs' offsets from itself.
    <div data-group={wsKey} className="flex shrink-0 items-center gap-1 self-stretch" style={{ boxShadow: `inset 0 -2px 0 color-mix(in oklab, ${tone} ${front ? 100 : 40}%, transparent)` }}>
      <GroupLabel wsKey={wsKey} front={front} folded={folded} count={ws.tabs.length} tone={tone} many={many} compact={compact} />
      {!folded &&
        ws.tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            wsKey={wsKey}
            tone={tone}
            active={front && t.id === ws.active}
            onActivate={() => go(t.id)}
            onClose={() => void closeTab(wsKey, t.id)}
            onDrag={(e, label, icon) => armDrag(e, { kind: "tab", key: wsKey, tab: t.id }, label, icon)}
            onSplit={ws.tabs.length > 1 ? (dir) => tabBeside(wsKey, t.id, dir) : undefined}
            onUnsplit={() => unsplitTab(wsKey, t.id)}
          />
        ))}
    </div>
  );
}

function GroupLabel({ wsKey, front, folded, count, tone, many, compact }: { wsKey: string; front: boolean; folded: boolean; count: number; tone: string; many: boolean; compact?: boolean }) {
  const { label, ref } = useLabel(wsKey);
  const away = useStore((s) => !!ref && !!s.status && s.status.boxes.find((b) => b.name === ref.box)?.state !== "online");
  const leaving = useRemoval(ref?.box ?? "", ref?.path);
  const picked = useWorkspaces((s) => s.tones?.[wsKey]);
  // A renamed worktree's own name follows its title.
  const own = ref && !ref.main && label !== ref.worktree && !label.startsWith(`${ref.worktree} `) ? ` (${ref.worktree})` : "";
  const where = ref ? `${label}${own} on ${ref.box}` : label;
  const tip = leaving ? `${where} · ${removalLabel(leaving)}` : away ? `${where} · ${ref?.box} is offline` : folded ? `${where} · ${count} ${count === 1 ? "tab" : "tabs"}, folded` : where;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex shrink-0 items-stretch" />}>
        <Tip label={<span className="flex flex-col">{tip}<span className="text-muted-foreground">Click to {folded ? "unfold" : "fold"}, right-click for more</span></span>} side="bottom" align="start">
          <button
            type="button"
            data-group-label={wsKey}
            aria-label={`${label} tab group, ${count} ${count === 1 ? "tab" : "tabs"}${front ? ", in front" : ""}${folded ? ", folded" : ""}${leaving ? `, ${removalLabel(leaving)}` : away ? `, ${ref?.box} is offline` : ""}`}
            aria-expanded={!folded}
            onClick={() => {
              if (folded) {
                foldGroup(wsKey, false);
                focusGroup(wsKey);
              } else foldGroup(wsKey, true);
            }}
            className="group/label flex shrink-0 items-center px-1.5 outline-none"
          >
            <span
              className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 font-medium text-tag transition-opacity group-focus-visible/label:ring-2 group-focus-visible/label:ring-ring group-focus-visible/label:ring-offset-1 group-focus-visible/label:ring-offset-sidebar", compact ? "max-w-28" : "max-w-40", (away || leaving) && "opacity-55")}
              style={front ? { background: tone, color: "var(--background)" } : { background: `color-mix(in oklab, ${tone} 15%, transparent)`, color: tone }}
            >
              {leaving ? <Spinner className="size-3" /> : away ? <CloudOffIcon className="size-3" aria-hidden /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: front ? "var(--background)" : tone }} />}
              <span className="truncate">{label}</span>
              {folded && !compact && <span className="tabular-nums opacity-75">{count}</span>}
            </span>
          </button>
        </Tip>
      </ContextMenuTrigger>
      <ContextMenuPopup className="min-w-52">
        <ContextMenuItem onClick={() => foldGroup(wsKey, !folded)}>
          {folded ? <UnfoldHorizontalIcon /> : <FoldHorizontalIcon />}
          <span className="flex-1">{folded ? "Unfold" : "Fold to its name"}</span>
        </ContextMenuItem>
        {ref && !ref.main && (
          <ContextMenuItem
            onClick={() => {
              const at = findWorktree(ref.box, ref.path);
              if (at) openRenameWorktree(ref.box, at.loc, at.wt, { inPlace: false });
            }}
          >
            <PencilIcon />
            <span className="flex-1">Rename worktree…</span>
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <PaletteIcon />
            Colour
          </ContextMenuSubTrigger>
          <ContextMenuSubPopup className="min-w-40">
            <ContextMenuRadioGroup value={picked ?? "auto"} onValueChange={(v) => setTone(wsKey, v === "auto" ? undefined : String(v))}>
              <ContextMenuRadioItem value="auto">Automatic</ContextMenuRadioItem>
              {TONES.map((t) => (
                <ContextMenuRadioItem key={t} value={t}>
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-2.5 rounded-full" style={{ background: toneVar(t) }} />
                    {t[0].toUpperCase() + t.slice(1)}
                  </span>
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubPopup>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!many} onClick={() => closeGroup(wsKey)}>
          <XIcon />
          <span className="flex-1">Close group</span>
          {front && <ContextMenuShortcut>⌘⇧W</ContextMenuShortcut>}
        </ContextMenuItem>
        <p className="max-w-52 px-2 pt-0.5 pb-1.5 text-muted-foreground text-meta">Its tabs leave the strip; the worktree and its agents carry on.</p>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

// ToneItems picks a worktree's colour, for the sidebar's worktree menu.
export function ToneItems({ wsKey }: { wsKey: string }) {
  const picked = useWorkspaces((s) => s.tones?.[wsKey]);
  return (
    <MenuRadioGroup value={picked ?? "auto"} onValueChange={(v) => setTone(wsKey, v === "auto" ? undefined : String(v))}>
      <MenuRadioItem value="auto">Automatic</MenuRadioItem>
      {TONES.map((t) => (
        <MenuRadioItem key={t} value={t}>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: toneVar(t) }} />
            {t[0].toUpperCase() + t.slice(1)}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
