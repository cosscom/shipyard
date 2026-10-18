import { BellIcon, ChevronDownIcon, PackageIcon, PlusIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { load, save } from "@/lib/storage";
import { STARTERS, type Starter } from "@/views/automations/catalog";
import { EventsPanel, EventsRail } from "@/views/automations/events-panel";
import { type Editing, HookSheet } from "@/views/automations/hook-sheet";
import { HooksTable } from "@/views/automations/hooks-table";
import { LAPTOP, useHooks } from "@/views/automations/use-hooks";

const starterIcons: Record<string, typeof BellIcon> = { notify: BellIcon, deps: PackageIcon, "no-main": ShieldIcon };

const machineLabel = (m: string) => (m === LAPTOP ? "This laptop" : m);
// In a sentence: "on this laptop", "on devl".
const machineInProse = (m: string) => (m === LAPTOP ? "this laptop" : m);

// ShellHooks edits the raw hooks on this laptop and every online box: a
// table per machine, an editor in a side sheet, and the live event stream
// beside them for finding the event to hook. Flows cover most automations;
// these are for anything a shell command does better.
export function ShellHooks() {
  const { machines, byMachine, save: saveHooks } = useHooks();
  const [editing, setEditing] = useState<Editing>();
  const [deleting, setDeleting] = useState<{ machine: string; index: number }>();
  // Under 1280px the events panel starts collapsed to a rail.
  const [showEvents, setShowEvents] = useState(() => load("berth.automations.events", window.innerWidth >= 1280));
  const boxes = machines.filter((m) => m !== LAPTOP);

  const toggleEvents = (on: boolean) => {
    setShowEvents(on);
    save("berth.automations.events", on);
  };

  // write puts one hook into its machine's list (or takes it out) and saves
  // the whole list; a server refusal surfaces in the sheet.
  const write = async (machine: string, index: number | undefined, hook?: Editing["hook"]) => {
    const list = [...(byMachine[machine]?.file?.hooks ?? [])];
    if (index === undefined) list.push(hook!);
    else if (hook) list[index] = hook;
    else list.splice(index, 1);
    await saveHooks(machine, list);
  };

  const add = (machine: string, hook = { on: "", run: "" }) => setEditing({ machine, hook });
  const startFrom = (s: Starter, machine: string) => add(machine, { ...s.hook });

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-6 pt-1 pb-3">
          <p className="min-w-0 flex-1 text-muted-foreground text-body">Shell commands that run when an event happens. Gates run before an action and can stop it.</p>
          <MachineMenu machines={machines} onPick={(m) => add(m)}>
            <PlusIcon />
            New hook
            <ChevronDownIcon className="opacity-60" />
          </MachineMenu>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pt-3 pb-10">
          <section>
            <h2 className="mb-2 text-section">Start from</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
              {STARTERS.map((s) => {
                const Icon = starterIcons[s.id] ?? PlusIcon;
                const card = (
                  <>
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-row">{s.title}</span>
                      <span className="block text-desc text-muted-foreground">
                        {s.description} {s.where === "laptop" ? "On this laptop." : "On a box."}
                      </span>
                    </span>
                  </>
                );
                const cls = "flex h-full min-h-16 w-full items-start gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:border-ring/40 disabled:opacity-50";
                if (s.where === "laptop") {
                  return (
                    <button key={s.id} type="button" className={cls} onClick={() => startFrom(s, LAPTOP)}>
                      {card}
                    </button>
                  );
                }
                if (boxes.length === 1) {
                  return (
                    <button key={s.id} type="button" className={cls} onClick={() => startFrom(s, boxes[0])}>
                      {card}
                    </button>
                  );
                }
                return (
                  <Menu key={s.id}>
                    <MenuTrigger disabled={boxes.length === 0} render={<button type="button" className={cls} />}>
                      {card}
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuGroup>
                        <MenuGroupLabel>Which box?</MenuGroupLabel>
                        {boxes.map((b) => (
                          <MenuItem key={b} onClick={() => startFrom(s, b)}>
                            {b}
                          </MenuItem>
                        ))}
                      </MenuGroup>
                    </MenuPopup>
                  </Menu>
                );
              })}
            </div>
          </section>

          {machines.map((m) => (
            <HooksTable
              key={m}
              label={machineLabel(m)}
              data={byMachine[m] ?? { machine: m, loading: true }}
              onAdd={() => add(m)}
              onEdit={(index) => setEditing({ machine: m, index, hook: byMachine[m]!.file!.hooks[index] })}
              onDelete={(index) => setDeleting({ machine: m, index })}
            />
          ))}
        </div>
      </div>

      {showEvents ? (
        <EventsPanel
          onClose={() => toggleEvents(false)}
          onNewHook={(e) => add(e.box ?? LAPTOP, { on: e.type, run: "" })}
        />
      ) : (
        <EventsRail onOpen={() => toggleEvents(true)} />
      )}

      <HookSheet editing={editing} onClose={() => setEditing(undefined)} onSave={(e) => write(e.machine, e.index, e.hook)} />
      <DeleteHook
        target={deleting}
        hook={deleting && byMachine[deleting.machine]?.file?.hooks[deleting.index]}
        onClose={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (deleting) await write(deleting.machine, deleting.index);
          setDeleting(undefined);
        }}
      />
    </div>
  );
}

function MachineMenu({ machines, onPick, children }: { machines: string[]; onPick(m: string): void; children: React.ReactNode }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" />}>{children}</MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Run it on</MenuGroupLabel>
          {machines.map((m) => (
            <MenuItem key={m} onClick={() => onPick(m)}>
              {machineLabel(m)}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function DeleteHook({ target, hook, onClose, onConfirm }: { target?: { machine: string }; hook?: { on: string; run: string }; onClose(): void; onConfirm(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this hook?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops running on {target && machineInProse(target.machine)} straight away.
            {hook && <code className="mt-2 block truncate rounded-md bg-muted px-2 py-1 font-mono text-mono">{`${hook.on} → ${hook.run}`}</code>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
