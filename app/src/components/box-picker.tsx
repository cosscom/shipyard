import { HouseIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { StatusDot, useBoxState } from "@/components/agent-glyph";
import { boxLoad } from "@/components/sidebar/box-load";
import { toastManager } from "@/components/ui/toast";
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandFooter, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { startSession } from "@/lib/actions";
import { closeBoxPicker, lastHomeBox, openBoxPicker, pickableBoxes, rememberHomeBox, useBoxPicker } from "@/lib/box-home";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { here, homeKey } from "@/lib/workspaces";

// openHomeTerminal opens a terminal in box's home folder, as a tab over
// Home, and makes box the default next time.
export function openHomeTerminal(box: string) {
  rememberHomeBox(box);
  return startSession("", { kind: "tab" }, "Terminal", homeKey(box));
}

// newTerminal is ⌘T and "New terminal": in the worktree you are acting in
// (or the box whose home terminal has focus), as always; with neither, in a
// box's home, asking which box unless only one is online.
export function newTerminal() {
  if (here()) return void startSession("");
  const status = useStore.getState().status;
  const online = status?.boxes.filter((b) => b.state === "online") ?? [];
  if (online.length === 1) return void openHomeTerminal(online[0].name);
  // Before the boxes are known the picker opens anyway, and fills in.
  if (status && !status.boxes.length) {
    toastManager.add({ title: "No boxes yet", description: "Add a box to open a terminal on it." });
    return;
  }
  openBoxPicker();
}

interface Item {
  box: string;
  detail: string;
  blocked?: string;
  last: boolean;
}

// BoxPicker asks which box a new terminal opens on, when no worktree is in
// focus: every box with its state and load, the last one picked first (and
// highlighted, so ↵ opens it). A box that can't is listed, disabled, with
// why.
export function BoxPicker() {
  const open = useBoxPicker((s) => s.open);
  const status = useStore((s) => s.status);
  const boxes = useStore((s) => s.boxes);
  const [query, setQuery] = useState("");

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const last = lastHomeBox();
    return pickableBoxes(status?.boxes ?? []).map(({ box, blocked }) => ({
      box: box.name,
      last: box.name === last && !blocked,
      blocked,
      detail: blocked ? reason(blocked) : [box.latency_ms !== undefined ? `${box.latency_ms} ms` : "", boxLoad(box.name)].filter(Boolean).join(" · "),
    }));
    // boxes: the load and capabilities pickableBoxes reads.
  }, [open, status, boxes]);
  const groups = [{ value: "boxes", items }];

  const close = () => {
    closeBoxPicker();
    setQuery("");
  };
  const pick = (box: string) => {
    close();
    void openHomeTerminal(box);
  };

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && close()}>
      <CommandDialogPopup aria-label="New terminal on a box">
        <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => (i as Item).box}>
          <CommandInput placeholder="New terminal on…" />
          <CommandPanel>
            <CommandEmpty>No box matches.</CommandEmpty>
            <CommandList>
              {(group: (typeof groups)[number]) => (
                <CommandGroup key={group.value} items={group.items}>
                  <CommandGroupLabel>Boxes</CommandGroupLabel>
                  <CommandCollection>
                    {(item: Item) => (
                      <CommandItem key={item.box} value={item} disabled={!!item.blocked} data-box={item.box} className="gap-2" onClick={() => pick(item.box)}>
                        <BoxDot box={item.box} />
                        <span className="truncate font-medium">{item.box}</span>
                        {item.last && <span className="shrink-0 rounded bg-accent px-1 py-px text-tag text-muted-foreground">last used</span>}
                        <span className={cn("ml-auto min-w-0 shrink truncate text-meta tabular-nums", item.blocked ? "text-muted-foreground" : "text-muted-foreground/80")}>{item.detail}</span>
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="text-tag text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open a terminal in its home
            </span>
            <span className="flex items-center gap-1">
              <HouseIcon className="size-3" /> It opens on Home, in <span className="font-mono">~</span> <Kbd>esc</Kbd>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

// reason is why a box can't, in the list's few words.
function reason(blocked: string): string {
  if (blocked.endsWith("older berthd")) return "older berthd · update it first";
  if (blocked.endsWith("offline")) return "offline";
  if (blocked.endsWith("connecting")) return "connecting…";
  return blocked;
}

function BoxDot({ box }: { box: string }) {
  const state = useBoxState(box);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <StatusDot state={state} className="size-2" />
    </span>
  );
}
