import { HouseIcon, PlusIcon } from "lucide-react";
import { Fragment } from "react";

import { openHomeTerminal } from "@/components/box-picker";
import { Tip } from "@/components/tip";
import { PaneActions } from "@/components/workspace/pane";
import { TabButton } from "@/components/workspace/tab-strip";
import { closeTab } from "@/lib/actions";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { activateTab, goHome, homeBox, showHome, tabBeside, unsplitTab, useWorkspaces } from "@/lib/workspaces";
import { platformKeys } from "@/lib/platform";

// HomeTabs is the strip over Home: the terminals open in boxes' homes
// (lib/box-home.ts), each box's after a chip that names it ("devl · ~"),
// with Home itself first. They are tabs like a worktree's, in the same
// panes; closing the last one goes back to plain Home. With none, it is the
// plain strip Home always had.
export function HomeTabs() {
  const current = useWorkspaces((s) => s.current);
  const spaces = useWorkspaces((s) => s.spaces);
  const homes = Object.keys(spaces)
    .filter((k) => homeBox(k) && spaces[k].tabs.length)
    .sort();
  const front = homeBox(current) ? spaces[current!] : undefined;
  const active = front?.tabs.find((t) => t.id === front.active);
  const lone = active && active.root.kind === "leaf" ? active.root : undefined;
  const onHome = !front;

  return (
    <div data-tauri-drag-region data-tab-bar className="flex h-bar shrink-0 items-stretch">
      {homes.length > 0 && (
        <div data-tauri-drag-region data-tab-strip role="tablist" aria-label="Home tabs" className="flex min-w-0 items-center gap-1 overflow-x-auto px-1.5 [scrollbar-width:none]">
          <Tip label="Home" side="bottom">
            <div
              role="tab"
              aria-label="Home"
              aria-selected={onHome}
              tabIndex={onHome ? 0 : -1}
              data-home-tab
              onClick={goHome}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  goHome();
                }
              }}
              className={cn(
                "flex h-6.5 w-8 shrink-0 cursor-default items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                onHome ? "bg-foreground/9 text-foreground shadow-xs/5 ring-1 ring-foreground/6 ring-inset" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              <HouseIcon className="size-3.5" />
            </div>
          </Tip>
          {homes.map((key) => {
            const ws = spaces[key];
            return (
              <Fragment key={key}>
                <BoxHomeChip box={homeBox(key)!} />
                {ws.tabs.map((t) => (
                  <TabButton
                    key={t.id}
                    tab={t}
                    wsKey={key}
                    active={key === current && t.id === ws.active}
                    onActivate={() => {
                      showHome(key);
                      activateTab(key, t.id);
                    }}
                    onClose={() => void closeTab(key, t.id)}
                    // Home's tabs stay on Home: no dragging them into a worktree's.
                    onDrag={() => {}}
                    onSplit={ws.tabs.length > 1 ? (dir) => tabBeside(key, t.id, dir) : undefined}
                    onUnsplit={() => unsplitTab(key, t.id)}
                  />
                ))}
              </Fragment>
            );
          })}
        </div>
      )}
      {homes.length > 0 && (
        <div className="flex shrink-0 items-center">
          <NewHomeTerminal box={homeBox(current) ?? homeBox(homes[homes.length - 1])!} />
        </div>
      )}
      <div data-tauri-drag-region className="min-w-4 flex-1" />
      {current && active && lone && (
        <div className="flex shrink-0 items-center gap-1 pr-1.5 pl-3">
          <PaneActions wsKey={current} tab={active.id} pane={lone} />
        </div>
      )}
    </div>
  );
}

// BoxHomeChip names the box the terminals after it run on, in its home.
function BoxHomeChip({ box }: { box: string }) {
  const home = useStore((s) => (s.boxes[box]?.info as { home?: string } | undefined)?.home);
  return (
    <Tip label={`Terminals in ${box}'s home folder${home ? `, ${home}` : ""}. They belong to no worktree.`} side="bottom">
      <span data-tauri-drag-region data-home-box={box} className="flex shrink-0 items-center pl-1">
        <span className="rounded bg-foreground/6 px-1.5 py-px font-mono text-tag text-muted-foreground">{box} · ~</span>
      </span>
    </Tip>
  );
}

// NewHomeTerminal opens another terminal in the same box's home.
function NewHomeTerminal({ box }: { box: string }) {
  return (
    <Tip
      label={
        <span className="flex items-center gap-2">
          New terminal on {box}
          <span className="text-muted-foreground">{platformKeys("⌘T")}</span>
        </span>
      }
      side="bottom"
    >
      <button
        type="button"
        aria-label={`New terminal on ${box}`}
        onClick={() => void openHomeTerminal(box)}
        className="inline-flex size-6.5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon className="size-4" />
      </button>
    </Tip>
  );
}
