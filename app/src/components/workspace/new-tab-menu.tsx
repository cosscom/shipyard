import { Columns2Icon, GitCompareArrowsIcon, GlobeIcon, HistoryIcon, ListPlusIcon, MonitorSmartphoneIcon, PlusIcon, PuzzleIcon, RadioIcon, Settings2Icon, SquareTerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Tip } from "@/components/tip";
import { AgentIcon } from "@/components/agent-glyph";
import { Command, CommandCollection, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { agentPresets, openBrowserAt, openPreviewAt, resolveUrl, startAgent, startSession } from "@/lib/actions";
import { guessSessionName, sessionName } from "@/lib/derive";
import { focusNewPane } from "@/lib/focus-home";
import { leaves } from "@/lib/layout";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { portUrl, suggestions } from "@/lib/browser-url";
import { activateTab, focusPane, openPanel, showWorktree, useHereRef, useWorkspaces } from "@/lib/workspaces";
import { usePrefs } from "@/lib/prefs";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { useRegistry } from "@/plugins/registry";
import { Icon } from "@/plugins/ui";
import { shortLabel } from "@/lib/worktree-names";

interface Item {
  value: string;
  label: string;
  detail?: string;
  // Also matched when searching, without being shown (a session's id).
  search?: string;
  icon: React.ReactNode;
  shortcut?: string;
  run(): void;
}

interface Group {
  value: string;
  label?: string;
  items: Item[];
}

// NewTabMenu is the tab strip's "+", as in Orca: a search over open tabs,
// dev servers, recent pages and agents, then quick ways to start a terminal,
// a browser, or any agent in the worktree you are acting in (the focused
// pane's).
export function NewTabMenu() {
  const open = useStore((s) => s.newTabMenuOpen);
  const setOpen = useStore((s) => s.setNewTabMenuOpen);
  const [query, setQuery] = useState("");
  // Agents, panels and dev servers are the focused pane's worktree's.
  const hereRef = useHereRef();
  const spaces = useWorkspaces((s) => s.spaces);
  const recent = useWorkspaces((s) => s.recentUrls);
  const ws = useMemo(() => (hereRef ? { ref: hereRef } : undefined), [hereRef]);
  const services = useStore((s) => (ws ? s.boxes[ws.ref.box]?.services : undefined));
  const urlPort = useStore((s) => s.status?.proxy.url_port);
  const boxData = useStore((s) => (ws ? s.boxes[ws.ref.box] : undefined));
  const panels = useRegistry((s) => s.worktreePanels);
  const labs = usePrefs((p) => p.labs);

  const groups = useMemo<Group[]>(() => {
    const done = (fn: () => void) => () => {
      setOpen(false);
      setQuery("");
      fn();
    };
    const q = query.trim();
    const url = resolveUrl(q);
    const top: Item[] = url ? [{ value: `open:${url}`, label: `Open ${url}`, icon: <GlobeIcon />, run: done(() => openBrowserAt(url)) }] : [];
    const actions: Item[] = [
      { value: "terminal", label: "New terminal", icon: <SquareTerminalIcon />, shortcut: "⌘T", run: done(() => void startSession("")) },
      { value: "browser", label: "New browser tab", icon: <GlobeIcon />, shortcut: "⌘⇧B", run: done(() => openBrowserAt("")) },
      // The worktree's dev server at every size, when it runs one.
      { value: "preview sizes breakpoints responsive", label: "Preview", detail: "every size at once", icon: <MonitorSmartphoneIcon />, run: done(() => openPreviewAt(devServerUrl())) },
      ...(labs
        ? [
            { value: "add worktree tabs group", label: "Another worktree's tabs…", icon: <ListPlusIcon />, run: done(() => openWorktreePicker({ kind: "group" })) },
            { value: "split another worktree beside", label: "Another worktree beside…", icon: <Columns2Icon />, shortcut: keysFor("split-worktree"), run: done(() => openWorktreePicker({ kind: "split" })) },
            { value: "compare with another worktree side by side", label: "Compare with…", icon: <GitCompareArrowsIcon />, shortcut: keysFor("compare"), run: done(() => openWorktreePicker({ kind: "compare" })) },
          ]
        : []),
    ];
    const agents: Item[] = ws
      ? agentPresets(ws.ref.box, ws.ref.location).map((p) => ({ value: `agent:${p.id}`, label: p.name, icon: <AgentIcon agent={p.id} />, run: done(() => void startAgent(p, { kind: "tab" }, p.name)) }))
      : [];
    const panelItems: Item[] = ws
      ? panels.map(({ plugin, item }) => ({
          value: `panel:${plugin}:${item.id}`,
          label: item.title,
          icon: item.icon ? <Icon name={item.icon} /> : <PuzzleIcon />,
          // The panel takes the keyboard, not the "+" that opened it.
          run: done(() => {
            openPanel(plugin, item.id, item.title);
            focusNewPane();
          }),
        }))
      : [];
    const devServerUrl = () => (ws ? suggestions({ ref: ws.ref, services, urlPort })[0]?.url : undefined) ?? "";
    const settings: Item[] = [{ value: "agent-settings", label: "Agent settings…", icon: <Settings2Icon />, run: done(() => useStore.getState().setView({ kind: "settings", section: "agents" })) }];
    const history: Item[] = recent.map((u) => ({ value: `recent:${u}`, label: u.replace(/^https?:\/\//, "").replace(/\/$/, ""), search: u, icon: <HistoryIcon />, run: done(() => openBrowserAt(u)) }));
    if (!q) {
      return [
        { value: "new", label: "New", items: actions },
        { value: "agents", label: "Agents", items: agents },
        { value: "panels", label: "Panels", items: panelItems },
        { value: "recent", label: "Recent pages", items: history.slice(0, 3) },
      ].filter((g) => g.items.length);
    }

    // Searching: everything, filtered by the command list.
    const tabs: Item[] = Object.entries(spaces).flatMap(([key, space]) =>
      space.tabs.map((t) => {
        const focus = leaves(t.root).find((l) => l.id === t.focus) ?? leaves(t.root)[0];
        const c = focus.content;
        // Terminals by what the app calls them everywhere: "Claude Code 2".
        const what = c.kind === "terminal" ? terminalName(c.box, c.session) : c.kind === "browser" ? c.url.replace(/^https?:\/\//, "") || "Browser" : c.kind === "preview" ? `Preview ${c.url.replace(/^https?:\/\//, "")}`.trim() : c.kind === "helper" ? `Helper ${c.title ?? ""}`.trim() : "Starting";
        return {
          value: `tab:${key}:${t.id}`,
          label: `${what} — ${shortLabel(space.ref)}`,
          detail: space.ref.box,
          search: [c.kind === "terminal" ? c.session : undefined, space.ref.worktree].filter(Boolean).join(" ") || undefined,
          icon: c.kind === "browser" ? <GlobeIcon /> : c.kind === "preview" ? <MonitorSmartphoneIcon /> : <AgentIcon agent={c.kind === "terminal" ? sessionAgent(c.box, c.session) : undefined} />,
          run: done(() => {
            showWorktree(key);
            activateTab(key, t.id);
            focusPane(key, t.id, focus.id);
          }),
        };
      }),
    );
    const servers: Item[] =
      ws
        ? (services ?? [])
            .filter((s) => s.path === ws.ref.path)
            .map((s) => {
              const u = portUrl(s.port, { ref: ws.ref, services, urlPort }) ?? "";
              return { value: `svc:${s.port}`, label: `Open ${s.port}${s.process ? ` (${s.process})` : ""}`, detail: u, icon: <RadioIcon />, run: done(() => openBrowserAt(u)) };
            })
        : [];
    return [
      { value: "url", items: top },
      { value: "tabs", label: "Open tabs", items: tabs },
      { value: "servers", label: "Dev servers", items: servers },
      { value: "history", label: "Recent", items: history },
      { value: "agents", label: "Agents", items: agents },
      { value: "panels", label: "Panels", items: panelItems },
      { value: "actions", items: [...actions, ...settings] },
    ].filter((g) => g.items.length);
    // boxData keeps agent labels current as sessions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ws, spaces, services, recent, urlPort, boxData, panels, setOpen, labs]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <Tip label="New tab (⌘T for a terminal)" side="bottom">
        <PopoverTrigger
          render={<button type="button" aria-label="New tab" className="inline-flex size-6.5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-popup-open:bg-foreground/9" />}
        >
          <PlusIcon className="size-4" />
        </PopoverTrigger>
      </Tip>
      <PopoverPopup aria-label="New tab" align="start" sideOffset={2} className="w-88 p-0 [&_[data-slot=popover-viewport]]:p-0">
        <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => `${(i as Item).label} ${(i as Item).detail ?? ""} ${(i as Item).search ?? ""}`}>
          <CommandInput aria-label="Search open tabs, history, URLs and agents" placeholder="Search open tabs, history, URLs, agents…" className="text-body" />
          <CommandSeparator className="my-0" />
          <CommandEmpty>Nothing matches. Type a port or a URL to open it.</CommandEmpty>
          <CommandList className="max-h-96">
            {(group: Group) => (
              <CommandGroup key={group.value} items={group.items}>
                {group.label && <CommandGroupLabel>{group.label}</CommandGroupLabel>}
                <CommandCollection>
                  {(item: Item) => (
                    <CommandItem key={item.value} value={item} onClick={() => item.run()} className="gap-2.5 text-body [&_svg]:size-4 [&_svg]:text-muted-foreground">
                      {item.icon}
                      <span className="truncate">{item.label}</span>
                      {item.detail && <span className="ml-auto max-w-40 truncate text-muted-foreground text-meta">{item.detail}</span>}
                      {item.shortcut && <Kbd className="ml-auto">{item.shortcut}</Kbd>}
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
}

function terminalName(box: string, session: string): string {
  const d = useStore.getState().boxes[box];
  const s = d?.sessions?.find((x) => x.name === session);
  return s ? sessionName(s, { sessions: d?.sessions }) : guessSessionName(session);
}

function sessionAgent(box: string, session: string): string | undefined {
  const s = useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session);
  return s?.agent;
}
