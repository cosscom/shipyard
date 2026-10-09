import { CloudOffIcon, GaugeIcon, PencilIcon, RowsIcon, SquareSplitHorizontalIcon, SquareSplitVerticalIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { TabErrorBadge } from "@/components/browser-devtools";
import { BoardButton } from "@/components/art/board-buttons";
import { DockButton } from "@/components/files/tree-dock";
import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { NewTabMenu } from "@/components/workspace/new-tab-menu";
import { FileTabState } from "@/components/files/file-bits";
import { PaneActions, PaneIcon, paneLabel } from "@/components/workspace/pane";
import { helperKey, useHelperInfo } from "@/components/conversation/subagent-view";
import { RunMenu } from "@/components/workspace/run-menu";
import { armDrag, StripMarker, useTabDrag } from "@/components/workspace/tab-drag";
import { TabGroup } from "@/components/workspace/tab-group";
import { CompareIcon, useCompareTitle } from "@/components/workspace/compare-view";
import { useGroups, useLabels, useNarrow, useTiny, WtDot } from "@/components/workspace/worktree-tone";
import { foldedOf } from "@/lib/groups";
import { paneKey } from "@/lib/devtools";
import { closeTab } from "@/lib/actions";
import { agentOf, type SessionState, sessionAgent, sessionName, sessionState } from "@/lib/derive";
import { type Leaf, leaves, mixed, paneWorktree, worktreesOf } from "@/lib/layout";
import { removalLabel, useRemoval } from "@/lib/removing";
import { renameSession, useRenaming } from "@/lib/session-title";
import { useStore } from "@/lib/store";
import { memoryNote } from "@/lib/processes";
import { cn } from "@/lib/utils";
import { activateTab, tabBeside, unsplitTab, useHereKey, useHereRef, useWorkspaces, type WsTab } from "@/lib/workspaces";
import { useTitleAt } from "@/lib/worktree-names";
import { isContextMenuKey, openContextMenu } from "@/lib/context-menu-key";

// TabStrip is the current worktree's tabs across the top, as in Orca. It is
// also the window's drag handle. A tab that is not split has no pane header,
// so its pane's actions sit at the strip's right. A tab drags (tab-drag.tsx)
// to another place in the strip or into a split beside a pane.
export function TabStrip() {
  const key = useWorkspaces((s) => s.current);
  const ws = useWorkspaces((s) => (s.current ? s.spaces[s.current] : undefined));
  // Tab groups (Labs): with more than one worktree in the strip, each one's
  // tabs are a group; in a narrow window the others fold to their label.
  const groups = useGroups();
  const narrow = useNarrow();
  const tiny = useTiny();
  const folded = useWorkspaces((s) => s.folded);
  const foldedNow = useMemo(() => new Set(foldedOf({ shown: groups, current: key }, folded, narrow)), [groups, key, folded, narrow]);
  const grouped = groups.length > 1;
  // What the strip holds, so measuring and revealing rerun when it changes.
  const layoutKey = useWorkspaces((s) => groups.map((g) => `${g}:${s.spaces[g]?.tabs.length ?? 0}:${foldedNow.has(g) ? 1 : 0}`).join("|"));
  const leaving = useRemoval(ws?.ref.box ?? "", ws?.ref.path);
  const active = ws?.tabs.find((t) => t.id === ws.active);
  const lone = active && active.root.kind === "leaf" ? active.root : undefined;
  // The worktree you are acting in: the focused pane's, which in a tab that
  // mixes worktrees may not be the tab's. The breadcrumb and Run follow it.
  const hereKey = useHereKey();
  const hereRef = useHereRef();
  const hereTitle = useTitleAt(hereRef?.box, hereRef?.path);
  const hereLeaving = useRemoval(hereRef?.box ?? "", hereKey !== key ? hereRef?.path : undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // Which ends have tabs scrolled past them, for the fades that say so.
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    measure();
    return () => ro.disconnect();
  }, [measure, ws?.tabs.length, layoutKey]);

  // The active tab is always in view: brought in when it changes (⌘T, ⌘⇧B,
  // a tab opened by an agent) and when the strip narrows.
  useLayoutEffect(() => {
    const el = scroller.current;
    const tab = ws?.active ? el?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(ws.active)}"]`) : null;
    if (!el || !tab) return;
    const reveal = () => {
      // Its group's label too, when the two fit.
      const group = tab.closest<HTMLElement>("[data-group]");
      const start = group && tab.offsetLeft + tab.offsetWidth - group.offsetLeft <= el.clientWidth ? group.offsetLeft : tab.offsetLeft;
      const end = tab.offsetLeft + tab.offsetWidth;
      if (start < el.scrollLeft) el.scrollLeft = start;
      else if (end > el.scrollLeft + el.clientWidth) el.scrollLeft = end - el.clientWidth;
      measure();
    };
    reveal();
    const ro = new ResizeObserver(reveal);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ws?.active, ws?.tabs.length, key, layoutKey, measure]);

  const fade = edges.left && edges.right ? "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]" : edges.left ? "[mask-image:linear-gradient(to_right,transparent,black_24px)]" : edges.right ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]" : "";

  return (
    <div data-tauri-drag-region data-tab-bar className="flex h-10 shrink-0 items-stretch border-b bg-sidebar">
      {/* Tabs scroll when they do not fit (a wheel scrolls them sideways),
          with a fade at each end that has more; + stays just after them,
          outside the scroller, so it never scrolls away. */}
      <div
        ref={scroller}
        data-tauri-drag-region
        data-tab-strip
        onScroll={measure}
        onWheel={(e) => {
          const el = scroller.current;
          if (!el || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
          el.scrollLeft += e.deltaY;
        }}
        role="tablist"
        aria-label="Tabs"
        onKeyDown={stripKeys}
        className={cn("relative flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]", fade)}
      >
        {/* Narrow, only the group in front scrolls here; the others wait as
            labels beside it, always in view (tiny, as chips). */}
        {grouped &&
          groups.filter((g) => !narrow || g === key).map((g) => <TabGroup key={g} wsKey={g} front={g === key} folded={foldedNow.has(g)} many={grouped} />)}
        {!grouped &&
          key &&
          ws?.tabs.map((t) => (
            <TabButton
              key={t.id}
              tab={t}
              wsKey={key}
              active={t.id === ws.active}
              onActivate={() => activateTab(key, t.id)}
              onClose={() => void closeTab(key, t.id)}
              onDrag={(e, label, icon) => armDrag(e, { kind: "tab", key, tab: t.id }, label, icon)}
              onSplit={ws.tabs.length > 1 ? (dir) => tabBeside(key, t.id, dir) : undefined}
              onUnsplit={() => unsplitTab(key, t.id)}
            />
          ))}
        <StripMarker />
      </div>
      {grouped && narrow && (
        <div className="flex shrink-0 items-stretch border-l" role="group" aria-label="Other tab groups" onKeyDown={stripKeys}>
          {groups
            .filter((g) => g !== key)
            .map((g) => (
              <TabGroup key={g} wsKey={g} front={false} folded many={grouped} compact={tiny} />
            ))}
        </div>
      )}
      {ws && (
        <div className="flex shrink-0 items-center px-1">
          <NewTabMenu />
        </div>
      )}
      <div data-tauri-drag-region className="min-w-4 flex-1" />
      {ws && (
        <div data-tauri-drag-region className="flex shrink-0 items-center gap-2 pr-2 pl-3 text-muted-foreground text-xs">
          {leaving && (
            <Tip label={leaving.script ? "The repo's archive script is running on the box. This worktree closes when it finishes, or stays if it fails." : "Waiting for the box."} side="bottom">
              <span role="status" className="flex items-center gap-1.5 rounded-lg bg-accent/70 px-2 py-0.5 text-foreground">
                <Spinner className="size-3" />
                {removalLabel(leaving)}
              </span>
            </Tip>
          )}
          {hereLeaving && !leaving && (
            <span role="status" className="flex items-center gap-1.5 rounded-lg bg-accent/70 px-2 py-0.5 text-foreground">
              <Spinner className="size-3" />
              {removalLabel(hereLeaving)}
            </span>
          )}
          {/* With groups, the solid label already names the worktree in
              front; the breadcrumb only speaks up for a guest pane. */}
          {hereRef && !(grouped && hereKey === key) && (
            <Tip label={`${hereTitle && !hereRef.main ? `${hereRef.worktree} · ` : ""}${hereRef.box}:${hereRef.path}`} side="bottom">
              <span data-tauri-drag-region data-strip-place={hereKey === key ? "own" : "guest"} className="flex max-w-56 items-center gap-1.5 truncate">
                <WtDot wsKey={hereKey} />
                <span className="truncate">
                  {hereRef.location}
                  {hereRef.main ? "" : ` / ${hereTitle ?? hereRef.worktree}`}
                </span>
                <span className="rounded bg-accent/70 px-1 py-px font-mono text-[10px]">{hereRef.box}</span>
              </span>
            </Tip>
          )}
          <RunMenu />
          <BoardButton />
          <DockButton />
          {key && active && lone && (
            <div className="flex items-center border-l pl-1">
              <PaneActions wsKey={key} tab={active.id} pane={lone} compact={tiny} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// stripKeys moves the keyboard along the strip: ← and → (Home, End) go
// between its tabs and its groups' labels, in order; Enter or Space on a tab
// shows it.
function stripKeys(e: React.KeyboardEvent<HTMLElement>) {
  const el = e.target as HTMLElement;
  if (!el.matches("[data-tab], [data-group-label]") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const all = [...document.querySelectorAll<HTMLElement>("[data-tab-bar] [data-tab], [data-tab-bar] [data-group-label]")];
  const i = all.indexOf(el);
  const to = e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : all[i + (e.key === "ArrowRight" ? 1 : -1)];
  if (!to) return;
  e.preventDefault();
  to.focus();
}

interface TabProps {
  tab: WsTab;
  // The workspace that holds the tab.
  wsKey: string;
  // Its group's colour, when the strip holds several.
  tone?: string;
  active: boolean;
  onActivate(): void;
  onClose(): void;
  onDrag(e: React.PointerEvent<HTMLElement>, label: string, icon: React.ReactNode): void;
  // Unset when there is no other tab to split beside.
  onSplit?(dir: "row" | "col"): void;
  onUnsplit(): void;
}

export function TabButton({ tab, wsKey, tone, active, onActivate, onClose, onDrag, onSplit, onUnsplit }: TabProps) {
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const panes = leaves(tab.root);
  // Its Browser panes, whose page errors the tab counts.
  const browsers = panes.filter((l) => l.content.kind === "browser").map((l) => paneKey(l.id));
  // A tab with panes of other worktrees wears each one's colour as a dot,
  // and names the others: colour is never all that tells them apart.
  const owners = mixed(tab.root, wsKey) ? worktreesOf(tab.root, wsKey) : [];
  const names = useLabels(owners.length ? owners : [wsKey]);
  // A Compare tab is named after its two worktrees.
  const compared = useCompareTitle(tab);

  const helpers = useHelperInfo();
  // A tab is named after its most important pane: an agent that needs you,
  // then one working, then the focused pane. A helper's pane says whether
  // its helper is working or back.
  const ranked = panes
    .map((l) => {
      const c = l.content;
      const s = c.kind === "terminal" ? boxes[c.box]?.sessions?.find((x) => x.name === c.session) : undefined;
      // A session the box no longer lists has ended, as its pane says.
      const gone = c.kind === "terminal" && !s && !!boxes[c.box]?.sessions;
      const helper = c.kind === "helper" ? helpers[helperKey(c.box, c.session, c.helper)]?.state : undefined;
      const state: SessionState | undefined = helper ?? (s && c.kind === "terminal" ? sessionState(s, boxes[c.box]?.stats) : gone ? "exited" : undefined);
      return { l, s, state, agent: s ? agentOf(s) : c.kind === "terminal" ? c.agent : undefined };
    })
    .sort((a, b) => rank(a, tab.focus) - rank(b, tab.focus));
  const lead = ranked[0];
  const c = lead.l.content;
  const offline = c.kind === "terminal" && status?.boxes.find((b) => b.name === c.box)?.state !== "online" && !!status;
  // Named as everywhere else (sessionName): the session's title, or its
  // agent's name; the agent and the session id are in the tooltip.
  const title = compared ?? (lead.s ? sessionName(lead.s, { sessions: c.kind === "terminal" ? boxes[c.box]?.sessions : undefined }) : (c.kind === "terminal" && c.title) || paneLabel(c, lead.agent));
  const secondary = lead.s ? sessionAgent(lead.s) : "";
  const session = c.kind === "terminal" && lead.s && !tab.compare ? { box: c.box, name: lead.s.name } : undefined;
  // Read aloud with its worktrees: "Claude Code, checkout-fix, with search-perf".
  const spoken = compared ? `Compare ${compared}` : [title, names[0], ...(names.length > 1 ? [`with ${names.slice(1).join(" and ")}`] : [])].join(", ");
  const [editingHere, setEditing] = useState(false);
  // Or asked for from the pane's menu.
  const asked = useRenaming((s) => !!session && s.key === `${session.box}/${session.name}`);
  const editing = editingHere || asked;
  const dragged = useTabDrag((s) => s.source?.kind === "tab" && s.source.tab === tab.id);

  const tab$ = (
    <div
      onPointerDown={(e) => !editing && onDrag(e, title, <PaneIcon content={c} agent={lead.agent} className="size-3" />)}
      data-tab={tab.id}
      data-ws={wsKey}
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-label={spoken}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        } else if (isContextMenuKey(e)) {
          e.preventDefault();
          openContextMenu(e.currentTarget);
        }
      }}
      className={cn(
        "group relative flex h-full min-w-24 shrink-0 cursor-default items-center gap-1.5 border-r pr-1 pl-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-background/60",
        tab.compare ? "max-w-72" : "max-w-56",
        active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
        dragged && "opacity-50",
      )}
      onMouseDown={(e) => {
        // Middle click closes, as in a browser.
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={onActivate}
      onDoubleClick={() => session && setEditing(true)}
    >
      {active && <span className={cn("absolute inset-x-0 top-0", tone ? "h-0.5" : "h-px bg-foreground/50")} style={tone ? { background: tone } : undefined} />}
      {owners.length > 0 && (
        <span className="flex shrink-0 -space-x-0.5" aria-hidden>
          {owners.map((o) => (
            <WtDot key={o} wsKey={o} className={cn("size-2 ring-[1.5px]", active ? "ring-background" : "ring-sidebar")} />
          ))}
        </span>
      )}
      {offline ? (
        <CloudOffIcon className="size-3 shrink-0 text-muted-foreground" aria-label={`${c.kind === "terminal" ? c.box : "The box"} is offline`} />
      ) : lead.state && lead.state !== "idle" ? (
        <StateGlyph state={lead.state} className="size-3" />
      ) : null}
      {/* Near the box's per-session memory limit (its chat says more). */}
      {!offline && memoryNote(lead.s?.usage) && <GaugeIcon data-testid="tab-memory" className="size-3 shrink-0 text-warning-foreground dark:text-warning" aria-label={`This session is ${memoryNote(lead.s?.usage)}`} />}
      {tab.compare ? <CompareIcon aria-hidden className="size-3 shrink-0" /> : <PaneIcon content={c} agent={lead.agent} className="size-3" />}
      {editing && session ? (
        <TitleInput
          initial={lead.s?.title ?? ""}
          placeholder={paneLabel(c, lead.agent)}
          onDone={(next) => {
            setEditing(false);
            if (asked) useRenaming.setState({ key: undefined });
            if (next !== undefined && next !== (lead.s?.title ?? "")) void renameSession(session.box, session.name, next);
          }}
        />
      ) : (
        <span className="min-w-0 truncate">{title}</span>
      )}
      {c.kind === "file" && <FileTabState ws={paneWorktree(wsKey, lead.l)} path={c.path} />}
      {browsers.length > 0 && <TabErrorBadge paneIds={browsers} />}
      {panes.length > 1 && !tab.compare && (owners.length > 1 ? (
        <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground">+ {names.slice(1).join(", ")}</span>
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">+{panes.length - 1}</span>
      ))}
      {/* The pointer's way to close. A tab can't hold a button for screen
          readers and the keyboard (it is one control): they close it from
          its menu (Shift-F10 or the menu key) or with ⌘W. */}
      <Tip label={`Close ${title}`} side="bottom">
        <span
          aria-hidden
          data-tab-close=""
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn("ml-auto inline-flex size-5 shrink-0 cursor-default items-center justify-center rounded hover:bg-accent", active ? "opacity-70" : "opacity-0 group-hover:opacity-70")}
        >
          <XIcon className="size-3" />
        </span>
      </Tip>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex shrink-0 items-stretch" />}>
        {editing ? (
          tab$
        ) : (
          <Tip label={tab.compare ? `Compare ${title}` : c.kind === "terminal" ? [title, secondary, c.session].filter(Boolean).join(" · ") : c.kind === "helper" ? `${title} · a helper's conversation, read-only` : undefined} side="bottom" align="start">
            {tab$}
          </Tip>
        )}
      </ContextMenuTrigger>
      <ContextMenuPopup className="min-w-48">
        {session && (
          <ContextMenuItem onClick={() => setEditing(true)}>
            <PencilIcon />
            <span className="flex-1">Rename…</span>
          </ContextMenuItem>
        )}
        {session && lead.s?.title && (
          <ContextMenuItem onClick={() => void renameSession(session.box, session.name, "")}>
            <span className="size-4" />
            <span className="flex-1">Use the agent's name</span>
          </ContextMenuItem>
        )}
        {session && <ContextMenuSeparator />}
        {onSplit && !tab.compare && (
          <>
            <ContextMenuItem onClick={() => onSplit("row")}>
              <SquareSplitHorizontalIcon />
              <span className="flex-1">Split right</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onSplit("col")}>
              <SquareSplitVerticalIcon />
              <span className="flex-1">Split down</span>
            </ContextMenuItem>
          </>
        )}
        {panes.length > 1 && !tab.compare && (
          <ContextMenuItem onClick={onUnsplit}>
            <RowsIcon />
            <span className="flex-1">Move panes to their own tabs</span>
          </ContextMenuItem>
        )}
        {(onSplit || panes.length > 1) && !tab.compare && <ContextMenuSeparator />}
        <ContextMenuItem onClick={onClose}>
          <XIcon />
          <span className="flex-1">Close tab</span>
          <ContextMenuShortcut>⌘W</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

// TitleInput renames a session in place: Enter keeps it, Escape or leaving
// the field without a change drops it. Empty means the agent's name again.
export function TitleInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone(next?: string): void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The menu that asked for it gives focus back to its button as it
  // closes: take it after that, and only count a blur once it has been ours.
  const ready = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
      ready.current = true;
    }, 60);
    return () => window.clearTimeout(t);
  }, []);
  const finish = (next?: string, refocus = false) => {
    if (done.current) return;
    done.current = true;
    // Enter and Esc give the keyboard back to the tab it renamed.
    const tab = refocus ? input.current?.closest<HTMLElement>("[data-tab]")?.dataset.tab : undefined;
    onDone(next);
    if (tab) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tab)}"]`)?.focus());
  };
  return (
    <input
      ref={input}
      value={v}
      maxLength={80}
      aria-label="Session title"
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v.trim(), true);
        if (e.key === "Escape") finish(undefined, true);
      }}
      onBlur={() => ready.current && finish(v.trim())}
      className="h-6 w-48 min-w-0 rounded border border-ring bg-background px-1.5 text-foreground text-xs outline-none ring-2 ring-ring/24 placeholder:text-muted-foreground/72"
    />
  );
}

function rank(x: { l: Leaf; state?: SessionState; agent?: string }, focus: string): number {
  if (x.state === "waiting") return 0;
  if (x.state === "running") return 1;
  if (x.l.id === focus) return 2;
  return x.agent ? 3 : 4;
}
