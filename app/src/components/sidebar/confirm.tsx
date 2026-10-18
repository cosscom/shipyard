import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { plainError } from "@/lib/errors";
import { ErrorText } from "@/components/error-note";

// confirm asks before something that cannot be undone, from anywhere (a
// menu item has no room for its own dialog). Options become checkboxes, and
// run gets their values. If run throws, the dialog stays open with the
// error, so the person can change an option and try again.

export interface ConfirmOption {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
}

export interface ConfirmRequest {
  title: string;
  description: ReactNode;
  // The thing it acts on, shown on its own line: a path, a branch.
  detail?: ReactNode;
  confirm: string;
  destructive?: boolean;
  options?: ConfirmOption[];
  // The shortcut that opened it confirms it when pressed again (⌘W). Off
  // for anything that removes data.
  repeatConfirms?: boolean;
  // A text field, for asking a name: its value goes to run.
  input?: { label: string; initial?: string; placeholder?: string };
  // A second way through, beside the confirm button ("Keep running").
  secondary?: { label: string; run(checked: Record<string, boolean>): Promise<void> | void };
  run(checked: Record<string, boolean>, value: string): Promise<void> | void;
}

const useConfirm = create<{ req?: ConfirmRequest; submit: number }>()(() => ({ submit: 0 }));

// submitConfirm presses the open dialog's confirm button, for a shortcut
// that confirms when pressed again (⌘W). False when none is open.
export function submitConfirm(): boolean {
  if (!useConfirm.getState().req?.repeatConfirms) return false;
  useConfirm.setState((s) => ({ submit: s.submit + 1 }));
  return true;
}

export function confirm(req: ConfirmRequest) {
  useConfirm.setState({ req });
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  return <AlertDialog open={!!req} onOpenChange={(o) => !o && useConfirm.setState({ req: undefined })}>{req && <Body key={req.title} req={req} />}</AlertDialog>;
}

function Body({ req }: { req: ConfirmRequest }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [value, setValue] = useState(req.input?.initial ?? "");
  const button = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const second = useRef<HTMLButtonElement>(null);
  // Where the keyboard starts: the field when it asks for one; the safe way
  // out when it destroys something (the secondary, "Keep running", else
  // Cancel), so Enter right after it opens never destroys; else confirm.
  // A shortcut that confirms when pressed again (⌘W) is a deliberate second
  // press, and still works through submit below.
  const start = req.input ? undefined : req.destructive ? (req.secondary ? second : cancel) : button;
  const submit = useConfirm((s) => s.submit);
  const first = useRef(submit);
  useEffect(() => {
    if (submit !== first.current) button.current?.click();
  }, [submit]);
  return (
    <AlertDialogPopup initialFocus={start ?? true}>
      <AlertDialogHeader>
        <AlertDialogTitle>{req.title}</AlertDialogTitle>
        <AlertDialogDescription>{req.description}</AlertDialogDescription>
      </AlertDialogHeader>
      {(req.detail || req.options?.length || error || req.input) && (
        <div className="flex flex-col gap-3 px-6 pb-2 text-body">
          {req.input && (
            <label className="flex flex-col gap-1.5">
              <span className="text-label">{req.input.label}</span>
              <Input
                autoFocus
                value={value}
                placeholder={req.input.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && button.current?.click()}
              />
            </label>
          )}
          {req.detail && <div className="rounded-md bg-muted/60 px-3 py-2 font-mono text-mono">{req.detail}</div>}
          {req.options?.map((o) => (
            <label key={o.id} className="flex items-start gap-2.5">
              <Checkbox className="mt-0.5" checked={!!checked[o.id]} onCheckedChange={(v) => setChecked((c) => ({ ...c, [o.id]: !!v }))} />
              <span>
                {o.label}
                {o.hint && <span className="block text-muted-foreground text-meta">{o.hint}</span>}
              </span>
            </label>
          ))}
          {error && <ErrorText className="text-destructive-foreground text-meta" text={error} />}
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogClose ref={cancel} render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
        {req.secondary && (
          <Button
            ref={second}
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setError(undefined);
              try {
                await req.secondary!.run(checked);
                useConfirm.setState({ req: undefined });
              } catch (err) {
                setError(plainError(err));
              }
            }}
          >
            {req.secondary.label}
          </Button>
        )}
        <Button
          ref={button}
          disabled={!!req.input && !value.trim()}
          variant={req.destructive ? "destructive" : "default"}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await req.run(checked, value);
              useConfirm.setState({ req: undefined });
            } catch (err) {
              setError(plainError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {req.confirm}
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}

export function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text);
  toastManager.add({ title: `Copied the ${what}`, description: text, type: "success" });
}
