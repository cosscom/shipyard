import { CheckIcon, GripVerticalIcon, LayoutGridIcon, MoveDiagonal2Icon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { add, columnsFor, LAYOUT_VERSION, move, moveToward, type Placed, readLayout, remove, resize, SIZE_ORDER, SIZES, snapSize, stepSize, type WidgetSize } from "@/lib/home-layout";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { scrollBehavior } from "@/lib/motion";
import { usePluginsLoading } from "@/plugins/registry";

import { useOnScreen, WidgetBoundary, WidgetHeading, WidgetMenu } from "./card";
import { GAP, HomeWidgetProvider, ROW } from "./env";
import { AddWidgetDialog } from "./picker";
import { sizeFor, useWidgets, type WidgetDef } from "./registry";

// Home's grid of widgets, under the composer. Four columns, two in a
// narrower window and one in a narrow one (container queries, so the
// first paint is already right). The layout is the person's (Prefs.home,
// lib/home-layout.ts), read before the first paint, and every cell's size
// is fixed by its widget's size, so nothing moves while widgets load.
//
// Customize turns each card's heading into a handle: drag it to move the
// widget, or focus it and use the arrow keys; [ and ] change its size,
// Delete removes it, Escape leaves. The corner resizes it with a pointer.

// Each size's cells, as Tailwind classes (written out so they're built).
const SPAN: Record<WidgetSize, string> = {
  s: "col-span-1 row-span-1",
  m: "col-span-2 row-span-1 @max-[480px]:col-span-1",
  t: "col-span-1 row-span-2",
  l: "col-span-2 row-span-2 @max-[480px]:col-span-1",
  w: "col-span-4 row-span-1 @max-[800px]:col-span-2 @max-[480px]:col-span-1",
};

type Dir = "left" | "right" | "up" | "down";
const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function HomeGrid({ className }: { className?: string }) {
  const saved = usePrefs((p) => p.home);
  const items = useMemo(() => readLayout(saved).items, [saved]);
  const latest = useRef(items);
  latest.current = items;
  const setItems = useCallback((next: Placed[]) => setPrefs({ home: { version: LAYOUT_VERSION, items: next } }), []);

  const defs = useWidgets();
  const byId = useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);
  const pluginsLoading = usePluginsLoading();
  const [edit, setEdit] = useState(false);
  const [picker, setPicker] = useState(false);
  const [drag, setDrag] = useState<string>();
  const [refresh, setRefresh] = useState<Record<string, number>>({});
  const [said, say] = useState("");

  // Columns as drawn, for the keyboard's up and down and each body's span.
  const wrap = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setCols(columnsFor(el.clientWidth));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A plugin's widget keeps its place while plugins load; once they have,
  // one whose plugin is off is kept in the layout but drawn only in
  // Customize, to be removed.
  const pending = (id: string) => !byId.has(id) && pluginsLoading && id.includes("/");
  const drawn = items.filter((p) => byId.has(p.id) || pending(p.id) || edit);
  const drawable = items.filter((p) => byId.has(p.id));

  const handles = useRef(new Map<string, HTMLElement>());
  const focusHandle = (id: string | undefined) => requestAnimationFrame(() => id && handles.current.get(id)?.focus());
  const titleOf = (id: string) => byId.get(id)?.title ?? "Widget";
  const position = (list: Placed[], id: string) => `${list.findIndex((p) => p.id === id) + 1} of ${list.length}`;

  const onKey = (id: string, e: KeyboardEvent) => {
    const now = latest.current;
    const p = now.find((x) => x.id === id);
    if (!p) return;
    const def = byId.get(id);
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const next = moveToward(now, id, dir, cols);
      setItems(next);
      say(`${titleOf(id)}, ${position(next, id)}`);
      focusHandle(id);
    } else if ((e.key === "[" || e.key === "]" || e.key === "-" || e.key === "=" || e.key === "+") && def) {
      e.preventDefault();
      const size = stepSize(def.sizes, sizeFor(def, p.size), e.key === "[" || e.key === "-" ? -1 : 1);
      setItems(resize(now, id, size));
      say(`${titleOf(id)}, ${SIZES[size].label.toLowerCase()}, ${SIZES[size].c} by ${SIZES[size].r}`);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const i = now.findIndex((x) => x.id === id);
      const next = remove(now, id);
      setItems(next);
      say(`${titleOf(id)} removed`);
      focusHandle(next[Math.min(i, next.length - 1)]?.id);
    }
  };

  // Dragging a heading moves its widget into the place of whichever one
  // the pointer is over; Escape puts everything back.
  const dragging = useRef<{ id: string; x: number; y: number; from: Placed[]; over?: string; moved: boolean }>(undefined);
  const onPointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    dragging.current = { id, x: e.clientX, y: e.clientY, from: latest.current, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragging.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDrag(d.id);
    }
    const over = (document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-widget]") as HTMLElement | null)?.dataset.widget;
    if (!over || over === d.id || over === d.over) return;
    d.over = over;
    setItems(move(latest.current, d.id, over));
  };
  const endDrag = () => {
    const d = dragging.current;
    dragging.current = undefined;
    setDrag(undefined);
    if (d?.moved) say(`${titleOf(d.id)}, ${position(latest.current, d.id)}`);
  };
  useEffect(() => {
    if (!drag) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !dragging.current) return;
      e.stopPropagation();
      setItems(dragging.current.from);
      dragging.current = undefined;
      setDrag(undefined);
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [drag, setItems]);

  // Escape leaves Customize (unless a menu or dialog has it).
  useEffect(() => {
    if (!edit || picker) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[data-slot=menu-popup]")) setEdit(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [edit, picker]);

  const reset = () => {
    setPrefs({ home: null });
    say("Home is back to the default widgets");
  };

  return (
    <section aria-label="Your widgets" data-testid="home-grid" data-editing={edit || undefined} className={cn("w-full", className)}>
      <div className="mb-2.5 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5">
        {edit ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-section">Customize Home</h2>
              <p id="home-grid-hint" className="text-desc text-muted-foreground">
                Drag a heading to move a widget, or focus it and use the arrow keys. <kbd className="font-mono">[</kbd> <kbd className="font-mono">]</kbd> resize, Delete removes. Saved as you go.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={reset}>
              <RotateCcwIcon />
              Reset
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPicker(true)}>
              <PlusIcon />
              Add widget
            </Button>
            <Button size="sm" onClick={() => setEdit(false)}>
              <CheckIcon />
              Done
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEdit(true)} data-testid="home-customize">
              <LayoutGridIcon />
              Customize
            </Button>
          </>
        )}
      </div>
      <div ref={wrap} className="@container">
        {drawn.length === 0 ? (
          <EmptyGrid onAdd={() => setPicker(true)} onReset={reset} />
        ) : (
          <div role="list" aria-label="Home widgets" className="grid grid-flow-row-dense grid-cols-4 @max-[480px]:grid-cols-1 @max-[800px]:grid-cols-2" style={{ gridAutoRows: ROW, gap: GAP }}>
            {drawn.map((p) => {
              const def = byId.get(p.id);
              if (!def)
                return pending(p.id) ? <PendingCell key={p.id} p={p} /> : <OffCell key={p.id} p={p} onRemove={() => setItems(remove(latest.current, p.id))} />;
              return (
                <Cell
                  key={p.id}
                  def={def}
                  size={sizeFor(def, p.size)}
                  cols={cols}
                  edit={edit}
                  dragging={drag === p.id}
                  refresh={refresh[p.id] ?? 0}
                  handleRef={(el) => (el ? handles.current.set(p.id, el) : handles.current.delete(p.id))}
                  onKeyDown={(e) => onKey(p.id, e)}
                  onPointerDown={(e) => onPointerDown(p.id, e)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onSize={(s) => {
                    setItems(resize(latest.current, p.id, s));
                    say(`${def.title}, ${SIZES[s].label.toLowerCase()}`);
                  }}
                  onRemove={() => {
                    setItems(remove(latest.current, p.id));
                    say(`${def.title} removed`);
                  }}
                  onRefresh={() => setRefresh((r) => ({ ...r, [p.id]: (r[p.id] ?? 0) + 1 }))}
                  onCustomize={() => setEdit(true)}
                />
              );
            })}
            {edit && (
              <button
                type="button"
                onClick={() => setPicker(true)}
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-muted-foreground text-body outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PlusIcon className="size-4" />
                Add widget
              </button>
            )}
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <AddWidgetDialog
        open={picker}
        onOpenChange={setPicker}
        defs={defs}
        have={drawable.map((p) => p.id)}
        onAdd={(id, size) => {
          setItems(add(latest.current, id, size));
          setPicker(false);
          say(`${titleOf(id)} added`);
          // Show where it went.
          requestAnimationFrame(() => document.querySelector(`[data-widget="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }));
        }}
      />
    </section>
  );
}

interface CellProps {
  def: WidgetDef;
  size: WidgetSize;
  cols: number;
  edit: boolean;
  dragging: boolean;
  refresh: number;
  handleRef(el: HTMLElement | null): void;
  onKeyDown(e: KeyboardEvent): void;
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onSize(s: WidgetSize): void;
  onRemove(): void;
  onRefresh(): void;
  onCustomize(): void;
}

function Cell({ def, size, cols, edit, dragging, refresh, handleRef, onKeyDown, onPointerDown, onPointerMove, onPointerUp, onSize, onRemove, onRefresh, onCustomize }: CellProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const onScreen = useOnScreen(el);
  const headingId = `w-${def.id.replace(/[^a-z0-9-]/gi, "-")}`;
  const Body = def.Component;
  const body = (
    <WidgetBoundary title={def.title}>
      <Body />
    </WidgetBoundary>
  );
  const content = def.wrap ? def.wrap(body) : body;

  // The corner snaps to the nearest size this widget takes.
  const startResize = (e: ReactPointerEvent) => {
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const sp = SIZES[size];
    const col = (r.width + GAP) / Math.min(sp.c, cols);
    let current = size;
    const onMove = (m: PointerEvent) => {
      const c = Math.max(1, Math.min(cols, Math.round((m.clientX - r.left + GAP) / col)));
      const rr = Math.max(1, Math.round((m.clientY - r.top + GAP) / (ROW + GAP)));
      const best = snapSize(def.sizes, c, rr, current);
      if (best !== current) {
        current = best;
        onSize(best);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={setEl} role="listitem" data-widget={def.id} data-size={size} className={cn("relative min-h-0 min-w-0", SPAN[size])}>
      <HomeWidgetProvider size={size} cols={cols} visible={onScreen} refresh={refresh} bare={def.bare && !edit}>
      {def.bare && !edit ? (
        <section aria-label={def.title} className="group/w relative size-full overflow-hidden rounded-lg border">
          {content}
          <WidgetMenu def={def} size={size} onSize={onSize} onRefresh={onRefresh} onRemove={onRemove} onCustomize={onCustomize} className="absolute top-1.5 right-1.5 z-10 bg-background/80 backdrop-blur-sm" />
        </section>
      ) : (
        <section
          aria-labelledby={headingId}
          className={cn(
            "group/w relative flex size-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs/5",
            edit && "border-dashed",
            dragging && "opacity-40 ring-2 ring-ring",
          )}
        >
          {edit ? (
            <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-1">
              <button
                ref={handleRef}
                type="button"
                aria-label={`Move ${def.title}`}
                aria-describedby="home-grid-hint"
                aria-roledescription="movable widget"
                data-testid="widget-handle"
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="flex h-7 min-w-0 flex-1 cursor-grab touch-none items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              >
                <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span id={headingId} className="truncate text-section">
                  {def.title}
                </span>
              </button>
              <SizeChips def={def} size={size} onSize={onSize} />
              <Tip label={`Remove ${def.title}`}>
                <button
                  type="button"
                  aria-label={`Remove ${def.title}`}
                  onClick={onRemove}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3.5" />
                </button>
              </Tip>
            </div>
          ) : (
            <WidgetHeading def={def} id={headingId} actions={<WidgetMenu def={def} size={size} onSize={onSize} onRefresh={onRefresh} onRemove={onRemove} onCustomize={onCustomize} />} />
          )}
          <div className={cn("@container relative min-h-0 flex-1 overflow-hidden px-1 pb-1.5", edit && "pointer-events-none select-none", def.bare && edit && "mx-1.5 mb-1.5 rounded-md px-0 pb-0")} inert={edit || undefined}>
            {content}
          </div>
          {edit && def.sizes.length > 1 && (
            <span
              aria-hidden
              onPointerDown={startResize}
              className="absolute right-1 bottom-1 z-10 flex size-5 cursor-se-resize touch-none items-center justify-center rounded-md border bg-popover text-muted-foreground shadow-xs hover:text-foreground"
            >
              <MoveDiagonal2Icon className="size-3" />
            </span>
          )}
        </section>
      )}
      </HomeWidgetProvider>
    </div>
  );
}

function SizeChips({ def, size, onSize }: { def: WidgetDef; size: WidgetSize; onSize(s: WidgetSize): void }) {
  if (def.sizes.length < 2) return null;
  return (
    <div role="group" aria-label={`${def.title} size`} className="flex shrink-0 items-center rounded-md border bg-background p-0.5 @max-[200px]:hidden">
      {SIZE_ORDER.filter((s) => def.sizes.includes(s)).map((s) => (
        <Tip key={s} label={`${SIZES[s].label}, ${SIZES[s].c}×${SIZES[s].r}`}>
          <button
            type="button"
            aria-pressed={s === size}
            aria-label={`${SIZES[s].label}, ${SIZES[s].c} by ${SIZES[s].r}`}
            onClick={() => onSize(s)}
            className={cn(
              "h-5 min-w-6 rounded-[5px] px-1 font-mono text-tag tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
              s === size ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {s.toUpperCase()}
          </button>
        </Tip>
      ))}
    </div>
  );
}

// A plugin's widget while plugins load: its cell, so nothing moves.
function PendingCell({ p }: { p: Placed }) {
  return (
    <div role="listitem" data-widget={p.id} className={cn("relative min-h-0 min-w-0", SPAN[p.size] ?? SPAN.m)}>
      <div className="flex size-full flex-col gap-3 rounded-lg border bg-card p-3" role="status" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// A widget whose plugin is off, in Customize: it comes back when the
// plugin does, or can be removed.
function OffCell({ p, onRemove }: { p: Placed; onRemove(): void }) {
  const plugin = p.id.includes("/") ? p.id.split("/")[0] : undefined;
  return (
    <div role="listitem" data-widget={p.id} className={cn("relative min-h-0 min-w-0", SPAN[p.size] ?? SPAN.m)}>
      <div className="flex size-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-3 text-center text-muted-foreground text-meta">
        <p className="text-foreground text-row">{plugin ? "Its plugin is off" : "Not available"}</p>
        <p className="font-mono text-tag">{p.id}</p>
        <p className="text-balance">{plugin ? `Turn ${plugin} on in Settings → Plugins and it comes back here.` : "This version of Shipyard has no such widget."}</p>
        <Button size="xs" variant="outline" className="mt-1" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function EmptyGrid({ onAdd, onReset }: { onAdd(): void; onReset(): void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <Scene name="dock" width={150} className="text-muted-foreground" />
      <h3 className="mt-1 text-row">No widgets on Home</h3>
      <p className="max-w-sm text-balance text-muted-foreground text-body">Put what you check first here: agents that need you, pull requests, how your boxes are doing.</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onAdd}>
          <PlusIcon />
          Add a widget
        </Button>
        <Button size="sm" variant="outline" onClick={onReset}>
          <RotateCcwIcon />
          Restore the default
        </Button>
      </div>
    </div>
  );
}

