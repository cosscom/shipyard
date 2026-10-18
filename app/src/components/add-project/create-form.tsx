import { useState } from "react";

import { Labelled } from "@/components/add-project/clone-form";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Location } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { locationName, projectsApi } from "@/lib/projects";
import { useStore } from "@/lib/store";
import { ErrorText } from "@/components/error-note";

// CreateForm starts a project from nothing: a folder with a fresh git
// repository and an empty first commit, so worktrees work right away.
export function CreateForm({ box, onAdded, onCancel }: { box: string; onAdded(loc: Location): Promise<void>; onCancel(): void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("~/work");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clean = locationName(name);
  const taken = useStore((s) => s.boxes[box]?.locations?.some((l) => l.name === clean));
  const dir = parent.replace(/\/+$/, "") || "~/work";

  const create = async () => {
    const client = useStore.getState().client;
    if (!client || !clean || busy || taken) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdded(await projectsApi.create(client, box, clean, parent.trim() || undefined));
    } catch (err) {
      setError(plainError(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <DialogPanel className="flex flex-col gap-3 px-5 pb-5">
        <div className="grid grid-cols-[1fr_11rem] gap-2">
          <Labelled label="Name">
            <Input autoFocus value={name} spellCheck={false} placeholder="my-app" onChange={(e) => setName(e.target.value)} />
          </Labelled>
          <Labelled label="In">
            <Input className="font-mono" value={parent} spellCheck={false} onChange={(e) => setParent(e.target.value)} />
          </Labelled>
        </div>
        <p className="truncate text-desc text-muted-foreground">
          Creates{" "}
          <span className="font-mono">
            <span className="text-foreground/80">{dir}/</span>
            {clean ? <span className="text-foreground/80">{clean}</span> : <span className="text-muted-foreground/60">my-app</span>}
          </span>{" "}
          with git and an empty first commit.
        </p>
        {taken && <p className="text-body text-warning-foreground">{box} already has a project called {clean}.</p>}
        {error && <ErrorText className="text-destructive text-body" text={error} />}
      </DialogPanel>
      <DialogFooter className="items-center px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!clean || taken}>
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
