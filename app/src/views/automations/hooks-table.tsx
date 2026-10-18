import { LaptopIcon, LockIcon, PlusIcon, ServerIcon, ShieldIcon, Trash2Icon, ZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Hook } from "@/lib/api";
import { cn } from "@/lib/utils";
import { describe } from "@/views/automations/catalog";
import { LAPTOP, type MachineHooks } from "@/views/automations/use-hooks";
import { Tip } from "@/components/tip";
import { ErrorText } from "@/components/error-note";
import { BoxError } from "@/components/upgrade-box";

// HooksTable is one machine's hooks: when each runs, what it runs, and
// anything else about it. Rows stack into cards when the table is narrow.
export function HooksTable({ data, label, onAdd, onEdit, onDelete }: { data: MachineHooks; label: string; onAdd(): void; onEdit(index: number): void; onDelete(index: number): void }) {
  const hooks = data.file?.hooks ?? [];
  const MachineIcon = data.machine === LAPTOP ? LaptopIcon : ServerIcon;

  return (
    <section className="@container overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-2.5 border-b px-4 py-2.5">
        <MachineIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-section">{label}</h2>
        {data.file?.path && <code className="hidden min-w-0 truncate font-mono text-meta text-muted-foreground @md:block">{data.file.path}</code>}
        <span className="ml-auto" />
        <Button size="xs" variant="ghost" onClick={onAdd} disabled={!data.file}>
          <PlusIcon />
          Add
        </Button>
      </header>

      {data.error ? (
        data.machine === LAPTOP ? (
          <ErrorText className="px-4 py-3 text-muted-foreground text-meta" text={`Couldn't read this computer's hooks. ${data.error}`} />
        ) : (
          <BoxError className="mx-4 my-3" box={data.machine} error={data.error} what="its hooks" />
        )
      ) : !data.file ? (
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : hooks.length === 0 ? (
        <button type="button" onClick={onAdd} className="flex w-full items-center gap-2 px-4 py-3 text-left text-muted-foreground text-body hover:bg-accent/40">
          <PlusIcon className="size-3.5" />
          No hooks yet. Add one, or start from a template above.
        </button>
      ) : (
        <div role="list" className="divide-y divide-border/70">
          {hooks.map((h, i) => (
            <HookRow key={`${h.on}-${i}`} hook={h} onEdit={() => onEdit(i)} onDelete={() => onDelete(i)} />
          ))}
        </div>
      )}
    </section>
  );
}

function HookRow({ hook, onEdit, onDelete }: { hook: Hook; onEdit(): void; onDelete(): void }) {
  const d = describe(hook.on);
  const plugin = hook.source?.startsWith("plugin:") ? hook.source.slice("plugin:".length) : undefined;
  const meta = [hook.timeout && <Chip key="t" mono>{hook.timeout}</Chip>, hook.tool && <Chip key="i">{hook.tool}</Chip>].filter(Boolean);

  return (
    <div
      role="listitem"
      tabIndex={plugin ? undefined : 0}
      onClick={plugin ? undefined : onEdit}
      onKeyDown={(e) => !plugin && e.key === "Enter" && e.target === e.currentTarget && onEdit()}
      aria-label={plugin ? undefined : `Edit hook: ${d.label}`}
      className={cn(
        "group grid grid-cols-1 gap-x-3 gap-y-1.5 px-4 py-row-pad outline-none @2xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] @2xl:items-center",
        !plugin && "cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {d.gate ? <ShieldIcon className="size-3.5 shrink-0 text-warning" /> : <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate text-row">{d.label}</span>
        </div>
        <code className="mt-0.5 block truncate pl-5 font-mono text-meta text-muted-foreground">{hook.on}</code>
      </div>
      <code className="block min-w-0 truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-mono" title={hook.run}>
        {hook.run}
      </code>
      <div className="flex items-center justify-end gap-1.5">
        {meta}
        {plugin && (
          <Chip title="Change it by changing the plugin">
            <LockIcon className="size-2.5" />
            {plugin}
          </Chip>
        )}
        {!plugin && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Delete hook"
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

function Chip({ children, mono, title }: { children: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <Tip label={title}>
      <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-tag text-muted-foreground", mono && "font-mono")}>{children}</span>
    </Tip>
  );
}
