import { CodeXmlIcon, WorkflowIcon } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import "@/components/art/art.css";
import { FlowchartSvg, flowchartBox } from "@/components/art/flowchart";
import type { Block } from "@/components/conversation/code-blocks";
import type { FileDiffMetadata } from "@/components/diff/diffs";
import { useDark, useDiffs } from "@/components/diff/load";
import { Tip } from "@/components/tip";
import { useActiveTheme } from "@/hooks/use-theme";
import { type Flowchart, layoutFlowchart } from "@/lib/art/mermaid";
import { chartVars } from "@/lib/art/theme";
import { type DiffShape, drawnBlock, tidyFile } from "@/lib/code-blocks";

// A reply's mermaid or diff block, drawn into its frame (code-blocks.tsx
// finds them and loads this). What can't be drawn stays its text: the
// frame shows its <pre> until a drawing marks it data-drawn.
export default function Drawn({ block }: { block: Block }) {
  const drawn = useMemo(() => drawnBlock(block.lang, block.text), [block]);
  if (!drawn) return null;
  if (drawn.kind === "flowchart") return <FlowchartBlock block={block} chart={drawn.chart} />;
  if (drawn.kind === "diff") return <DiffBlock block={block} shape={drawn.shape} patch={drawn.patch} />;
  return createPortal(<span className="cv-pre-note">Shown as written: Shipyard draws flowcharts</span>, block.slot);
}

// ---- Mermaid ----

function FlowchartBlock({ block, chart }: { block: Block; chart: Flowchart }) {
  const [source, setSource] = useState(false);
  const theme = useActiveTheme();
  const vars = useMemo(() => chartVars(theme) as CSSProperties, [theme]);
  const layout = useMemo(() => layoutFlowchart(chart), [chart]);
  const { frame } = block;
  useLayoutEffect(() => {
    if (source) delete frame.dataset.drawn;
    else frame.dataset.drawn = "diagram";
  }, [frame, source]);
  // Drawn at its own size where the column has the room; narrower, it
  // shrinks to three quarters of that, then scrolls sideways.
  const { w, h } = useMemo(() => flowchartBox(chart, layout, true), [chart, layout]);
  const size: CSSProperties = { width: "100%", maxWidth: w, minWidth: Math.round(w * 0.75), aspectRatio: `${w} / ${h}`, height: "auto" };
  return (
    <>
      {createPortal(
        <Tip label={source ? "Show the diagram" : "Show the Mermaid source"}>
          <button type="button" className="cv-pre-toggle" onClick={() => setSource(!source)}>
            {source ? <WorkflowIcon aria-hidden /> : <CodeXmlIcon aria-hidden />}
            {source ? "Diagram" : "Source"}
          </button>
        </Tip>,
        block.slot,
      )}
      {createPortal(
        <div className="art-scope cv-pre-diagram" style={vars}>
          <FlowchartSvg g={chart} layout={layout} fit style={size} />
        </div>,
        block.host,
      )}
    </>
  );
}

// ---- Diffs ----

// The renderer loads with the first diff shown (components/diff/load);
// until then, and if it can't, the block is its highlighted text.
function DiffBlock({ block, shape, patch }: { block: Block; shape: DiffShape; patch: string }) {
  const lib = useDiffs(true);
  const dark = useDark();
  const mod = lib && "mod" in lib ? lib.mod : undefined;
  const files = useMemo(() => {
    if (!mod) return undefined;
    try {
      return mod
        .parse(patch)
        .map(tidyFile)
        .filter((f) => f.hunks.length);
    } catch {
      return undefined;
    }
  }, [mod, patch]);
  const ready = !!files?.length;
  const { frame } = block;
  useLayoutEffect(() => {
    if (!ready) return;
    frame.dataset.drawn = "diff";
    return () => void delete frame.dataset.drawn;
  }, [frame, ready]);
  if (!mod || !files || !ready) return null;
  const style = { "--berth-diff-bg": "var(--card)" } as CSSProperties;
  return createPortal(
    files.map((f, i) => (
      <div key={i} className="cv-pre-file">
        {shape === "files" && <FileHead f={f} />}
        <mod.Diff fileDiff={f} layout="unified" dark={dark} lineNumbers={shape !== "lines"} style={style} />
      </div>
    )),
    block.host,
  );
}

// FileHead names a file in a patch, as an edit's header does, with what
// it adds and takes out.
function FileHead({ f }: { f: FileDiffMetadata }) {
  const added = f.hunks.reduce((n, h) => n + h.additionLines, 0);
  const removed = f.hunks.reduce((n, h) => n + h.deletionLines, 0);
  const what = f.type === "new" ? "New" : f.type === "deleted" ? "Deleted" : f.prevName ? "Renamed" : undefined;
  return (
    <div className="flex h-8 items-center gap-2 border-b bg-muted/30 px-3 font-sans text-muted-foreground text-meta">
      <span className="min-w-0 flex-1 truncate">
        {what && `${what} `}
        {f.prevName && (
          <>
            <span className="font-mono">{f.prevName}</span> →{" "}
          </>
        )}
        <span className="font-mono text-foreground">{f.name}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">
        {added > 0 && <span className="text-success-foreground">+{added}</span>}
        {added > 0 && removed > 0 && " "}
        {removed > 0 && <span className="text-destructive-foreground">−{removed}</span>}
      </span>
    </div>
  );
}
