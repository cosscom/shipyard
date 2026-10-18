import type { ViewProps } from "@/components/art/kinds";
import { Thumb } from "@/components/art/thumb";

// An artifact's source as text: the source view, and the viewer for a kind
// this app doesn't know yet.
export default function SourceView({ body, size, height }: ViewProps) {
  const pre = <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-mono">{body}</pre>;
  if (size === "thumb")
    return (
      <Thumb h={height ?? 120} width={520}>
        {pre}
      </Thumb>
    );
  return pre;
}
