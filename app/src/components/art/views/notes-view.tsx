import type { ViewProps } from "@/components/art/kinds";
import { Thumb } from "@/components/art/thumb";
import { Markdown } from "@/components/conversation/markdown";

// Notes: Markdown through the chat's own renderer (no raw HTML).
export default function NotesView({ body, size, height }: ViewProps) {
  if (size === "thumb")
    return (
      <Thumb h={height ?? 120} width={520}>
        <div className="p-2 text-desc">
          <Markdown text={body} copy={false} />
        </div>
      </Thumb>
    );
  return (
    <div className="mx-auto w-full max-w-[46rem] text-body" data-art-notes>
      <Markdown text={body} copy={false} />
    </div>
  );
}
