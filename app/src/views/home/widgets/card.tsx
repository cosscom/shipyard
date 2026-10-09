import { EllipsisIcon, EyeOffIcon, LayoutGridIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SIZE_ORDER, SIZES, type WidgetSize } from "@/lib/home-layout";
import { cn } from "@/lib/utils";

import type { WidgetDef } from "./registry";
import { WidgetEmpty } from "./parts";

// A widget's card: one bordered surface (rounded-lg) with a 36px heading
// (its icon, title, count and, for a plugin's, the plugin), a menu, and its
// body under an error boundary, so one broken widget never blanks Home.

function Count({ use }: { use: NonNullable<WidgetDef["useCount"]> }) {
  const c = use();
  if (!c || c.n <= 0) return null;
  return (
    <span className={cn("rounded-sm px-1 font-medium text-[11px] tabular-nums", c.urgent ? "bg-warning/14 text-warning-foreground" : "text-muted-foreground")} aria-label={`${c.n}${c.urgent ? ", needs you" : ""}`}>
      {c.n}
    </span>
  );
}

export function CountBadge({ def }: { def: WidgetDef }) {
  if (!def.useCount) return null;
  const node = (
    <Quiet>
      <Count use={def.useCount} />
    </Quiet>
  );
  return <>{def.wrap ? def.wrap(node) : node}</>;
}

export function WidgetHeading({ def, id, actions, className }: { def: WidgetDef; id?: string; actions?: ReactNode; className?: string }) {
  const Icon = def.icon;
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3", className)}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <h2 id={id} className="truncate font-medium text-[13px]">
        {def.title}
      </h2>
      <CountBadge def={def} />
      {def.plugin && (
        <Tip label={`From the ${def.plugin.name} plugin`}>
          <span className="inline-flex shrink-0 text-muted-foreground/70" role="img" aria-label={`From the ${def.plugin.name} plugin`}>
            <PlugIcon className="size-3" />
          </span>
        </Tip>
      )}
      <span className="flex-1" />
      {actions}
    </div>
  );
}

export function WidgetMenu({ def, size, onSize, onRefresh, onRemove, onCustomize, className }: { def: WidgetDef; size: WidgetSize; onSize(s: WidgetSize): void; onRefresh(): void; onRemove(): void; onCustomize(): void; className?: string }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${def.title} options`}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-focus-within/w:opacity-100 group-hover/w:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100",
              className,
            )}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-48">
        {def.sizes.length > 1 && (
          <>
            <MenuRadioGroup value={size} onValueChange={(v) => onSize(v as WidgetSize)}>
              <MenuGroupLabel>Size</MenuGroupLabel>
              {SIZE_ORDER.filter((s) => def.sizes.includes(s)).map((s) => (
                <MenuRadioItem key={s} value={s}>
                  <span className="flex w-full items-center gap-3">
                    {SIZES[s].label}
                    <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                      {SIZES[s].c}×{SIZES[s].r}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh now
        </MenuItem>
        <MenuItem onClick={onCustomize}>
          <LayoutGridIcon />
          Customize Home
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onRemove}>
          <EyeOffIcon />
          Remove from Home
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// useOnScreen says whether el is within (or near) the scrolling view and
// the window is showing: a widget reads its data only then.
export function useOnScreen(el: HTMLElement | null): boolean {
  const [near, setNear] = useState(false);
  const [shown, setShown] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  useEffect(() => {
    const sync = () => setShown(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return near && shown;
}

// WidgetBoundary keeps a widget's error inside its card, with a way to try
// again.
export class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Home widget ${this.props.title} failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <WidgetEmpty scene="storm" title={`${this.props.title} hit an error`} hint={this.state.error.message} action="Try again" onAction={() => this.setState({ error: undefined })} compact />;
  }
}

// Quiet drops what a count throws: a heading never breaks over a badge.
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
