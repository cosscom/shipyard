import { useEffect, useState } from "react";

import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

type State = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "unavailable" };

// ToolImage is a picture a tool call returned, read from the box's record of
// the conversation (never the file, which may be gone or changed since):
// a thumbnail that opens to its full size. One the box can't give back reads
// as the "[image]" the terminal shows.
export function ToolImage({ n, load, name }: { n: number; load: (n: number) => Promise<Blob>; name: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [full, setFull] = useState(false);
  useEffect(() => {
    let live = true;
    let url: string | undefined;
    setState({ kind: "loading" });
    load(n).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (live) setState({ kind: "ready", url });
        else URL.revokeObjectURL(url);
      },
      () => {
        if (live) setState({ kind: "unavailable" });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [load, n]);

  if (state.kind === "unavailable") return <pre className="px-3 py-2">[image]</pre>;
  if (state.kind === "loading")
    return (
      <div className="px-3 py-2">
        <span className="flex h-24 w-40 items-center justify-center rounded-md border text-muted-foreground">
          <Spinner className="size-4" />
        </span>
      </div>
    );
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        aria-label={`Open ${name} at full size`}
        onClick={() => setFull(true)}
        data-testid="tool-image"
        className="flex max-w-full overflow-hidden rounded-md border bg-[repeating-conic-gradient(color-mix(in_oklab,var(--muted)_70%,transparent)_0%_25%,transparent_0%_50%)] bg-size-[16px_16px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={state.url} alt={name} onError={() => setState({ kind: "unavailable" })} className="max-h-80 max-w-full object-contain" />
      </button>
      <Dialog open={full} onOpenChange={setFull}>
        <DialogPopup className="w-auto max-w-[92vw] p-3" data-testid="tool-image-full">
          <DialogTitle className="sr-only">{name}</DialogTitle>
          <img src={state.url} alt={name} className="max-h-[85vh] max-w-full object-contain" />
        </DialogPopup>
      </Dialog>
    </div>
  );
}
