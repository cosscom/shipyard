import { toastManager } from "@/components/ui/toast";
import { type EditorId, openInEditor, SSHSetupNeeded } from "@/lib/editors";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { openSettings } from "@/views/settings/open";

// openEditor opens a worktree, or a file in it, and says what went wrong in
// a toast: most often that editors cannot reach the box over SSH yet.
export async function openEditor(req: { box: string; path?: string; location?: string; file?: string; line?: number; col?: number; editor?: EditorId }) {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    const res = await openInEditor(client, req);
    if (res.note) toastManager.add({ title: "Opened in your editor", description: res.note, type: "info" });
  } catch (err) {
    if (err instanceof SSHSetupNeeded) {
      toastManager.add({
        title: "Set up SSH for editors",
        description: `Your editor reaches boxes over SSH, as berth-${req.box}. Shipyard can write those hosts for you.`,
        type: "warning",
        actionProps: { children: "Set up", onClick: () => openSettings("boxes") },
      });
      return;
    }
    toastManager.add({ title: "Could not open the editor", description: errorMessage(err), type: "error" });
  }
}
