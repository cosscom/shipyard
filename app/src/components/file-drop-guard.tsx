import { PaperclipIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// FileDropGuard keeps a file dropped where nothing takes it from replacing
// the app. The window gets the browser's own drag and drop (tauri.conf's
// dragDropEnabled is false, so the sidebar, tabs and Home widgets can drag),
// and a file let fall on a page that doesn't take it is opened in its place:
// the whole window becomes that markdown file or image, with no way back.
//
// Places that take files (a chat's or a task's composer, a terminal)
// accept the drag first, by preventing its default. What reaches the
// window unaccepted is refused here: no drop, and a hint says where a file
// goes. Only drags that carry files are touched, so the app's own drags
// (a project, a tab, a widget) go on as they were.

const carriesFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

// dragover comes every 50 ms or so while a drag is over the window; when it
// stops coming, the drag has left or ended.
const QUIET_MS = 200;

export function FileDropGuard() {
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    let quiet = 0;
    const hideSoon = () => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => setRefused(false), QUIET_MS);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      hideSoon();
      // Taken by what is under it.
      if (e.defaultPrevented) {
        setRefused(false);
        return;
      }
      e.preventDefault();
      e.dataTransfer!.dropEffect = "none";
      setRefused(true);
    };
    const onDrop = (e: DragEvent) => {
      window.clearTimeout(quiet);
      setRefused(false);
      // A drop that nothing handled never opens the file.
      if (carriesFiles(e) && !e.defaultPrevented) e.preventDefault();
    };
    const onEnd = () => {
      window.clearTimeout(quiet);
      setRefused(false);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.clearTimeout(quiet);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onEnd);
    };
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="file-drop-hint"
      data-shown={refused || undefined}
      className={cn(
        "pointer-events-none fixed bottom-[calc(var(--berth-status-h,26px)+20px)] left-1/2 z-80 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover py-2 ps-3 pe-4 text-popover-foreground text-body shadow-xl/20",
        "invisible translate-y-1 opacity-0 transition-[opacity,translate,visibility] duration-150 ease-out data-shown:visible data-shown:translate-y-0 data-shown:opacity-100",
      )}
    >
      <PaperclipIcon className="size-4 shrink-0 text-muted-foreground" />
      <span>Drop on a message box or a terminal to attach</span>
    </div>
  );
}
