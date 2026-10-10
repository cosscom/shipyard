import { Suspense } from "react";

import { Dialog, DialogPopup } from "@/components/ui/dialog";
import { lazyView } from "@/lib/lazy-view";
import { useStore } from "@/lib/store";

// AddProjectDialog's frame (components/add-project/add-project-dialog.tsx
// is what it does): its content loads after the app has started.
const AddProjectBody = lazyView(() => import("@/components/add-project/add-project-dialog").then((m) => m.AddProjectBody));

export function AddProjectDialog() {
  const draft = useStore((s) => s.locationDraft);
  return (
    <Dialog open={!!draft} onOpenChange={(open) => !open && useStore.getState().closeAddLocation()}>
      {/* Anchored at the top, as New worktree is: Browse and the box's
          states differ in height, and a centred dialog would move its title. */}
      <DialogPopup anchored className="sm:max-w-[38rem]" showCloseButton={false}>
        <Suspense>{draft && <AddProjectBody key={draft.box ?? ""} startBox={draft.box} />}</Suspense>
      </DialogPopup>
    </Dialog>
  );
}

export { AddProjectDialog as AddLocationDialog };
