import { AlertTriangleIcon, CheckIcon, FolderGitIcon, ServerIcon, XIcon } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import type { InstalledKitOn, KitTarget } from "@/lib/kits";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// ProjectPicker chooses where a kit goes: every project on every online box,
// grouped by box. Once applying, each row shows how it went.

export type TargetResult = { state: "applying" } | { state: "applied"; warnings: string[] } | { state: "failed"; error: string };

export const targetKey = (t: KitTarget) => `${t.box}/${t.location}`;

// matchingTargets are the projects a kit is for: those whose repository is
// the one the kit names.
export function matchingTargets(slug: string | undefined, boxes: Record<string, { locations?: { name: string; slug?: string; repo: boolean }[] }>, online: string[]): KitTarget[] {
  if (!slug) return [];
  const out: KitTarget[] = [];
  for (const box of online) {
    for (const l of boxes[box]?.locations ?? []) {
      if (l.repo && l.slug?.toLowerCase() === slug.toLowerCase()) out.push({ box, location: l.name });
    }
  }
  return out;
}

export function ProjectPicker({
  kitId,
  slug,
  selected,
  onChange,
  results,
  installed,
  disabled,
}: {
  kitId: string;
  slug?: string;
  selected: Set<string>;
  onChange(next: Set<string>): void;
  results: Record<string, TargetResult>;
  installed: InstalledKitOn[];
  disabled?: boolean;
}) {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const online = boxes.filter((b) => b.state === "online");

  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };

  if (!online.length) return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-meta text-muted-foreground">No box is online. Kits apply to projects on online boxes.</p>;

  return (
    <div className="space-y-3">
      {online.map((b) => {
        const locs = (data[b.name]?.locations ?? []).filter((l) => l.repo);
        return (
          <div key={b.name} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-meta text-muted-foreground">
              <ServerIcon className="size-3" />
              <span className="font-medium text-foreground/90">{b.name}</span>
              <span className="ml-auto">{locs.length === 1 ? "1 project" : `${locs.length} projects`}</span>
            </div>
            {locs.length === 0 && <p className="px-3 py-2.5 text-meta text-muted-foreground">No git projects on {b.name} yet.</p>}
            {locs.map((l) => {
              const key = targetKey({ box: b.name, location: l.name });
              const here = installed.find((i) => i.box === b.name && i.location === l.name);
              const result = results[key];
              const matches = !!slug && l.slug?.toLowerCase() === slug.toLowerCase();
              return (
                <label key={key} className={cn("flex min-w-0 cursor-pointer items-start gap-2.5 border-b px-3 py-2 last:border-b-0 hover:bg-accent/40", disabled && "cursor-default hover:bg-transparent")}>
                  <Checkbox className="mt-0.5" checked={selected.has(key)} disabled={disabled} onCheckedChange={(v) => toggle(key, !!v)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-body">
                      <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{l.name}</span>
                      {l.slug && <span className={cn("truncate font-mono text-meta", matches ? "text-success-foreground" : "text-muted-foreground")}>{l.slug}</span>}
                      {here && (
                        <span className="ml-auto shrink-0 rounded-md border px-1.5 text-tag text-muted-foreground">
                          {here.kit.id === kitId ? (here.outdated ? "Has an older version" : "Has this kit") : `Has ${here.kit.name || here.kit.id}`}
                        </span>
                      )}
                    </div>
                    {result && <ResultLine result={result} />}
                  </div>
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ResultLine({ result }: { result: TargetResult }) {
  if (result.state === "applying") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-meta text-muted-foreground">
        <Spinner className="size-3" /> Applying…
      </p>
    );
  }
  if (result.state === "failed") {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-destructive-foreground text-meta">
        <XIcon className="mt-0.5 size-3 shrink-0" />
        {result.error}
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-0.5 text-meta">
      <p className="flex items-center gap-1.5 text-success-foreground">
        <CheckIcon className="size-3" /> Applied
      </p>
      {result.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-warning-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          {w}
        </p>
      ))}
    </div>
  );
}
