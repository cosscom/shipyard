import { GitCommitHorizontalIcon, LaptopMinimalIcon, PackageIcon, ServerIcon, Undo2Icon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RepoConfig } from "@/lib/flows";
import { kitHas } from "@/lib/kits";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/tip";

// Section is one titled part of Project settings, framed like the rest of
// the app's settings.
export function Section({ id, title, description, actions, children }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-2.5 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-section">{title}</h2>
          {description && <p className="mt-0.5 text-desc text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  );
}

export type Source = "repo" | "kit" | "box" | "override";

// KitLayer is the project's kit, when it has one: its layer sits between the
// committed config and this box's own, so a value under this box's can come
// from either. The sections pass "repo" for that layer, and the badge tells
// which by asking the kit.
export const KitLayer = createContext<{ config?: RepoConfig; name?: string }>({});

type KitField = Parameters<typeof kitHas>[1];

// SourceBadge says where a value comes from: committed in the repository,
// the project's kit, set on this box, or this box overriding what's below.
export function SourceBadge({ source, box, field, entry }: { source: Source; box: string; field?: KitField; entry?: string }) {
  const kit = useContext(KitLayer);
  if (source === "repo" && field && kitHas(kit.config, field, entry)) source = "kit";
  const map = {
    repo: { Icon: GitCommitHorizontalIcon, label: "Repo", cls: "text-muted-foreground", title: "Committed in the repository's .berth/config.json" },
    kit: { Icon: PackageIcon, label: "Kit", cls: "text-violet-600 border-violet-500/25 dark:text-violet-400", title: `From the ${kit.name ?? "project's"} kit` },
    box: { Icon: ServerIcon, label: box, cls: "text-sky-400 border-sky-400/25", title: `Set on ${box} only` },
    override: { Icon: ServerIcon, label: `${box} override`, cls: "text-warning-foreground border-warning/30", title: `${box} replaces the committed value` },
  }[source];
  return (
    <Tip label={map.title}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-tag", map.cls)}>
        <map.Icon className="size-3" />
        {map.label}
      </span>
    </Tip>
  );
}

// LayeredScript is a script the repository may commit and this box may
// override: the committed one shows read-only until overridden.
export function LayeredScript({
  label,
  hint,
  repo,
  local,
  box,
  placeholder,
  onChange,
  field,
}: {
  field?: KitField;
  label: string;
  hint: ReactNode;
  repo?: string;
  local?: string;
  box: string;
  placeholder: string;
  onChange(v: string | undefined): void;
}) {
  const overriding = local !== undefined && local !== "";
  const source: Source | undefined = overriding ? (repo ? "override" : "box") : repo ? "repo" : undefined;
  return (
    <div className="px-4 py-3.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-row">{label}</span>
        {source && <SourceBadge source={source} box={box} field={field} />}
        <span className="ml-auto flex gap-1">
          {repo && !overriding && (
            <Button size="xs" variant="ghost" onClick={() => onChange(repo)}>
              <LaptopMinimalIcon />
              Override on {box}
            </Button>
          )}
          {overriding && repo && (
            <Button size="xs" variant="ghost" onClick={() => onChange(undefined)}>
              <Undo2Icon />
              Use the repo's
            </Button>
          )}
        </span>
      </div>
      <p className="mb-2 text-desc text-muted-foreground">{hint}</p>
      {repo && !overriding ? (
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-mono">{repo}</pre>
      ) : (
        <Textarea value={local ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-h-16 font-mono text-mono" spellCheck={false} />
      )}
    </div>
  );
}
