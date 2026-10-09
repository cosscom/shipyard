import { AppWindowIcon, ArchiveIcon, ChartColumnIcon, FileTextIcon, GaugeIcon, LayoutGridIcon, TableIcon, WorkflowIcon, ArrowLeftRightIcon, BotIcon, Columns2Icon, EllipsisIcon, GlobeIcon, ImageIcon, MessagesSquareIcon, MonitorSmartphoneIcon, PencilIcon, ScrollTextIcon, SquareSplitHorizontalIcon, SquareSplitVerticalIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";


import { Tip } from "@/components/tip";
import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { BrowserPane } from "@/components/browser-pane";
import { PreviewPane } from "@/components/preview-pane";
import { FileGlyph } from "@/components/files/file-bits";
import { EmptySide } from "@/components/workspace/compare-view";
import { CompareSideContext, type CompareSide, pageLoading } from "@/lib/compare-actions";
import { openChatBackgroundSettings } from "@/components/conversation/chat-background";
import { ConversationPane } from "@/components/conversation/conversation-pane";
import { HelperPane } from "@/components/conversation/helper-pane";
import { helperKey, useHelperInfo } from "@/components/conversation/subagent-view";
import { ErrorText } from "@/components/error-note";
import { SessionActionItems } from "@/components/orchestrate/session-actions";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LogView } from "@/components/workspace/log-view";
import { PanelIcon, PanelPane } from "@/components/workspace/panel-pane";
import { ServiceIcon } from "@/components/workspace/service-terminal";
import { armDrag, useTabDrag } from "@/components/workspace/tab-drag";
import { TerminalView } from "@/components/workspace/terminal-view";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { useLabel, useTone, WtChip } from "@/components/workspace/worktree-tone";
import { agentPresets, closePane, openBrowserAt, openPreviewAt, startSession } from "@/lib/actions";
import { agentLabel, agentOf, restartCommand, sessionAgent, sessionName, sessionState } from "@/lib/derive";
import { nameFromKey } from "@/lib/groups";
import { type Leaf, leaves, paneWorktree } from "@/lib/layout";
import { PaneContext } from "@/lib/pane-context";
import { usePrefs } from "@/lib/prefs";
import { useRemoval } from "@/lib/removing";
import { useStore } from "@/lib/store";
import { startRenaming } from "@/lib/session-title";
import { memory, memoryNote } from "@/lib/processes";
import { cn } from "@/lib/utils";
import { focusPane, paneBeside, paneToTab, setPaneContent, splitKey, useWorkspaces, useWorktreeRef } from "@/lib/workspaces";
import { platformKeys } from "@/lib/platform";
import { DeckPaneBits, useDeckOn } from "@/components/deck/deck-pane";

export { agentLabel };

// A File tab's pane and its editor load the first time one shows.
// An artifact or a worktree's board (components/art), loaded when first shown.
const ArtifactPane = lazy(() => import("@/components/art/artifact-pane").then((m) => ({ default: m.ArtifactPane })));
const ART_ICONS: Record<string, typeof ChartColumnIcon> = { chart: ChartColumnIcon, table: TableIcon, diagram: WorkflowIcon, page: AppWindowIcon, notes: FileTextIcon };

const FilePane = lazy(() => import("@/components/files/file-pane"));

interface Props {
  wsKey: string;
  tab: string;
  pane: Leaf;
  visible: boolean;
  focused: boolean;
  // More than one pane in the tab. Only then does a pane have its own
  // header; a lone pane's actions are in the tab strip.
  split: boolean;
  // The tab shows panes of more than one worktree: each header names its
  // pane's worktree in its colour.
  mixed?: boolean;
  // A side of a Compare tab: no header (the tab's bar names both sides),
  // and what inside it syncs with the other side knows which it is.
  compare?: CompareSide;
}

// Pane is one leaf of a tab's split tree: a terminal, a browser, a log or a
// plugin's panel, under a slim header when the tab is split.
export function Pane({ wsKey, tab, pane, visible, focused, split, mixed, compare }: Props) {
  // The worktree the pane belongs to: its own, in a tab that mixes
  // worktrees, else its tab's.
  const owner = paneWorktree(wsKey, pane);
  const info = useMemo(() => ({ wsKey, tab, pane: pane.id, worktree: owner }), [wsKey, tab, pane.id, owner]);
  // The workspace layout (components/deck): every pane names its place, and
  // worktrees wear no colours; the one accent is for an agent that needs you.
  const deck = useDeckOn();
  const tone = useTone(mixed && !deck ? owner : undefined);
  // Named with its worktree for screen readers: "Claude Code, search-perf".
  const { label: worktreeName } = useLabel(owner);
  // A guest pane whose worktree was archived or removed: say so, and let it
  // be closed, rather than show a page or panel for nothing.
  const gone = useGuestGone(wsKey, pane);
  const focus = () => {
    if (!focused) focusPane(wsKey, tab, pane.id);
  };
  const close = () => void closePane(wsKey, tab, pane.id);
  const c = pane.content;
  const session = useStore((s) => (c.kind === "terminal" ? s.boxes[c.box]?.sessions?.find((x) => x.name === c.session) : undefined));

  // Remember what runs here, so the pane can name it and start it again
  // once the session itself is gone.
  const agent = session ? agentOf(session) : undefined;
  const needsYou = useStore((s) => deck && !!session && sessionState(session, s.boxes[(c as { box: string }).box]?.stats) === "waiting");
  const view = usePaneView(pane);
  // Lifted: being dragged by its header, so it fades while it moves.
  const lifted = useTabDrag((s) => s.source?.kind === "pane" && s.source.pane === pane.id);
  useEffect(() => {
    if (c.kind !== "terminal" || !session) return;
    const title = session.title?.trim() || undefined;
    if (c.agent !== agent || c.command !== session.command || c.title !== title) setPaneContent(wsKey, tab, pane.id, { ...c, agent, command: session.command, title });
  }, [c, session, agent, wsKey, tab, pane.id]);

  return (
    <PaneContext.Provider value={info}>
      <CompareSideContext.Provider value={compare}>
      <div role="region" aria-label={`${paneLabel(c, agent)}, ${worktreeName}`} className="flex h-full min-h-0 flex-col" onMouseDownCapture={focus}>
        {/* A Compare tab's side has no header: its focus line is its own. */}
        {compare && focused && tone && <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5" style={{ background: tone }} />}
        {split && (
          // Its header drags the pane beside another, or onto the tab strip as
          // a tab of its own (tab-drag.tsx). Zen has no strip: there it only
          // moves beside another pane. In a tab that mixes worktrees, it names
          // the pane's worktree, and the focus line is in that one's colour.
          <div
            onPointerDown={(e) => armDrag(e, { kind: "pane", key: wsKey, tab, pane: pane.id }, (c.kind === "terminal" && (session?.title?.trim() || c.title)) || paneLabel(c, agent), <PaneIcon content={c} agent={agent} className="size-3" />)}
            data-needs-you={needsYou ? "" : undefined}
            className={cn(
              "group/header flex h-7 shrink-0 items-center gap-1.5 border-b px-2 text-xs",
              focused ? "bg-accent/50 text-foreground shadow-[inset_0_2px_0_var(--ring)]" : "text-muted-foreground",
              deck && "@container h-8",
              needsYou && "bg-warning/8 shadow-[inset_0_2px_0_color-mix(in_oklab,var(--warning)_70%,transparent)]",
            )}
            style={tone ? { boxShadow: focused ? `inset 0 2px 0 ${tone}` : `inset 0 1px 0 color-mix(in oklab, ${tone} 50%, transparent)` } : undefined}
          >
            {tone && <WtChip wsKey={owner} />}
            <PaneTitle pane={pane} bare={deck} />
            {deck && <DeckPaneBits owner={owner} needsYou={needsYou} />}
            {/* In the workspace layout the actions show on hover, so a
                narrow pane's header is all name. */}
            <div className={cn("ml-auto flex items-center transition-opacity", deck ? "hidden shrink-0 group-hover/header:flex group-focus-within/header:flex" : focused ? "opacity-100" : "opacity-0 group-hover/header:opacity-100 focus-within:opacity-100")}>
              {deck && <DeckPaneBits owner={owner} pane={pane.id} focused={focused} actions />}
              <PaneActions wsKey={wsKey} tab={tab} pane={pane} onClose={close} closable focused={focused} compact={deck} />
            </div>
          </div>
        )}
        <div className={cn("relative flex min-h-0 flex-1 flex-col transition-opacity", split && !focused && !deck && "opacity-85", lifted && "opacity-40")}>
          {gone && <GonePane name={gone} onClose={close} />}
          {/* Under a chat the terminal is out of reach: Tab never lands in its
              hidden input, where it would type a tab and keep the focus. */}
          {c.kind === "terminal" && (
            <div className="contents" inert={view === "conversation" || undefined}>
              {/* Typing shows before the box echoes it on a slow link, in a
                  shell; an agent's own screen (Claude Code, Codex) draws
                  its input its own way, so it gets none. */}
              <TerminalView box={c.box} session={c.session} agent={c.agent} command={c.command} wsKey={wsKey} tab={tab} pane={pane.id} visible={visible && view !== "conversation"} focused={focused && view !== "conversation"} predict={!c.agent && !agent} onFocus={focus} onClose={close} />
            </div>
          )}
          {/* The terminal stays connected underneath, so switching back is instant. */}
          {c.kind === "terminal" && view === "conversation" && (
            <div className="absolute inset-0 z-10 flex flex-col">
              <ConversationPane box={c.box} session={c.session} agent={c.agent} visible={visible} onStartAgain={() => void startSession(restartCommand(c.command) ?? c.agent ?? "", { kind: "replace", tab, pane: pane.id }, c.agent ? agentLabel(c.agent) : "Agent")} onShowTerminal={() => setPaneContent(wsKey, tab, pane.id, { ...c, view: "terminal" })} />
            </div>
          )}
          {c.kind === "browser" && <BrowserPane id={pane.id} url={c.url} visible={visible} worktree={owner} onNavigate={(url) => setPaneContent(wsKey, tab, pane.id, { kind: "browser", url })} onLoading={compare ? (l) => pageLoading(pane.id, l) : undefined} />}
          {c.kind === "preview" && <PreviewPane url={c.url} visible={visible} worktree={owner} onNavigate={(url) => setPaneContent(wsKey, tab, pane.id, { kind: "preview", url })} />}
          {c.kind === "file" && (
            <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner className="size-4 text-muted-foreground" /></div>}>
              <FilePane path={c.path} owner={owner} visible={visible} onClose={close} />
            </Suspense>
          )}
          {c.kind === "artifact" && (
            <Suspense fallback={<div className="flex-1" />}>
              <ArtifactPane id={c.id} focus={c.focus} />
            </Suspense>
          )}
          {c.kind === "helper" && <HelperPane box={c.box} session={c.session} helper={c.helper} title={c.title} onClose={close} onResolve={(id, title) => setPaneContent(wsKey, tab, pane.id, { ...c, helper: id, title })} />}
          {c.kind === "empty" && <EmptySide owner={owner} tab={tab} pane={pane.id} label={c.label} />}
          {c.kind === "log" && <LogView box={c.box} location={c.location} worktree={c.worktree} service={c.service} visible={visible} />}
          {c.kind === "panel" && <PanelPane wsKey={owner} plugin={c.plugin} panel={c.panel} />}
          {c.kind === "starting" && (
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              Starting {c.label}…
            </div>
          )}
          {c.kind === "error" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
              <p className="font-medium">Couldn't start it</p>
              <ErrorText className="max-w-md items-center text-muted-foreground text-xs" text={c.message} />
              <Button size="sm" variant="outline" onClick={close}>
                Close pane
              </Button>
            </div>
          )}
        </div>
      </div>
      </CompareSideContext.Provider>
    </PaneContext.Provider>
  );
}

// useGuestGone is the name of a guest pane's worktree once its box no
// longer lists it (archived or removed), else undefined. A pane of the
// tab's own worktree goes with its tab, so only guests can be left behind.
function useGuestGone(wsKey: string, pane: Leaf): string | undefined {
  const wt = pane.wt && pane.wt !== wsKey ? pane.wt : undefined;
  const ref = useWorktreeRef(wt);
  const listed = useStore((s) => (wt ? !!s.boxes[splitKey(wt).box]?.locations : false));
  const leaving = useRemoval(wt ? splitKey(wt).box : "", wt ? splitKey(wt).path : undefined);
  return wt && listed && !ref && !leaving ? nameFromKey(wt) : undefined;
}

// GonePane stands in for a guest pane whose worktree was archived.
function GonePane({ name, onClose }: { name: string; onClose(): void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm">
      <ArchiveIcon className="size-5 text-muted-foreground" />
      <p className="font-medium">{name} was archived</p>
      <p className="max-w-xs text-muted-foreground text-xs">Its agents stopped with it, so there is nothing left to show here.</p>
      <Button size="sm" variant="outline" onClick={onClose}>
        Close pane
      </Button>
    </div>
  );
}

// usePaneView is how an agent's pane shows: its terminal, or (Labs) its
// conversation. Shells and other panes are always what they are.
export function usePaneView(pane: Leaf): "terminal" | "conversation" | undefined {
  const c = pane.content;
  const labs = usePrefs((p) => p.labs);
  const fallback = usePrefs((p) => (p.zen ? "conversation" : p.agentView));
  // A pane made for a new session doesn't record its agent; the box's
  // session list says whether it runs one.
  const runsAgent = useStore((st) => {
    if (c.kind !== "terminal") return false;
    if (c.agent) return true;
    const s = st.boxes[c.box]?.sessions?.find((x) => x.name === c.session);
    return !!(s && agentOf(s));
  });
  if (c.kind !== "terminal" || !labs || !runsAgent) return undefined;
  return c.view ?? fallback;
}

// ViewSwitch flips an agent's pane between its terminal and its
// conversation.
export function ViewSwitch({ wsKey, tab, pane }: { wsKey: string; tab: string; pane: Leaf }) {
  const view = usePaneView(pane);
  const c = pane.content;
  if (!view || c.kind !== "terminal") return null;
  return (
    <ToggleGroup
      size="sm"
      variant="outline"
      value={[view]}
      onValueChange={(v) => {
        const next = v[0] as "terminal" | "conversation" | undefined;
        if (!next) return;
        setPaneContent(wsKey, tab, pane.id, { ...c, view: next });
        // The way you last chose to see an agent is how new ones open.
        usePrefs.setState({ agentView: next });
      }}
      aria-label="Show the agent as"
      className="mr-1"
    >
      <Tip label="Terminal">
        <ToggleGroupItem value="terminal" aria-label="Terminal" className="h-6! min-w-7! px-1!">
          <SquareTerminalIcon className="size-3.5" />
        </ToggleGroupItem>
      </Tip>
      <Tip label="Conversation">
        <ToggleGroupItem value="conversation" aria-label="Conversation" className="h-6! min-w-7! px-1!">
          <MessagesSquareIcon className="size-3.5" />
        </ToggleGroupItem>
      </Tip>
    </ToggleGroup>
  );
}

// paneLabel is what a pane is called in headers and tabs: the agent's name,
// "Shell", "Browser", or the plugin panel's title.
export function paneLabel(c: Leaf["content"], agent?: string): string {
  switch (c.kind) {
    case "terminal":
      return agent || c.agent ? agentLabel((agent ?? c.agent)!) : "Shell";
    case "browser":
      return "Browser";
    case "preview":
      return "Preview";
    case "file":
      return c.path.slice(c.path.lastIndexOf("/") + 1);
    case "log":
      return `${c.service} log`;
    case "helper":
      return c.title || "Helper";
    case "artifact":
      return c.id ? c.title || "Artifact" : "Artifacts";
    case "panel":
      return c.title;
    case "starting":
      return c.label;
    default:
      return "Error";
  }
}

export function PaneIcon({ content, agent, className }: { content: Leaf["content"]; agent?: string; className?: string }) {
  const c = content;
  const service = useStore((s) => c.kind === "terminal" && !!s.boxes[c.box]?.sessions?.find((x) => x.name === c.session)?.service);
  if (c.kind === "browser") return <GlobeIcon className={cn("size-3.5 shrink-0", className)} />;
  if (c.kind === "file") return <FileGlyph path={c.path} className={className} />;
  if (c.kind === "preview") return <MonitorSmartphoneIcon className={cn("size-3.5 shrink-0", className)} />;
  if (c.kind === "helper") return <BotIcon className={cn("size-3.5 shrink-0", className)} />;
  if (c.kind === "artifact") {
    const Icon = c.id ? (ART_ICONS[c.art ?? ""] ?? ChartColumnIcon) : LayoutGridIcon;
    return <Icon className={cn("size-3.5 shrink-0", className)} />;
  }
  if (c.kind === "log") return <ScrollTextIcon className={cn("size-3.5 shrink-0", className)} />;
  if (c.kind === "panel") return <PanelIcon plugin={c.plugin} panel={c.panel} className={cn("size-3.5 shrink-0", className)} />;
  if (service) return <ServiceIcon className={cn("size-3", className)} />;
  return <AgentIcon agent={agent ?? (c.kind === "terminal" ? c.agent : undefined)} className={cn("size-3", className)} />;
}

function PaneTitle({ pane, bare }: { pane: Leaf; bare?: boolean }) {
  const c = pane.content;
  const session = useStore((s) => (c.kind === "terminal" ? s.boxes[c.box]?.sessions?.find((x) => x.name === c.session) : undefined));
  const stats = useStore((s) => (c.kind === "terminal" ? s.boxes[c.box]?.stats : undefined));
  // Named as everywhere else: its title, then its agent ("Fix checkout
  // webhook · Claude Code"), or "Claude Code", "Shell 2" (sessionName).
  const named = useStore((s) => (c.kind === "terminal" && session ? sessionName(session, { sessions: s.boxes[c.box]?.sessions }) : undefined));
  const agent = session ? agentOf(session) : undefined;
  const label = named ?? paneLabel(c, agent);
  // Bare (the workspace layout): the agent's icon says which it is.
  const secondary = session && !bare ? sessionAgent(session) : "";
  // Honest about what it can't know: nothing while the box is away, ended
  // once the box no longer lists the session.
  const away = useStore((s) => c.kind === "terminal" && !!s.status && s.status.boxes.find((b) => b.name === c.box)?.state !== "online");
  const gone = useStore((s) => c.kind === "terminal" && !session && !!s.boxes[c.box]?.sessions);
  const helper = useHelperState(c);
  const state = helper ?? (away ? undefined : session ? sessionState(session, stats) : gone ? "exited" : undefined);
  // Near the box's per-session memory ceiling: said here and in its chat.
  const near = away ? undefined : memoryNote(session?.usage);
  return (
    <Tip label={c.kind === "terminal" ? `${c.session} on ${c.box}${away ? ` · ${c.box} is offline` : ""}${near ? ` · ${near}` : ""}` : undefined} align="start">
      <span className="flex min-w-0 items-center gap-1.5">
        <PaneIcon content={c} agent={agent} />
        <span className="truncate">{label}</span>
        {secondary && <span className="shrink-0 text-muted-foreground">{secondary}</span>}
        {state && <StateGlyph state={state} className="size-3" />}
        {near && session?.usage && (
          <span data-testid="pane-memory" className="flex shrink-0 items-center gap-1 text-[11px] text-warning-foreground tabular-nums dark:text-warning">
            <GaugeIcon className="size-3" aria-hidden />
            {memory(session.usage.memory)} of {memory(session.usage.memory_high ?? 0)}
          </span>
        )}
      </span>
    </Tip>
  );
}

// useHelperState is how a helper's pane's helper is doing: working, or
// back.
export function useHelperState(c: Leaf["content"]): "running" | "finished" | undefined {
  return useHelperInfo((s) => (c.kind === "helper" ? s[helperKey(c.box, c.session, c.helper)]?.state : undefined));
}

// PaneActions are a pane's split buttons and its ⋯ menu: in the pane's own
// header when the tab is split, and in the tab strip when it is not.
// ⌘W and ⌘D act on the focused pane, so only its buttons name them.
// compact (a tiny window's strip) keeps the ⋯ menu and drops the split
// buttons; ⌘D and ⌘⇧D still split.
export function PaneActions({ wsKey, tab, pane, onClose, closable, focused = true, compact }: { wsKey: string; tab: string; pane: Leaf; onClose?: () => void; closable?: boolean; focused?: boolean; compact?: boolean }) {
  const c = pane.content;
  const session = useStore((s) => (c.kind === "terminal" ? s.boxes[c.box]?.sessions?.find((x) => x.name === c.session) : undefined));
  // Agents to open beside it are its own worktree's repository's.
  const ref = useWorktreeRef(paneWorktree(wsKey, pane));
  const agent = session && agentOf(session);
  const close = onClose ?? (() => void closePane(wsKey, tab, pane.id));
  const labs = usePrefs((p) => p.labs);
  const beside = (dir: "row" | "col") => ({ kind: "split" as const, tab, pane: pane.id, dir });
  // The tab's other panes, for moving this one out or swapping it.
  const others = useWorkspaces((s) => {
    const t = s.spaces[wsKey]?.tabs.find((x) => x.id === tab);
    return t ? leaves(t.root).filter((l) => l.id !== pane.id).map((l) => l.id).join(" ") : "";
  })
    .split(" ")
    .filter(Boolean);

  return (
    <>
      <ViewSwitch wsKey={wsKey} tab={tab} pane={pane} />
      {!compact && (
        <>
          <HeaderButton label="Split right" keys={focused ? "⌘D" : undefined} onClick={() => void startSession("", beside("row"))}>
            <SquareSplitHorizontalIcon />
          </HeaderButton>
          <HeaderButton label="Split down" keys={focused ? "⌘⇧D" : undefined} onClick={() => void startSession("", beside("col"))}>
            <SquareSplitVerticalIcon />
          </HeaderButton>
        </>
      )}
      <Menu>
        <Tip label="Pane actions">
          <MenuTrigger render={<button type="button" aria-label="Pane actions" className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent" />}>
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
        </Tip>
        <MenuPopup align="end" className="min-w-56">
          {c.kind === "terminal" && agent && (
            <>
              <SessionActionItems box={c.box} session={c.session} />
              <MenuSeparator />
            </>
          )}
          <MenuGroup>
            <MenuGroupLabel>Open beside</MenuGroupLabel>
            {ref &&
              agentPresets(ref.box, ref.location).map((p) => (
                <MenuItem key={p.id} onClick={() => void startSession(p.command, beside("row"), p.name)}>
                  <span className="flex size-4 items-center justify-center">
                    <AgentIcon agent={p.id} />
                  </span>
                  {p.name}
                </MenuItem>
              ))}
            <MenuItem onClick={() => void startSession("", beside("row"))}>
              <span className="flex size-4 items-center justify-center">
                <AgentIcon />
              </span>
              Shell
            </MenuItem>
            <MenuItem onClick={() => openBrowserAt("", beside("row"))}>
              <span className="flex size-4 items-center justify-center">
                <GlobeIcon />
              </span>
              Browser
            </MenuItem>
            <MenuItem onClick={() => openPreviewAt("", beside("row"))}>
              <span className="flex size-4 items-center justify-center">
                <MonitorSmartphoneIcon />
              </span>
              Preview
            </MenuItem>
            {labs && (
              <MenuItem
                onClick={() => {
                  focusPane(wsKey, tab, pane.id);
                  openWorktreePicker({ kind: "split" });
                }}
              >
                <span className="flex size-4 items-center justify-center">
                  <Columns2Icon />
                </span>
                Another worktree…
                {focused && <MenuShortcut>⌘⌥D</MenuShortcut>}
              </MenuItem>
            )}
          </MenuGroup>
          <MenuSeparator />
          {c.kind === "terminal" && session && (
            <MenuItem onClick={() => startRenaming(c.box, c.session)}>
              <PencilIcon />
              Rename…
            </MenuItem>
          )}
          {c.kind === "terminal" && agent && (
            <MenuItem onClick={openChatBackgroundSettings}>
              <ImageIcon />
              Chat background…
            </MenuItem>
          )}
          {others.length > 0 && (
            <>
              <MenuItem onClick={() => paneToTab(wsKey, tab, pane.id)}>
                <AppWindowIcon />
                Move to a new tab
              </MenuItem>
              {others.length === 1 && (
                <MenuItem onClick={() => paneBeside(wsKey, tab, pane.id, others[0], "center")}>
                  <ArrowLeftRightIcon />
                  Swap with the other pane
                </MenuItem>
              )}
            </>
          )}
          <MenuItem onClick={close}>
            <XIcon />
            {closable ? "Close pane" : "Close tab"}
            {focused && <MenuShortcut>⌘W</MenuShortcut>}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {closable && (
        <HeaderButton label="Close pane" keys={focused ? "⌘W" : undefined} onClick={close}>
          <XIcon />
        </HeaderButton>
      )}
    </>
  );
}

function HeaderButton({ label, keys, onClick, children }: { label: string; keys?: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tip
      label={
        <span className="flex items-center gap-2">
          {label}
          {keys && <span className="text-muted-foreground">{platformKeys(keys)}</span>}
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
