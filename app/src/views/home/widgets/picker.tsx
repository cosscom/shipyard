import { CheckIcon, PlugIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import type { PluginInfo } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { SIZE_ORDER, SIZES, type WidgetSize } from "@/lib/home-layout";
import { builtinOn, setBuiltinOn, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { builtinPlugins, loadPlugins } from "@/plugins/host";

import { WidgetBoundary, WidgetHeading } from "./card";
import { GAP, HomeWidgetProvider, ROW } from "./env";
import { CATEGORIES, type WidgetDef } from "./registry";

// "Add widget": every widget there is, Shipyard's by what they're about and
// each plugin's under the plugin's name, with the one picked drawn live at
// the size chosen, and where its data comes from. Built-in plugins that are
// off but add widgets are offered too, a click from on.

export function AddWidgetDialog({ open, onOpenChange, defs, have, onAdd }: { open: boolean; onOpenChange(o: boolean): void; defs: WidgetDef[]; have: string[]; onAdd(id: string, size: WidgetSize): void }) {
  const [q, setQ] = useState("");
  const firstFree = defs.find((d) => !have.includes(d.id)) ?? defs[0];
  const [pick, setPick] = useState<string>();
  const def = defs.find((d) => d.id === pick) ?? firstFree;
  const [size, setSize] = useState<WidgetSize>(def?.sizes[0] ?? "m");
  useEffect(() => {
    if (!open) return;
    setQ("");
    setPick(undefined);
  }, [open]);
  useEffect(() => {
    if (def) setSize(def.sizes[0]);
  }, [def]);

  const match = (d: WidgetDef) => !q || `${d.title} ${d.description} ${d.plugin?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
  const groups = useMemo(() => {
    const out: { label: string; plugin?: boolean; list: WidgetDef[] }[] = [];
    for (const c of CATEGORIES) {
      const list = defs.filter((d) => !d.plugin && d.category === c && match(d));
      if (list.length) out.push({ label: c, list });
    }
    const plugins = [...new Set(defs.filter((d) => d.plugin).map((d) => d.plugin!.name))];
    for (const name of plugins) {
      const list = defs.filter((d) => d.plugin?.name === name && match(d));
      if (list.length) out.push({ label: name, plugin: true, list });
    }
    return out;
    // match reads q.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs, q]);

  if (!def) return null;
  const on = have.includes(def.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[min(620px,88vh)] max-w-[min(940px,calc(100vw-2rem))] overflow-hidden p-0" bottomStickOnMobile={false} data-testid="widget-picker">
        <div className="flex h-full min-h-0 max-[720px]:flex-col">
          <div className="flex w-[340px] shrink-0 flex-col border-r max-[720px]:h-1/2 max-[720px]:w-full max-[720px]:border-r-0 max-[720px]:border-b">
            <div className="flex flex-col gap-0.5 px-4 pt-3.5 pb-2.5">
              <DialogTitle className="text-heading">Add a widget</DialogTitle>
              <DialogDescription className="text-muted-foreground text-meta">Pick one to see it with your data.</DialogDescription>
            </div>
            <label className="mx-3 flex h-8 items-center gap-2 rounded-lg border bg-background px-2 text-body focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search widgets" aria-label="Search widgets" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
            </label>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" role="listbox" aria-label="Widgets">
              {groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.plugin ? `From the ${g.label} plugin` : g.label} className="pb-1.5">
                  <p className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-tag text-muted-foreground">
                    {g.plugin && <PlugIcon className="size-3" />}
                    {g.label}
                  </p>
                  {g.list.map((w) => (
                    <Option key={w.id} w={w} selected={w.id === def.id} on={have.includes(w.id)} onSelect={() => setPick(w.id)} onAdd={() => !have.includes(w.id) && onAdd(w.id, w.sizes[0])} />
                  ))}
                </div>
              ))}
              {!groups.length && <p className="px-3 py-6 text-center text-muted-foreground text-body">No widget matches “{q}”.</p>}
              {!q && <OffPlugins />}
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
              <Preview def={def} size={size} />
            </div>
            <div className="flex flex-col gap-3 border-t bg-popover px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-48 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 text-row">
                    {def.title}
                    {def.plugin && <span className="rounded-sm border px-1 font-normal text-tag text-muted-foreground">{def.plugin.name} plugin</span>}
                  </span>
                  <span className="text-muted-foreground text-meta">{def.description}</span>
                </div>
                {def.sizes.length > 1 && (
                  <div role="radiogroup" aria-label="Size" className="flex items-center rounded-lg border p-0.5">
                    {SIZE_ORDER.filter((s) => def.sizes.includes(s)).map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={s === size}
                        onClick={() => setSize(s)}
                        className={cn("h-6 rounded-md px-2 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring", s === size ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}
                      >
                        {SIZES[s].label}
                      </button>
                    ))}
                  </div>
                )}
                <Button size="sm" onClick={() => onAdd(def.id, size)} disabled={on} data-testid="widget-add">
                  {on ? <CheckIcon /> : <PlusIcon />}
                  {on ? "On Home" : "Add to Home"}
                </Button>
              </div>
              <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 text-meta">
                <dt className="text-muted-foreground">Data</dt>
                <dd>{def.source}</dd>
              </dl>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Option({ w, selected, on, onSelect, onAdd }: { w: WidgetDef; selected: boolean; on: boolean; onSelect(): void; onAdd(): void }) {
  const Icon = w.icon;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onAdd}
      onKeyDown={(e) => {
        if (e.key === "Enter" && selected) {
          e.preventDefault();
          onAdd();
        }
      }}
      onFocus={onSelect}
      data-testid="widget-option"
      data-widget-id={w.id}
      className={cn("flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", selected && "bg-accent")}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon className="size-3.5 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-body">
          <span className="truncate font-medium">{w.title}</span>
          {on && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-tag text-muted-foreground">
              <CheckIcon className="size-3" /> On Home
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-muted-foreground text-meta">{w.description}</span>
      </span>
    </button>
  );
}

// Preview draws the real widget at a size, scaled to fit, unclickable.
function Preview({ def, size }: { def: WidgetDef; size: WidgetSize }) {
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 520, h: 360 });
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth - 48, h: el.clientHeight - 48 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sp = SIZES[size];
  const W = sp.c * 270 + (sp.c - 1) * GAP;
  const H = sp.r * ROW + (sp.r - 1) * GAP;
  const scale = Math.max(0.2, Math.min(1, room.w / W, room.h / H));
  const Body = def.Component;
  const body = (
    <WidgetBoundary title={def.title}>
      <Body />
    </WidgetBoundary>
  );
  return (
    <div ref={ref} style={{ width: W * scale, height: H * scale }} className="pointer-events-none relative" aria-label={`Preview of ${def.title}`} role="img" inert>
      <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }} className="absolute top-0 left-0">
        <HomeWidgetProvider size={size} cols={4} visible refresh={0} preview bare={def.bare}>
        {def.bare ? (
          <div className="size-full overflow-hidden rounded-lg border">{def.wrap ? def.wrap(body) : body}</div>
        ) : (
          <section className="flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-md/5">
            <WidgetHeading def={def} />
            <div className="@container relative min-h-0 flex-1 overflow-hidden px-1 pb-1.5">{def.wrap ? def.wrap(body) : body}</div>
          </section>
        )}
        </HomeWidgetProvider>
      </div>
    </div>
  );
}

// OffPlugins: built-in plugins that are off but add widgets, to turn on.
function OffPlugins() {
  const disabledPlugins = usePrefs((p) => p.disabledPlugins);
  const enabledPlugins = usePrefs((p) => p.enabledPlugins);
  const [list, setList] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let alive = true;
    void builtinPlugins().then((all) => alive && setList(all));
    return () => {
      alive = false;
    };
  }, []);
  const off = list.filter((p) => p.homeWidgets?.length && !builtinOn(p, { disabledPlugins, enabledPlugins }));
  if (!off.length) return null;
  const turnOn = async (p: PluginInfo) => {
    const client = useStore.getState().client;
    if (!client) return;
    setBusy(p.id);
    try {
      setBuiltinOn(p, true);
      await loadPlugins(client);
    } catch (err) {
      toastManager.add({ title: `Couldn't turn on ${p.name}`, description: errorMessage(err), type: "error" });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="mt-1 border-t px-2 pt-2.5">
      <p className="pb-1.5 text-tag text-muted-foreground">More with plugins that are off</p>
      {off.map((p) => (
        <div key={p.id} className="flex items-start gap-2.5 py-1.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed">
            <PlugIcon className="size-3.5 text-muted-foreground" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body">{p.homeWidgets!.join(", ")}</span>
            <span className="text-muted-foreground text-meta">From {p.name}</span>
          </span>
          <Button size="xs" variant="outline" disabled={busy === p.id} onClick={() => void turnOn(p)}>
            Turn on
          </Button>
        </div>
      ))}
    </div>
  );
}
