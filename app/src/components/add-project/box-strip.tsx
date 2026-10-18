import { useRef } from "react";

import { boxLoad } from "@/components/sidebar/box-load";
import type { BoxStatus } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";

// BoxStrip is where the project will live: every box, how it is doing, and
// how many projects it has. The chosen one carries the logo's amber dot.
// Arrow keys move between online boxes.
export function BoxStrip({ boxes, value, onChange }: { boxes: BoxStatus[]; value: string; onChange(box: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const online = boxes.filter((b) => b.state === "online");
  const many = boxes.length > 3;

  const move = (d: number) => {
    if (!online.length) return;
    const i = online.findIndex((b) => b.name === value);
    const next = online[(i + d + online.length) % online.length].name;
    onChange(next);
    ref.current?.querySelector<HTMLButtonElement>(`[data-box="${CSS.escape(next)}"]`)?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label="Box"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {boxes.map((b) => (
        <Tile key={b.name} box={b} selected={b.name === value} wide={!many} onSelect={() => onChange(b.name)} />
      ))}
    </div>
  );
}

function Tile({ box, selected, wide, onSelect }: { box: BoxStatus; selected: boolean; wide: boolean; onSelect(): void }) {
  const projects = useStore((s) => s.boxes[box.name]?.locations?.length);
  const online = box.state === "online";
  const load = online ? boxLoad(box.name) : "";
  const facts = online ? [box.latency_ms !== undefined ? `${box.latency_ms}ms` : "", projects !== undefined ? `${projects} ${projects === 1 ? "project" : "projects"}` : ""].filter(Boolean).join(" · ") : box.state;
  const tile = (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-box={box.name}
      tabIndex={selected ? 0 : -1}
      disabled={!online && !selected}
      onClick={onSelect}
      className={cn(
        "group relative flex h-13 min-w-0 shrink-0 flex-col justify-center gap-0.5 rounded-lg border px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        wide ? "flex-1 basis-0" : "w-40",
        selected ? "border-foreground/20 bg-accent/72 dark:bg-input/64" : "border-border/80 hover:bg-accent/40 dark:hover:bg-input/32",
        !online && "border-dashed opacity-64 disabled:cursor-not-allowed",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full transition-colors",
            selected && online ? "bg-foreground" : online ? "border border-muted-foreground/48" : "border border-dashed border-muted-foreground/48",
          )}
        />
        <span className="min-w-0 truncate text-row">{box.name}</span>
      </span>
      <span className="truncate ps-4 text-muted-foreground text-meta tabular-nums">{facts}</span>
    </button>
  );
  return load ? <Tip label={load} wrapClassName={wide ? "flex min-w-0 flex-1 basis-0" : undefined}>{tile}</Tip> : tile;
}
