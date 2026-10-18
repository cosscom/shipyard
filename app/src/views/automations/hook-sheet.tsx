import { ShieldIcon, ZapIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { Hook } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { ALWAYS_ENV, catalogFor, describe, envName } from "@/views/automations/catalog";
import { LAPTOP } from "@/views/automations/use-hooks";
import { ErrorText } from "@/components/error-note";

// A valid "on": an event, a prefix like worktree.*, *, or before: one of those.
const VALID_ON = /^(before:)?(\*|[a-z][a-z0-9-]*\.(\*|[a-z][a-z0-9.-]*))$/;

export interface Editing {
  machine: string;
  // The hook's index in the machine's list; absent for a new one.
  index?: number;
  hook: Hook;
}

// HookSheet adds or edits one hook. Saving writes the machine's whole list,
// and the server's validation error, if any, is shown here.
export function HookSheet({ editing, onSave, onClose }: { editing?: Editing; onSave(e: Editing): Promise<void>; onClose(): void }) {
  const [hook, setHook] = useState<Hook>({ on: "", run: "" });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const run = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setHook(editing.hook);
      setError(undefined);
    }
  }, [editing]);

  const machine = editing?.machine ?? LAPTOP;
  const isNew = editing?.index === undefined;
  const d = describe(hook.on);
  const onValid = VALID_ON.test(hook.on);

  const insert = (raw: string) => {
    const el = run.current;
    const at = el?.selectionStart ?? hook.run.length;
    // Its own word: a space unless the cursor already follows one.
    const text = at > 0 && !/\s/.test(hook.run[at - 1]) ? ` ${raw}` : raw;
    const next = hook.run.slice(0, at) + text + hook.run.slice(el?.selectionEnd ?? at);
    setHook({ ...hook, run: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const submit = async () => {
    if (!editing) return;
    setSaving(true);
    setError(undefined);
    try {
      const clean: Hook = { on: hook.on.trim(), run: hook.run.trim() };
      if (hook.tool?.trim()) clean.tool = hook.tool.trim();
      if (hook.timeout?.trim()) clean.timeout = hook.timeout.trim();
      await onSave({ ...editing, hook: clean });
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={!!editing} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="w-[min(512px,100vw)] max-w-none">
        <SheetHeader>
          <SheetTitle>{isNew ? "New hook" : "Edit hook"}</SheetTitle>
          <SheetDescription>Runs on {machine === LAPTOP ? "this laptop" : machine}.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="space-y-5">
          <section>
            <Label>When</Label>
            <EventPicker machine={machine} value={hook.on} onChange={(on) => setHook({ ...hook, on })} />
            {hook.on && !onValid && <p className="mt-1.5 text-destructive-foreground text-meta">Use an event like agent.finished, a prefix like worktree.*, *, or before: one of those.</p>}
            {d.gate && onValid && (
              <p className="mt-1.5 flex items-start gap-1.5 text-desc text-muted-foreground">
                <ShieldIcon className="mt-0.5 size-3 shrink-0 text-warning" />A gate: it runs first, and exiting non-zero stops the action. What it prints is the reason shown.
              </p>
            )}
          </section>

          <section>
            <Label>Run</Label>
            <Textarea
              ref={run}
              value={hook.run}
              onChange={(e) => setHook({ ...hook, run: e.target.value })}
              placeholder={d.gate ? 'test "$BERTH_NAME" != main' : 'cd "$BERTH_PATH" && pnpm install'}
              rows={2}
              className="font-mono text-mono [&_textarea]:max-h-48 [&_textarea]:min-h-13"
              spellCheck={false}
            />
            <p className="mt-2 text-desc text-muted-foreground">Through /bin/sh, with the event as JSON on stdin. Click to insert:</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[...d.fields.map(envName), ...ALWAYS_ENV].map((v) => (
                <button key={v} type="button" onClick={() => insert(`"$${v}"`)} className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-tag text-muted-foreground hover:border-ring/40 hover:text-foreground">
                  ${v}
                </button>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-[8rem_1fr] gap-3">
            <div>
              <Label>Timeout</Label>
              <Input value={hook.timeout ?? ""} onChange={(e) => setHook({ ...hook, timeout: e.target.value })} placeholder={d.gate ? "30s" : "1m"} className="font-mono text-mono" />
            </div>
            <div>
              <Label>Integration (optional)</Label>
              <Input value={hook.tool ?? ""} onChange={(e) => setHook({ ...hook, tool: e.target.value })} placeholder="e.g. slack" className="font-mono text-mono" />
              <p className="mt-1 text-desc text-muted-foreground">Skips events this integration caused, so two integrations can't loop.</p>
            </div>
          </section>

          {error && <ErrorText className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive-foreground text-meta" text={error} />}
        </SheetPanel>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!onValid || !hook.run.trim() || saving} loading={saving}>
            {isNew ? "Add hook" : "Save"}
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-label">{children}</div>;
}

// EventPicker is a filterable list of what this machine can follow. Typing
// filters it, and anything that is a valid pattern can be kept as typed.
function EventPicker({ machine, value, onChange }: { machine: string; value: string; onChange(on: string): void }) {
  const [query, setQuery] = useState("");
  // Collapsed to the chosen event, so it is always visible; open to change.
  const [picking, setPicking] = useState(!value);
  const entries = useMemo(() => catalogFor(machine), [machine]);
  const pick = (on: string) => {
    onChange(on);
    setPicking(false);
    setQuery("");
  };
  if (!picking && value) {
    const d = describe(value);
    return (
      <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
        {d.gate ? <ShieldIcon className="size-3.5 shrink-0 text-warning" /> : <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body">{d.label}</span>
          <code className="block truncate font-mono text-meta text-muted-foreground">{value}</code>
        </span>
        <Button size="xs" variant="outline" onClick={() => setPicking(true)}>
          Change
        </Button>
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.on.includes(q) || e.label.toLowerCase().includes(q)) : entries;
  const custom = q && VALID_ON.test(q) && !entries.some((e) => e.on === q);

  return (
    <div className="overflow-hidden rounded-lg border">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && custom) pick(q);
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            setPicking(false);
          }
        }}
        autoFocus={!!value}
        placeholder="Search events, or type a pattern like worktree.*"
        unstyled
        className="flex w-full border-b py-0.5"
      />
      <ul className="max-h-60 overflow-y-auto py-1" role="listbox">
        {custom && (
          <Row selected={value === q} onPick={() => pick(q)} icon={<ZapIcon className="size-3.5 text-muted-foreground" />} label={describe(q).label} on={q} />
        )}
        {shown.map((e) => (
          <Row
            key={e.on}
            selected={value === e.on}
            onPick={() => pick(e.on)}
            icon={e.gate ? <ShieldIcon className="size-3.5 text-warning" /> : <ZapIcon className="size-3.5 text-muted-foreground" />}
            label={e.label}
            on={e.on}
            hint={e.hint}
          />
        ))}
        {!custom && shown.length === 0 && <li className="px-3 py-2 text-muted-foreground text-meta">Nothing matches. A valid pattern can be typed and kept with Enter.</li>}
      </ul>
    </div>
  );
}

function Row({ selected, onPick, icon, label, on, hint }: { selected: boolean; onPick(): void; icon: React.ReactNode; label: string; on: string; hint?: string }) {
  return (
    <li>
      <button type="button" role="option" aria-selected={selected} onClick={onPick} className={cn("flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent", selected && "bg-accent")}>
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body">{label}</span>
          {hint && <span className="block truncate text-muted-foreground text-meta">{hint}</span>}
        </span>
        <code className="shrink-0 font-mono text-tag text-muted-foreground">{on}</code>
      </button>
    </li>
  );
}
