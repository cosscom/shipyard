import type * as React from "react";
import { cn } from "@/lib/utils";

// Frame has two looks. "inset" (the default) is coss's muted tray with
// raised panels in it, for grouped inputs in dialogs. "card" is one bordered
// card whose header and panels sit flat inside it, divided by a rule: use it
// for a section of a page (Review, plugin screens), so the section has one
// outline, not a card inside a card. See the guideline in card.tsx.
export function Frame({
  className,
  variant = "inset",
  ...props
}: React.ComponentProps<"div"> & { variant?: "inset" | "card" }): React.ReactElement {
  return (
    <div
      className={cn(
        variant === "card"
          ? [
              "relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs/5",
              "*:data-[slot=frame-panel]:rounded-none *:data-[slot=frame-panel]:border-0 *:data-[slot=frame-panel]:bg-transparent *:data-[slot=frame-panel]:shadow-none *:data-[slot=frame-panel]:before:hidden",
              "*:data-[slot=frame-panel]:not-first:border-t *:data-[slot=frame-panel-footer]:border-t",
            ]
          : ["relative flex flex-col rounded-2xl bg-muted/72 p-1", "*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1"],
        className,
      )}
      data-slot="frame"
      data-variant={variant}
      {...props}
    />
  );
}

export function FramePanel({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "relative rounded-xl border bg-background bg-clip-padding p-5 shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="frame-panel"
      {...props}
    />
  );
}

export function FrameHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.ReactElement {
  return (
    <header
      className={cn("flex flex-col px-5 py-4", className)}
      data-slot="frame-panel-header"
      {...props}
    />
  );
}

export function FrameTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("font-semibold text-section", className)}
      data-slot="frame-panel-title"
      {...props}
    />
  );
}

export function FrameDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("text-desc text-muted-foreground", className)}
      data-slot="frame-panel-description"
      {...props}
    />
  );
}

export function FrameFooter({
  className,
  ...props
}: React.ComponentProps<"footer">): React.ReactElement {
  return (
    <footer
      className={cn("px-5 py-4", className)}
      data-slot="frame-panel-footer"
      {...props}
    />
  );
}
