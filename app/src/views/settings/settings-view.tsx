import { ArrowLeftIcon, BellIcon, BotIcon, CableIcon, FlaskConicalIcon, InfoIcon, KeyboardIcon, LaptopIcon, PaletteIcon, PuzzleIcon, ServerIcon, SlidersHorizontalIcon, SmartphoneIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react";
import { type ComponentType, useEffect } from "react";

import { ink, inkScale } from "@/components/sidebar/ink";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar-width";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AboutSection } from "@/views/settings/about-section";
import { AgentsSection } from "@/views/settings/agents-section";
import { useAppVersion } from "@/views/settings/app-version";
import { AppearanceSection } from "@/views/settings/appearance-section";
import { BoxesSection } from "@/views/settings/boxes-section";
import { ComputersSection } from "@/views/settings/computers-section";
import { DeveloperSection } from "@/views/settings/developer-section";
import { GeneralSection } from "@/views/settings/general-section";
import { IntegrationsSection } from "@/views/settings/integrations-section";
import { LabsSection } from "@/views/settings/labs-section";
import { NotificationsSection } from "@/views/settings/notifications-section";
import { PhoneSection } from "@/views/settings/phone-section";
import { PluginsSection } from "@/views/settings/plugins-section";
import { ShortcutsSection } from "@/views/settings/shortcuts-section";
import { TerminalSection } from "@/views/settings/terminal-section";

import { closeSettings, openSettings, type SettingsSectionId } from "@/views/settings/open";

export { openSettings, type SettingsSectionId };

const SECTIONS: { id: SettingsSectionId; title: string; icon: ComponentType<{ className?: string }>; Component: ComponentType }[] = [
  { id: "general", title: "General", icon: SlidersHorizontalIcon, Component: GeneralSection },
  { id: "notifications", title: "Notifications", icon: BellIcon, Component: NotificationsSection },
  { id: "appearance", title: "Appearance", icon: PaletteIcon, Component: AppearanceSection },
  { id: "terminal", title: "Terminal", icon: SquareTerminalIcon, Component: TerminalSection },
  { id: "boxes", title: "Boxes", icon: ServerIcon, Component: BoxesSection },
  { id: "computers", title: "Computers", icon: LaptopIcon, Component: ComputersSection },
  { id: "phone", title: "Phone", icon: SmartphoneIcon, Component: PhoneSection },
  { id: "agents", title: "Agents", icon: BotIcon, Component: AgentsSection },
  { id: "integrations", title: "Integrations", icon: CableIcon, Component: IntegrationsSection },
  { id: "plugins", title: "Plugins", icon: PuzzleIcon, Component: PluginsSection },
  { id: "shortcuts", title: "Shortcuts", icon: KeyboardIcon, Component: ShortcutsSection },
  { id: "labs", title: "Labs", icon: FlaskConicalIcon, Component: LabsSection },
  { id: "about", title: "About", icon: InfoIcon, Component: AboutSection },
  { id: "developer", title: "Developer", icon: WrenchIcon, Component: DeveloperSection },
];

// The nav groups the sections by what they're about; the quieter ones
// (Labs, Developer, About) sit at the bottom.
const GROUPS: { title?: string; ids: SettingsSectionId[] }[] = [
  { title: "Shipyard", ids: ["general", "appearance", "notifications", "shortcuts"] },
  { title: "Agents", ids: ["agents", "terminal", "integrations", "plugins"] },
  { title: "Machines", ids: ["boxes", "computers", "phone"] },
];
const BOTTOM: SettingsSectionId[] = ["labs", "developer", "about"];
// Longer names where the nav has room for them.
const NAV_TITLES: Partial<Record<SettingsSectionId, string>> = { agents: "Agents and models" };

const back = closeSettings;

// Settings is a page of its own: while it's open its nav takes the
// sidebar's place (App.tsx hides the sidebar and the status bar), as wide
// as the sidebar and drawn like it, with Back to app at the top and the
// sections in groups beneath.
export function SettingsView() {
  const view = useStore((s) => s.view);
  const id = (view.kind === "settings" && SECTIONS.some((s) => s.id === view.section) ? view.section : "general") as SettingsSectionId;
  const current = SECTIONS.find((s) => s.id === id)!;

  // Esc goes back to the app, unless something in the page has it (a field,
  // a menu or a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        style={{ width: `clamp(${SIDEBAR_MIN}px, var(--sidebar-w, ${SIDEBAR_DEFAULT}px), max(${SIDEBAR_DEFAULT}px, min(${SIDEBAR_MAX}px, 40vw)))` }}
        className={cn("flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar-surface text-sidebar-foreground", inkScale)}
      >
        {/* Room for the macOS traffic lights; the strip drags the window. */}
        <div data-tauri-drag-region className="h-bar shrink-0" />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-edge pb-2">
          <button type="button" onClick={back} className={cn(ROW, ink.quiet)}>
            <ArrowLeftIcon />
            <span className="flex-1">Back to app</span>
            <kbd className={cn("font-sans text-tag", ink.faint)}>esc</kbd>
          </button>
          {GROUPS.map((g) => (
            <div key={g.title} className="flex flex-col gap-px">
              <div className={cn("pt-4 pb-1 text-tag font-medium", ink.faint)}>{g.title}</div>
              {g.ids.map((sid) => (
                <NavItem key={sid} id={sid} current={id} />
              ))}
            </div>
          ))}
          <div className="min-h-4 flex-1" />
          <div className="flex flex-col gap-px">
            {BOTTOM.map((sid) => (
              <NavItem key={sid} id={sid} current={id} />
            ))}
          </div>
        </div>
      </nav>
      <div data-testid={`settings-${id}`} className="min-w-0 flex-1 overflow-y-auto bg-pane">
        <current.Component key={id} />
      </div>
    </div>
  );
}

// A nav row, drawn as the sidebar's places are (components/sidebar/nav.tsx).
// In the sidebar's one ink (components/sidebar/ink.ts).
const ROW = cn("flex h-side-row w-full items-center gap-2 rounded-lg px-2 text-left text-desc outline-hidden ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-(color:--ink-glyph)", ink.row);

function NavItem({ id, current }: { id: SettingsSectionId; current: SettingsSectionId }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  const title = NAV_TITLES[id] ?? s.title;
  const active = id === current;
  return (
    <button
      type="button"
      onClick={() => openSettings(s.id)}
      data-testid={`settings-nav-${s.id}`}
      aria-current={active ? "page" : undefined}
      aria-label={s.title}
      className={cn(ROW, active && "bg-sidebar-accent text-foreground [&>svg]:text-(color:--ink-row)")}
    >
      <s.icon />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <NavNote id={id} />
    </button>
  );
}

// NavNote is the quiet fact beside a few sections: how many boxes are
// online, the app's version.
function NavNote({ id }: { id: SettingsSectionId }) {
  const status = useStore((s) => s.status);
  const version = useAppVersion();
  let note: string | undefined;
  if (id === "boxes" && status?.boxes.length) note = `${status.boxes.filter((b) => b.state === "online").length} of ${status.boxes.length} online`;
  if (id === "about" && version && version !== "…") note = version === "dev" || version === "unknown" ? version : `v${version}`;
  if (!note) return null;
  return <span className={cn("shrink-0 text-tag tabular-nums", ink.faint)}>{note}</span>;
}
