import { Children, cloneElement, createContext, Fragment, isValidElement, type ReactElement, type ReactNode, useContext, useId } from "react";

import { platformKeys } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { SettingsFind } from "@/views/settings/find";

// The pieces every settings section is made of: a titled page, groups of
// rows, and rows of label, description and control. Rows sit on the page,
// split by hairlines, with every control in one lane along the right.

// badge sits beside the title (the Linux app's Alpha, in About); actions sit
// beside "Find a setting".
export function SettingsPage({ title, badge, description, actions, children }: { title: string; badge?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[728px] px-6 pt-14 pb-20 max-[1200px]:pt-10">
      <header data-tauri-drag-region className="mb-10 flex items-end gap-4">
        <div data-tauri-drag-region className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-page-title">
            {title}
            {badge}
          </h1>
          {description && <p className="mt-1.5 text-muted-foreground text-subtitle">{typeof description === "string" ? platformKeys(description) : description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        <SettingsFind />
      </header>
      <div className="space-y-10">{children}</div>
    </div>
  );
}

export function SettingsGroup({ title, description, actions, children }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {(title || actions) && (
        <div className="mb-1.5 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-section text-foreground">{title}</h2>}
            {description && <p className="mt-0.5 text-muted-foreground text-desc">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="divide-y divide-border/60 border-border/60 border-b">{children}</div>
    </section>
  );
}

// A row's label and description name its control: a switch reads "Play a
// sound, on", not just "switch". SettingsRow passes the ids to each control
// it holds; a control that can't take them as props (a stepper's input, say)
// reads them with useSettingsRow.
const RowContext = createContext<{ labelledBy: string; describedBy?: string } | null>(null);
export const useSettingsRow = () => useContext(RowContext);

type AriaProps = { "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string; children?: ReactNode };

// hasText is whether a control names itself, as a button with words does.
function hasText(children: ReactNode): boolean {
  return Children.toArray(children).some((c) => typeof c === "string" || typeof c === "number");
}

function nameControl(child: ReactNode, labelledBy: string, describedBy?: string): ReactNode {
  // Plain elements and fragments are layout, not controls: the controls
  // inside them read the ids from context.
  if (!isValidElement<AriaProps>(child) || typeof child.type === "string" || child.type === Fragment) return child;
  const props = child.props;
  const next: AriaProps = {};
  if (!props["aria-label"] && !props["aria-labelledby"] && !hasText(props.children)) next["aria-labelledby"] = labelledBy;
  if (describedBy && !props["aria-describedby"]) next["aria-describedby"] = describedBy;
  return Object.keys(next).length ? cloneElement(child as ReactElement<AriaProps>, next) : child;
}

export function SettingsRow({ label, description, children, className }: { label: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  const labelledBy = `${id}-label`;
  const describedBy = description ? `${id}-description` : undefined;
  return (
    <div className={cn("flex min-h-14 items-center gap-8 py-4", className)}>
      <div className="min-w-0 flex-1">
        <div id={labelledBy} className="text-row">
          {label}
        </div>
        {description && (
          <div id={describedBy} className="mt-[3px] text-desc text-muted-foreground">
            {typeof description === "string" ? platformKeys(description) : description}
          </div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2">
          <RowContext.Provider value={{ labelledBy, describedBy }}>{Children.map(children, (c) => nameControl(c, labelledBy, describedBy))}</RowContext.Provider>
        </div>
      )}
    </div>
  );
}

// Code is a path or a command inside a description.
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-px font-mono text-tag text-foreground">{children}</code>;
}

// Value shows a setting that is read, not edited here, as a quiet chip.
export function Value({ children }: { children: ReactNode }) {
  return <span className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-muted-foreground text-mono tabular-nums">{children}</span>;
}
