import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { FileGlyph } from "@/components/files/file-bits";
import { Spinner } from "@/components/ui/spinner";
import { agentMarks } from "@/lib/file-marks";
import { dirName, fileName } from "@/lib/file-match";
import { docKey, openDoc, useFiles } from "@/lib/files";
import { useHereRef } from "@/lib/workspaces";

const CodeEditor = lazy(() => import("@/components/files/code-editor"));

// Preview is the highlighted file, read only, at the agent's first change.
export default function Preview({ ws, path }: { ws: string; path: string }) {
  const ref = useHereRef();
  const [shown, setShown] = useState(path);
  // Arrowing through the list fetches only where it rests.
  useEffect(() => {
    const id = window.setTimeout(() => setShown(path), 90);
    return () => window.clearTimeout(id);
  }, [path]);
  useEffect(() => {
    if (ref) void openDoc(ws, ref, shown);
  }, [ws, ref, shown]);
  const doc = useFiles((s) => s.docs[docKey(ws, shown)]);
  const marks = useMemo(() => (doc?.state === "ready" && !doc.binary && !doc.tooLarge ? agentMarks(doc.turn ? doc.turn.before : undefined, doc.agentText, doc.base, doc.text) : undefined), [doc]);
  const hunks = marks?.hunks.length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-preview" data-path={shown}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-meta">
        <FileGlyph path={shown} />
        <span className="min-w-0 truncate text-muted-foreground">
          {dirName(shown) && <span>{dirName(shown)}/</span>}
          <span className="text-foreground">{fileName(shown)}</span>
        </span>
        {doc?.turn && hunks > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <AgentIcon agent={doc.turn.agent} className="size-3" />
            {hunks} {hunks === 1 ? "change" : "changes"}
          </span>
        )}
      </div>
      {!doc || doc.state === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : doc.state !== "ready" || doc.binary || doc.tooLarge ? (
        <p className="m-auto max-w-xs px-6 text-center text-muted-foreground text-meta">{doc.reason ?? doc.error ?? (doc.image ? "A picture: open it to see it." : "Nothing to show.")}</p>
      ) : (
        <Suspense fallback={<Spinner className="m-6 size-4" />}>
          <CodeEditor key={shown} path={shown} text={doc.text} changes={marks} readOnly revealLine={marks?.hunks[0]?.from} fontSize={11.5} className="min-h-0 flex-1 overflow-hidden" />
        </Suspense>
      )}
    </div>
  );
}
