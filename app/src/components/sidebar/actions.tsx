import { ActivityIcon, ListPlusIcon, PaletteIcon, ArchiveIcon, ArrowUpCircleIcon, ArrowUpRightIcon, BotIcon, CheckIcon, FolderInputIcon, MergeIcon, PackageIcon, PencilIcon, PlusIcon, ServerIcon, SplitIcon, CodeXmlIcon, CopyIcon, EllipsisIcon, ExternalLinkIcon, FolderOpenIcon, GitBranchIcon, GitCompareArrowsIcon, GitBranchPlusIcon, GitPullRequestIcon, GlobeIcon, HomeIcon, LinkIcon, PlayIcon, RotateCwIcon, Settings2Icon, SquareIcon, SquareTerminalIcon, StethoscopeIcon, Trash2Icon, UnplugIcon, WorkflowIcon, WrenchIcon, BellOffIcon, UsersRoundIcon, HistoryIcon } from "lucide-react";
import { type ComponentProps, createContext, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type TouchEvent, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { EditorMenuItems } from "@/components/editors/editor-menu";
import { AutoFixItems } from "@/components/sidebar/autofix-items";
import { boxHasRuns } from "@/lib/runs";
import { openUpdate, reviewOf } from "@/lib/pr-review";
import { copyReviewLink } from "@/views/pr-review/copy-link";
import { loginUserLabel, useLoginConfig } from "@/lib/login-users";
import { entryKey, useReview } from "@/views/review/review-store";
import { SessionActionItems } from "@/components/orchestrate/session-actions";
import { confirm, copy } from "@/components/sidebar/confirm";
import { Tip } from "@/components/tip";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { agentPresets, openBrowserAt, resumeConversation, startAgent, startSession, stopSession } from "@/lib/actions";
import { boxApi, type BoxStatus, type Conversation, laptopApi, type Location, type Worktree, type WorktreeService } from "@/lib/api";
import { portUrl } from "@/lib/browser-url";
import { agentOf, worktreeSessions } from "@/lib/derive";
import { ago, errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { scheduleRefresh, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { removeWorktreeOnBox } from "@/lib/remove-worktree";
import { addGroup, isShown, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { ToneItems } from "@/components/workspace/tab-group";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { usePrefs } from "@/lib/prefs";
import { useRegistry } from "@/plugins/registry";
import { openAddToBox } from "@/components/sidebar/add-to-box-dialog";
import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import { renameWorktree, shortLabel, worktreeLabel } from "@/lib/worktree-names";
import { openHomeTerminal } from "@/components/box-picker";
import { boxLoad } from "@/components/sidebar/box-load";
import { ink } from "@/components/sidebar/ink";
import { kitsApi } from "@/lib/kits";
import { deriveProjects, type Member, type Project, projectActions as groupActions, useProjectsDoc } from "@/lib/project-groups";
import { reloadKits, useKits } from "@/views/kits/kits-store";
import { useTeam } from "@/lib/team";
import { copyTeamLink, dismissSuggestion, projectSuggestion, reviewSuggestion } from "@/lib/team-suggest";
import { orgName } from "@/lib/team-suggest-model";
import { openTeamKit } from "@/views/team/team-kit-sheet";

// The sidebar's actions are defined once and drawn into either menu: the
// ⋯ button on a row, or the row's right-click menu. Both show the same
// items in the same order, with what removes things last and in red, each
// behind a confirmation that names what it removes.

export type Action =
  | { type: "item"; label: string; icon?: ReactNode; shortcut?: string; hint?: string; destructive?: boolean; disabled?: boolean; run(): void }
  | { type: "sub"; label: string; icon?: ReactNode; items: Action[] | (() => ReactNode) }
  | { type: "label"; label: string }
  | { type: "sep" }
  | { type: "node"; node: ReactNode };

const item = (label: string, icon: ReactNode, run: () => void, more: Partial<Extract<Action, { type: "item" }>> = {}): Action => ({ type: "item", label, icon, run, ...more });
const sep: Action = { type: "sep" };

// ActionItems draws actions as menu items; it works inside a Menu or a
// ContextMenu, which share their parts. Given a function, it makes them as
// it draws: a menu's popup is only drawn while open, so a row's actions are
// only worked out when its menu opens.
export function ActionItems({ items: from }: { items: Action[] | (() => Action[]) }) {
  const items = typeof from === "function" ? from() : from;
  return (
    <>
      {items.map((a, i) => {
        switch (a.type) {
          case "sep":
            return <MenuSeparator key={i} />;
          case "label":
            // Base UI requires a group label inside a group.
            return (
              <MenuGroup key={i}>
                <MenuGroupLabel className="px-2 pt-1 pb-0.5">{a.label}</MenuGroupLabel>
              </MenuGroup>
            );
          case "node":
            return <span key={i}>{a.node}</span>;
          case "sub":
            return (
              <MenuSub key={i}>
                <MenuSubTrigger>
                  {a.icon}
                  {a.label}
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-48">{typeof a.items === "function" ? a.items() : <ActionItems items={a.items} />}</MenuSubPopup>
              </MenuSub>
            );
          default:
            return (
              <MenuItem key={i} variant={a.destructive ? "destructive" : "default"} disabled={a.disabled} onClick={a.run}>
                {a.icon}
                <span className="flex-1">{a.label}</span>
                {a.hint && <span className="text-meta text-muted-foreground">{a.hint}</span>}
                {a.shortcut && <Kbd className="ml-2">{a.shortcut}</Kbd>}
              </MenuItem>
            );
        }
      })}
    </>
  );
}

// DotsMenu is the ⋯ button for a row.
export function DotsMenu({ label, items }: { label: string; items: () => Action[] }) {
  return (
    <Menu>
      <Tip label={label}>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className={cn("inline-flex size-6 items-center justify-center rounded-md hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent [&_svg]:size-3.5", ink.glyph)}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
      </Tip>
      <MenuPopup align="start" className="min-w-56">
        <ActionItems items={items} />
      </MenuPopup>
    </Menu>
  );
}

// ---- Rows' menus ------------------------------------------------------------------

// A list of hundreds of rows (the sidebar's, the rail's) can't afford a
// context menu, ⋯ menu and tooltips of its own on every row: it is a
// RowMenus, with one context menu for all its rows, and each row only draws
// its buttons once the pointer or focus first comes to it ("armed").

interface RowMenuHost {
  rows: Map<string, { items: { current: () => Action[] }; arm(): void }>;
  // Marks rows out of sight (data-offscreen), where agents' state glyphs
  // stop spinning and pulsing (index.css): hundreds of running animations
  // kept the main thread busy at rest.
  sight?: IntersectionObserver;
}

const RowMenuContext = createContext<RowMenuHost | null>(null);
const ArmedContext = createContext(true);

// useArmed says whether the row it is in has been pointed at or focused
// (always, outside a RowMenus); Armed draws its children only then.
export const useArmed = () => useContext(ArmedContext);
export function Armed({ children }: { children: ReactNode }) {
  return useArmed() ? children : null;
}

// unmarked is a RowMenus' props without its open and pressed marks.
function unmarked<P extends object>(p: P): P {
  const { "data-popup-open": _open, "data-pressed": _pressed, ...rest } = p as P & { "data-popup-open"?: unknown; "data-pressed"?: unknown };
  return rest as P;
}

const rowOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-row-menu]") : null);

// RowMenus holds rows (ContextRow) and opens their context menus: on a
// right-click, or Shift+F10 or the menu key on a focused row. It renders a
// div, with the props given.
export function RowMenus({ children, onKeyDown, ...props }: ComponentProps<"div">) {
  const host = useMemo<RowMenuHost>(
    () => ({
      rows: new Map(),
      sight:
        typeof IntersectionObserver === "undefined"
          ? undefined
          : new IntersectionObserver((es) => {
              for (const e of es) e.target.toggleAttribute("data-offscreen", !e.isIntersecting);
            }),
    }),
    [],
  );
  const [items, setItems] = useState<{ fn: () => Action[] }>();
  const row = useRef<HTMLElement>(undefined);
  const mark = (el?: HTMLElement) => {
    row.current?.removeAttribute("data-menu-open");
    row.current = el;
    el?.setAttribute("data-menu-open", "");
  };
  const pick = (e: ReactMouseEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>) => {
    const el = rowOf(e.target);
    const entry = el && e.currentTarget.contains(el) ? host.rows.get(el.dataset.rowMenu ?? "") : undefined;
    if (!el || !entry) return e.stopPropagation();
    mark(el);
    setItems({ fn: entry.items.current });
  };
  return (
    <RowMenuContext.Provider value={host}>
      <ContextMenu onOpenChange={(open) => !open && mark(undefined)}>
        <ContextMenuTrigger
          {...props}
          // Not marked open itself: an attribute on a list this big restyled
          // all of it (60 ms at 300 worktrees); the row is marked instead.
          render={(p) => <div {...unmarked(p)} />}
          // Whose menu it is, before the trigger opens it (a right-click, or
          // a touch held down); outside a row, none.
          onContextMenuCapture={pick}
          onTouchStartCapture={pick}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            onKeyDown?.(e);
            const el = rowOf(e.target);
            if (!el || !e.currentTarget.contains(el)) return;
            // Shift+Tab goes back to the row before's last button: draw them.
            if (e.key === "Tab" && e.shiftKey) {
              const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-menu]")];
              const prev = all[all.indexOf(el) - 1];
              if (prev) host.rows.get(prev.dataset.rowMenu ?? "")?.arm();
              return;
            }
            if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
            e.preventDefault();
            const r = (document.activeElement as HTMLElement | null)?.getBoundingClientRect() ?? el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + r.height / 2, button: 2 }));
          }}
        >
          {children}
          {/* Inside the trigger, so tooltips in it reach a tip layer round it. */}
          <ContextMenuPopup className="min-w-56">{items && <ActionItems items={items.fn} />}</ContextMenuPopup>
        </ContextMenuTrigger>
      </ContextMenu>
    </RowMenuContext.Provider>
  );
}

// ContextRow gives a row a right-click menu. The row looks selected while
// its menu is open, and Shift+F10 or the menu key opens it from the
// keyboard on a focused row. Inside a RowMenus it is a plain div that
// RowMenus opens a menu for; elsewhere it is a context menu of its own.
export function ContextRow(props: { items: () => Action[]; children: ReactNode; className?: string }) {
  const host = useContext(RowMenuContext);
  return host ? <HostedRow host={host} {...props} /> : <OwnContextRow {...props} />;
}

function HostedRow({ host, items, children, className }: { host: RowMenuHost; items: () => Action[]; children: ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef(items);
  ref.current = items;
  const [armed, setArmed] = useState(false);
  useLayoutEffect(() => {
    host.rows.set(id, { items: ref, arm: () => setArmed(true) });
    return () => void host.rows.delete(id);
  }, [host, id]);
  const watch = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !host.sight) return;
      host.sight.observe(el);
      return () => host.sight?.unobserve(el);
    },
    [host],
  );
  const arm = armed ? undefined : () => setArmed(true);
  return (
    <div ref={watch} data-row-menu={id} onPointerEnter={arm} onFocus={arm} className={cn("block rounded-md data-menu-open:bg-sidebar-accent", className)}>
      <ArmedContext.Provider value={armed}>{children}</ArmedContext.Provider>
    </div>
  );
}

function OwnContextRow({ items, children, className }: { items: () => Action[]; children: ReactNode; className?: string }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn("block rounded-md data-popup-open:bg-sidebar-accent", className)}
        onKeyDown={(e) => {
          if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
          e.preventDefault();
          const el = e.currentTarget as HTMLElement;
          const r = (document.activeElement as HTMLElement | null)?.getBoundingClientRect() ?? el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + r.height / 2, button: 2 }));
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuPopup className="min-w-56">
        <ActionItems items={items} />
      </ContextMenuPopup>
    </ContextMenu>
  );
}

const slot = (icon: ReactNode) => <span className="flex size-4 items-center justify-center">{icon}</span>;

function urlFor(box: string, loc: Location, wt: Worktree) {
  const st = useStore.getState();
  const services = st.boxes[box]?.services ?? [];
  const port = services
    .filter((s) => s.path === wt.path)
    .map((s) => s.port)
    .sort((a, b) => a - b)[0];
  return port ? portUrl(port, { ref: refOf(box, loc, wt), services, urlPort: st.status?.proxy.url_port }) : undefined;
}

// worktreeActions is everything a worktree row offers, in four short
// groups: what to start in it; where else to open it and what to run on it;
// what it is called and looks like, and what to copy; then what ends it.
// The rarer ones (resuming, comparing, each thing to copy) sit one step in.
export function worktreeActions(box: string, loc: Location, wt: Worktree): Action[] {
  const st = useStore.getState();
  const sessions = worktreeSessions(st.boxes[box]?.sessions, wt).filter((s) => !s.exited);
  const agentSession = sessions.find((s) => agentOf(s));
  const url = urlFor(box, loc, wt);
  const name = worktreeLabel(wt, loc);
  const select = () => selectWorktree(refOf(box, loc, wt));
  // What these start is this worktree's, whatever pane has the focus there.
  const key = wsKey(box, wt.path);
  const presets = agentPresets(box, loc);

  // Labs: its tabs beside the worktree in front, as a group of the strip.
  const ws = useWorkspaces.getState();
  const front = ws.current && ws.current !== key ? ws.spaces[ws.current]?.ref : undefined;
  const grouping = usePrefs.getState().labs;

  const agents: Action[] = presets.map((p) =>
    item(p.name, slot(<AgentIcon agent={p.id} />), () => {
      select();
      void startAgent(p, { kind: "tab" }, p.name, key);
    }),
  );
  if (st.boxes[box]?.info?.capabilities?.includes("conversations")) agents.push(sep, { type: "sub", label: "Resume a conversation", icon: <HistoryIcon />, items: () => <ResumeItems box={box} loc={loc} wt={wt} /> });

  const items: Action[] = [
    item("Open", wt.main ? <HomeIcon /> : <GitBranchIcon />, select),
    { type: "sub", label: "New agent", icon: <BotIcon />, items: agents },
    item("New terminal", <SquareTerminalIcon />, () => {
      select();
      void startSession("", { kind: "tab" }, "Terminal", key);
    }),
    item(url ? "Open dev server" : "New browser tab", <GlobeIcon />, () => {
      select();
      openBrowserAt(url ?? "", { kind: "tab" }, key);
    }),
    sep,
    {
      type: "sub",
      label: "Open in",
      icon: <CodeXmlIcon />,
      items: () => (
        <>
          <EditorMenuItems box={box} path={wt.path} />
          {grouping && (
            <>
              <MenuSeparator />
              <ActionItems
                items={[
                  ...(front && !isShown(key) ? [item(`Tabs beside ${shortLabel(front)}`, <ListPlusIcon />, () => void addGroup(key), { shortcut: "⌥ Click" })] : []),
                  item("Compare with…", <GitCompareArrowsIcon />, () => openWorktreePicker({ kind: "compare", from: key })),
                ]}
              />
            </>
          )}
        </>
      ),
    },
    { type: "sub", label: "Run", icon: <PlayIcon />, items: () => <RunItems box={box} loc={loc} wt={wt} /> },
  ];
  // A branch's pull request can fix its own CI and review comments.
  if (!wt.main && wt.branch && boxHasRuns(box)) items.push({ type: "sub", label: "Auto-fix this PR", icon: <WrenchIcon />, items: () => <AutoFixItems box={box} path={wt.path} /> });
  if (agentSession) items.push({ type: "sub", label: "Orchestrate", icon: <WorkflowIcon />, items: () => <SessionActionItems box={box} session={agentSession.name} /> });
  // The berth://review link for its PR, for a teammate to review it on
  // their own box: a review's PR, or the PR its branch has, if any.
  const review = reviewOf(wt);
  const knownPr = useReview.getState().prs[entryKey(box, wt.path)];
  if (review) items.push(item("Update review to latest…", <RotateCwIcon />, () => openUpdate(box, loc, wt)));

  items.push(sep);
  // A display name for it; the branch and folder keep theirs.
  if (!wt.main) {
    items.push(item("Rename…", <PencilIcon />, () => openRenameWorktree(box, loc, wt), { shortcut: "F2" }));
    if (wt.title) items.push(item(`Show as ${wt.name}`, <span className="size-4" />, () => void renameWorktree(box, loc, wt, "")));
  }
  if (grouping) items.push({ type: "sub", label: "Colour", icon: <PaletteIcon />, items: () => <ToneItems wsKey={key} /> });
  const copies: Action[] = [item("Path", <FolderOpenIcon />, () => copy(wt.path, "path"))];
  if (wt.branch) copies.push(item("Branch", <GitBranchIcon />, () => copy(wt.branch!, "branch name")));
  if (url) copies.push(item("URL", <LinkIcon />, () => copy(url, "URL")));
  if (review || (!wt.main && wt.branch && knownPr !== null)) {
    copies.push(item("Review link", <GitPullRequestIcon />, () => void copyReviewLink(box, loc, wt)));
    // The same link, opening logged in as one of the project's dev users.
    copies.push({ type: "sub", label: "Review link as…", icon: <span className="size-4" />, items: () => <ReviewLinkAsItems box={box} loc={loc} wt={wt} /> });
  }
  items.push({ type: "sub", label: "Copy", icon: <CopyIcon />, items: copies });

  const danger: Action[] = [];
  if (sessions.length > 0) {
    danger.push(
      item(`Stop ${sessions.length === 1 ? "its session" : `all ${sessions.length} sessions`}…`, <SquareIcon />, () =>
        confirm({
          title: `Stop everything in ${name}?`,
          description: `${sessions.length === 1 ? "Its session stops" : `All ${sessions.length} sessions stop`}, agents included. Their work stays in the worktree.`,
          detail: sessions.map((s) => s.name).join("\n"),
          confirm: "Stop sessions",
          destructive: true,
          run: async () => {
            for (const s of sessions) await stopSession(box, s.name, true);
          },
        }),
        { destructive: true },
      ),
    );
  }
  if (!wt.main) {
    danger.push(item("Archive…", <ArchiveIcon />, () => archiveWorktree(box, loc, wt)));
    danger.push(item("Remove worktree…", <Trash2Icon />, () => removeWorktree(box, loc, wt), { destructive: true }));
  }
  if (danger.length) items.push(sep, ...danger);
  return items;
}

// archiveWorktree asks, then archives a worktree: its sessions and services
// stop, the repo's archive script runs (on the box, in the background),
// then its folder goes. Its branch stays, and git refuses to lose
// uncommitted work, so nothing is lost; Remove is the way to discard.
export function archiveWorktree(box: string, loc: Location, wt: Worktree) {
  const script = loc.scripts?.archive;
  confirm({
    title: `Archive ${worktreeLabel(wt)}?`,
    description: `${script ? "The repo's archive script runs, then its" : "Its"} folder on ${box} goes and its sessions and services stop. ${wt.branch ? `Branch ${wt.branch} stays, so you can pick it up again.` : ""}`,
    detail: script ? <span className="font-mono">{script}</span> : undefined,
    confirm: "Archive",
    run: async () => {
      const client = useStore.getState().client;
      if (!client) throw new Error("not connected");
      let res: { archive?: string };
      try {
        res = await removeWorktreeOnBox(client, box, loc.name, wt, "archive");
      } catch (err) {
        if (/modified|untracked|uncommitted|contains/i.test(errorMessage(err))) throw new Error(`${wt.name} has uncommitted changes, so it was left as it is. Commit them first, or use Remove worktree… to discard them.`);
        throw err;
      }
      if (res.archive) toastManager.add({ title: `Archiving ${wt.name}`, description: "Its archive script is running on the box; the worktree goes when it finishes.", type: "info" });
      else toastManager.add({ title: `Archived ${wt.name}`, description: wt.branch ? `Branch ${wt.branch} is kept.` : box, type: "success" });
    },
  });
}

// removeWorktree asks, then removes a worktree: the sidebar's "Remove
// worktree…" and the dashboard's "Stop and remove worktree…".
export function removeWorktree(box: string, loc: Location, wt: Worktree) {
  confirm({
    title: `Remove ${worktreeLabel(wt)}?`,
    description: `Its folder on ${box} is deleted. The repository's teardown script runs first, and the worktree's services and sessions stop.`,
    detail: (
      <>
        {wt.path}
        {wt.branch && (
          <>
            <br />
            branch {wt.branch}
          </>
        )}
      </>
    ),
    confirm: "Remove worktree",
    destructive: true,
    options: [
      ...(wt.branch ? [{ id: "branch", label: `Also delete branch ${wt.branch}` }] : []),
      { id: "force", label: "Remove even with uncommitted changes", hint: "Without this, git refuses when there is work it would lose." },
    ],
    run: async (checked) => {
      const client = useStore.getState().client;
      if (!client) throw new Error("not connected");
      let res: { archive?: string };
      try {
        res = await removeWorktreeOnBox(client, box, loc.name, wt, "remove", { force: checked.force, branch: checked.branch });
      } catch (err) {
        const m = errorMessage(err);
        // git's own words for work it would lose.
        if (/modified|untracked|uncommitted|contains/i.test(m) && !checked.force) throw new Error(`${wt.name} has uncommitted changes. Tick "Remove even with uncommitted changes" to remove it anyway.`);
        throw err;
      }
      if (res.archive) toastManager.add({ title: `Removing ${wt.name}`, description: "The repo's archive script runs on the box first; the worktree goes when it finishes.", type: "info" });
      else toastManager.add({ title: `Removed ${wt.name}`, description: box, type: "success" });
    },
  });
}

// RunItems are a worktree's services, loaded when the Run submenu opens.
function ReviewLinkAsItems({ box, loc, wt }: { box: string; loc: Location; wt: Worktree }) {
  const login = useLoginConfig(box, loc.name);
  if (!login?.users?.length) return <div className="max-w-56 px-2 py-1.5 text-muted-foreground text-meta">{loc.name} lists no dev users to log in as.</div>;
  return <ActionItems items={login.users.map((u) => item(loginUserLabel(u), <span className="size-4" />, () => void copyReviewLink(box, loc, wt, { as: u.email })))} />;
}

// ResumeItems are the worktree's structured conversations whose agent isn't
// running, newest first: each carries on where it left off.
function ResumeItems({ box, loc, wt }: { box: string; loc: Location; wt: Worktree }) {
  const [list, setList] = useState<Conversation[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const client = useStore.getState().client;
    if (!client) return;
    boxApi.conversations(client, box, wt.path).then(
      (all) => setList(all.filter((c) => !c.live)),
      (e) => {
        setList([]);
        setError(plainError(e));
      },
    );
  }, [box, wt.path]);
  if (!list) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-meta">
        <Spinner className="size-3" /> Loading…
      </div>
    );
  }
  if (!list.length) return <div className="max-w-56 px-2 py-1.5 text-muted-foreground text-meta">{error ?? "No structured conversations to resume here."}</div>;
  const items: Action[] = list.slice(0, 12).map((c) =>
    item(`${c.title || "Untitled"} · ${ago(c.updated ?? c.created)}`, slot(<AgentIcon agent={c.agent} />), () => {
      selectWorktree(refOf(box, loc, wt));
      void resumeConversation(box, c, wsKey(box, wt.path));
    }),
  );
  return <ActionItems items={items} />;
}

function RunItems({ box, loc, wt }: { box: string; loc: Location; wt: Worktree }) {
  const [list, setList] = useState<WorktreeService[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const client = useStore.getState().client;
    if (!client) return;
    boxApi.worktreeServices(client, box, loc.name, wt.name).then(setList, (e) => {
      setList([]);
      setError(plainError(e));
    });
  }, [box, loc.name, wt.name]);
  if (!list) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-meta">
        <Spinner className="size-3" /> Loading…
      </div>
    );
  }
  if (!list.length) return <div className="max-w-56 px-2 py-1.5 text-muted-foreground text-meta">{error ?? `${loc.name} defines no services.`}</div>;
  const act = (svc: WorktreeService, action: "start" | "stop" | "restart") => {
    const client = useStore.getState().client;
    if (!client) return;
    boxApi.serviceAction(client, box, loc.name, wt.name, svc.name, action).then(
      () => toastManager.add({ title: `${action === "stop" ? "Stopped" : action === "restart" ? "Restarted" : "Started"} ${svc.name}`, description: wt.main ? loc.name : wt.name, type: "success" }),
      (e) => toastManager.add({ title: `Could not ${action} ${svc.name}`, description: errorMessage(e), type: "error" }),
    );
  };
  const items: Action[] = list.flatMap((svc, i) => {
    const live = svc.state === "running" || svc.state === "activating";
    const url = svc.port ? portUrl(svc.port, { ref: refOf(box, loc, wt), services: useStore.getState().boxes[box]?.services, urlPort: useStore.getState().status?.proxy.url_port }) : undefined;
    return [
      ...(i > 0 ? [sep] : []),
      { type: "label" as const, label: `${svc.name} · ${svc.state}` },
      live ? item(`Stop ${svc.name}`, <SquareIcon />, () => act(svc, "stop")) : item(`Start ${svc.name}`, <PlayIcon />, () => act(svc, "start")),
      ...(live ? [item(`Restart ${svc.name}`, <RotateCwIcon />, () => act(svc, "restart"))] : []),
      ...(live && url
        ? [
            item(`Open ${svc.name}`, <ArrowUpRightIcon />, () => {
              selectWorktree(refOf(box, loc, wt));
              openBrowserAt(url, { kind: "tab" }, wsKey(box, wt.path));
            }),
          ]
        : []),
    ];
  });
  return <ActionItems items={items} />;
}

const githubSlug = (loc: Location) => (loc.slug && loc.remote && /github\.com/i.test(loc.remote) ? loc.slug : undefined);

// teamActions are a project's team setup: when the laptop noticed that its
// org publishes one the person hasn't accepted, a quiet way to review it or
// to never hear of it again; and, for any org whose setup exists, the link
// that opens it, to send a teammate.
function teamActions(members: { box: string; loc: Location }[]): Action[] {
  const found = members.map((m) => projectSuggestion(m.box, m.loc.name)).find(Boolean);
  const out: Action[] = [];
  let org = found?.suggestion.org;
  if (found) {
    const s = found.suggestion;
    out.push(item(`${orgName(s)} has a team setup`, <UsersRoundIcon />, () => reviewSuggestion(s, found.project.box), { hint: "Review…" }));
    // Or just this project's kit from it, without the box steps.
    if (found.project.kit && !found.project.kit_applied) {
      const p = found.project;
      out.push(item(`Use ${s.org}'s kit for this project…`, <PackageIcon />, () => openTeamKit({ org: s.org, name: orgName(s), box: p.box, location: p.location })));
    }
    out.push(item(`Don't suggest again for ${s.org}`, <BellOffIcon />, () => void dismissSuggestion(s)));
  } else {
    // Set up from its org's own .berth on this laptop.
    const owners = new Set(members.map((m) => githubSlug(m.loc)?.split("/")[0]?.toLowerCase()).filter(Boolean));
    org = useTeam.getState().accepted.find((a) => owners.has(a.org.toLowerCase()) && (a.key ?? a.org).toLowerCase() === a.org.toLowerCase())?.org;
  }
  if (org) {
    const o = org;
    out.push(item("Copy team setup link", <LinkIcon />, () => copyTeamLink(o)));
  }
  return out.length ? [sep, ...out] : [];
}

// projectActions is everything a repository row offers.
export function projectActions(box: string, loc: Location): Action[] {
  const st = useStore.getState();
  const main = loc.worktrees?.find((w) => w.main);
  const gh = githubSlug(loc);
  const items: Action[] = [];
  if (main) items.push(item("Open main checkout", <HomeIcon />, () => selectWorktree(refOf(box, loc, main))));
  items.push({ type: "sub", label: "Open in", icon: <CodeXmlIcon />, items: () => <EditorMenuItems box={box} path={main?.path ?? loc.path} /> });
  items.push(
    item("New task…", <GitBranchPlusIcon />, () => st.openNewWorktree({ box, location: loc.name }), { shortcut: "⌘N" }),
    item("Project settings", <Settings2Icon />, () => st.setView({ kind: "project", box, location: loc.name })),
    ...teamActions([{ box, loc }]),
    sep,
    item("Copy path", <CopyIcon />, () => copy(loc.path, "path")),
  );
  if (loc.slug) items.push(item("Copy owner/repo", <CopyIcon />, () => copy(loc.slug!, "repository name")));
  if (gh) items.push(item("Open on GitHub", <ExternalLinkIcon />, () => void import("@/lib/open-url").then((m) => m.openUrl(`https://github.com/${gh}`))));
  items.push(
    sep,
    item(
      "Remove project from Shipyard…",
      <Trash2Icon />,
      () =>
        confirm({
          title: `Remove ${loc.name} from Shipyard?`,
          description: `Shipyard stops listing it. Files on ${box} are not touched, and its worktrees stay on disk.`,
          detail: loc.path,
          confirm: "Remove project",
          destructive: true,
          run: async () => {
            const client = useStore.getState().client;
            if (!client) throw new Error("not connected");
            await client.box(box, "DELETE", `locations/${encodeURIComponent(loc.name)}`);
            scheduleRefresh(box, ["locations"]);
            toastManager.add({ title: `Removed ${loc.name}`, description: `from ${box}`, type: "success" });
          },
        }),
      { destructive: true },
    ),
  );
  return items;
}

// boxActions is everything a box offers.
export function boxActions(box: BoxStatus): Action[] {
  const st = useStore.getState();
  const online = box.state === "online";
  const monitor = useRegistry.getState().screens.some((c) => c.plugin === "box-monitor" && c.item.id === "boxes");
  const items: Action[] = [];
  if (online) items.push(item("Add a project…", <FolderOpenIcon />, () => st.openAddProject(box.name)));
  // A terminal on the box itself, in its home, over Home (lib/box-home.ts).
  if (online) items.push(item("New terminal", <SquareTerminalIcon />, () => void openHomeTerminal(box.name)));
  if (monitor) items.push(item("Box monitor", <ActivityIcon />, () => st.setView({ kind: "plugin", screen: "boxes" })));
  if (!online) items.push(item("Reconnect", <RotateCwIcon />, () => void st.refreshAll()));
  if (online)
    items.push(
      item("Upgrade berthd", <ArrowUpCircleIcon />, () => {
        const client = useStore.getState().client;
        if (!client) return;
        const id = toastManager.add({ title: `Upgrading ${box.name}…`, type: "loading" });
        laptopApi.upgrade(client, box.name, () => {}).then(
          () => toastManager.update(id, { title: `Upgraded ${box.name}`, type: "success" }),
          (e) => toastManager.update(id, { title: `Could not upgrade ${box.name}`, description: errorMessage(e), type: "error" }),
        );
      }),
    );
  items.push(
    item("Doctor", <StethoscopeIcon />, () => st.setView({ kind: "settings", section: "boxes" })),
    sep,
    item("Copy address", <CopyIcon />, () => copy(box.address, "address")),
    sep,
    item(
      "Forget box…",
      <UnplugIcon />,
      () =>
        confirm({
          title: `Forget ${box.name}?`,
          description: `This laptop stops trusting it and drops its forwards. Nothing on ${box.name} changes: its sessions keep running, and you can pair again later.`,
          detail: box.address,
          confirm: "Forget box",
          destructive: true,
          run: async () => {
            const client = useStore.getState().client;
            if (!client) throw new Error("not connected");
            await laptopApi.forget(client, box.name);
            await useStore.getState().refreshAll();
            toastManager.add({ title: `Forgot ${box.name}`, type: "success" });
          },
        }),
      { destructive: true },
    ),
  );
  return items;
}

// Projects across boxes: what a project row offers. New work goes to the
// project's default box unless another is picked, and each box shows how
// busy it is.
export function projectGroupActions(p: Project): Action[] {
  const st = useStore.getState();
  const online = p.members.filter((m) => m.box.state === "online");
  const def = p.members.find((m) => m.box.name === p.defaultBox) ?? online[0] ?? p.members[0];
  const multi = p.members.length > 1;
  const main = (m: Member) => m.loc.worktrees?.find((w) => w.main);
  const { kits, installed } = useKits.getState();
  const kit = kits?.find((k) => k.match?.slug && p.slug && k.match.slug.toLowerCase() === p.slug.toLowerCase());
  const kitOn = (installed ?? []).filter((i) => p.members.some((m) => m.box.name === i.box && m.loc.name === i.location));
  const others = deriveProjects(st.status?.boxes ?? [], st.boxes, useProjectsDoc.getState().doc).filter((x) => x.id !== p.id);
  const sections = useProjectsDoc.getState().doc.sections;
  const gh = p.slug && p.remote && /github\.com/i.test(p.remote) ? p.slug : undefined;
  const items: Action[] = [];

  // Kept to about ten entries: what you open or start first, then one
  // submenu per object (its boxes, its kit, how it is organised), then
  // removing, last and in red, never inside a submenu.
  const mm = def && main(def);
  if (mm) items.push(item(multi ? `Open main checkout on ${def.box.name}` : "Open main checkout", <HomeIcon />, () => selectWorktree(refOf(def.box.name, def.loc, mm))));
  if (def) items.push(item(multi ? `New task on ${def.box.name}…` : "New task…", <GitBranchPlusIcon />, () => st.openNewWorktree({ box: def.box.name, location: def.loc.name }), { shortcut: "⌘N" }));
  if (def && mm && def.box.state === "online") {
    items.push({
      type: "sub",
      label: multi ? `New agent on ${def.box.name}` : "New agent",
      icon: <BotIcon />,
      items: agentPresets(def.box.name, def.loc).map((pr) =>
        item(pr.name, slot(<AgentIcon agent={pr.id} />), () => {
          selectWorktree(refOf(def.box.name, def.loc, mm));
          void startAgent(pr, { kind: "tab" }, pr.name, wsKey(def.box.name, mm.path));
        }),
      ),
    });
  }

  // Its boxes: where to make a worktree, which box is the default, and
  // adding it to another.
  const missingBoxes = (st.status?.boxes ?? []).filter((b) => b.state === "online" && !p.members.some((m) => m.box.name === b.name));
  const addToBox = !!p.remote && missingBoxes.length > 0;
  if (multi) {
    const boxes: Action[] = [];
    if (online.length > 1) {
      boxes.push(
        { type: "label", label: "New task on" },
        ...online.map((m) => item(m.box.name, slot(<GitBranchPlusIcon />), () => st.openNewWorktree({ box: m.box.name, location: m.loc.name }), { hint: boxLoad(m.box.name) })),
        sep,
      );
    }
    boxes.push(
      { type: "label", label: "Default box" },
      ...p.members.map((m) => item(m.box.name, slot(m.box.name === p.defaultBox ? <CheckIcon /> : null), () => void groupActions.setDefaultBox(p, m.box.name), { disabled: m.box.state !== "online" })),
    );
    if (addToBox) boxes.push(sep, item("Add to another box…", <PlusIcon />, () => openAddToBox(p)));
    // Each box's own actions, as the sidebar's foot has them.
    boxes.push(sep, ...p.members.map((m): Action => ({ type: "sub", label: m.box.name, icon: slot(<ServerIcon />), items: boxActions(m.box) })));
    items.push({ type: "sub", label: "Boxes", icon: <ServerIcon />, items: boxes });
  } else {
    if (addToBox) items.push(item("Add to box…", <ServerIcon />, () => openAddToBox(p)));
    // Its box's own actions (reconnect, a terminal there, Doctor…), named
    // after it: boxes live in the sidebar's foot, not as rows of their own.
    if (def) items.push({ type: "sub", label: def.box.name, icon: <ServerIcon />, items: boxActions(def.box) });
  }

  // Its kit, across its boxes.
  if (kit) {
    const outdated = kitOn.filter((i) => i.outdated).map((i) => i.box);
    const missing = online.filter((m) => !kitOn.some((i) => i.box === m.box.name && i.location === m.loc.name)).map((m) => m.box.name);
    const parts = [outdated.length && `outdated on ${outdated.join(", ")}`, missing.length && `not on ${missing.join(", ")}`].filter(Boolean);
    const state = parts.length ? parts.join(" · ") : multi ? "on every box" : "applied";
    const kitItems: Action[] = [{ type: "label", label: `${kit.name} · ${state}` }];
    if (outdated.length || missing.length) {
      kitItems.push(
        item(multi ? "Apply to all boxes" : "Apply", <PackageIcon />, () => {
          const client = useStore.getState().client;
          if (!client) return;
          const targets = online.map((m) => ({ box: m.box.name, location: m.loc.name }));
          const id = toastManager.add({ title: `Applying ${kit.name} to ${p.name}…`, type: "loading" });
          kitsApi.apply(client, kit.id, targets, () => {}).then(
            (end) => {
              toastManager.update(id, { title: end.error ? `${kit.name}: ${end.error}` : `Applied ${kit.name} to ${p.name}`, type: end.error ? "error" : "success" });
              void reloadKits();
            },
            (e) => toastManager.update(id, { title: `Could not apply ${kit.name}`, description: errorMessage(e), type: "error" }),
          );
        }),
      );
    }
    kitItems.push(item("Open Kits", <ArrowUpRightIcon />, () => st.setView({ kind: "kits" })));
    items.push({ type: "sub", label: outdated.length || missing.length ? "Kit (needs applying)" : "Kit", icon: <PackageIcon />, items: kitItems });
  }

  if (multi) {
    items.push({
      type: "sub",
      label: "Project settings",
      icon: <Settings2Icon />,
      items: p.members.map((m) => item(m.box.name, slot(<ServerIcon />), () => st.setView({ kind: "project", box: m.box.name, location: m.loc.name }))),
    });
  } else if (def) items.push(item("Project settings", <Settings2Icon />, () => st.setView({ kind: "project", box: def.box.name, location: def.loc.name })));
  items.push(...teamActions(p.members.map((m) => ({ box: m.box.name, loc: m.loc }))));

  // How Shipyard shows it: its name, its section, and which projects it joins.
  const organise: Action[] = [
    item("Rename…", <PencilIcon />, () =>
      confirm({
        title: `Rename ${p.name}`,
        description: "Only how Shipyard shows it; folders and repositories keep their names.",
        input: { label: "Name", initial: p.name },
        confirm: "Rename",
        run: (_c, v) => groupActions.rename(p, v),
      }),
    ),
    sep,
    { type: "label", label: "Section" },
    ...sections.map((sec) => item(sec, slot(p.section === sec ? <CheckIcon /> : null), () => void groupActions.setSection(p, sec))),
    item("No section", slot(!p.section ? <CheckIcon /> : null), () => void groupActions.setSection(p, undefined)),
    item("New section…", <PlusIcon />, () => newSection(p)),
  ];
  if (others.length) organise.push(sep, { type: "label", label: "Merge into" }, ...others.map((o) => item(o.name, slot(<MergeIcon />), () => void groupActions.merge(o, p), { hint: o.members.map((m) => m.box.name).join(", ") })));
  if (multi) organise.push(sep, { type: "label", label: "Split off" }, ...p.members.map((m) => item(`The copy on ${m.box.name}`, slot(<SplitIcon />), () => void groupActions.split(p, m.box.name))));
  items.push(sep, { type: "sub", label: "Organise", icon: <FolderInputIcon />, items: organise });

  if (gh) items.push(item("Open on GitHub", <ExternalLinkIcon />, () => void import("@/lib/open-url").then((m) => m.openUrl(`https://github.com/${gh}`))));
  if (p.slug) items.push(item("Copy owner/repo", <CopyIcon />, () => copy(p.slug!, "repository name")));

  // Removing works per box: each copy is its own folder.
  const removeFrom = (m: Member) => projectActions(m.box.name, m.loc).find((a) => a.type === "item" && a.destructive);
  const removals = (multi ? p.members : def ? [def] : []).flatMap((m) => {
    const a = removeFrom(m);
    return a && a.type === "item" ? [multi ? { ...a, label: `Remove from ${m.box.name}…` } : a] : [];
  });
  if (removals.length) items.push(sep, ...removals);
  return items;
}

export function newSection(p?: Project) {
  confirm({
    title: "New section",
    description: "Sections group projects in the sidebar, such as Work and Personal.",
    input: { label: "Name", placeholder: "Work" },
    confirm: "Add section",
    run: (_c, v) => groupActions.addSection(v, p),
  });
}
