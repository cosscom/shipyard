import { TeamKitSheet } from "@/views/team/team-kit-sheet";
import { lazy, Suspense, useEffect } from "react";

import { AddLocationDialog } from "@/components/add-location-dialog";
import { Connecting } from "@/components/agent-offline";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { FilePicker } from "@/components/files/file-picker";
import { TreeDockFrame } from "@/components/files/tree-dock";
import { WorktreePicker } from "@/components/workspace/worktree-picker";
import { ComposerDialog } from "@/components/conversation/composer-dialog";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { LoopsPanel } from "@/components/orchestrate/loops-panel";
import { PluginConsentDialog } from "@/components/plugin-consent-dialog";
import { PromptDialogs } from "@/components/prompts";
import { StatusBar } from "@/components/status-bar";
import { ErrorBoundary } from "@/components/error-boundary";
import { AddToBoxDialog } from "@/components/sidebar/add-to-box-dialog";
import { ConfirmHost } from "@/components/sidebar/confirm";
import { ErrorDetailsHost } from "@/components/error-note";
import { ShortcutsSheet } from "@/components/shortcuts-sheet";
import { WhatsNewDialog } from "@/components/whats-new/whats-new-dialog";
import { CustomizeSidebarSheet } from "@/components/sidebar/nav";
import { ToastProvider } from "@/components/ui/toast";
import { FileDropGuard } from "@/components/file-drop-guard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Launcher } from "@/components/workspace/launcher";
import { PaneLayer } from "@/components/workspace/pane-layer";
import { TabStrip } from "@/components/workspace/tab-strip";
import { HomeTabs } from "@/components/workspace/home-tabs";
import { BoxPicker } from "@/components/box-picker";
import { FakeTrafficLights, ZenBar } from "@/components/workspace/zen";
import { Announcer } from "@/components/announcer";
import { DeckBar } from "@/components/deck/deck-bar";
import { DeckEmpty, DeckStrip, DeckSwitcher } from "@/components/deck/deck-strip";
import { deckTab, useDeckOn, useDecks } from "@/lib/deck";
import { fakeTrafficLights } from "@/lib/api";
import { useBerthConnection } from "@/hooks/use-berth-connection";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useWindowTitle } from "@/hooks/use-window-title";
import { useApplyTheme } from "@/hooks/use-theme";
import { startOutdatedWatch } from "@/lib/outdated";
import { startRunsWatch } from "@/lib/runs";
import { watchStillness } from "@/lib/still";
import { useStore } from "@/lib/store";
import { startUpdater } from "@/lib/updater";
import { useWhatsNewAfterUpdate } from "@/lib/whats-new";
import { cn } from "@/lib/utils";
import { homeBox, useWorkspaces } from "@/lib/workspaces";
import { AutomationsView } from "@/views/automations";
import { WorktreesView } from "@/views/worktrees/worktrees-view";
import { useKitDeepLinks } from "@/views/kits/deep-link";
import { useTeamDeepLinks, useTeamWatch } from "@/views/team/team-entry";
import { TeamSetupView } from "@/views/team/team-view";
import { KitsView } from "@/views/kits/kits-view";
import { ReviewSheet } from "@/views/kits/review-sheet";
import { useReviewDeepLinks } from "@/views/pr-review/deep-link";
import { PrReviewSheet } from "@/views/pr-review/review-sheet";
import { useReviewStatuses } from "@/views/pr-review/use-review-status";
import { ReviewView } from "@/views/review/review-view";
import { ProjectView } from "@/views/project/project-view";
import { DashboardView } from "@/views/dashboard";
import { PluginScreenView } from "@/views/plugin-screen-view";
import { AddBoxDialog } from "@/views/onboarding/add-box-dialog";
import { useOnboardingActive } from "@/views/onboarding/onboarding-state";
import { OnboardingView } from "@/views/onboarding/onboarding-view";
import { SettingsView } from "@/views/settings/settings-view";
import { HomeView } from "@/views/home/home-view";
import { usePrefs } from "@/lib/prefs";
import { placeLabel } from "@/lib/worktree-names";
import { useRescueRemovedFocus } from "@/lib/focus-home";

// The live demo's guide and script (pnpm build:demo); not in the app.
const DemoGuide = __BERTH_DEMO__ ? lazy(() => import("@/demo/guide")) : null;

const viewTitles = { team: "Team setup", dashboard: "Agent Dashboard", review: "Review", worktrees: "Worktrees", automations: "Automations", kits: "Kits", project: "Project settings", settings: "Settings", plugin: "" } as const;

export default function App() {
  useApplyTheme();
  useBerthConnection();
  useShortcuts();
  useWindowTitle();
  // Checks for a newer Shipyard on launch and every few hours (lib/updater.ts).
  useEffect(startUpdater, []);
  // Spinners and shimmers hold still while the window is in the background.
  useEffect(watchStillness, []);
  // Runs on the boxes (loops, attempts, flows): kept fresh for the loops
  // panel, Automations and Review (lib/runs.ts).
  const connectedToAgent = useStore((s) => !!s.client);
  useEffect(() => (connectedToAgent ? startRunsWatch() : undefined), [connectedToAgent]);
  // Which boxes run an older berthd (lib/outdated.ts).
  useEffect(() => (connectedToAgent ? startOutdatedWatch() : undefined), [connectedToAgent]);
  useKitDeepLinks();
  // Team setup: berth://team?org= links, and setups running on boxes.
  useTeamDeepLinks();
  // PR reviews: berth://review links open the review sheet, and each review
  // worktree's PR is checked for new commits now and then.
  useReviewDeepLinks();
  useReviewStatuses();
  useTeamWatch();
  const view = useStore((s) => s.view);
  const workspace = view.kind === "workspace";
  // Labs: the workspace layout (lib/deck.ts) has no sidebar or tab strip:
  // named workspaces of panes across the top, other agents in a strip below.
  const deckOn = useDeckOn();
  // Labs: zen (⌘.) puts away the sidebar, the tab strip and the status bar.
  // The workspace layout has its own way, so zen stays out of it.
  const zen = usePrefs((p) => p.labs && p.zen) && !deckOn;
  // Without the status bar, what floats over its corner (toasts, the loops
  // panel) comes down to the window's edge.
  useEffect(() => document.documentElement.style.setProperty("--berth-status-h", zen ? "0px" : "26px"), [zen]);
  // The keyboard is never dropped on <body> by what had it going away.
  useRescueRemovedFocus();
  // Onboarding has no tabs yet, so it gets the plain strip, not the tab strip.
  const onboarding = useOnboardingActive();
  const deck = deckOn && !onboarding;
  // Home (no worktree, or a box's home terminals over it) has its own strip.
  const onHome = useWorkspaces((s) => !s.current || !!homeBox(s.current));
  const connected = useStore((s) => !!s.client);
  // Until onboarding is done it is the whole window: no sidebar, status
  // bar, palette or shortcuts to wander off through.
  const gated = onboarding && connected;
  // Once after an update: the release's highlights (lib/whats-new.ts),
  // never over onboarding.
  useWhatsNewAfterUpdate(!gated);
  useEffect(() => {
    // Team setup is the one page first run opens over the welcome.
    if (gated && !["workspace", "team"].includes(useStore.getState().view.kind)) useStore.getState().setView({ kind: "workspace" });
  }, [gated]);

  if (gated) {
    return (
      <TooltipProvider delay={300}>
        <ToastProvider position="bottom-right" viewportClassName="max-w-88 data-[position=bottom-right]:bottom-3 data-[position=bottom-right]:right-3">
          <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
            {/* Room for the traffic lights; the strip drags the window. */}
            <div data-tauri-drag-region className="h-10 shrink-0" />
            <main className="relative min-h-0 flex-1">
              <ErrorBoundary scope="onboarding">
                {view.kind === "team" ? <TeamSetupView org={view.org} from={view.from ?? "onboarding"} box={view.box} onBack={() => useStore.getState().setView({ kind: "workspace" })} /> : <OnboardingView />}
              </ErrorBoundary>
            </main>
          </div>
          <ErrorBoundary scope="a dialog">
            <AddBoxDialog />
            <ConfirmHost />
            <ErrorDetailsHost />
          </ErrorBoundary>
          <FileDropGuard />
          <Announcer />
        </ToastProvider>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delay={300}>
      {/* Toasts sit bottom-right, as in other desktop tools: above the status
          bar (26px) and above the loop panel when there is one, which says
          how tall it is in --berth-loops-h. Top-right covered the headers of
          pages (Review's, say). A bar floating at a page's bottom (the
          Dashboard's selection, the Worktrees bulk bar) lifts them above
          it through --berth-bar-lift (hooks/lift-toasts.ts). With a dialog
          or sheet open they move to a corner clear of it; see
          components/ui/toast.tsx. The stack is as wide as the loops panel. */}
      <ToastProvider position="bottom-right" viewportClassName="max-w-88 data-[position=bottom-right]:bottom-[max(calc(var(--berth-status-h,26px)+12px+var(--berth-loops-h,0px)),var(--berth-bar-lift,0px))] data-[position=bottom-right]:right-3 data-[position=bottom-left]:bottom-[calc(var(--berth-status-h,26px)+12px)] data-[position=bottom-left]:left-3 data-[position=top-left]:top-3 data-[position=top-left]:left-3 data-[position=top-right]:top-3 data-[position=top-right]:right-3">
        <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
          {fakeTrafficLights() && <FakeTrafficLights />}
          {deck ? (
            <>
              <Disconnectable className="shrink-0 flex-col" label="Workspaces">
                <DeckBar />
              </Disconnectable>
              <main className="relative min-h-0 flex-1">
                <TreeDockFrame showing={workspace}>
                  <PaneLayer showing={workspace} />
                </TreeDockFrame>
                <ErrorBoundary key={view.kind} scope={viewTitles[view.kind as keyof typeof viewTitles] || (view.kind === "workspace" ? "the workspace" : undefined)} onLeave={view.kind === "workspace" ? undefined : () => useStore.getState().setView({ kind: "workspace" })}>
                  <MainView />
                </ErrorBoundary>
              </main>
              <Disconnectable className="shrink-0 flex-col" label="Agents not on screen">
                <DeckStrip />
              </Disconnectable>
            </>
          ) : (
          <div className="flex min-h-0 flex-1">
            {!zen && (
              <Disconnectable>
                <AppSidebar />
              </Disconnectable>
            )}
            <div className="relative flex min-w-0 flex-1 flex-col">
              {zen && !onboarding ? (
                <ZenBar />
              ) : workspace && !onboarding ? (
                <Disconnectable className="shrink-0 flex-col" label="Tab bar">
                  {!onHome && <WorkspaceHeading />}
                  {onHome ? <HomeTabs /> : <TabStrip />}
                </Disconnectable>
              ) : !workspace ? null /* every other view's ViewHeader is the strip */ : (
                // Onboarding names itself; the strip only drags the window.
                <div data-tauri-drag-region className="h-10 shrink-0 bg-background" />
              )}
              <main className="relative min-h-0 flex-1">
                {/* Always mounted: terminals keep running behind other views. */}
                <TreeDockFrame showing={workspace && view.kind === "workspace"}>
                  <PaneLayer showing={workspace} />
                </TreeDockFrame>
                <ErrorBoundary key={view.kind} scope={viewTitles[view.kind as keyof typeof viewTitles] || (view.kind === "workspace" ? "the workspace" : undefined)} onLeave={view.kind === "workspace" ? undefined : () => useStore.getState().setView({ kind: "workspace" })}>
                  <MainView />
                </ErrorBoundary>
              </main>
            </div>
          </div>
          )}
          {!zen && <StatusBar />}
        </div>
        <ErrorBoundary scope="a dialog">
          <CommandPalette />
          <FilePicker />
          <WorktreePicker />
          <BoxPicker />
          <ComposerDialog />
          <AddLocationDialog />
          <PromptDialogs />
          <LoopsPanel />
          <AddBoxDialog />
          <ConfirmHost />
          <ErrorDetailsHost />
          <AddToBoxDialog />
          <TeamKitSheet />
          <PluginConsentDialog />
          <CustomizeSidebarSheet />
          <ShortcutsSheet />
          <ReviewSheet />
          <PrReviewSheet />
          <NotificationCenter />
          <WhatsNewDialog />
          {deck && <DeckSwitcher />}
        </ErrorBoundary>
        <FileDropGuard />
        <Announcer />
        {DemoGuide && (
          <Suspense>
            <DemoGuide />
          </Suspense>
        )}
      </ToastProvider>
    </TooltipProvider>
  );
}

function MainView() {
  const view = useStore((s) => s.view);
  const connection = useStore((s) => s.connection);
  const client = useStore((s) => s.client);
  const ws = useWorkspaces((s) => (s.current ? s.spaces[s.current] : undefined));
  const home = useWorkspaces((s) => !!homeBox(s.current));
  const onboarding = useOnboardingActive();
  const deckOn = useDeckOn();
  const zen = usePrefs((p) => p.labs && p.zen) && !deckOn;
  // The workspace in front with no panes yet (the layout's own empty page).
  const emptyDeck = useDecks((d) => {
    if (!deckOn || d.home) return undefined;
    const a = d.decks.find((x) => x.id === d.active);
    return a && !deckTab(a) ? a.name : undefined;
  });

  if (!client) return <Connecting state={connection.state} error={connection.error} />;
  // A new account starts here; Settings and the other views stay reachable.
  if (view.kind === "workspace" && onboarding) {
    return (
      <div className="absolute inset-0">
        <OnboardingView />
      </div>
    );
  }
  if (view.kind === "workspace") {
    // A box's home terminals show over Home, which shows again without them.
    if (!ws && emptyDeck) return <DeckEmpty name={emptyDeck} />;
    if (!ws || home) return ws?.tabs.length ? null : <NoWorktree />;
    return ws.tabs.length ? null : <Launcher worktree={ws.ref} />;
  }
  return (
    // In zen there is no sidebar: a view keeps the width it has beside one,
    // centred, rather than stretching across the window.
    <div className={cn("absolute inset-0 bg-background", zen && "mx-auto max-w-[1280px] min-[1300px]:border-x")}>
      {view.kind === "dashboard" && <DashboardView />}
      {view.kind === "automations" && <AutomationsView />}
      {view.kind === "review" && <ReviewView />}
      {view.kind === "kits" && <KitsView />}
      {view.kind === "worktrees" && <WorktreesView />}
      {view.kind === "project" && <ProjectView key={`${view.box}/${view.location}`} box={view.box} location={view.location} />}
      {view.kind === "settings" && <SettingsView />}
      {view.kind === "plugin" && <PluginScreenView screen={view.screen} />}
      {view.kind === "team" && <TeamSetupView key={`${view.org ?? ""}${view.update ? ":update" : ""}`} org={view.org} from={view.from} box={view.box} update={view.update} />}
    </div>
  );
}

// NoWorktree is the workspace before any worktree is picked: the composer,
// to start work, and the agents and worktrees to go back to. Labs adds the
// harbour across the top.
function NoWorktree() {
  return <HomeView />;
}

// Disconnectable dims what cannot work until the agent answers.
// Inert as well, so the keyboard cannot reach it either.
// WorkspaceHeading names the worktree in front for screen readers, as the
// window's title does: the page's one heading while its tabs show.
function WorkspaceHeading() {
  const ref = useWorkspaces((s) => (s.current && !homeBox(s.current) ? s.spaces[s.current]?.ref : undefined));
  const label = useStore((s) => (ref?.path ? placeLabel(ref, s.boxes) : undefined));
  return label ? <h1 className="sr-only">{label}</h1> : null;
}

function Disconnectable({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  const offline = useStore((s) => !s.client);
  return (
    <div role={label ? "region" : undefined} aria-label={label} className={cn("flex", className, offline && "pointer-events-none opacity-50")} aria-disabled={offline || undefined} inert={offline || undefined}>
      {children}
    </div>
  );
}
