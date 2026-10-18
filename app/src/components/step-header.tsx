import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// StepHeader heads one step of a flow that goes a step at a time: a back
// arrow when there is a step to go back to, the step's own title, and a line
// about it. Every dialog with steps uses it (Add a box, Add a project, the
// prompt picker, broadcast and its results), and onboarding's steps, so a
// back arrow looks and sits the same everywhere.
//
// In a dialog it is the dialog's header, its title the dialog's title, and
// `aside` sits on the title's line after it (the agent a prompt goes to,
// say). On a page (onboarding) the arrow hangs in the margin left of the
// column, so a step's title starts where every other step's does.
export function StepHeader({
  title,
  description,
  onBack,
  backLabel = "Back",
  aside,
  hideDescription,
  variant = "dialog",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  aside?: ReactNode;
  // For screen readers only, where the step speaks for itself.
  hideDescription?: boolean;
  variant?: "dialog" | "page";
  className?: string;
}) {
  const back = onBack && (
    <Button type="button" size="icon-sm" variant="ghost" aria-label={backLabel} data-focus-skip="" className={variant === "page" ? "absolute top-0 -left-10 text-muted-foreground" : "-ms-1.5 -my-1 shrink-0"} onClick={onBack}>
      <ArrowLeftIcon />
    </Button>
  );
  if (variant === "page") {
    return (
      <header className={cn("relative", className)}>
        {back}
        <h1 className="text-title">{title}</h1>
        {description && <p className="mt-2 text-muted-foreground text-subtitle">{description}</p>}
      </header>
    );
  }
  return (
    <DialogHeader className={cn("gap-1.5 px-5 pt-5 pb-3", className)}>
      {/* One line, as tall as the arrow, whatever sits on it: the title
          stays put from step to step. */}
      <div className="flex h-6 min-w-0 items-center gap-2">
        {back}
        {/* The title is short and says what this is; the aside gives way. */}
        <DialogTitle className={cn("text-heading", aside ? "shrink-0" : "min-w-0 truncate")}>{title}</DialogTitle>
        {aside && <span className="flex min-w-0">{aside}</span>}
      </div>
      {description && <DialogDescription className={hideDescription ? "sr-only" : "text-desc"}>{description}</DialogDescription>}
    </DialogHeader>
  );
}
