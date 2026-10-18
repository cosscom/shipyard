import { useState } from "react";

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toastManager } from "@/components/ui/toast";
import { plainError } from "@/lib/errors";
import { localBoxApi, useLocalBoxName } from "@/lib/local-box";
import { useStore } from "@/lib/store";
import { CommandLog } from "@/views/settings/command-log";
import { IS_LINUX, thisComputer } from "@/lib/platform";

// RemoveLocalBoxDialog stops using this Mac as a box (Use this Mac,
// undone): Shipyard forgets the box, stops berthd here and removes its launch
// agent. Its data stays unless asked: the box's keys, projects list and
// session records. Repositories are never touched.
export function RemoveLocalBoxDialog({ box, open, onOpenChange }: { box: string; open: boolean; onOpenChange(open: boolean): void }) {
  const [removeData, setRemoveData] = useState(false);
  const [lines, setLines] = useState<string[]>();
  const [error, setError] = useState<string>();
  const running = !!lines && !error;

  const remove = async () => {
    const client = useStore.getState().client;
    if (!client) return;
    setLines([]);
    setError(undefined);
    try {
      await localBoxApi.remove(client, removeData, (l) => setLines((p) => [...(p ?? []), l]));
      useLocalBoxName.setState({ name: undefined });
      await useStore.getState().refreshStatus();
      onOpenChange(false);
      setLines(undefined);
      toastManager.add({ title: "This Mac is no longer a box", description: removeData ? "berthd and its data are gone." : "berthd is stopped; its data is kept.", type: "success" });
    } catch (err) {
      setError(plainError(err));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{thisComputer("Stop using this Mac as a box?")}</AlertDialogTitle>
          <AlertDialogDescription>
            Shipyard forgets {box}, stops berthd on {thisComputer("this Mac")} and removes its {IS_LINUX ? "systemd user unit" : "launch agent"}. Your repositories and files stay where they are, and agents still running here keep going until they finish.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-6">
          <label className="flex items-start gap-2.5 text-body">
            <Checkbox className="mt-0.5" checked={removeData} disabled={running} onCheckedChange={(v) => setRemoveData(v === true)} />
            <span>
              Also delete its data
              <span className="mt-0.5 block text-muted-foreground text-meta">{thisComputer("The box's keys, its list of projects and its session records. Keep them to set this Mac up again as the same box.")}</span>
            </span>
          </label>
          {lines && <CommandLog className="mt-3" lines={lines} error={error} />}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" disabled={running} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" loading={running} onClick={() => void remove()}>
            {error ? "Try again" : thisComputer("Stop using this Mac")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
