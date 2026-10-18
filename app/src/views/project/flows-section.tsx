import { ChevronRightIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useEventLog } from "@/lib/events";
import { flowsApi, isOverridden, overrides, type ScopedFlow } from "@/lib/flows";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { kindMeta, summary } from "@/views/automations/flows/model";
import { Section, SourceBadge } from "@/views/project/parts";

// FlowsSection lists this repo's flows on this box; they open in the flow
// editor, scoped to the repo.
export function FlowsSection({ box, location }: { box: string; location: string }) {
  const client = useStore((s) => s.client);
  const [flows, setFlows] = useState<ScopedFlow[]>();
  const scope = `repo:${location}`;
  const changed = useEventLog((s) => s.events.find((e) => e.box === box && (e.type === "flows.changed" || e.type === "config.changed")));

  useEffect(() => {
    if (!client) return;
    flowsApi.list(client, box).then(
      (all) => setFlows(all.filter((f) => f.scope === scope)),
      () => setFlows([]),
    );
  }, [client, box, scope, changed]);

  const open = (id?: string) => useStore.getState().setView({ kind: "automations", open: { box, scope, id } });
  // An override hides the committed or kit flow it replaces.
  const shown = (flows ?? []).filter((f) => !isOverridden(f, flows!));

  return (
    <Section
      id="flows"
      title="Automations"
      description={`Flows that run for ${location}'s worktrees: tests after an agent's turn, a review when it finishes, a ping when setup fails.`}
      actions={
        <Button size="xs" variant="ghost" onClick={() => open()}>
          <PlusIcon />
          New flow
        </Button>
      }
    >
      {flows && shown.length === 0 ? (
        <button type="button" onClick={() => open()} className="flex w-full items-center gap-2 px-4 py-3 text-left text-muted-foreground text-body hover:text-foreground">
          <WorkflowIcon className="size-4" />
          No flows for {location} yet. Make one.
        </button>
      ) : (
        <div className="divide-y divide-border/70">
          {shown.map((f) => (
            <button key={`${f.source}:${f.flow.id}`} type="button" onClick={() => open(f.flow.id)} className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40", !f.flow.enabled && "opacity-60")}>
              <span className="flex shrink-0 -space-x-1">
                {[...new Set(f.flow.steps.map((s) => s.kind))].slice(0, 3).map((k) => {
                  const m = kindMeta(k);
                  return (
                    <span key={k} className={cn("inline-flex size-6 items-center justify-center rounded-md border-2 border-card bg-muted", m.tone)}>
                      <m.Icon className="size-3.5" />
                    </span>
                  );
                })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-row">{f.flow.name}</span>
                <span className="block truncate text-desc text-muted-foreground">{summary(f.flow)}</span>
              </span>
              {!f.flow.enabled && <span className="text-meta text-muted-foreground">Off</span>}
              <SourceBadge source={f.source === "local" ? (overrides(f, flows!) ? "override" : "box") : f.source === "box" ? "box" : f.source} box={box} />
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}
