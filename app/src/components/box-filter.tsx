import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

// BoxFilter chooses which boxes a page covers. Pressed means shown: every
// box starts pressed, turning one off hides what is on it, and the last
// one on stays on, so the filter never empties the page by itself. The
// Agent Dashboard, Worktrees, History, Automations runs and Usage share it.
//
// `hidden` is what is kept, so a new box shows up on its own. Boxes in
// `hidden` that are not in `boxes` (offline, say) stay hidden.
//
// Narrowing by what rows have (a label, a state) is FilterChip's job, and
// picking one of a few values is PickOne's.
export function BoxFilter({
  boxes,
  hidden,
  onChange,
  label = "Boxes to show",
  className,
}: {
  boxes: string[];
  hidden: string[];
  onChange(hidden: string[]): void;
  label?: string;
  className?: string;
}) {
  if (boxes.length < 2) return null;
  const shown = boxes.filter((b) => !hidden.includes(b));
  return (
    <ToggleGroup
      multiple
      size="sm"
      variant="outline"
      className={cn("shrink-0", className)}
      // A stored filter can hide every box there is now; show them all then.
      value={shown.length ? shown : boxes}
      onValueChange={(v) => {
        const on = v as string[];
        if (!on.length) return;
        onChange([...hidden.filter((h) => !boxes.includes(h)), ...boxes.filter((b) => !on.includes(b))]);
      }}
      aria-label={label}
    >
      {boxes.map((b) => (
        <ToggleGroupItem
          key={b}
          value={b}
          className="group/box h-7 gap-1.5 px-2.5 font-normal text-muted-foreground text-meta sm:text-meta data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs dark:data-pressed:bg-input"
        >
          {/* Filled when shown, hollow when hidden: the state reads without colour. */}
          <span className="size-1.5 shrink-0 rounded-full border border-current opacity-70 group-data-pressed/box:bg-current" aria-hidden />
          {b}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// shownBoxes is what a BoxFilter leaves on, all of them if it hides every one.
export function shownBoxes(boxes: string[], hidden: string[]): string[] {
  const shown = boxes.filter((b) => !hidden.includes(b));
  return shown.length ? shown : boxes;
}
