import { FolderGitIcon, LayersIcon } from "lucide-react";

import { type Scope, scopeLocation } from "@/lib/flows";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { hereRef } from "@/lib/workspaces";

// BoxChip names a box the way the sidebar does.
export function BoxChip({ box, className }: { box: string; className?: string }) {
  return <span className={cn("inline-flex h-4 shrink-0 items-center rounded bg-muted px-1 font-mono text-tag text-muted-foreground leading-none", className)}>{box}</span>;
}

// ProjectLabel names where a flow runs: a project as "shop · acme/shop" on
// its box, or every project on a box.
export function ProjectLabel({ box, scope, className, chip = true }: { box: string; scope: Scope; className?: string; chip?: boolean }) {
  return <OneBoxLabel box={box} scope={scope} className={className} chip={chip} />;
}

function OneBoxLabel({ box, scope, className, chip }: { box: string; scope: Scope; className?: string; chip: boolean }) {
  const loc = scopeLocation(scope);
  const slug = useStore((s) => (loc ? s.boxes[box]?.locations?.find((l) => l.name === loc)?.slug : undefined));
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {loc ? <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">
        {loc ?? "All projects"}
        {slug && <span className="text-muted-foreground"> · {slug}</span>}
      </span>
      {chip && <BoxChip box={box} />}
    </span>
  );
}

// savedWhere says in a line where a flow lives, so it is never a surprise.
// A read-only flow says which layer it comes from: committed ("repo") or the
// project's kit ("kit").
export function savedWhere(box: string, scope: Scope, readOnlyFrom?: "repo" | "kit"): string {
  const loc = scopeLocation(scope);
  if (readOnlyFrom === "kit") return "From the project's kit, applied on this box";
  if (readOnlyFrom) return "Saved in the repo's .berth/config.json";
  return loc ? `Saved on ${box} for ${loc} · not committed` : `Saved on ${box} · runs for every project there`;
}

// defaultScope is where a new flow goes: the project you are working in,
// else the first project on the first box that has one.
export function defaultScope(): { box: string; scope: Scope } | undefined {
  const ref = hereRef();
  if (ref) return { box: ref.box, scope: `repo:${ref.location}` };
  const { status, boxes } = useStore.getState();
  const online = status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [];
  for (const b of online) {
    const loc = boxes[b]?.locations?.[0];
    if (loc) return { box: b, scope: `repo:${loc.name}` };
  }
  return online[0] ? { box: online[0], scope: "box" } : undefined;
}
