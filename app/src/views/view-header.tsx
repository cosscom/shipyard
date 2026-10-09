import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useCommandLayout, useViewSlot } from "@/lib/command-nav";

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

function Strip(props: ViewHeaderProps) {
  // The command layout (Labs) has one line across the top: the view's
  // header goes into it, so the page doesn't stack two bars.
  const slot = useViewSlot((s) => s.el);
  const command = useCommandLayout();
  if (command && slot) return createPortal(<InLine {...props} />, slot);
  return <FullStrip {...props} />;
}

// InLine is the header in the command layout's line: the line already names
// the view, so a plain title is left out, and so is the line of context, to
// keep it quiet; its actions stay.
function InLine({ title, actions, children }: ViewHeaderProps) {
  return (
    <div data-tauri-drag-region data-testid="view-header-inline" className="flex min-w-0 flex-1 items-center justify-end gap-3">
      {typeof title !== "string" && <div className="shrink-0 text-[13px]">{title}</div>}
      {children}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

function FullStrip({ title, description, actions, children }: ViewHeaderProps) {
  return (
    <header data-tauri-drag-region className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-sidebar/40 px-6 py-2">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="shrink-0 font-medium text-sm">{title}</h1>
        {description && <p className="hidden min-w-0 truncate text-muted-foreground text-xs md:block">{description}</p>}
      </div>
      {children}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
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
  return <div className={cn("w-full max-w-5xl space-y-5 px-6 pt-5 pb-16", className)}>{children}</div>;
}
