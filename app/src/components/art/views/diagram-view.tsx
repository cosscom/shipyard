import { useMemo } from "react";

import type { ViewProps } from "@/components/art/kinds";
import { FlowchartSvg } from "@/components/art/flowchart";
import SourceView from "@/components/art/views/source-view";
import { layoutFlowchart, parseFlowchart } from "@/lib/art/mermaid";
import { cn } from "@/lib/utils";

// A diagram: a Mermaid flowchart drawn by Shipyard in the theme (lib/art/
// mermaid.ts, components/art/flowchart.tsx); any other Mermaid diagram as
// its source, said so.
export default function DiagramView(props: ViewProps) {
  const { body, size, height } = props;
  const g = useMemo(() => parseFlowchart(body), [body]);
  const layout = useMemo(() => (g ? layoutFlowchart(g) : undefined), [g]);
  if (!g || !layout || !g.nodes.length)
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {size === "full" && <p className="text-muted-foreground text-meta">Shipyard draws Mermaid flowcharts (graph or flowchart); this one is shown as written.</p>}
        <SourceView {...props} />
      </div>
    );
  const thumb = size === "thumb";
  return (
    <div className={cn("flex w-full items-center justify-center", thumb ? "pointer-events-none" : "h-full")} style={thumb ? { height: height ?? 120 } : undefined} data-art-diagram>
      <FlowchartSvg g={g} layout={layout} thumb={thumb} className="h-full max-h-full w-full max-w-full" />
    </div>
  );
}
