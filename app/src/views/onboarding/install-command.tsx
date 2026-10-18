import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// The one line that installs berthd on a box (site/install.sh, served at
// berthd.app/install): it installs for the user who runs it, starts the
// service, and prints a pairing link.
export const INSTALL_COMMAND = "curl -fsSL https://berthd.app/install | sh";

// InstallCommand shows the line to run on the box, with a copy button.
export function InstallCommand({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!navigator.clipboard) {
      toastManager.add({ type: "error", title: "Could not copy", description: "Select the line and copy it instead." });
      return;
    }
    navigator.clipboard.writeText(INSTALL_COMMAND).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toastManager.add({ type: "error", title: "Could not copy", description: "Select the line and copy it instead." }),
    );
  };
  return (
    <div className={cn("flex h-10 items-center gap-2.5 rounded-lg border bg-muted/40 ps-3 pe-1 dark:bg-input/16", className)}>
      <span aria-hidden className="select-none font-mono text-mono text-muted-foreground">
        $
      </span>
      <code className="min-w-0 flex-1 select-all truncate font-mono text-mono">{INSTALL_COMMAND}</code>
      <Button type="button" size="xs" variant="ghost" className="shrink-0 text-muted-foreground" onClick={copy} aria-label="Copy the install command">
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
