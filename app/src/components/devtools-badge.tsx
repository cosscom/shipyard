import { useErrorCountOf } from "@/lib/devtools";
import { badgeText } from "@/lib/devtools-model";
import { cn } from "@/lib/utils";

// The page-error counts on a Browser tab and its devtools button: the tab
// strip's stays in the app while the browser pane and its drawer
// (browser-devtools.tsx) load after it has started.

export function ErrorBadge({ n, testId, className }: { n: number; testId?: string; className?: string }) {
  return (
    <span data-testid={testId} className={cn("inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 font-medium text-[9.5px] text-white tabular-nums leading-none", className)}>
      {badgeText(n)}
    </span>
  );
}

// TabErrorBadge is the count on a Browser tab in the tab strip: its panes'
// page errors since they loaded.
export function TabErrorBadge({ paneIds }: { paneIds: string[] }) {
  const n = useErrorCountOf(paneIds);
  if (!n) return null;
  // The tab is a tooltip's trigger already: the count says it all.
  return (
    <span role="img" aria-label={`${n} page error${n === 1 ? "" : "s"}`} className="inline-flex shrink-0">
      <ErrorBadge n={n} testId="tab-devtools-badge" />
    </span>
  );
}
