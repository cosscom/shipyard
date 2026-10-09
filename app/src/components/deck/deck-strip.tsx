import { GitBranchIcon, GitBranchPlusIcon, HouseIcon, LayersIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandFooter, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { DECK_NARROW } from "@/components/workspace/pane-layer";
import { type SessionEntry, useAllSessions } from "@/hooks/use-agent-counts";
import { useMediaQuery } from "@/hooks/use-media-query";
import { runShortcut } from "@/hooks/use-shortcuts";
import { openInDeck, openWorktreeInDeck, type Placement } from "@/lib/deck";
import { agentOf, type SessionState, sessionName, worktreeOf } from "@/lib/derive";
import { ago } from "@/lib/format";
import { leaves } from "@/lib/layout";
import { platformKeys } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusPane, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";
import { armDrag } from "@/components/workspace/tab-drag";

// The strip along the bottom of the workspace layout holds every agent not
// on screen, the ones that need you first. Click one to bring it in beside
// the others (or, with the workspace full, in the focused pane's place),
// ⌥-click to put it in the focused pane's place, or drag it onto a pane.
// ⌘E opens the same list, and every worktree, to type into.

const RANK: Partial<Record<SessionState, number>> = { waiting: 0, running: 1, finished: 2, ready: 3, idle: 4 };

export interface StripAgent {
  e: SessionEntry;
  key: string;
  title: string;
  place: string;
}

// useAgents is every live agent, the ones that need you first (the longest
// waiting first), then working, then done, newest first.
function useAgents(): StripAgent[] {
  const all = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  return useMemo(
    () =>
      all
        .filter((e) => agentOf(e.session) && !e.session.exited && RANK[e.state] !== undefined)
        .map((e) => {
          const wt = worktreeOf(boxes[e.box]?.locations, e.session);
          return {
            e,
            key: wsKey(e.box, e.session.dir ?? ""),
            title: sessionName(e.session, { sessions: boxes[e.box]?.sessions }),
            place: wt ? worktreeLabel(wt.worktree, wt.location) : (e.session.location ?? e.box),
          };
        })
        .sort((a, b) => {
          const r = RANK[a.e.state]! - RANK[b.e.state]!;
          if (r) return r;
          const x = a.e.session.state_since ?? a.e.session.created ?? "";
          const y = b.e.session.state_since ?? b.e.session.created ?? "";
          return a.e.state === "waiting" ? x.localeCompare(y) : y.localeCompare(x);
        }),
    [all, boxes],
  );
}

// useShowing is what shows now: the tab in front and its panes that show
// (one, while it is zoomed or the window narrow).
function useShowing() {
  const current = useWorkspaces((s) => s.current);
  const tab = useWorkspaces((s) => (s.current ? s.spaces[s.current]?.tabs.find((t) => t.id === s.spaces[s.current!].active) : undefined));
  const workspace = useStore((s) => s.view.kind === "workspace");
  const narrow = useMediaQuery(DECK_NARROW);
  return useMemo(() => {
    if (!workspace || !tab || !current) return { key: current, tab: undefined, visible: new Set<string>(), hidden: [] as { id: string; box: string; session: string }[] };
    const ls = leaves(tab.root);
    const one = ls.length > 1 && (tab.zoomed || narrow);
    const shownLeaves = one ? ls.filter((l) => l.id === tab.focus) : ls;
    const id = (l: (typeof ls)[number]) => (l.content.kind === "terminal" ? `${l.content.box}/${l.content.session}` : "");
    return {
      key: current,
      tab,
      visible: new Set(shownLeaves.map(id).filter(Boolean)),
      // In the workspace but behind the zoomed pane.
      hidden: (one ? ls.filter((l) => l.id !== tab.focus) : []).flatMap((l) => (l.content.kind === "terminal" ? [{ id: l.id, box: l.content.box, session: l.content.session }] : [])),
    };
  }, [workspace, tab, current, narrow]);
}

export function DeckStrip() {
  const agents = useAgents();
  const showing = useShowing();
  const away = agents.filter((a) => !showing.visible.has(`${a.e.box}/${a.e.session.name}`));
  const behind = showing.hidden.map((h) => agents.find((a) => a.e.box === h.box && a.e.session.name === h.session)).filter((a): a is StripAgent => !!a);
  const elsewhere = away.filter((a) => !behind.includes(a));
  // Agents with nothing going on fold into one chip, so the ones that need
  // you, work or are done stay in sight.
  const quiet = elsewhere.filter((a) => a.e.state === "ready" || a.e.state === "idle");
  const rest = elsewhere.filter((a) => !quiet.includes(a));
  // The first few that need you never scroll out of sight.
  const pinned = rest.filter((a) => a.e.state === "waiting").slice(0, 3);
  const lead = rest.filter((a) => !pinned.includes(a));
  const scroller = useRef<HTMLDivElement>(null);
  const shape = lead.map((a) => a.e.session.name).join(" ");
  // What it shows changed (one was brought in): back to its start.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 0;
  }, [shape]);
  const waiting = elsewhere.filter((a) => a.e.state === "waiting").length;
  return (
    <div data-deck-strip role="toolbar" aria-label="Agents not on screen" className="flex h-10 shrink-0 items-center gap-2 border-t bg-background pr-2 pl-3">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
        <LayersIcon className="size-3.5" />
        <span className="max-[699px]:hidden">Elsewhere</span>
        <span className="tabular-nums">{elsewhere.length}</span>
        {waiting > 0 && <span className="sr-only">{waiting} need you</span>}
      </span>
      {pinned.map((a) => (
        <Chip key={`${a.e.box}/${a.e.session.name}`} a={a} onOpen={(how) => openInDeck(a.e.box, a.e.session.name, how)} />
      ))}
      <div ref={scroller} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">
        {behind.length > 0 && (
          <>
            {behind.map((a) => (
              <Chip key={`behind:${a.e.box}/${a.e.session.name}`} a={a} here onOpen={() => focusBehind(showing, a)} />
            ))}
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          </>
        )}
        {lead.map((a) => (
          <Chip key={`${a.e.box}/${a.e.session.name}`} a={a} onOpen={(how) => openInDeck(a.e.box, a.e.session.name, how)} />
        ))}
        {quiet.length > 0 && <Quiet agents={quiet} />}
        {!elsewhere.length && !behind.length && !pinned.length && <span className="text-muted-foreground text-xs">Every agent is on screen.</span>}
      </div>
      <Tip label="Every agent and worktree, to type into">
        <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" data-testid="deck-switcher-open" onClick={() => openSwitcher()}>
          <SearchIcon />
          <span className="max-[699px]:hidden">Open…</span>
          <Kbd>{platformKeys("⌘E")}</Kbd>
        </Button>
      </Tip>
    </div>
  );
}

// Quiet is the agents waiting for nothing (ready, idle), as one chip whose
// menu lists them.
function Quiet({ agents }: { agents: StripAgent[] }) {
  return (
    <Menu>
      <MenuTrigger render={<button type="button" data-testid="strip-quiet" className="flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-transparent px-2 text-muted-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent" />}>
        <StateGlyph state="ready" className="size-3" />
        {agents.length} ready
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Ready for a prompt</MenuGroupLabel>
          {agents.map((a) => (
            <MenuItem key={`${a.e.box}/${a.e.session.name}`} onClick={(e) => openInDeck(a.e.box, a.e.session.name, e.altKey ? "replace" : "auto")}>
              <AgentIcon agent={agentOf(a.e.session)} className="size-3" />
              <span className="min-w-0 flex-1 truncate">{a.title}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {a.place} · {a.e.box}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function focusBehind(showing: ReturnType<typeof useShowing>, a: StripAgent) {
  const l = showing.tab && leaves(showing.tab.root).find((x) => x.content.kind === "terminal" && x.content.box === a.e.box && x.content.session === a.e.session.name);
  if (l && showing.key && showing.tab) focusPane(showing.key, showing.tab.id, l.id);
}

function Chip({ a, here, onOpen }: { a: StripAgent; here?: boolean; onOpen(how: Placement): void }) {
  const needs = a.e.state === "waiting";
  return (
    <Tip
      label={
        <span className="flex flex-col gap-0.5">
          <span>
            {a.title} · {a.place} on {a.e.box}
          </span>
          <span className="text-muted-foreground">{here ? "In this workspace, behind the one showing" : "Click to bring in · ⌥-click for the focused pane's place · or drag onto a pane"}</span>
        </span>
      }
      side="top"
    >
      <button
        type="button"
        data-testid="strip-agent"
        data-session={`${a.e.box}/${a.e.session.name}`}
        data-state={a.e.state}
        onPointerDown={(e) => armDrag(e, { kind: "session", key: a.key, box: a.e.box, session: a.e.session.name }, a.title, <StateGlyph state={a.e.state} className="size-3" />)}
        onClick={(e) => onOpen(e.altKey ? "replace" : "auto")}
        className={cn(
          "flex h-7 max-w-72 shrink-0 cursor-default items-center gap-1.5 rounded-md border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          needs ? "border-warning/35 bg-warning/8 hover:bg-warning/14" : "border-transparent bg-muted/60 hover:bg-accent",
          here && "border-dashed border-border bg-transparent",
        )}
      >
        <StateGlyph state={a.e.state} className="size-3" />
        <span className="min-w-0 truncate font-medium text-foreground">{a.title}</span>
        <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{a.place}</span>
        {needs && <span className="shrink-0 text-[11px] text-warning-foreground tabular-nums">{ago(a.e.session.state_since ?? a.e.session.created).replace(/ ago$/, "")}</span>}
      </button>
    </Tip>
  );
}

// ---- The switcher (⌘E) ----

const useSwitcher = create<{ open: boolean }>(() => ({ open: false }));
export const openSwitcher = () => useSwitcher.setState({ open: true });
export const toggleSwitcher = () => useSwitcher.setState((s) => ({ open: !s.open }));

interface Item {
  value: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  run(how: Placement): void;
}

const HEAD: Partial<Record<SessionState, string>> = { waiting: "Needs you", running: "Working", finished: "Done", ready: "Ready", idle: "Ready" };

// DeckSwitcher is ⌘E: every agent (who needs you first) and every worktree.
// ↵ brings one in, ⌥↵ puts it in the focused pane's place.
export function DeckSwitcher() {
  const open = useSwitcher((s) => s.open);
  const agents = useAgents();
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const visible = useShowing().visible;
  const [query, setQuery] = useState("");
  const alt = useRef(false);
  const close = () => {
    useSwitcher.setState({ open: false });
    setQuery("");
  };
  const groups = useMemo(() => {
    const byHead = new Map<string, Item[]>();
    for (const a of agents) {
      const head = HEAD[a.e.state] ?? "Ready";
      const list = byHead.get(head) ?? [];
      list.push({
        value: `agent:${a.e.box}/${a.e.session.name}`,
        label: a.title,
        detail: `${a.place} · ${a.e.box}`,
        icon: <StateGlyph state={a.e.state} />,
        trailing: (
          <span className="flex shrink-0 items-center gap-2">
            {visible.has(`${a.e.box}/${a.e.session.name}`) && <span className="text-muted-foreground text-xs">on screen</span>}
            <AgentIcon agent={agentOf(a.e.session)} className="size-3" />
          </span>
        ),
        run: (how) => openInDeck(a.e.box, a.e.session.name, how),
      });
      byHead.set(head, list);
    }
    const online = status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [];
    const worktrees: Item[] = online.flatMap((box) =>
      (boxes[box]?.locations ?? []).flatMap((loc) =>
        (loc.worktrees ?? []).map((wt) => ({
          value: `wt:${box}:${wt.path}`,
          label: worktreeLabel(wt, loc),
          detail: `${loc.name} · ${box}`,
          icon: wt.main ? <HouseIcon className="size-4 text-muted-foreground" /> : <GitBranchIcon className="size-4 text-muted-foreground" />,
          run: (how: Placement) => {
            // Its agent comes in; with none, the worktree shows as it would
            // from the sidebar, to start one.
            if (!openWorktreeInDeck(wsKey(box, wt.path), how)) selectWorktree(refOf(box, loc, wt));
          },
        })),
      ),
    );
    return [
      ...["Needs you", "Working", "Done", "Ready"].filter((h) => byHead.has(h)).map((h) => ({ value: h, label: h, items: byHead.get(h)! })),
      { value: "worktrees", label: "Worktrees", items: worktrees },
      { value: "start", label: "Start", items: [{ value: "new-task", label: "New task…", icon: <GitBranchPlusIcon className="size-4 text-muted-foreground" />, run: () => runShortcut("new-worktree", "menu") }] as Item[] },
    ].filter((g) => g.items.length);
  }, [agents, boxes, status, visible]);

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && close()}>
      <CommandDialogPopup aria-label="Open an agent or worktree">
        <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => `${(i as Item).label} ${(i as Item).detail ?? ""}`}>
          <CommandInput
            placeholder="Bring an agent or worktree into this workspace…"
            onKeyDown={(e) => {
              alt.current = e.key === "Enter" && e.altKey;
            }}
          />
          <CommandPanel>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(group: { value: string; label: string; items: Item[] }) => (
                <CommandGroup key={group.value} items={group.items}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  <CommandCollection>
                    {(item: Item) => (
                      <CommandItem
                        key={item.value}
                        value={item}
                        className="gap-2"
                        onClick={(e) => {
                          const how: Placement = e.altKey || alt.current ? "replace" : "auto";
                          close();
                          item.run(how);
                        }}
                      >
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                        {item.detail && <span className="ml-auto min-w-0 shrink truncate text-muted-foreground text-xs">{item.detail}</span>}
                        {item.trailing}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> bring in <Kbd>⌥↵</Kbd> in the focused pane's place
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

// DeckEmpty is a workspace with no panes yet.
export function DeckEmpty({ name }: { name: string }) {
  const agents = useAgents().slice(0, 5);
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-background p-6">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayersIcon />
          </EmptyMedia>
          <EmptyTitle>{name} is empty</EmptyTitle>
          <EmptyDescription>Bring agents in from the strip below, or start something new. Up to four sit side by side.</EmptyDescription>
        </EmptyHeader>
        <div className="mt-2 flex w-full flex-col gap-1">
          {agents.map((a) => (
            <button
              key={`${a.e.box}/${a.e.session.name}`}
              type="button"
              onClick={() => openInDeck(a.e.box, a.e.session.name)}
              className="flex h-9 items-center gap-2 rounded-lg px-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StateGlyph state={a.e.state} />
              <span className="min-w-0 truncate font-medium">{a.title}</span>
              <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                {a.place} · {a.e.box}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" onClick={() => runShortcut("new-worktree", "menu")}>
            <GitBranchPlusIcon />
            New task
            <Kbd>⌘N</Kbd>
          </Button>
          <Button variant="ghost" onClick={openSwitcher}>
            <SearchIcon />
            Open…
            <Kbd>{platformKeys("⌘E")}</Kbd>
          </Button>
        </div>
      </Empty>
    </div>
  );
}
