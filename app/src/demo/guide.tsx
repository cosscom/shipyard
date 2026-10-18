import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";
import { resetDemo, startDemoScript } from "@/demo/script";

// The live demo's guide: three things to try, ticked off as you do them,
// and a way to start over. It sits bottom left, clear of the toasts, and
// folds down to one small button.

const CHECKOUT_FIX = "devl:/home/me/work/shop-checkout-fix";
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

interface Steps {
  open: boolean;
  answer: boolean;
  palette: boolean;
}

const useSteps = create<Steps>(() => ({ open: false, answer: false, palette: false }));

// Ticks each step off for good the first time it happens.
function follow() {
  let waiting = new Set<string>();
  const seen = () => {
    const s = useStore.getState();
    const now = new Set<string>();
    for (const [box, data] of Object.entries(s.boxes)) {
      for (const x of data.sessions ?? []) {
        const k = `${box}/${x.name}`;
        if (x.agent_state === "waiting") now.add(k);
        else if (waiting.has(k)) useSteps.setState({ answer: true });
      }
    }
    waiting = now;
    if (s.paletteOpen) useSteps.setState({ palette: true });
    const ws = useWorkspaces.getState();
    if (s.view.kind === "workspace" && ws.current === CHECKOUT_FIX) useSteps.setState({ open: true });
  };
  const a = useStore.subscribe(seen);
  const b = useWorkspaces.subscribe(seen);
  return () => {
    a();
    b();
  };
}

// ?shots=1 is the website's poster (site/scripts/capture.mjs): the demo as
// it opens, without the guide or the script.
const shots = new URLSearchParams(location.search).has("shots");

export default function DemoGuide() {
  const steps = useSteps();
  const [folded, setFolded] = useState(false);
  const connected = useStore((s) => !!s.client);
  useEffect(() => {
    if (connected) startDemoScript(shots);
  }, [connected]);
  useEffect(follow, []);
  const done = steps.open && steps.answer && steps.palette;
  if (shots) return null;

  if (folded) {
    return (
      <div className="fixed bottom-[38px] left-3 z-40">
        <Button size="xs" variant="outline" onClick={() => setFolded(false)} className="shadow-md">
          Demo guide
        </Button>
      </div>
    );
  }

  return (
    <section aria-labelledby="demo-guide-title" className="fixed bottom-[38px] left-3 z-40 w-[17rem] rounded-lg border bg-popover text-popover-foreground shadow-lg/5">
      <header className="flex items-start gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="demo-guide-title" className="font-medium text-desc">
            {done ? "That's the tour" : "Try the demo"}
          </h2>
          <p className="text-meta text-muted-foreground">Invented boxes and repositories; nothing runs.</p>
        </div>
        <Tip label="Fold the guide">
          <Button size="icon-xs" variant="ghost" aria-label="Fold the guide" onClick={() => setFolded(true)} className="-mt-0.5 -mr-1.5 text-muted-foreground">
            <XIcon />
          </Button>
        </Tip>
      </header>
      <ol className="mt-2 space-y-1 px-3 text-meta">
        <Step done={steps.open}>
          Open <span className="font-mono text-mono">checkout-fix</span>
        </Step>
        <Step done={steps.answer}>Answer the waiting agent</Step>
        <Step done={steps.palette}>
          Press{" "}
          <Kbd className="h-4.5 min-w-4.5 text-tag">
            {mac ? "⌘" : "Ctrl"} K
          </Kbd>{" "}
          for every command
        </Step>
      </ol>
      <footer className="mt-2.5 flex items-center justify-between gap-2 border-t px-1.5 py-1">
        <Button size="xs" variant="ghost" onClick={resetDemo} className="text-muted-foreground">
          <RotateCcwIcon />
          Reset demo
        </Button>
        {done && (
          <Button size="xs" variant="ghost" render={<a href="../#start" target="_top" />}>
            Get started
          </Button>
        )}
      </footer>
    </section>
  );
}

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors", done ? "border-foreground/70 bg-foreground/90 text-background" : "border-border")}>
        {done && <CheckIcon className="size-2.5" strokeWidth={3} />}
      </span>
      <span className={cn("min-w-0", done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{children}</span>
      <span className="sr-only">{done ? "(done)" : ""}</span>
    </li>
  );
}
