import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// FilterChip narrows a list to the rows that have something: a label, a
// tag, a state. Chips start off, so nothing is narrowed; each one turned
// on narrows further. Issues' labels, Prompts' tags, Worktrees' "Behind
// base" and the live events' types use it.
//
// Choosing which boxes a page covers is BoxFilter (all on to start), and
// picking one of a few values is PickOne.
export function FilterChip({ pressed, onPressedChange, children, className }: { pressed: boolean; onPressedChange(pressed: boolean): void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-meta text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3 [&_svg]:shrink-0",
        pressed && "border-foreground/25 bg-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
