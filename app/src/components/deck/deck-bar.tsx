import { Columns3Icon, EllipsisIcon, GitBranchPlusIcon, HouseIcon, InboxIcon, LayoutGridIcon, Maximize2Icon, PencilIcon, PinIcon, PlusIcon, SearchIcon, SettingsIcon, WorkflowIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { NotificationBell } from "@/components/notifications/notification-center";
import { MoreItems, useNavItems } from "@/components/sidebar/nav";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { runShortcut } from "@/hooks/use-shortcuts";
import { hasTrafficLights } from "@/lib/api";
import { closeDeck, type Deck, deckTab, frontDeck, keepAsDeck, newDeck, renameDeck, seedDecks, setArrange, showDeck, showDeckHome, toggleZoom, useDecks } from "@/lib/deck";
import { sessionState } from "@/lib/derive";
import { arranged, leaves } from "@/lib/layout";
import { platformKeys } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";
import { shortLabel } from "@/lib/worktree-names";

// DeckBar is the workspace layout's one bar across the top, in place of the
// sidebar and the tab strip: home, your named workspaces as tabs (⌘1–9),
// how the one in front is tiled, then starting work, search and the places
// (Review, Automations, Settings). It drags the window.
export function DeckBar() {
  useEffect(seedDecks, []);
  const decks = useDecks((s) => s.decks);
  const view = useStore((s) => s.view);
  const home = useDecks((s) => !!s.home);
  // Read so the bar redraws as what shows changes.
  const current = useWorkspaces((s) => s.current);
  const spaces = useWorkspaces((s) => s.spaces);
  const front = useMemo(() => frontDeck({ current, spaces }, useDecks.getState(), view.kind), [current, spaces, view.kind, decks, home]);
  const t = deckTab(front, spaces);
  const arrange = arranged(front?.arrange ?? "auto", t ? leaves(t.root).length : 0);
  const nav = useNavItems();
  const place = useMemo(() => nav.find((n) => n.active && n.id !== "home"), [nav]);
  const settings = view.kind === "settings" || view.kind === "project";
  // A worktree's tab opened some other way (⌘K): not a workspace yet.
  const stray = view.kind === "workspace" && !front && current && spaces[current] ? spaces[current] : undefined;
  const boxes = useStore((s) => s.boxes);

  return (
    <div data-tauri-drag-region data-deck-bar className={cn("flex h-11 shrink-0 items-center gap-1 border-b bg-background pr-2", hasTrafficLights() ? "pl-[84px]" : "pl-2")}>
      <Tip label="Home: start work, and every agent">
        <Button
          size="icon-sm"
          variant="ghost"
          data-testid="nav-home"
          aria-label="Home"
          aria-current={view.kind === "workspace" && !current && (home || !front) ? "page" : undefined}
          className="aria-[current=page]:bg-accent"
          onClick={showDeckHome}
        >
          <HouseIcon />
        </Button>
      </Tip>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <div role="tablist" aria-label="Workspaces" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {decks.map((d, i) => (
          <DeckTab key={d.id} deck={d} index={i} on={front?.id === d.id} />
        ))}
        {stray && (
          <span className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-dashed pr-0.5 pl-2.5 text-sm">
            <span className="max-w-40 truncate">{shortLabel(stray.ref, boxes)}</span>
            <Tip label="Keep it as a workspace">
              <Button size="icon-xs" variant="ghost" aria-label="Keep as a workspace" onClick={() => keepAsDeck(shortLabel(stray.ref, boxes))}>
                <PinIcon />
              </Button>
            </Tip>
          </span>
        )}
        {(place || settings) && (
          <span role="tab" aria-selected className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent pr-0.5 pl-2.5 font-medium text-sm">
            <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{settings ? <SettingsIcon /> : place?.icon}</span>
            {settings ? "Settings" : place?.label}
            <Tip label="Back to your workspace">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close"
                onClick={() => {
                  const a = useDecks.getState().active;
                  if (a) showDeck(a);
                  else useStore.getState().setView({ kind: "workspace" });
                }}
              >
                <XIcon />
              </Button>
            </Tip>
          </span>
        )}
        <Tip label="New workspace">
          <Button size="icon-sm" variant="ghost" aria-label="New workspace" className="shrink-0 text-muted-foreground" onClick={() => newDeck()}>
            <PlusIcon />
          </Button>
        </Tip>
      </div>
      <div data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
      {front && t && leaves(t.root).length > 1 && (
        <div className="flex items-center gap-1 max-[899px]:hidden">
          <ToggleGroup size="sm" variant="outline" value={[t.zoomed ? "zoom" : arrange]} aria-label="Arrange panes" onValueChange={(v) => (v[0] === "zoom" ? !t.zoomed && toggleZoom() : v[0] && setArrange(v[0] as "columns" | "grid"))}>
            <Tip label="Side by side">
              <ToggleGroupItem value="columns" aria-label="Side by side" className="h-7! min-w-8! px-1.5!">
                <Columns3Icon className="size-4" />
              </ToggleGroupItem>
            </Tip>
            <Tip label="Grid">
              <ToggleGroupItem value="grid" aria-label="Grid" className="h-7! min-w-8! px-1.5!">
                <LayoutGridIcon className="size-4" />
              </ToggleGroupItem>
            </Tip>
            <Tip label={<span className="flex items-center gap-2">Zoom the focused pane <span className="text-muted-foreground">{platformKeys("⌘⇧↵")}</span></span>}>
              <ToggleGroupItem value="zoom" aria-label="Zoom" className="h-7! min-w-8! px-1.5!">
                <Maximize2Icon className="size-3.5" />
              </ToggleGroupItem>
            </Tip>
          </ToggleGroup>
          <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => runShortcut("new-worktree", "menu")}>
        <GitBranchPlusIcon />
        <span className="max-[999px]:hidden">New task</span>
        <Kbd className="max-[999px]:hidden">⌘N</Kbd>
      </Button>
      <Tip label={<span className="flex items-center gap-2">Search everything <span className="text-muted-foreground">⌘K</span></span>}>
        <Button size="icon-sm" variant="ghost" aria-label="Search" onClick={() => useStore.getState().setPaletteOpen(true)}>
          <SearchIcon />
        </Button>
      </Tip>
      <Places />
      <NotificationBell />
      <Tip label="Settings">
        <Button size="icon-sm" variant="ghost" data-testid="nav-settings" aria-label="Settings" aria-current={settings ? "page" : undefined} className="aria-[current=page]:bg-accent" onClick={() => useStore.getState().setView({ kind: "settings" })}>
          <SettingsIcon />
        </Button>
      </Tip>
    </div>
  );
}

// Places are Review and Automations as buttons (Review with how many wait
// for it), and every other place under ⋯, as the sidebar's More.
function Places() {
  const nav = useNavItems();
  const review = nav.find((n) => n.id === "review");
  const automations = nav.find((n) => n.id === "automations");
  const rest = nav.filter((n) => n.id !== "home" && n.id !== "review" && n.id !== "automations");
  return (
    <>
      {review && (
        <Tip label={review.badge ? review.badge.title : "Review"}>
          <Button size="sm" variant="ghost" data-testid="nav-review" aria-label="Review" aria-current={review.active ? "page" : undefined} className="relative gap-1 px-2 aria-[current=page]:bg-accent" onClick={review.go}>
            <InboxIcon />
            <span className="max-[1199px]:sr-only">Review</span>
            {review.badge && <span className="text-muted-foreground text-xs tabular-nums">{review.badge.count}</span>}
          </Button>
        </Tip>
      )}
      {automations && (
        <Tip label="Automations">
          <Button size="sm" variant="ghost" data-testid="nav-automations" aria-label="Automations" aria-current={automations.active ? "page" : undefined} className="gap-1 px-2 aria-[current=page]:bg-accent" onClick={automations.go}>
            <WorkflowIcon />
            <span className="max-[1199px]:sr-only">Automations</span>
          </Button>
        </Tip>
      )}
      <Menu>
        <Tip label="More places">
          <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More places" />}>
            <EllipsisIcon />
          </MenuTrigger>
        </Tip>
        <MenuPopup align="end" className="min-w-52">
          <MoreItems more={rest} />
        </MenuPopup>
      </Menu>
    </>
  );
}

// DeckTab is one workspace in the bar: its name, and a quiet dot with how
// many of its agents need you. Double-click renames it; its menu renames
// or closes it (nothing in it stops).
function DeckTab({ deck, index, on }: { deck: Deck; index: number; on: boolean }) {
  const [editing, setEditing] = useState(false);
  const waiting = useStore((s) => {
    const t = deckTab(deck);
    if (!t) return 0;
    return leaves(t.root).filter((l) => {
      if (l.content.kind !== "terminal") return false;
      const c = l.content;
      const x = s.boxes[c.box]?.sessions?.find((y) => y.name === c.session);
      return !!x && sessionState(x, s.boxes[c.box]?.stats) === "waiting";
    }).length;
  });
  // Read so the count of panes follows the tab.
  const panes = useWorkspaces((s) => {
    const t = deckTab(deck, s.spaces);
    return t ? leaves(t.root).length : 0;
  });
  if (editing)
    return (
      <RenameInput
        initial={deck.name}
        onDone={(v) => {
          setEditing(false);
          if (v !== undefined) renameDeck(deck.id, v);
        }}
      />
    );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="flex shrink-0" />}>
      <Tip label={<span className="flex items-center gap-2">{panes ? `${panes} pane${panes === 1 ? "" : "s"}` : "Empty"}{index < 9 && <span className="text-muted-foreground">{platformKeys(`⌘${index + 1}`)}</span>}</span>}>
        <button
          type="button"
          role="tab"
          aria-selected={on}
          data-deck={deck.name}
          onClick={() => showDeck(deck.id)}
          onDoubleClick={() => setEditing(true)}
          className={cn(
            "flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {index < 9 && <span aria-hidden className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">{index + 1}</span>}
          <span className="max-w-40 truncate">{deck.name}</span>
          {/* Only what needs you is counted here; how many panes is in the tooltip. */}
          {waiting > 0 && (
            <span aria-label={`${waiting} need${waiting === 1 ? "s" : ""} you`} className="flex items-center gap-1 text-warning-foreground text-xs tabular-nums">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {waiting}
            </span>
          )}
        </button>
      </Tip>
      </ContextMenuTrigger>
      <ContextMenuPopup className="min-w-44">
        <ContextMenuItem onClick={() => setEditing(true)}>
          <PencilIcon />
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => closeDeck(deck.id)}>
          <XIcon />
          Close workspace
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone(v?: string): void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (next?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      ref={ref}
      value={v}
      maxLength={40}
      aria-label="Workspace name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(v);
        if (e.key === "Escape") finish();
      }}
      className="h-7 w-36 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
