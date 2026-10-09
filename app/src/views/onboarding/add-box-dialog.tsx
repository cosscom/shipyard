import { Suspense } from "react";
import { create } from "zustand";

import { Dialog, DialogPopup } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { useStore } from "@/lib/store";
import { lazyView } from "@/lib/lazy-view";
import { prefetchTailnets } from "@/views/onboarding/tailnet";
import { openTeam, TeamBoxEntry } from "@/views/team/team-entry";

// The flow (its install, SSH and tailnet steps) loads after the app starts.
const AddBoxFlow = lazyView(() => import("@/views/onboarding/add-box-flow").then((m) => m.AddBoxFlow));

const useAddBox = create<{ open: boolean }>()(() => ({ open: false }));

// openAddBox shows the add-a-box flow from anywhere: Settings, the sidebar,
// the command palette.
export function openAddBox() {
  prefetchTailnets(useStore.getState().client);
  useAddBox.setState({ open: true });
}

export function AddBoxDialog() {
  const open = useAddBox((s) => s.open);
  const close = () => useAddBox.setState({ open: false });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {/* Anchored at the top: steps differ in height, and a centred dialog
          would move its title with each one. */}
      <DialogPopup className="sm:max-w-xl" anchored>
        {open && (
          <Suspense>
            <AddBoxFlow
              variant="dialog"
              intro={{ title: "Add a box", description: "Any VPS or dev machine. Agents and dev servers run there; this computer only watches." }}
              lead={
                // Team setup picks or adds the box on its own page, so it is
                // offered only from the app, not from inside that page.
                useStore.getState().view.kind !== "team" ? (
                  <TeamBoxEntry
                    onPick={() => {
                      close();
                      openTeam(undefined, "addbox");
                    }}
                  />
                ) : undefined
              }
              onDone={(box) => {
                close();
                toastManager.add({ title: `${box} is ready`, description: "Paired and online. Add a repo on it to start working there.", type: "success" });
              }}
            />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
}
