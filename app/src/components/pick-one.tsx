import type { ReactNode } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface PickOneOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  // For the rare option that needs a tone of its own when chosen.
  className?: string;
}

// PickOne is the app's one control for picking one of a few values: a coss
// ToggleGroup, 28px high, in a muted track, the chosen item raised and the
// rest at 80% foreground. Settings, New worktree, Hand off, Review, the diff
// layout, a flow step's "Runs" and the plugins' screens use it; a page's
// filter with an "All" choice (Activity's kinds, Issues' assignee) is one
// too. Which boxes a page covers is BoxFilter; narrowing by labels or tags,
// any number at once, is FilterChip.
//
// Base UI's ToggleGroup never presses an item whose value is the empty
// string, so "" (such as "No agent") travels through the group as NONE.
const NONE = "__none__";
const toItem = (v: string) => (v === "" ? NONE : v);
const fromItem = (v: string) => (v === NONE ? "" : v);

export function PickOne<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  value: T;
  options: PickOneOption<T>[];
  onChange(v: T): void;
  label?: string;
  className?: string;
  // A visible label elsewhere (a settings row's) names the group instead.
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      aria-describedby={describedBy}
      size="sm"
      value={[toItem(value)]}
      // Clicking the chosen item again keeps it chosen.
      onValueChange={(v) => v.length && onChange(fromItem(v[v.length - 1] as string) as T)}
      // shrink-0: in a row it keeps its one line and its neighbours give way
      // (a file path beside Review's Unified/Split); it wraps only when it
      // is wider than the whole row (max-w-full).
      className={cn("w-fit max-w-full shrink-0 flex-wrap rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={toItem(o.value)}
          value={toItem(o.value)}
          className={cn(
            "gap-1.5 rounded-md px-2.5 font-normal text-desc text-foreground/80 hover:bg-background/60 hover:text-foreground data-pressed:bg-background data-pressed:font-medium data-pressed:text-foreground data-pressed:shadow-xs/5 dark:hover:bg-input/32 dark:data-pressed:bg-input",
            o.className,
          )}
        >
          {o.icon}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
