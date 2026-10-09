import { EllipsisIcon, SearchIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { type Item, askText } from "@/components/layouts/model";
import { MoreItems, type NavItem, useArrangedNav } from "@/components/sidebar/nav";
import { Tip } from "@/components/tip";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { hasTrafficLights } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { platformKeys } from "@/lib/platform";
import { useLiveStep } from "@/views/home/widgets/agents";

// The pieces the Labs layouts share: what an agent is doing, the places,
// and the buttons kept in reach (search, Settings).

// trafficPad leaves the macOS window buttons room at a bar's left.
export const trafficPad = () => (hasTrafficLights() ? "pl-[84px]" : "pl-2");

// useDoing is what an item is doing, in a few words: what a waiting agent
// asks, the step a working one is on (read from its screen while shown),
// or nothing to add.
export function useDoing(i: Item, live = true): string | undefined {
  const step = useLiveStep(i.box, i.session?.name ?? "", i.agent ?? "", live && i.lane === "running" && !!i.session);
  if (i.lane === "away") return `${i.box} is away`;
  if (i.lane === "waiting") return askText(i.session) ?? "Waiting for you";
  if (i.lane === "running") return step?.now ?? "Working…";
  return undefined;
}

// ItemGlyph is the state, or a plain dot for a worktree with no agent.
export function ItemGlyph({ i, className }: { i: Item; className?: string }) {
  if (i.lane === "away") return <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}><span className="size-2 rounded-full border border-muted-foreground/60 border-dashed" /></span>;
  if (i.state) return <StateGlyph state={i.state} className={className} />;
  return <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}><span className="size-1.5 rounded-full bg-muted-foreground/50" /></span>;
}

// BoxTag names the box quietly, and only where it tells you something.
export function BoxTag({ i, always }: { i: Item; always?: boolean }) {
  if (!always && !i.spansBoxes) return null;
  return <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">{i.box}</span>;
}

// SearchButton opens ⌘K.
export function SearchButton({ wide, className }: { wide?: boolean; className?: string }) {
  const open = () => useStore.getState().setPaletteOpen(true);
  if (!wide)
    return (
      <Tip label={<span className="flex items-center gap-1.5">Search <Kbd>{platformKeys("⌘K")}</Kbd></span>}>
        <IconButton label="Search" onClick={open} className={className}>
          <SearchIcon />
        </IconButton>
      </Tip>
    );
  return (
    <button type="button" onClick={open} className={cn("flex h-7 min-w-0 items-center gap-2 rounded-lg border border-sidebar-border bg-background/50 px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent", className)}>
      <SearchIcon className="size-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">Search</span>
      <Kbd className="h-4.5 text-[10px]">{platformKeys("⌘K")}</Kbd>
    </button>
  );
}

export function SettingsButton({ withLabel, className }: { withLabel?: boolean; className?: string }) {
  const active = useStore((s) => s.view.kind === "settings");
  const go = (e: React.MouseEvent) => useStore.getState().setView({ kind: "settings", section: e.shiftKey ? "developer" : undefined });
  if (withLabel)
    return (
      <button
        type="button"
        data-testid="nav-settings"
        aria-current={active ? "page" : undefined}
        onClick={go}
        className={cn("inline-flex h-6.5 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-sidebar-accent hover:text-foreground", active && "text-foreground", className)}
      >
        <SettingsIcon className="size-3.5" />
        Settings
      </button>
    );
  return (
    <Tip label="Settings">
      <IconButton label="Settings" testid="nav-settings" active={active} onClick={go} className={className}>
        <SettingsIcon />
      </IconButton>
    </Tip>
  );
}

export function IconButton({ label, children, onClick, active, className, testid }: { label: string; children: ReactNode; onClick(e: React.MouseEvent): void; active?: boolean; className?: string; testid?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testid}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
        active && "bg-sidebar-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

// usePlaces is the person's places (lib/nav) less Home, which each layout
// has its own way to.
export function usePlaces() {
  const { pinned, more } = useArrangedNav();
  const home = [...pinned, ...more].find((n) => n.id === "home");
  return { home, pinned: pinned.filter((n) => n.id !== "home"), more: more.filter((n) => n.id !== "home") };
}

// PlaceButton is a place as a small labelled button with its count.
export function PlaceButton({ n, iconOnly, className }: { n: NavItem; iconOnly?: boolean; className?: string }) {
  const btn = (
    <button
      type="button"
      data-testid={`nav-${n.id}`}
      aria-label={iconOnly ? n.label : undefined}
      aria-current={n.active ? "page" : undefined}
      onClick={n.go}
      className={cn(
        "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md text-[13px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
        iconOnly ? "w-7 justify-center" : "px-2",
        n.active && "bg-sidebar-accent text-foreground",
        className,
      )}
    >
      {n.icon}
      {!iconOnly && n.label}
      {n.badge &&
        (iconOnly ? (
          <span className={cn("absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-1 text-center font-medium text-[9px] leading-3.5 tabular-nums", n.badge.loud ? "bg-warning text-warning-foreground" : "bg-muted-foreground/25 text-foreground")}>{n.badge.count}</span>
        ) : (
          <span className={cn("text-xs tabular-nums", n.badge.loud ? "text-warning-foreground" : "text-muted-foreground")}>{n.badge.count}</span>
        ))}
    </button>
  );
  return iconOnly ? <Tip label={n.badge ? `${n.label} · ${n.badge.title}` : n.label}>{btn}</Tip> : btn;
}

// MorePlaces is the places that aren't pinned, as a menu.
export function MorePlaces({ more, side = "bottom", align = "end" }: { more: NavItem[]; side?: "bottom" | "top" | "right"; align?: "start" | "end" }) {
  if (!more.length) return null;
  const active = more.some((n) => n.active);
  return (
    <Menu>
      <Tip label="More places">
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="More places"
              data-testid="nav-more"
              className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent", active && "bg-sidebar-accent text-foreground")}
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
      </Tip>
      <MenuPopup side={side} align={align} className="min-w-52">
        <MoreItems more={more} />
      </MenuPopup>
    </Menu>
  );
}

