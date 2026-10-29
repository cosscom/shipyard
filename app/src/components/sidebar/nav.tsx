import type { SidebarItem } from "@berth/plugin";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ClockIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  GitBranchIcon,
  GripVerticalIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListIcon,
  PackageIcon,
  PenLineIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Component, Fragment, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { type Action, ContextRow } from "@/components/sidebar/actions";
import { ink } from "@/components/sidebar/ink";
import { selectedRow } from "@/components/sidebar/task-parts";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useAgentCounts } from "@/hooks/use-agent-counts";
import { arrange, type NavList, navActions, useNav } from "@/lib/nav";
import { type NavBadge, readNavBadge } from "@/lib/nav-badge";
import { platformKeys } from "@/lib/platform";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { goHome, homeBox, useWorkspaces } from "@/lib/workspaces";
import { PluginReactContext } from "@/plugins/context";
import { pluginContexts } from "@/plugins/plugin-boundary";
import { type Contribution, useRegistry } from "@/plugins/registry";
import { Icon } from "@/plugins/ui";
import { useReviewCount } from "@/views/review/review-store";

// The app's places: Home, its own views and any plugin's screens. The person
// arranges them into Pinned, More and Hidden (lib/nav). This is the one model
// of the way around: the sidebar, its folded rail and zen's switcher all draw
// useArrangedNav, so they list the same places in the same order.

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  // go opens the place. Every way in (a row, the rail, zen, ⌘K) calls it.
  go(): void;
  badge?: NavBadge;
  // A shortcut, said at the row's end in the sidebar.
  keys?: string;
}

// useNavItems is every place there is, in its default order.
//
// Home is where you start work and see your agents. With Labs that is the
// harbour home (a composer and your agents), so its row is "New task"; the
// Agent Dashboard is a place of its own under More. Without Labs there is no harbour, so the
// first place is the Agent Dashboard itself, under its own name.
export function useNavItems(): NavItem[] {
  const view = useStore((s) => s.view);
  // A box's home terminals show over Home.
  const noWorktree = useWorkspaces((s) => !s.current || !!homeBox(s.current));
  const labs = usePrefs((p) => p.labs);
  const plugins = useRegistry((s) => s.sidebarItems);
  const pluginBadges = usePluginBadges();
  const counts = useAgentCounts();
  const toReview = useReviewCount();
  return useMemo(() => {
    // A fresh object, so clicking the page you're on still says so
    // (Automations leaves its flow editor).
    const open = (v: typeof view) => () => useStore.getState().setView({ ...v });
    const waiting = counts.waiting ? { count: counts.waiting, loud: true, title: `${counts.waiting} waiting for you` } : undefined;
    const dashboard = { label: "Agent Dashboard", icon: <LayoutDashboardIcon />, go: open({ kind: "dashboard" }), active: view.kind === "dashboard" };
    const items: NavItem[] = [
      labs
        ? { id: "home", label: "New task", icon: <PenLineIcon />, go: goHome, active: view.kind === "workspace" && noWorktree, badge: waiting, keys: "⌘N" }
        : { id: "home", ...dashboard, badge: waiting },
      { id: "review", label: "Review", icon: <InboxIcon />, go: open({ kind: "review" }), active: view.kind === "review", badge: toReview ? { count: toReview, title: `${toReview} to review` } : undefined },
      { id: "worktrees", label: "Worktrees", icon: <GitBranchIcon />, go: open({ kind: "worktrees" }), active: view.kind === "worktrees" },
      { id: "automations", label: "Automations", icon: <ClockIcon />, go: open({ kind: "automations" }), active: view.kind === "automations" },
      ...(labs ? [{ id: "dashboard", ...dashboard }] : []),
      { id: "kits", label: "Kits", icon: <PackageIcon />, go: open({ kind: "kits" }), active: view.kind === "kits" },
      ...plugins.map(({ plugin, item }) => ({
        id: pluginNavId(plugin, item),
        label: item.title,
        icon: <Icon name={item.icon ?? "Puzzle"} />,
        go: open({ kind: "plugin", screen: item.screen }),
        active: view.kind === "plugin" && view.screen === item.screen,
        badge: pluginBadges[pluginNavId(plugin, item)],
      })),
    ];
    return items;
  }, [view, noWorktree, labs, plugins, pluginBadges, counts.waiting, toReview]);
}

const pluginNavId = (plugin: string, item: SidebarItem) => `plugin:${plugin}:${item.id}`;

// The badges plugin sidebar items have, by nav id. A list that changes
// can't call a hook per item, so each item's useCount runs in its own
// PluginNavCount, under its plugin's context like the plugin's components,
// and puts what it says here.
const usePluginBadges = create<Record<string, NavBadge>>()(() => ({}));

// One key per contribution, so a plugin that reloads gets a fresh count and
// a fresh boundary.
const countKeys = new WeakMap<Contribution<SidebarItem>, number>();
let nextCountKey = 0;
const countKey = (c: Contribution<SidebarItem>) => {
  let k = countKeys.get(c);
  if (k === undefined) countKeys.set(c, (k = nextCountKey++));
  return k;
};

// PluginNavCounts runs the plugins' sidebar counts. It draws nothing; App
// mounts it once, so the sidebar, the rail and zen's switcher all see them.
// What a count throws while its plugin is removed (an effect's cleanup)
// passes its own boundary, which goes with it, so the outer one stays to
// catch it there rather than in App's; it tries again when the list changes.
export function PluginNavCounts() {
  const items = useRegistry((s) => s.sidebarItems);
  return (
    <CountBoundary reset={items}>
      {items.map((c) =>
        c.item.useCount ? (
          <PluginReactContext.Provider key={countKey(c)} value={pluginContexts.get(c.plugin) ?? null}>
            <CountBoundary plugin={c.plugin}>
              <PluginNavCount id={pluginNavId(c.plugin, c.item)} plugin={c.plugin} title={c.item.title} use={c.item.useCount} />
            </CountBoundary>
          </PluginReactContext.Provider>
        ) : null,
      )}
    </CountBoundary>
  );
}

function PluginNavCount({ id, plugin, title, use }: { id: string; plugin: string; title: string; use: NonNullable<SidebarItem["useCount"]> }) {
  // Logged once, not on every render it fails in.
  const logged = useRef(false);
  const badge = readNavBadge(title, use, (err) => {
    if (logged.current) return;
    logged.current = true;
    console.error(`plugin ${plugin}: the count for sidebar item ${title} failed`, err);
  });
  const count = badge?.count;
  const loud = badge?.loud;
  const tip = badge?.title;
  useEffect(() => {
    if (count === undefined || tip === undefined) return;
    usePluginBadges.setState({ [id]: { count, loud, title: tip } });
    return () =>
      usePluginBadges.setState((s) => {
        const { [id]: _, ...rest } = s;
        return rest;
      }, true);
  }, [id, count, loud, tip]);
  return null;
}

// CountBoundary is the backstop for a count that breaks React itself (a
// hook called a different number of times): it logs, and the badge goes.
class CountBoundary extends Component<{ plugin?: string; reset?: unknown; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(this.props.plugin ? `plugin ${this.props.plugin}: a sidebar count failed` : "a plugin's sidebar count failed", error, info.componentStack);
  }

  componentDidUpdate(prev: { reset?: unknown }) {
    if (this.state.failed && prev.reset !== this.props.reset) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// useArrangedNav is the items in their lists.
export function useArrangedNav() {
  const items = useNavItems();
  const layout = useNav((s) => s.layout);
  const ids = items.map((i) => i.id);
  const lists = arrange(layout, ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  const pick = (l: NavList) => lists[l].map((id) => byId.get(id)!);
  return { pinned: pick("pinned"), more: pick("more"), hidden: pick("hidden"), ids };
}

// The item being dragged, shared by every list it may land in.
const useDrag = create<{ id?: string; over?: { list: NavList; index: number } }>()(() => ({}));

function navItemActions(id: string, list: NavList, ids: string[]): Action[] {
  const items: Action[] = [];
  if (list !== "pinned") items.push({ type: "item", label: "Pin", icon: <PinIcon />, run: () => navActions.place(id, "pinned", undefined, ids) });
  if (list !== "more") items.push({ type: "item", label: list === "pinned" ? "Move to More" : "Show in More", icon: list === "pinned" ? <PinOffIcon /> : <EyeIcon />, run: () => navActions.place(id, "more", undefined, ids) });
  if (list !== "hidden") items.push({ type: "item", label: "Hide", icon: <EyeOffIcon />, hint: "still in ⌘K", run: () => navActions.place(id, "hidden", undefined, ids) });
  items.push(
    { type: "sep" },
    { type: "item", label: "Move up", icon: <ArrowUpIcon />, run: () => navActions.move(id, -1, ids) },
    { type: "item", label: "Move down", icon: <ArrowDownIcon />, run: () => navActions.move(id, 1, ids) },
    { type: "sep" },
    { type: "item", label: "Customize sidebar…", icon: <SlidersHorizontalIcon />, run: () => openCustomize() },
  );
  return items;
}

// dropProps makes an element a drop target: dropping there puts the dragged
// item into list at index.
function dropProps(list: NavList, index: number, ids: string[]) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!useDrag.getState().id) return;
      e.preventDefault();
      e.stopPropagation();
      const o = useDrag.getState().over;
      if (o?.list !== list || o.index !== index) useDrag.setState({ over: { list, index } });
    },
    onDrop: (e: React.DragEvent) => {
      const id = useDrag.getState().id;
      e.preventDefault();
      e.stopPropagation();
      useDrag.setState({ id: undefined, over: undefined });
      if (id) void navActions.place(id, list, index, ids);
    },
  };
}

function dragProps(id: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("application/x-berth-nav", id);
      e.dataTransfer.effectAllowed = "move";
      useDrag.setState({ id });
    },
    onDragEnd: () => useDrag.setState({ id: undefined, over: undefined }),
  };
}

function RowBadge({ badge }: { badge: NonNullable<NavItem["badge"]> }) {
  return (
    <Tip label={badge.title} side="right">
      <SidebarMenuBadge data-testid="nav-badge" className={cn("top-1/2 right-1.5 h-5 min-w-5 -translate-y-1/2 peer-data-[size=sm]/menu-button:top-1/2 rounded-full px-1 text-tag leading-none tabular-nums", badge.loud ? "bg-warning/15 text-warning-foreground" : ink.faint)}>
        {badge.count}
      </SidebarMenuBadge>
    </Tip>
  );
}

// RowKeys is a place's shortcut at its row's end, where a count would be.
export function RowKeys({ keys }: { keys: string }) {
  return <span aria-hidden className={cn("pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-tag peer-data-[active=true]/menu-button:text-foreground", ink.faint)}>{platformKeys(keys)}</span>;
}

// A place's row, sized as Settings' nav: 28px at the default density, a
// 14px icon and its name in text-desc, in the ordinary row's ink; the one
// you are on is full ink on the selected tint.
export const rowClass = cn("h-side-row gap-2 px-2 text-desc font-normal hover:text-foreground [&>svg]:size-3.5 [&>svg]:text-(color:--ink-glyph) data-[active=true]:[&>svg]:text-(color:--ink-row)", ink.row, selectedRow);

function NavRow({ item, list, index, ids }: { item: NavItem; list: NavList; index: number; ids: string[] }) {
  const over = useDrag((s) => s.over);
  const dragging = useDrag((s) => s.id === item.id);
  const before = over?.list === list && over.index === index;
  return (
    <SidebarMenuItem {...dropProps(list, index, ids)} className="relative">
      {before && <span className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-ring" />}
      <ContextRow items={() => navItemActions(item.id, list, ids)}>
        <SidebarMenuButton size="sm" data-testid={`nav-${item.id}`} isActive={item.active} aria-current={item.active ? "page" : undefined} onClick={item.go} {...dragProps(item.id)} className={cn(rowClass, item.keys && "font-medium data-[active=true]:font-medium", dragging && "opacity-40")}>
          {item.icon}
          <span>{item.label}</span>
        </SidebarMenuButton>
        {/* A shortcut wins over a count here: the rows below already show
            who needs you, and the rail keeps the count. */}
        {item.keys ? <RowKeys keys={item.keys} /> : item.badge ? <RowBadge badge={item.badge} /> : null}
      </ContextRow>
    </SidebarMenuItem>
  );
}

// MoreItems is More's places as menu items, then a way to rearrange them.
// The sidebar, the rail and zen's switcher share it.
export function MoreItems({ more }: { more: NavItem[] }) {
  return (
    <>
      {more.map((n) => (
        <MenuItem key={n.id} onClick={n.go} aria-current={n.active ? "page" : undefined} className={cn(n.active && "bg-accent/50 font-medium")}>
          <span className="flex size-4 items-center justify-center [&_svg]:size-4">{n.icon}</span>
          <span className="min-w-0 flex-1 truncate">{n.label}</span>
          {n.badge && <span className={cn("text-meta tabular-nums", n.badge.loud ? "text-warning-foreground" : "text-muted-foreground")}>{n.badge.count}</span>}
        </MenuItem>
      ))}
      {more.length > 0 && <MenuSeparator />}
      <MenuItem onClick={() => openCustomize()}>
        <SlidersHorizontalIcon />
        Customize sidebar…
      </MenuItem>
    </>
  );
}

// Nav is the top of the sidebar: the pinned places, then More, a menu of
// the rest. More stays one row however many plugins there are; while you
// are on one of its places it is highlighted and names it.
//
// lead are the sidebar's own rows (New task without Labs, Search): they
// follow Home when it comes first as New task, and otherwise lead. extra
// goes at the foot of More's menu.
export function Nav({ lead, extra }: { lead?: ReactNode; extra?: ReactNode } = {}) {
  const { pinned, more, ids } = useArrangedNav();
  const dragging = useDrag((s) => !!s.id);
  const over = useDrag((s) => s.over);
  const here = more.find((n) => n.active);
  const loud = more.find((n) => n.badge?.loud);
  const afterHome = pinned[0]?.id === "home" && !!pinned[0].keys;
  return (
    <div>
      <SidebarMenu className="gap-px" {...dropProps("pinned", pinned.length, ids)}>
        {!afterHome && lead}
        {pinned.map((item, i) => (
          <Fragment key={item.id}>
            <NavRow item={item} list="pinned" index={i} ids={ids} />
            {afterHome && i === 0 && lead}
          </Fragment>
        ))}
        {pinned.length === 0 && <li className={cn("px-2 py-1 text-meta", ink.faint)}>Drag places here to pin them.</li>}
        <SidebarMenuItem {...dropProps("more", more.length, ids)} className="relative">
          <Menu>
            <MenuTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  data-testid="nav-more"
                  isActive={!!here}
                  className={cn(rowClass, "data-popup-open:bg-sidebar-accent", dragging && over?.list === "more" && "bg-sidebar-accent ring-1 ring-ring")}
                />
              }
            >
              <EllipsisIcon />
              <span>{dragging ? "Drop in More" : "More"}</span>
            </MenuTrigger>
            <MenuPopup side="right" align="start" className="min-w-52">
              <MoreItems more={more} />
              {extra}
            </MenuPopup>
          </Menu>
          {here ? (
            <span className={cn("pointer-events-none absolute top-1/2 right-2.5 max-w-28 -translate-y-1/2 truncate text-tag", ink.row)}>{here.label}</span>
          ) : loud?.badge ? (
            <RowBadge badge={loud.badge} />
          ) : null}
        </SidebarMenuItem>
      </SidebarMenu>
      {dragging && (
        <div
          {...dropProps("hidden", 0, ids)}
          className={cn(
            "mt-1.5 flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed text-meta text-muted-foreground",
            over?.list === "hidden" ? "border-ring bg-sidebar-accent text-foreground" : "border-sidebar-border",
          )}
        >
          <EyeOffIcon className="size-3.5" />
          Drop to hide (still in ⌘K)
        </div>
      )}
    </div>
  );
}

// The Customize sheet: every place, in its three lists, with drag handles
// and buttons, and a way back to the defaults.
const useCustomize = create<{ open: boolean }>()(() => ({ open: false }));
export const openCustomize = () => useCustomize.setState({ open: true });

export function CustomizeSidebarSheet() {
  const open = useCustomize((s) => s.open);
  const { pinned, more, hidden, ids } = useArrangedNav();
  const lists: [NavList, string, NavItem[], string][] = [
    ["pinned", "Pinned", pinned, "At the top of the sidebar and zen's switcher."],
    ["more", "More", more, "In the More menu. New places, such as a plugin's, land here."],
    ["hidden", "Hidden", hidden, "Not in the sidebar; still in ⌘K."],
  ];
  return (
    <Sheet open={open} onOpenChange={(o) => useCustomize.setState({ open: o })}>
      <SheetPopup className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Customize sidebar</SheetTitle>
          <SheetDescription>Drag places between lists, or use the buttons. Right-click a place in the sidebar for the same choices.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-5">
          {lists.map(([list, title, items, hint]) => (
            <section key={list} {...dropProps(list, items.length, ids)}>
              <h3 className="text-row">{title}</h3>
              <p className="mb-1.5 text-meta text-muted-foreground">{hint}</p>
              <ul className="flex min-h-9 flex-col gap-px rounded-lg border p-1">
                {items.length === 0 && <li className="px-2 py-1.5 text-meta text-muted-foreground">Nothing here. Drag a place in.</li>}
                {items.map((item, i) => (
                  <CustomizeRow key={item.id} item={item} list={list} index={i} count={items.length} ids={ids} />
                ))}
              </ul>
            </section>
          ))}
        </SheetPanel>
        <SheetFooter>
          <Button variant="ghost" onClick={() => void navActions.reset()}>
            <RotateCcwIcon />
            Reset to default
          </Button>
          <Button onClick={() => useCustomize.setState({ open: false })}>Done</Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

function CustomizeRow({ item, list, index, count, ids }: { item: NavItem; list: NavList; index: number; count: number; ids: string[] }) {
  const over = useDrag((s) => s.over);
  const before = over?.list === list && over.index === index;
  const other: [NavList, string, ReactNode][] = (
    [
      ["pinned", "Pin", <PinIcon key="p" />],
      ["more", "Move to More", <ListIcon key="m" />],
      ["hidden", "Hide", <EyeOffIcon key="h" />],
    ] as [NavList, string, ReactNode][]
  ).filter(([l]) => l !== list);
  return (
    <li {...dropProps(list, index, ids)} {...dragProps(item.id)} className="relative flex h-8 items-center gap-2 rounded-md px-1.5 text-body hover:bg-accent/60">
      {before && <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-ring" />}
      <GripVerticalIcon className="size-3.5 shrink-0 cursor-grab text-muted-foreground" />
      <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <IconButton label="Move up" disabled={index === 0} onClick={() => navActions.move(item.id, -1, ids)}>
        <ArrowUpIcon />
      </IconButton>
      <IconButton label="Move down" disabled={index === count - 1} onClick={() => navActions.move(item.id, 1, ids)}>
        <ArrowDownIcon />
      </IconButton>
      {other.map(([l, label, icon]) => (
        <IconButton key={l} label={label} onClick={() => navActions.place(item.id, l, undefined, ids)}>
          {icon}
        </IconButton>
      ))}
    </li>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
