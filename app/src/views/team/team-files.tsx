import { FileIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { bytes } from "@/lib/format";
import type { TeamView } from "@/lib/team";
import { whereFrom } from "@/views/team/team-parts";
import { cn } from "@/lib/utils";

// TeamFiles is "Read every command": the .berth repo's own files at the
// commit Shipyard will use, read only, with the lines that call sudo marked.

export function TeamFiles({ view, open, onOpenChange }: { view: TeamView; open: boolean; onOpenChange(open: boolean): void }) {
  const files = view.files ?? [];
  const [at, setAt] = useState(() => files.find((f) => f.path.endsWith(".sh"))?.path ?? files[0]?.path);
  const file = files.find((f) => f.path === at) ?? files[0];
  const sudoLines = (file?.text ?? "").split("\n").filter((l) => /\bsudo\b/.test(l) && !l.trimStart().startsWith("#")).length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="w-[min(760px,100vw)] max-w-none">
        <SheetHeader>
          <SheetTitle>Every command, as {view.org.name} wrote it</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{whereFrom(view)}</span> at <span className="font-mono">{view.commit?.short}</span>, read only. This is exactly what runs on your box.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex min-h-0 flex-col gap-3">
          <div role="tablist" aria-label="Files" className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                role="tab"
                aria-selected={f.path === file?.path}
                onClick={() => setAt(f.path)}
                className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-mono outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring", f.path === file?.path ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground")}
              >
                <FileIcon className="size-3" />
                {f.path}
              </button>
            ))}
          </div>
          {file && (
            <div className="min-h-0 overflow-hidden rounded-lg border">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-meta text-muted-foreground">
                <span className="font-mono text-foreground">{file.path}</span>
                <span>{bytes(file.size)}</span>
                {sudoLines > 0 && (
                  <span className="ml-auto inline-flex items-center gap-1 text-warning-foreground">
                    <KeyRoundIcon className="size-3" /> {sudoLines} lines call sudo, marked
                  </span>
                )}
              </div>
              {file.text === undefined ? (
                <p className="px-3 py-6 text-center text-muted-foreground text-body">Not text, or too large to show here. It's on GitHub.</p>
              ) : (
                <pre data-testid="team-file" className="overflow-x-auto py-2 font-mono text-mono">
                  {file.text.split("\n").map((l, i) => {
                    const sudo = /\bsudo\b/.test(l) && !l.trimStart().startsWith("#");
                    return (
                      <div key={i} className={cn("flex", sudo && "bg-warning/10")}>
                        <span aria-hidden className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground/60">
                          {i + 1}
                        </span>
                        <span className={cn("whitespace-pre pr-4", l.trimStart().startsWith("#") && "text-muted-foreground")}>{l || " "}</span>
                      </div>
                    );
                  })}
                </pre>
              )}
            </div>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
