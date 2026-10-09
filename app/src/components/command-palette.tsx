import { currentSuggestions, reviewSuggestion } from "@/lib/team-suggest";
import {
  BellIcon,
  BellOffIcon,
  InboxIcon,
  MonitorSmartphoneIcon,
  PencilIcon,
  Columns2Icon,
  HouseIcon,
  KeyboardIcon,
  Minimize2Icon,
  SparkleIcon,
  BookMarkedIcon,
  CodeXmlIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CodeIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  PanelTopIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  PackageIcon,
  PackagePlusIcon,
  UserRoundIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { isMock } from "@/hooks/use-berth-connection";
import { openAddKit } from "@/views/kits/kits-store";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { openEditor } from "@/components/editors/open";
import { Kbd } from "@/components/ui/kbd";
import { useAllSessions } from "@/hooks/use-agent-counts";
import { sessionWord } from "@/lib/state-model";
import { useThemes } from "@/hooks/use-theme";
import { openBrowserAt, openPreviewAt, resolveUrl } from "@/lib/actions";
import { FROM_TABLE } from "@/lib/palette-shortcuts";
import { describe, keysFor, SHORTCUTS } from "@/lib/shortcuts";
import { runShortcut } from "@/hooks/use-shortcuts";
import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import type { SettingsSectionId } from "@/views/settings/settings-view";
import { agentOf, sessionAgent, sessionName, sortedWorktrees, worktreeOf } from "@/lib/derive";
import { openBroadcast, openPromptPicker } from "@/lib/prompts";
import { quietNow, setDoNotDisturb, setNotificationsOpen } from "@/lib/notifications";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { isLink, teamRef } from "@/lib/team-ref";
import { loginUrl, loginUserLabel, useLoginConfig, worktreeOrigin } from "@/lib/login-users";
import { openReviewSheet } from "@/lib/pr-review";
import { parseReviewRef } from "@/lib/review-link";
import { focusedPane, focusSession, goHome, hereRef, recentWorktrees, refOf, selectWorktree, useHereRef, useWorkspaces } from "@/lib/workspaces";
import { openShortcuts } from "@/components/shortcuts-sheet";
import { hasWhatsNew, openWhatsNew } from "@/lib/whats-new";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { newTerminal } from "@/components/box-picker";
import { openCustomize, useArrangedNav } from "@/components/sidebar/nav";
import { loadPlugins } from "@/plugins/host";
import { useRegistry } from "@/plugins/registry";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { openAttempts, openComposer } from "@/lib/composer";
import { defaultScope } from "@/views/automations/flows/project-label";
import { placeLabel, worktreeLabel } from "@/lib/worktree-names";
import { agentItem, type SwitchItem, switcherGroups, SwitcherPreview, SwitchRow, useSwitcherAnswers, worktreeItem } from "@/components/command/switcher";
import { showCommandKeys } from "@/components/command/hint-layer";
import { togglePin, useCommandLayout } from "@/lib/command-nav";

// Settings' sections ⌘K goes to, with words they answer to besides their name.
const SETTINGS_SECTIONS: [SettingsSectionId, string, string][] = [
  ["general", "General", "close agents tabs"],
  ["appearance", "Appearance", "theme density font chat background width"],
  ["terminal", "Terminal", "font cursor scrollback renderer"],
  ["boxes", "Boxes", "servers ssh"],
  ["computers", "Computers", "laptops devices"],
  ["phone", "Phone", "mobile pair"],
  ["agents", "Agents", "claude codex install"],
  ["plugins", "Plugins", "extensions"],
  ["shortcuts", "Shortcuts", "keys keyboard"],
  ["labs", "Labs", "experiments"],
  ["about", "About", "version update"],
];

// renameHere offers to rename the worktree you are in (F2 on its row).
function renameHere(go: (fn: () => void) => () => void) {
  const at = hereRef();
  if (!at || at.main) return [];
  const loc = useStore.getState().boxes[at.box]?.locations?.find((l) => l.name === at.location);
  const wt = loc?.worktrees?.find((w) => w.path === at.path);
  if (!loc || !wt) return [];
  return [{ value: `rename worktree display name ${wt.name}`, label: "Rename this worktree…", icon: slot(<PencilIcon />), shortcut: keysFor("rename"), run: go(() => openRenameWorktree(at.box, loc, wt)) }];
}

// defaultScopeRef is a project to try things in when no worktree is open.
function defaultScopeRef(): { box: string; location: string } | undefined {
  const at = defaultScope();
  return at?.scope.startsWith("repo:") ? { box: at.box, location: at.scope.slice(5) } : undefined;
}

interface Item {
  value: string;
  label: string;
  detail?: string;
  // Also matched when searching, without being shown.
  search?: string;
  icon?: React.ReactNode;
  // Shown at the right: a shortcut, or a theme's swatches.
  shortcut?: string;
  trailing?: React.ReactNode;
  // Highlighting a theme previews it.
  theme?: string;
  run(): void;
  // The command layout's switcher: an agent or worktree it previews and
  // pins, a second line, an age (components/command/switcher.tsx).
  agent?: SwitchItem["agent"];
  wt?: string;
  sub?: string;
  when?: string;
  kind?: boolean;
}

interface Group {
  value: string;
  items: Item[];
}

const slot = (icon: React.ReactNode) => <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>;

// CommandPalette (⌘K) jumps anywhere: sessions, worktrees, views, themes,
// and whatever commands plugins add. Empty, it shows what needs you and
// where you were; with a query that matches nothing, it offers to make it.
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const sessions = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const themeId = useStore((s) => s.themeId);
  const spaces = useWorkspaces((s) => s.spaces);
  const themes = useThemes();
  const pluginCommands = useRegistry((s) => s.commands);
  const nav = useArrangedNav();
  // The users the worktree you are in can be logged in as (lib/login-users).
  const here = useHereRef();
  const login = useLoginConfig(here?.box, here?.location);
  const [query, setQuery] = useState("");
  // The command layout makes ⌘K its switcher: wider, agents first, with a
  // preview of the item under the keyboard.
  const command = useCommandLayout();
  const pins = usePrefs((p) => p.pins);
  const [highlighted, setHighlighted] = useState<Item>();
  // The empty switcher by state (who needs you first) or by project and box.
  const [by, setBy] = useState<"state" | "place">("state");
  // The theme in use when the palette opened, to put back after a preview.
  const before = useRef<string | undefined>(undefined);

  const close = (keepTheme = false) => {
    if (!keepTheme && before.current && useStore.getState().themeId !== before.current) useStore.getState().setTheme(before.current);
    before.current = undefined;
    setQuery("");
    setHighlighted(undefined);
    setOpen(false);
  };

  // Shut from outside (⌘E, ⌘1–9 while it is open): start afresh next time.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setHighlighted(undefined);
  }, [open]);

  // The places change rarely, but useArrangedNav is new on every render.
  const navKey = JSON.stringify([nav.pinned, nav.more, nav.hidden].map((l) => l.map((n) => [n.id, n.active, n.badge?.count])));

  const groups = useMemo<Group[]>(() => {
    const st = useStore.getState();
    const go = (fn: () => void) => () => {
      close(true);
      fn();
    };
    const q = query.trim();

    const actions: Item[] = [
      { value: "new-worktree task start agent", label: "New task…", icon: slot(<GitBranchPlusIcon />), shortcut: keysFor("new-worktree"), run: go(() => {
        const at = hereRef();
        st.openNewWorktree(at ? { box: at.box, location: at.location } : {});
      }) },
      { value: "new worktree only no agent", label: "New worktree (no agent)…", icon: slot(<GitBranchPlusIcon />), run: go(() => {
        const at = hereRef();
        openComposer({ noAgent: true, ...(at ? { box: at.box, location: at.location } : {}) });
      }) },
      { value: "new-terminal", label: "New terminal", icon: slot(<SquareTerminalIcon />), shortcut: keysFor("new-terminal"), run: go(newTerminal) },
      { value: "new-browser", label: "New browser tab", icon: slot(<GlobeIcon />), shortcut: keysFor("new-browser"), run: go(() => openBrowserAt("")) },
      { value: "open in editor cursor vscode zed", label: "Open in editor", icon: slot(<CodeXmlIcon />), shortcut: keysFor("open-editor"), run: go(() => {
        const at = hereRef();
        if (at) void openEditor({ box: at.box, path: at.path });
      }) },
      { value: "new-tab", label: "New tab…", icon: slot(<PanelTopIcon />), run: go(() => st.setNewTabMenuOpen(true)) },
      ...(usePrefs.getState().labs && st.view.kind === "workspace" && focusedPane()
        ? [{ value: "split right with another worktree side by side guest pane", label: "Split right with another worktree…", icon: slot(<Columns2Icon />), shortcut: keysFor("split-worktree"), run: go(() => openWorktreePicker({ kind: "split" })) }]
        : []),
      { value: "send saved prompt library", label: "Send a saved prompt…", icon: slot(<BookMarkedIcon />), run: go(() => openPromptPicker()) },
      { value: "broadcast prompt several agents running", label: "Send a prompt to several agents…", icon: slot(<UsersIcon />), run: go(() => openBroadcast()) },
      {
        value: "try n ways attempts best of several agents compare",
        label: "Try N ways…",
        icon: slot(<GitCompareArrowsIcon />),
        run: go(() => {
          const at = hereRef() ?? defaultScopeRef();
          if (at) openAttempts({ box: at.box, location: at.location });
        }),
      },
      { value: "add-location", label: "Add a project…", icon: slot(<FolderPlusIcon />), run: go(() => st.openAddProject()) },
      ...(usePrefs.getState().labs
        ? [{ value: "zen focus calm hide sidebar labs", label: usePrefs.getState().zen ? "Leave zen" : "Zen: only the agents", icon: slot(<Minimize2Icon />), shortcut: keysFor("zen"), run: go(() => usePrefs.setState((p) => ({ zen: !p.zen }))) }]
        : []),
      { value: "home harbour start", label: "Home", icon: slot(<HouseIcon />), run: go(goHome) },
      { value: "review inbox approve changes", label: "Review", icon: slot(<InboxIcon />), run: go(() => st.setView({ kind: "review" })) },
      { value: "dashboard", label: "Agent Dashboard", icon: slot(<LayoutDashboardIcon />), shortcut: keysFor("dashboard"), run: go(() => st.setView({ kind: "dashboard" })) },
      ...(hasWhatsNew() ? [{ value: "whats new release notes changes update", label: "What's new in Shipyard", icon: slot(<SparkleIcon />), run: go(() => openWhatsNew("palette")) }] : []),
      { value: "keyboard shortcuts keys help", label: "Keyboard shortcuts", icon: slot(<KeyboardIcon />), shortcut: keysFor("shortcuts"), run: go(openShortcuts) },
      { value: "notifications inbox bell", label: "Notifications", icon: slot(<BellIcon />), shortcut: keysFor("notifications"), run: go(() => setNotificationsOpen(true)) },
      { value: "notification settings", label: "Notification settings", icon: slot(<BellIcon />), run: go(() => st.setView({ kind: "settings", section: "notifications" })) },
      quietNow()
        ? { value: "do not disturb off quiet notifications", label: "Turn off Do not disturb", icon: slot(<BellIcon />), run: go(() => setDoNotDisturb(false)) }
        : { value: "do not disturb on quiet notifications silence", label: "Turn on Do not disturb", icon: slot(<BellOffIcon />), run: go(() => setDoNotDisturb(true)) },
      { value: "new preview tab sizes responsive", label: "New Preview tab", icon: slot(<MonitorSmartphoneIcon />), run: go(() => openPreviewAt("")) },
      ...renameHere(go),
      // The shortcuts it has no item of its own for, as the menu bar names
      // them (lib/palette-shortcuts.ts).
      ...FROM_TABLE.flatMap((id) => {
        const k = SHORTCUTS.find((x) => x.id === id);
        if (!k || (k.labs && !usePrefs.getState().labs)) return [];
        return [{ value: `shortcut ${id} ${describe(k)}`, label: k.label, icon: slot(<KeyboardIcon />), shortcut: k.keys, run: go(() => void runShortcut(id, "menu")) }];
      }),
      { value: "worktrees", label: "Worktrees", icon: slot(<GitBranchIcon />), run: go(() => st.setView({ kind: "worktrees" })) },
      { value: "automations", label: "Automations", icon: slot(<WorkflowIcon />), run: go(() => st.setView({ kind: "automations" })) },
      { value: "kits", label: "Kits", icon: slot(<PackageIcon />), run: go(() => st.setView({ kind: "kits" })) },
      { value: "add kit from link", label: "Add a kit from a link…", icon: slot(<PackagePlusIcon />), run: go(() => openAddKit()) },
      { value: "settings", label: "Settings", icon: slot(<SettingsIcon />), run: go(() => st.setView({ kind: "settings" })) },
      { value: "add-box", label: "Add a box…", icon: slot(<ServerIcon />), run: go(openAddBox) },
      { value: "team setup github org berth workspace kit onboarding", label: "Team setup…", icon: slot(<UsersIcon />), run: go(() => st.setView({ kind: "team", from: "palette" })) },
      // The orgs the laptop noticed publish one (lib/team-suggest.ts).
      ...currentSuggestions().map((s) => ({ value: `team setup for ${s.org} ${s.name} suggested github org`, label: `Team setup for ${s.org}`, detail: s.repo, icon: slot(<UsersIcon />), run: go(() => reviewSuggestion(s)) })),
      // A link to a team setup pasted here opens it.
      ...(q.includes("/") && teamRef(q) && isLink(teamRef(q)!)
        ? [{ value: `team setup link ${q}`, label: "Open team setup from link", detail: teamRef(q), search: q, icon: slot(<UsersIcon />), run: go(() => st.setView({ kind: "team", org: teamRef(q), from: "palette" })) }]
        : []),
      // A review link, or OWNER/NAME#N, pasted here opens the PR's review sheet.
      ...(parseReviewRef(q)
        ? [{ value: `review pr ${q}`, label: "Review this PR on your box…", detail: `${parseReviewRef(q)!.repo}#${parseReviewRef(q)!.pr}`, search: q, icon: slot(<GitBranchIcon />), run: go(() => openReviewSheet(parseReviewRef(q)!)) }]
        : []),
      { value: "settings-developer", label: "Developer settings", icon: slot(<CodeIcon />), run: go(() => st.setView({ kind: "settings", section: "developer" })) },
      // Each part of Settings, by name ("appearance", "theme", "terminal").
      ...SETTINGS_SECTIONS.map(([section, label, words]) => ({ value: `settings ${section} ${words}`, label: `Settings: ${label}`, icon: slot(<SettingsIcon />), run: go(() => st.setView({ kind: "settings", section })) })),
      ...(command
        ? [
            { value: "command layout keys hints shortcuts help", label: "Show the command layout's keys", icon: slot(<KeyboardIcon />), run: go(showCommandKeys) },
            ...(hereRef() && !hereRef()!.main
              ? [{ value: "pin unpin this worktree", label: pins.includes(`${hereRef()!.box}:${hereRef()!.path}`) ? "Unpin this worktree" : "Pin this worktree to ⌘1–9", icon: slot(<GitBranchIcon />), run: go(() => togglePin(`${hereRef()!.box}:${hereRef()!.path}`)) }]
              : []),
            { value: "layout sidebar back to the sidebar labs", label: "Go back to the sidebar layout", icon: slot(<SlidersHorizontalIcon />), run: go(() => usePrefs.setState({ layout: "sidebar" })) },
          ]
        : []),
      { value: "customize-sidebar", label: "Customize sidebar…", icon: slot(<SlidersHorizontalIcon />), run: go(() => openCustomize()) },
      { value: "refresh", label: "Refresh everything", icon: slot(<RefreshCwIcon />), run: go(() => void st.refreshAll()) },
      { value: "reload-plugins", label: "Reload plugins", icon: slot(<PuzzleIcon />), run: go(() => st.client && void loadPlugins(st.client)) },
    ];
    // Demo mode plays what agents on boxes do, to see the app react.
    const hereAt = hereRef();
    const ws = hereAt ? { ref: hereAt } : undefined;
    if (isMock()) {
      actions.push({ value: "mock demo notifications every kind", label: "Demo: one of every notification", icon: slot(<BellIcon />), run: go(() => void import("@/lib/mock").then((m) => m.mockNotifications())) });
    }
    if (isMock() && ws) {
      const where = ws.ref.main ? ws.ref.location : `${ws.ref.location}/${ws.ref.worktree}`;
      for (const how of ["split", "tab"] as const) {
        actions.push({
          value: `mock agent opens ${how}`,
          label: `Demo: an agent opens Claude Code in a ${how} here`,
          icon: slot(<CodeIcon />),
          run: go(() => void import("@/lib/mock").then((m) => m.mockAgentOpens(ws.ref.box, where, ws.ref.path, how))),
        });
      }
    }

    // Log in as a seeded user: the worktree's page in a Browser tab, through
    // the laptop proxy's login route.
    const loginOrigin = hereAt && login ? worktreeOrigin(hereAt, status?.proxy.url_port) : undefined;
    if (hereAt && loginOrigin) {
      for (const u of login?.users ?? []) {
        actions.push({
          value: `log in as ${u.email} ${u.label ?? ""} login user persona`,
          label: `Log in as ${loginUserLabel(u)}`,
          detail: u.label ? u.email : undefined,
          icon: slot(<UserRoundIcon />),
          run: go(() => openBrowserAt(loginUrl(loginOrigin, u.email, "/"))),
        });
      }
    }

    // Sessions are named by where they run, so two "main" branches in
    // different repositories cannot be confused.
    const sessionItem = ({ box, session, state }: (typeof sessions)[number]): Item => {
      const where = worktreeOf(boxes[box]?.locations, session);
      const agent = agentOf(session);
      return {
        value: `session:${box}/${session.name}`,
        label: sessionName(session, { sessions: boxes[box]?.sessions, locations: boxes[box]?.locations, place: true }),
        // Its state in the same words as everywhere else, then where.
        detail: [sessionAgent(session), state !== "idle" && sessionWord(state), where?.worktree.branch, box].filter(Boolean).join(" · "),
        search: [session.name, where?.worktree.title ? where.worktree.name : undefined].filter(Boolean).join(" "),
        icon: (
          <span className="flex w-8 shrink-0 items-center gap-1">
            <AgentIcon agent={agent} />
            <StateGlyph state={state} className="size-3" />
          </span>
        ),
        run: go(() => void focusSession(box, session.name)),
      };
    };

    const online = status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [];
    const worktreeItems: Item[] = online.flatMap((box) =>
      (boxes[box]?.locations ?? []).flatMap((loc) =>
        sortedWorktrees(loc).map((wt) => ({
          value: `wt:${box}:${wt.path}`,
          label: wt.main ? loc.name : `${loc.name} / ${worktreeLabel(wt)}`,
          // A renamed worktree still answers to its own name and branch.
          detail: [wt.title ? wt.name : undefined, wt.branch !== wt.name || !wt.title ? wt.branch : undefined, box].filter(Boolean).join(" · "),
          search: [wt.name, wt.title, wt.branch].filter(Boolean).join(" "),
          icon: slot(<GitBranchIcon />),
          run: go(() => selectWorktree(refOf(box, loc, wt))),
        })),
      ),
    );

    const themeItems: Item[] = themes.map((t) => ({
      value: `theme:${t.id}`,
      label: t.name,
      search: "theme",
      theme: t.id,
      icon: slot(t.id === (before.current ?? themeId) ? <CheckIcon /> : null),
      trailing: (
        <span className="ml-auto flex shrink-0 overflow-hidden rounded-sm border">
          {[t.colors.background, t.colors.sidebar, t.terminal.blue, t.terminal.green].map((c, i) => (
            <span key={i} className="size-3" style={{ background: c }} />
          ))}
        </span>
      ),
      run: go(() => st.setTheme(t.id)),
    }));

    const pluginItems: Item[] = pluginCommands.map(({ plugin, item }) => ({
      value: `plugin:${plugin}:${item.id}`,
      label: item.title,
      detail: item.group ?? plugin,
      icon: slot(<PuzzleIcon />),
      shortcut: item.shortcut,
      run: go(() => {
        try {
          void Promise.resolve(item.run()).catch((err) => console.error(`plugin ${plugin}: ${item.id} failed`, err));
        } catch (err) {
          console.error(`plugin ${plugin}: ${item.id} failed`, err);
        }
      }),
    }));

    // Places hidden from the sidebar stay reachable here.
    const hiddenPlaces: Item[] = nav.hidden.map((n) => ({
      value: `place:${n.id}`,
      label: n.label,
      detail: "Hidden from sidebar",
      icon: slot(n.icon),
      run: go(n.go),
    }));

    // The command layout's places: every one the sidebar's nav lists, then
    // Settings; the actions don't repeat them.
    const places: Item[] = command ? [...nav.pinned, ...nav.more, ...nav.hidden].map((n) => ({ value: `place:${n.id}`, label: n.label, detail: n.badge?.title, icon: slot(n.icon), shortcut: n.id === "dashboard" ? keysFor("dashboard") : undefined, run: go(n.go) })) : [];
    if (command) {
      places.push({ value: "place:settings", label: "Settings", icon: slot(<SettingsIcon />), shortcut: "⌘,", run: go(() => st.setView({ kind: "settings" })) });
      const named = new Set(places.map((p) => p.label));
      for (let i = actions.length - 1; i >= 0; i--) if (named.has(actions[i].label)) actions.splice(i, 1);
    }
    if (!q && command) {
      return [
        ...switcherGroups({ sessions, spaces, recent: recentWorktrees(spaces, 8), places, go, focus: (b, n) => void focusSession(b, n), by }),
        { value: "Actions", items: actions },
      ];
    }
    if (!q) {
      const waiting = sessions.filter((s) => s.state === "waiting").map(sessionItem);
      const recent: Item[] = recentWorktrees(spaces, 5).map((w) => ({
        value: `recent:${w.ref.box}:${w.ref.path}`,
        label: placeLabel(w.ref),
        detail: w.ref.box,
        search: w.ref.worktree,
        icon: slot(<GitBranchIcon />),
        run: go(() => selectWorktree(w.ref)),
      }));
      return [
        { value: "Needs you", items: waiting },
        { value: "Recent", items: recent },
        { value: "Actions", items: actions },
      ].filter((g) => g.items.length);
    }

    // Searching: everything, and ways to make what is not there.
    const url = resolveUrl(q);
    const make: Item[] = [
      ...(url ? [{ value: `open:${url}`, label: `Open ${q} in a browser tab`, detail: url, icon: slot(<ArrowUpRightIcon />), run: go(() => openBrowserAt(url)) }] : []),
      { value: `new-worktree:${q}`, label: `New task from "${q}"`, icon: slot(<GitBranchPlusIcon />), run: go(() => st.openNewWorktree({ name: q })) },
    ];
    if (command) {
      const pinOf = (box: string, path: string) => pins.indexOf(`${box}:${path}`) + 1 || undefined;
      const wts: Item[] = online.flatMap((box) => (boxes[box]?.locations ?? []).flatMap((loc) => sortedWorktrees(loc).map((wt) => worktreeItem(box, loc, wt, go, { pin: pinOf(box, wt.path) }))));
      const mixed = new Set(sessions.map((e) => agentOf(e.session)).filter(Boolean)).size > 1;
      const agents: Item[] = sessions.filter((e) => agentOf(e.session)).map((e) => agentItem(e, go, (b, n) => void focusSession(b, n), mixed));
      const shells = sessions.filter((e) => !agentOf(e.session)).map(sessionItem);
      return [
        { value: "Agents", items: agents },
        { value: "Worktrees", items: wts },
        { value: "Go to", items: places },
        { value: "Terminals", items: shells },
        { value: "Actions", items: actions },
        { value: "Plugins", items: pluginItems },
        { value: "Themes", items: themeItems },
        { value: "Create", items: make },
      ].filter((g) => g.items.length);
    }
    return [
      { value: "Sessions", items: sessions.map(sessionItem) },
      { value: "Worktrees", items: worktreeItems },
      { value: "Actions", items: actions },
      { value: "Plugins", items: pluginItems },
      { value: "Themes", items: themeItems },
      { value: "Hidden from sidebar", items: hiddenPlaces },
      { value: "Make it", items: make },
    ].filter((g) => g.items.length);
    // close is stable enough: it only reads refs and store setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, boxes, status, themes, themeId, spaces, pluginCommands, query, navKey, open, login, command, pins, by]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (o) setOpen(true);
        else close();
      }}
    >
      <CommandDialogPopup aria-label={command ? "Switcher" : "Search and commands"} data-testid={command ? "switcher" : undefined} className={cn(command && "max-h-[min(640px,80vh)] max-w-[880px]")}>
        <Command
          items={groups}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(i: unknown) => `${(i as Item).label} ${(i as Item).detail ?? ""} ${(i as Item).search ?? ""}`}
          onItemHighlighted={(i: unknown) => {
            // By its value: the list is rebuilt as agents change, and the
            // preview reads them live anyway.
            if (command) setHighlighted((prev) => (prev?.value === (i as Item | undefined)?.value ? prev : (i as Item | undefined)));
            // Highlighting a theme previews it; closing without choosing puts
            // the old one back.
            const t = (i as Item | undefined)?.theme;
            if (!t) return;
            before.current ??= useStore.getState().themeId;
            useStore.getState().setTheme(t);
          }}
        >
          <CommandInput
            aria-label="Search sessions, worktrees and commands"
            placeholder={command ? "Go to an agent, worktree, view or command…" : "Jump to a session, worktree, or command…"}
            onKeyDown={(e) => {
              // ⇥ in the empty switcher: by state, or by project and box.
              if (command && e.key === "Tab" && !e.shiftKey && !e.metaKey && !query.trim()) {
                e.preventDefault();
                setBy((b) => (b === "state" ? "place" : "state"));
                return;
              }
              // ⌥A and ⌥D answer the permission the agent under the
              // keyboard asks for (its preview's Allow once and Deny).
              if (command && e.altKey && !e.metaKey && (e.code === "KeyA" || e.code === "KeyD")) {
                const a = useSwitcherAnswers.getState();
                const fn = e.code === "KeyA" ? a.allow : a.deny;
                if (fn) {
                  e.preventDefault();
                  fn();
                }
                return;
              }
              // ⌘↵ pins the worktree under the keyboard to ⌘1–9, or unpins it.
              if (!command || !e.metaKey || e.key !== "Enter" || !highlighted?.wt) return;
              e.preventDefault();
              (e as unknown as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
              togglePin(highlighted.wt);
            }}
          />
          {command && !query.trim() && (
            <div role="group" aria-label="Group by" className="absolute top-3 right-4 z-10 flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
              {(["state", "place"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={by === k}
                  data-testid={`switcher-by-${k}`}
                  onClick={() => setBy(k)}
                  className={cn("rounded-md px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring", by === k ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
                >
                  {k === "state" ? "By state" : "By project"}
                </button>
              ))}
              <Kbd className="mx-1 h-4.5 bg-transparent text-[10px]">⇥</Kbd>
            </div>
          )}
          <CommandPanel className={cn(command && "flex min-h-0 flex-1")}>
            <div className={cn(command && "flex min-h-0 min-w-0 flex-1 flex-col")}>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(group: Group) => (
                <CommandGroup key={group.value} items={group.items}>
                  <CommandGroupLabel>{group.value}</CommandGroupLabel>
                  <CommandCollection>
                    {(item: Item) =>
                      command ? (
                        <CommandItem key={item.value} value={item} data-testid="switcher-item" data-value={item.value} className={cn("gap-2.5", item.sub && "py-1.5")} onClick={() => item.run()}>
                          {item.theme || item.trailing ? (
                            <>
                              {item.icon}
                              <span className="truncate">{item.label}</span>
                              {item.trailing}
                            </>
                          ) : (
                            <SwitchRow item={item} />
                          )}
                        </CommandItem>
                      ) : (
                      <CommandItem key={item.value} value={item} className="gap-2" onClick={() => item.run()}>
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                        {item.detail && <span className="ml-auto min-w-0 shrink truncate text-muted-foreground text-xs">{item.detail}</span>}
                        {item.trailing}
                        {item.shortcut && <Kbd className={item.detail ? "" : "ml-auto"}>{item.shortcut}</Kbd>}
                      </CommandItem>
                      )
                    }
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
            </div>
            {command && <SwitcherPreview item={highlighted} />}
          </CommandPanel>
          <CommandFooter className="text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move, <Kbd>↵</Kbd> to open
            </span>
            {command && (
              <span className="flex items-center gap-1">
                <Kbd>⌘↵</Kbd> pin, <Kbd>⌘K</Kbd> again for the last place
              </span>
            )}
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> to close
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
