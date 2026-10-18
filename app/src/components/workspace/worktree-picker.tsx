import { ArrowLeftIcon, GitBranchIcon, GlobeIcon, HomeIcon, PuzzleIcon, RadioIcon, SquareTerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandFooter, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useOnScreen, WtDot } from "@/components/workspace/worktree-tone";
import { agentPresets, startAgent, startSession } from "@/lib/actions";
import { type Location, type Worktree } from "@/lib/api";
import { portUrl } from "@/lib/browser-url";
import { agentOf, sessionAgent, sessionName, sessionState, sortedWorktrees, worktreeSessions } from "@/lib/derive";
import type { PaneContent } from "@/lib/layout";
import { sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { closeCompare, openCompare } from "@/lib/compare-actions";
import { addGroup, bringSession, focusedPane, groupKeys, here, refFor, refOf, splitPane, useWorkspaces, type WorktreeRef, wsKey } from "@/lib/workspaces";
import { Icon } from "@/plugins/ui";
import { useRegistry } from "@/plugins/registry";
import { worktreeLabel } from "@/lib/worktree-names";

// The worktree picker (Labs): ⌘⌥D, "Split right with another worktree…".
// First a worktree, then what of it to show beside the focused pane: one of
// its agents, its dev server's page, a panel (its diff), or a new terminal.
// The pane it opens belongs to that worktree, as a guest in this tab.

// split: beside the focused pane. group: the worktree's tabs join the
// strip as a group. compare: a Compare tab of from (else the worktree you
// are acting in) and the one picked, in place of replace when it is given
// (a Compare tab whose other side went).
type Mode = { kind: "split" } | { kind: "group" } | { kind: "compare"; from?: string; replace?: { key: string; tab: string } };

export const useWorktreePicker = create<{ mode?: Mode; picked?: WorktreeRef }>(() => ({}));

export const openWorktreePicker = (mode: Mode) => useWorktreePicker.setState({ mode, picked: undefined });
const closePicker = () => useWorktreePicker.setState({ mode: undefined, picked: undefined });

// ⌥↵ (or ⌥-click) compares the diffs rather than the default lane.
let diffsNext = false;

interface Item {
  // Words it answers to besides its label: a renamed worktree's own name.
  search?: string;
  value: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  run(): void;
}

interface Group {
  value: string;
  label?: string;
  items: Item[];
}

const slot = (n: React.ReactNode) => <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{n}</span>;

// besideFocus puts content beside the focused pane, for worktree key.
function besideFocus(key: string, content: PaneContent) {
  const f = focusedPane();
  if (!f) return;
  splitPane(f.key, f.tab.id, f.leaf.id, "row", content, key);
}

// showSession brings one of the worktree's sessions beside the focused
// pane (bringSession: moved from wherever it shows, or added).
function showSession(key: string, box: string, session: string) {
  const f = focusedPane();
  if (f) bringSession(key, box, session, { tab: f.tab.id, pane: f.leaf.id, side: "right" });
}

// processName is what a dev server's command line runs, in a word: "vite"
// for node …/node_modules/.bin/vite --port 3000.
function processName(p?: string): string | undefined {
  if (!p) return undefined;
  return /\.bin\/([\w.-]+)/.exec(p)?.[1] ?? p.split(/\s+/)[0].split("/").pop();
}

export function WorktreePicker() {
  const mode = useWorktreePicker((s) => s.mode);
  const picked = useWorktreePicker((s) => s.picked);
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const spaces = useWorkspaces((s) => s.spaces);
  const panels = useRegistry((s) => s.worktreePanels);
  const onScreen = useOnScreen();
  const [query, setQuery] = useState("");

  const done = (fn: () => void) => () => {
    closePicker();
    setQuery("");
    fn();
  };

  const groups = useMemo<Group[]>(() => {
    if (!mode) return [];
    if (!picked) {
      // Splitting, the worktree you are in is no other; adding a group, the
      // ones already in the strip are no new group; comparing, the one it
      // is compared with.
      const skip = mode.kind === "compare" ? (mode.from ?? here()) : here();
      const inStrip = mode.kind === "group" ? groupKeys() : [];
      const online = status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [];
      const rows = online.flatMap((box) =>
        (boxes[box]?.locations ?? []).flatMap((loc: Location) =>
          sortedWorktrees(loc).map((wt: Worktree) => {
            const key = wsKey(box, wt.path);
            const sessions = worktreeSessions(boxes[box]?.sessions, wt);
            const agent = sessions.find((s) => agentOf(s) && !s.exited);
            const state = agent ? sessionState(agent, boxes[box]?.stats) : undefined;
            return {
              key,
              visited: spaces[key]?.visitedAt ?? 0,
              item: {
                trailing: onScreen.includes(key) ? <OnScreen wsKey={key} /> : undefined,
                value: `wt:${key}`,
                label: wt.main ? loc.name : `${loc.name} / ${worktreeLabel(wt)}`,
                search: [wt.name, wt.branch].filter(Boolean).join(" "),
                detail: [agent ? sessionName(agent, { sessions: boxes[box]?.sessions }) : wt.branch, box].filter(Boolean).join(" · "),
                icon: slot(state && state !== "idle" ? <StateGlyph state={state} className="size-3.5" /> : wt.main ? <HomeIcon /> : <GitBranchIcon />),
                run: () => {
                  setQuery("");
                  if (mode.kind === "group") {
                    closePicker();
                    addGroup(key);
                  } else if (mode.kind === "compare") {
                    closePicker();
                    const from = mode.from ?? here();
                    if (!from) return;
                    if (mode.replace) closeCompare(mode.replace.key, mode.replace.tab);
                    const lane = diffsNext ? "diff" : undefined;
                    diffsNext = false;
                    openCompare(from, key, lane);
                  } else useWorktreePicker.setState({ picked: refOf(box, loc, wt) });
                },
              } satisfies Item,
            };
          }),
        ),
      );
      const list = rows.filter((r) => (mode.kind === "group" ? !inStrip.includes(r.key) : r.key !== skip));
      const recent = list.filter((r) => r.visited).sort((a, b) => b.visited - a.visited);
      const rest = list.filter((r) => !r.visited);
      return [
        { value: "recent", label: "Recent", items: recent.map((r) => r.item) },
        { value: "all", label: recent.length ? "Everywhere" : undefined, items: rest.map((r) => r.item) },
      ].filter((g) => g.items.length);
    }

    const ref = picked;
    const key = wsKey(ref.box, ref.path);
    const data = boxes[ref.box];
    const sessions = data?.sessions?.filter((s) => s.dir === ref.path && !s.exited) ?? [];
    const agents: Item[] = sessions
      .filter((s) => agentOf(s))
      .map((s) => {
        const state = sessionState(s, data?.stats);
        return {
          value: `session:${s.name}`,
          label: sessionName(s, { sessions: data?.sessions }),
          detail: [sessionAgent(s), state !== "idle" && sessionWord(state)].filter(Boolean).join(" · "),
          icon: slot(<AgentIcon agent={agentOf(s)} />),
          run: done(() => showSession(key, ref.box, s.name)),
        };
      });
    const urlPort = status?.proxy.url_port;
    const servers = (data?.services ?? []).filter((s) => s.path === ref.path);
    const pages: Item[] = servers.flatMap((s) => {
      const url = portUrl(s.port, { ref, services: data?.services, urlPort });
      return url ? [{ value: `page:${s.port}`, label: `Page on :${s.port}`, detail: processName(s.process), icon: slot(<RadioIcon />), run: done(() => besideFocus(key, { kind: "browser", url })) }] : [];
    });
    if (!pages.length) pages.push({ value: "browser", label: "Browser", detail: "its dev servers, or any URL", icon: slot(<GlobeIcon />), run: done(() => besideFocus(key, { kind: "browser", url: "" })) });
    const panelItems: Item[] = panels.map(({ plugin, item }) => ({
      value: `panel:${plugin}:${item.id}`,
      label: item.title,
      icon: slot(item.icon ? <Icon name={item.icon} /> : <PuzzleIcon />),
      run: done(() => besideFocus(key, { kind: "panel", plugin, panel: item.id, title: item.title })),
    }));
    const f = focusedPane();
    const target = f ? ({ kind: "split", tab: f.tab.id, pane: f.leaf.id, dir: "row" } as const) : undefined;
    const fresh: Item[] = target
      ? [
          { value: "terminal", label: "New terminal", icon: slot(<SquareTerminalIcon />), run: done(() => void startSession("", target, "Terminal", key)) },
          ...agentPresets(ref.box, ref.location).map((p) => ({ value: `agent:${p.id}`, label: `New ${p.name}`, icon: slot(<AgentIcon agent={p.id} />), run: done(() => void startAgent(p, target, p.name, key)) })),
        ]
      : [];
    return [
      { value: "agents", label: "Its agents", items: agents },
      { value: "pages", label: "Its page", items: pages },
      { value: "panels", label: "Panels", items: panelItems },
      { value: "new", label: "Start", items: fresh },
    ].filter((g) => g.items.length);
    // done only closes the picker and runs what it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, picked, boxes, status, spaces, panels, onScreen]);

  const name = picked ? (picked.main ? picked.location : picked.worktree) : "";
  const fromRef = mode?.kind === "compare" ? refFor(mode.from ?? here()) : undefined;
  const fromName = fromRef ? (fromRef.main ? fromRef.location : fromRef.worktree) : "this worktree";
  return (
    <CommandDialog
      open={!!mode}
      onOpenChange={(o) => {
        if (!o) {
          closePicker();
          setQuery("");
        }
      }}
    >
      <CommandDialogPopup aria-label={mode?.kind === "group" ? "Add a worktree's tabs" : mode?.kind === "compare" ? `Compare ${fromName} with another worktree` : "Split right with another worktree"}>
        <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => `${(i as Item).label} ${(i as Item).detail ?? ""} ${(i as Item).search ?? ""}`}>
          <CommandInput
            key={picked ? "what" : "where"}
            placeholder={picked ? `Show from ${name} beside this pane…` : mode?.kind === "group" ? "Add a worktree's tabs to the strip…" : mode?.kind === "compare" ? `Compare ${fromName} with…` : "Split right with another worktree…"}
            onKeyDown={(e) => {
              // ⌥↵ picks as ↵ does, comparing diffs.
              if (mode?.kind === "compare" && e.key === "Enter" && e.altKey) {
                e.preventDefault();
                diffsNext = true;
                e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
                return;
              }
              // Backspace on an empty field goes back to the worktrees.
              if (picked && e.key === "Backspace" && !query) {
                e.preventDefault();
                useWorktreePicker.setState({ picked: undefined });
              }
            }}
          />
          <CommandPanel>
            <CommandEmpty>{picked ? "Nothing matches." : "No other worktree matches."}</CommandEmpty>
            <CommandList>
              {(group: Group) => (
                <CommandGroup key={group.value} items={group.items}>
                  {group.label && <CommandGroupLabel>{group.label}</CommandGroupLabel>}
                  <CommandCollection>
                    {(item: Item) => (
                      <CommandItem
                        key={item.value}
                        value={item}
                        className="gap-2"
                        onClick={(e) => {
                          if (e.altKey) diffsNext = true;
                          item.run();
                        }}
                      >
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                        {item.detail && <span className="ml-auto min-w-0 shrink truncate text-muted-foreground text-meta">{item.detail}</span>}
                        {item.trailing}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="text-tag text-muted-foreground">
            {picked ? (
              <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => useWorktreePicker.setState({ picked: undefined })}>
                <ArrowLeftIcon className="size-3" />
                <Kbd>⌫</Kbd> other worktrees
              </button>
            ) : mode?.kind === "group" ? (
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> add its tabs as a group
              </span>
            ) : mode?.kind === "compare" ? (
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> compare <Kbd>⌥↵</Kbd> compare diffs
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> pick, then what to show
              </span>
            )}
            <span className="flex items-center gap-1">
              {mode?.kind === "group" ? "or ⌥-click it in the sidebar" : mode?.kind === "compare" ? "Side by side, in a Compare tab" : "It opens beside the focused pane"} <Kbd>esc</Kbd>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

// OnScreen marks a worktree that already shows, in its colour.
function OnScreen({ wsKey }: { wsKey: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-meta">
      <WtDot wsKey={wsKey} className="size-1.5" />
      on screen
    </span>
  );
}
