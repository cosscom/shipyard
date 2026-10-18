import { useEffect, useRef, useState } from "react";

import { StepHeader } from "@/components/step-header";
import { Button } from "@/components/ui/button";
import type { LocalBoxStatus } from "@/lib/local-box";
import type { AddBoxStage } from "@/views/onboarding/add-box-flow";
import { UseThisMac } from "@/views/onboarding/local-box";
import { thisComputer } from "@/lib/platform";

// ThisMacStep makes this Mac the box, at once: the person chose it on the
// welcome. The log shows each step; once paired it moves on by itself, and
// a remote box is still one click away.
export function ThisMacStep({ status, onStage, onDone, onRemote, onBack }: { status: LocalBoxStatus; onStage(s: AddBoxStage): void; onDone(box: string): void; onRemote(): void; onBack(): void }) {
  const [running, setRunning] = useState(true);
  const [paired, setPaired] = useState<string>();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => onStage(paired ? "paired" : running ? "working" : "start"), [onStage, paired, running]);
  // A beat on "Paired" before moving on.
  useEffect(() => {
    if (!paired) return;
    const t = setTimeout(() => done.current(paired), 700);
    return () => clearTimeout(t);
  }, [paired]);
  return (
    <div>
      <StepHeader
        variant="page"
        title={thisComputer("Setting up this Mac")}
        description={thisComputer("Shipyard installs berthd for your user, no password needed. It listens on this Mac only, so nothing opens to your network.")}
        onBack={running ? undefined : onBack}
      />
      <UseThisMac status={status} autoStart className="mt-6" onRunning={setRunning} onPaired={setPaired} />
      <p className="mt-4 text-muted-foreground text-meta">
        Rather run agents on a server?{" "}
        <Button variant="link" size="xs" className="h-auto p-0 text-meta" disabled={running && !paired} onClick={onRemote}>
          Connect a remote box
        </Button>
      </p>
    </div>
  );
}
