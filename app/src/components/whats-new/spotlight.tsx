import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { ArrowRightIcon, ArrowUpRightIcon, ChevronLeftIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { WhatsNewArt } from "@/components/whats-new/art";
import { type Shower, showerFor, usePreloadArt } from "@/components/whats-new/show";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useArt } from "@/lib/art/model";
import { openDocs } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { closeWhatsNew } from "@/lib/whats-new";
import type { Release, WhatsNewItem } from "@/lib/whats-new-model";
import { useWorkspaces } from "@/lib/workspaces";

// The What's new card (lib/whats-new.ts): the release's highlights one at
// a time, each with a picture of it in the app and a way there, listed
// down the side so the whole release reads at a glance. After an update a
// note at the foot of the sidebar opens it (WhatsNewNudge).

// useShowers is each item's Show me as things stand; it follows the
// worktree in front and the artifacts known.
function useShowers(items: WhatsNewItem[], open: boolean): (Shower | undefined)[] {
  usePreloadArt(open);
  useArt((s) => s.byWt);
  useWorkspaces((s) => s.current);
  useStore((s) => s.boxes);
  return items.map((i) => (i.show ? showerFor(i.show) : undefined));
}

function go(s: Shower) {
  closeWhatsNew();
  // After the dialog has given the keyboard back, so what opens keeps it.
  window.setTimeout(() => s.run(), 0);
}

// Hint is what an item offers without a Show me: its keys and where.
// Beside a Show me, the keys alone.
function Hint({ item, where, className }: { item: WhatsNewItem; where: boolean; className?: string }) {
  if (!item.keys) return null;
  return (
    <span className={cn("flex items-center gap-1.5 text-muted-foreground text-xs", className)}>
      <Kbd className="text-foreground/80">{item.keys}</Kbd>
      {where && item.where}
    </span>
  );
}

// Also is the release's smaller things, a line each.
function Also({ release, className }: { release: Release; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="font-medium text-muted-foreground text-xs">Also in this release</span>
      <ul className="flex flex-col gap-1.5 text-muted-foreground text-xs leading-snug">
        {release.also.map((a) => {
          const to = a.show && showerFor(a.show);
          return (
            <li key={a.text}>
              {a.text}{" "}
              {to && (
                <button type="button" onClick={() => go(to)} className="rounded-sm text-foreground/85 underline decoration-foreground/30 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {to.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SpotlightCard({ open, release }: { open: boolean; release: Release }) {
  const items = release.items;
  const [at, setAt] = useState(0);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setAt(0);
  }, [open]);
  const showers = useShowers(items, open);
  const item = items[at];
  const s = showers[at];
  const last = at === items.length - 1;
  const step = (d: number) => setAt((n) => Math.min(items.length - 1, Math.max(0, n + d)));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeWhatsNew()}>
      <DialogPopup
        ref={popup}
        initialFocus={popup}
        className="max-w-[880px] overflow-hidden"
        showCloseButton={false}
        data-testid="whats-new"
        onKeyDown={(e) => {
          // ← and → page from anywhere in the card; ↑ and ↓ move in its list.
          if (e.defaultPrevented || e.metaKey || e.altKey || e.ctrlKey) return;
          if ((e.target as HTMLElement).closest("input, textarea")) return;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            step(e.key === "ArrowRight" ? 1 : -1);
          } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target === popup.current) {
            e.preventDefault();
            step(e.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        <TabsPrimitive.Root value={at} onValueChange={(v) => setAt(Number(v))} orientation="vertical" className="flex min-h-0">
          <div className="flex w-[248px] shrink-0 flex-col border-r bg-muted/40 max-sm:hidden">
            <DialogHeader className="gap-1 px-5 pt-5 pb-4">
              <DialogTitle className="text-base">What's new</DialogTitle>
              <DialogDescription className="font-mono text-xs">Shipyard {release.version}</DialogDescription>
            </DialogHeader>
            <TabsPrimitive.List activateOnFocus aria-label="Highlights" className="flex flex-col gap-px px-2.5">
              {items.map((it, i) => (
                <TabsPrimitive.Tab
                  key={it.id}
                  value={i}
                  className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-muted-foreground text-sm outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:bg-foreground/9 data-active:font-medium data-active:text-foreground"
                >
                  <span className="truncate">{it.title}</span>
                </TabsPrimitive.Tab>
              ))}
            </TabsPrimitive.List>
            <Also release={release} className="mt-auto px-5 pt-4 pb-6" />
          </div>
          <div className="relative flex min-w-0 flex-1 flex-col">
            <DialogClose aria-label="Close" className="absolute top-2 right-2 z-10" render={<Button size="icon" variant="ghost" />}>
              <XIcon />
            </DialogClose>
            <div className="hidden px-5 pt-5 max-sm:block">
              <span className="font-medium text-sm">What's new</span>
              <span className="ml-2 font-mono text-muted-foreground text-xs">Shipyard {release.version}</span>
            </div>
            {items.map((it, i) => (
              <TabsPrimitive.Panel key={it.id} value={i} className="flex flex-col gap-5 px-8 pt-12 pb-2 outline-none max-sm:px-5 max-sm:pt-4" aria-label={it.title}>
                <div className="overflow-hidden rounded-xl border bg-background shadow-xs">
                  <WhatsNewArt art={it.art} />
                </div>
                <div className="flex min-h-[6.75rem] flex-col gap-1.5 max-sm:min-h-0">
                  <h3 className="font-semibold text-base">{it.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{it.body}</p>
                </div>
                {/* Narrow, the list is hidden: the smaller things follow the last. */}
                {i === items.length - 1 && <Also release={release} className="hidden max-sm:flex" />}
              </TabsPrimitive.Panel>
            ))}
            <DialogFooter variant="bare" className="mx-8 mt-auto flex-row items-center justify-between gap-3 border-t px-0 pt-4 pb-6 max-sm:mx-5 max-sm:flex-row max-sm:px-0 sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                {s && (
                  <Button size="sm" onClick={() => go(s)} data-testid="whats-new-show">
                    {s.label}
                    <ArrowRightIcon />
                  </Button>
                )}
                <Hint item={item} where={!s} className="max-sm:hidden" />
                {!s && !item.keys && item.docs && (
                  <Button size="sm" variant="outline" onClick={() => void openDocs(item.docs)}>
                    Read the guide
                    <ArrowUpRightIcon />
                  </Button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="mr-1 text-muted-foreground text-xs tabular-nums" aria-hidden>
                  {at + 1} / {items.length}
                </span>
                <Button size="icon-sm" variant="ghost" aria-label="Previous" className={cn(at === 0 && "invisible")} onClick={() => step(-1)}>
                  <ChevronLeftIcon />
                </Button>
                {last ? (
                  <DialogClose render={<Button size="sm" variant="ghost" className="min-w-14" />}>Done</DialogClose>
                ) : (
                  <Button size="sm" variant="ghost" className="min-w-14" onClick={() => step(1)}>
                    Next
                  </Button>
                )}
              </div>
            </DialogFooter>
          </div>
        </TabsPrimitive.Root>
      </DialogPopup>
    </Dialog>
  );
}
