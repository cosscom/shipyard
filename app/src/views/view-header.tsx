import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface ViewHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

// ViewHeader is a full-page view's top strip: its title, a short line of
// context, and its actions, in the window's drag region, so the view's name
// appears once. Every full-page view has one: Dashboard, Review, Settings,
// Project settings and plugin screens alike.
//
// Inside a ViewHeaderHost (Settings, plugin screens), a ViewHeader rendered
// anywhere below takes the host's strip, so a section or a plugin can name
// itself and add its actions without the page growing a second header.
export function ViewHeader(props: ViewHeaderProps) {
  const host = useContext(HostContext);
  const claim = host?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  if (!host) return <Strip {...props} />;
  return host.el ? createPortal(<Strip {...props} />, host.el) : null;
}

// Strip is the window's top band (h-bar, as the tab bar is), so its bottom
// edge carries on the sidebar's and the tab bar's line: the title, its
// context on the same line, and the actions, on the page's gutter. Beside
// the sidebar it moves up out of the content's card into the band above it
// (TopBand, App.tsx), bare on the window as the tabs are; without one
// (Settings, zen) it tops the page, with a line under it.
function Strip({ title, description, actions, children }: ViewHeaderProps) {
  const band = useContext(BandContext);
  const strip = (
    <header data-tauri-drag-region className={cn("flex h-bar shrink-0 items-center gap-4 px-page", !band && "border-b bg-sidebar-surface")}>
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="shrink-0 font-semibold text-heading">{title}</h1>
        {description && <p className="hidden min-w-0 truncate text-desc text-muted-foreground md:block">{description}</p>}
      </div>
      {children}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
  return band ? createPortal(strip, band) : strip;
}

const BandContext = createContext<HTMLElement | null>(null);

// TopBand gives the pages under it the window's band above the content's
// card to put their header in (App.tsx); null keeps it on the page.
export function TopBand({ value, children }: { value: HTMLElement | null; children: ReactNode }) {
  return <BandContext.Provider value={value}>{children}</BandContext.Provider>;
}

const HostContext = createContext<{ el: HTMLElement | null; claim(): () => void } | null>(null);

// ViewHeaderHost keeps a strip at the top of its view: fallback until a
// ViewHeader below claims it.
export function ViewHeaderHost({ fallback, children }: { fallback: ViewHeaderProps; children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((c) => c + 1);
    return () => setClaims((c) => c - 1);
  }, []);
  const value = useMemo(() => ({ el, claim }), [el, claim]);
  return (
    <HostContext.Provider value={value}>
      <div ref={setEl} className="contents" />
      {claims === 0 && <Strip {...fallback} />}
      {children}
    </HostContext.Provider>
  );
}

// PluginPage is the body of a plugin screen: one width for every plugin,
// left aligned under the strip like the app's own pages.
export function PluginPage({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn("w-full max-w-5xl space-y-5 px-page pt-5 pb-16", className)}>{children}</div>;
}
