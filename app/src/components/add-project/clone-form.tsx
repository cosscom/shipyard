import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import type { Location } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { projectsApi, repoName } from "@/lib/projects";
import { useStore } from "@/lib/store";
import { ErrorText } from "@/components/error-note";

// CloneForm clones a repository onto the box, showing git's progress as it
// goes, and adds it as a project.
export function CloneForm({ box, onAdded, onCancel }: { box: string; onAdded(loc: Location): Promise<void>; onCancel(): void }) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("~/work");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const shownName = nameEdited ? name : repoName(url);

  const clone = async () => {
    const client = useStore.getState().client;
    if (!client || !url.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    setLines([]);
    abort.current = new AbortController();
    try {
      const loc = await projectsApi.clone(client, box, { url: url.trim(), parent: parent.trim() || undefined, name: shownName.trim() || undefined }, (line) => setLines((l) => mergeProgress(l, line)), abort.current.signal);
      await onAdded(loc);
    } catch (err) {
      setError(abort.current?.signal.aborted ? "Stopped." : plainError(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void clone();
      }}
    >
      <DialogPanel className="flex flex-col gap-3 px-5 pb-5">
        <Labelled label="Repository URL">
          <Input autoFocus className="font-mono" disabled={busy} value={url} spellCheck={false} placeholder="https://github.com/acme/shop" onChange={(e) => setUrl(e.target.value)} />
        </Labelled>
        <div className="grid grid-cols-[1fr_11rem] gap-2">
          <Labelled label="Into">
            <Input className="font-mono" disabled={busy} value={parent} spellCheck={false} onChange={(e) => setParent(e.target.value)} />
          </Labelled>
          <Labelled label="Folder">
            <Input
              className="font-mono"
              disabled={busy}
              value={shownName}
              spellCheck={false}
              placeholder="from the URL"
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
            />
          </Labelled>
        </div>
        <p className="truncate text-desc text-muted-foreground">
          Clones to <span className="font-mono text-foreground/80">{`${parent.replace(/\/+$/, "") || "~/work"}/${shownName || "…"}`}</span> on {box}
        </p>
        {(busy || lines.length > 0) && (
          <Frame className="rounded-xl p-0.5">
            <FramePanel className="rounded-[10px] p-0 shadow-none before:hidden dark:bg-input/32">
              <pre ref={logRef} aria-live="polite" className="max-h-40 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-mono text-muted-foreground">
                {lines.length ? lines.join("\n") : "Starting git clone…"}
              </pre>
            </FramePanel>
          </Frame>
        )}
        {error && <ErrorText className="text-destructive text-body" text={error} />}
      </DialogPanel>
      <DialogFooter className="items-center px-5 py-3">
        {busy ? (
          <Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={busy} disabled={!url.trim()}>
          Clone and add
        </Button>
      </DialogFooter>
    </form>
  );
}

export function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-medium text-desc">{label}</span>
      {children}
    </label>
  );
}

// mergeProgress keeps git's "Receiving objects: 42%" lines from piling up:
// a line that updates the same step replaces the last one.
function mergeProgress(lines: string[], line: string): string[] {
  const step = (l: string) => /^([A-Za-z ]+):\s+\d+%/.exec(l)?.[1];
  const s = step(line);
  if (s && lines.length && step(lines[lines.length - 1]) === s) return [...lines.slice(0, -1), line];
  return [...lines, line].slice(-200);
}
