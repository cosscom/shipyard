import type { ReactNode } from "react";

import { Scene, type SceneName } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { useHomeWidget } from "./env";

// The pieces Home's widgets are drawn with, shared with plugins through
// @berth/plugin/ui (WidgetRow, WidgetEmpty, WidgetSkeleton), so a plugin's
// widget reads like Shipyard's own.

// WidgetRow is one line of a widget: 36px, full width, a button when it
// does something.
export function WidgetRow({ children, onClick, className, label }: { children: ReactNode; onClick?: () => void; className?: string; label?: string }) {
  const cls = cn(
    "group/row flex h-9 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-body outline-none",
    onClick && "hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  if (!onClick) return <div className={cls}>{children}</div>;
  return (
    <button type="button" onClick={onClick} aria-label={label} className={cls}>
      {children}
    </button>
  );
}

// WidgetEmpty is a widget with nothing to show: a small scene, what that
// means, and the one thing to do about it. Compact in a one-row widget.
export function WidgetEmpty({ scene = "calm", title, hint, action, onAction, compact }: { scene?: SceneName; title: string; hint?: ReactNode; action?: string; onAction?: () => void; compact?: boolean }) {
  // In a one-row card the scene makes room for the action.
  const { height } = useHomeWidget();
  const art = !compact && (!action || height > 200);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 px-4 pb-1 text-center">
      {art && <Scene name={scene} width={104} className="mb-0.5 text-muted-foreground @max-[220px]:hidden" />}
      <p className="text-row">{title}</p>
      {hint && <p className="line-clamp-2 max-w-72 text-balance text-desc text-muted-foreground">{hint}</p>}
      {action && onAction && (
        <Button size="xs" variant="outline" className="mt-1.5" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}

// WidgetSkeleton stands in for rows while they load, at the height they
// will have, so nothing moves when they arrive.
export function WidgetSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)} role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-2.5 px-2">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-3 rounded-sm" style={{ width: `${[62, 48, 70, 54, 40, 66, 58, 44][i % 8]}%` }} />
          <Skeleton className="ml-auto h-3 w-8 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

// More says how many rows didn't fit; as a button, a full 24px touch target.
export function More({ n, label, onClick }: { n: number; label: string; onClick?: () => void }) {
  if (n <= 0) return null;
  const text = `+${n} more ${label}`;
  return onClick ? (
    <button type="button" onClick={onClick} className="inline-flex min-h-6 items-center self-start rounded-sm px-2 text-muted-foreground text-meta outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {text}
    </button>
  ) : (
    <p className="px-2 pt-0.5 text-meta text-muted-foreground">{text}</p>
  );
}

export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  return (
    <span className={cn("shrink-0 font-mono text-tag tabular-nums", className)}>
      <span className="text-success-foreground">+{compactNumber(add)}</span> <span className="text-destructive-foreground">−{compactNumber(del)}</span>
    </span>
  );
}

// A thin bar for a share of something (memory used, a plan's limit).
export function Bar({ value, className, tone }: { value: number; className?: string; tone?: "info" | "warning" | "destructive" | "muted" }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const t = tone ?? (v > 0.9 ? "destructive" : v > 0.75 ? "warning" : "info");
  return (
    <span className={cn("block h-1 w-full overflow-hidden rounded-full bg-muted", className)}>
      <span
        className={cn("block h-full rounded-full", { info: "bg-info", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-foreground/40" }[t])}
        style={{ width: `${Math.round(v * 100)}%` }}
      />
    </span>
  );
}

export function compactNumber(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// Short ago: "4m", "2h", "3d".
export function shortAgo(iso?: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso ?? "");
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
