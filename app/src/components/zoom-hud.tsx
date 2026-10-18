import { ALargeSmallIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { TERMINAL_SIZES, UI_SIZES, useZoomHud } from "@/lib/zoom";
import { platformKeys } from "@/lib/platform";

// ZoomHud shows the text size for a moment after ⌘+, ⌘− or ⌘0 (lib/zoom.ts):
// what changed, its size, and where that sits in the range. It is sized in
// px, not rem, so it holds still while everything behind it grows.

const SHOW_MS = 1100;

export function ZoomHud() {
  const { target, size, at } = useZoomHud();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!at) return;
    setShown(true);
    const t = window.setTimeout(() => setShown(false), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [at]);
  if (!target || size === undefined) return null;
  const range = target === "terminal" ? TERMINAL_SIZES : UI_SIZES;
  const Icon = target === "terminal" ? SquareTerminalIcon : ALargeSmallIcon;
  const steps = range.max - range.min + 1;
  const edge = size === range.max ? "Largest" : size === range.min ? "Smallest" : size === range.default ? "Default" : undefined;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="zoom-hud"
      data-shown={shown || undefined}
      className={cn(
        "pointer-events-none fixed top-[64px] left-1/2 z-70 flex w-[244px] -translate-x-1/2 flex-col gap-[10px] rounded-lg border bg-popover px-[14px] pt-[12px] pb-[12px] text-popover-foreground shadow-xl/20",
        "opacity-0 transition-[opacity,translate] duration-200 ease-out -translate-y-[4px] data-shown:translate-y-0 data-shown:opacity-100",
      )}
    >
      <div className="flex items-center gap-[8px] text-desc leading-[16px]">
        <Icon className="size-[16px] shrink-0 text-muted-foreground" />
        <span className="font-medium">{target === "terminal" ? "Terminal text" : "Text size"}</span>
        <span className="ms-auto font-mono text-mono text-muted-foreground tabular-nums">{size}px</span>
      </div>
      {/* One notch a step; the dot under one marks the default. */}
      <div className="flex items-start gap-[3px]" aria-hidden>
        {Array.from({ length: steps }, (_, i) => {
          const n = range.min + i;
          return (
            <span key={n} className="flex flex-1 flex-col items-center gap-[3px]">
              <span className={cn("h-[6px] w-full rounded-full transition-colors duration-150", n <= size ? "bg-foreground/80" : "bg-foreground/12")} />
              <span className={cn("size-[3px] rounded-full", n === range.default ? "bg-muted-foreground" : "bg-transparent")} />
            </span>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-tag text-muted-foreground">
        <span>{edge ?? `${size > range.default ? "+" : "−"}${Math.abs(size - range.default)} from default`}</span>
        <span>
          <kbd className="font-sans">{platformKeys("⌘0")}</kbd> resets
        </span>
      </div>
    </div>
  );
}
