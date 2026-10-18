import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { type BoxRoute, type BoxStatus, laptopApi } from "@/lib/api";
import { canTurnOff, routeSummary, routeWords } from "@/lib/box-routes";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// BoxRoutes is how this computer reaches a box: its paired address, SSH,
// other addresses. Shipyard sends new requests over the fastest one that
// works; this line says which, and opens BoxRouteList, where the person
// adds routes or turns them off.
export function BoxRoutes({ box, open, onOpenChange }: { box: BoxStatus; open: boolean; onOpenChange(open: boolean): void }) {
  const routes = box.routes ?? [];
  if (box.local || routes.length === 0) return null;
  const summary = routes.length > 1 ? routeSummary(box) : "";
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-tag text-muted-foreground" data-testid="box-routes">
      <button type="button" className="flex shrink-0 items-center gap-0.5 hover:text-foreground" onClick={() => onOpenChange(!open)} aria-expanded={open} data-testid="box-routes-toggle">
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        Routes
      </button>
      {summary && (
        <span className="truncate" data-testid="box-routes-summary">
          {summary}
        </span>
      )}
    </div>
  );
}

async function change(what: string, call: () => Promise<unknown>) {
  try {
    await call();
  } catch (err) {
    toastManager.add({ title: `Couldn't ${what}`, description: errorMessage(err), type: "error" });
  } finally {
    await useStore.getState().refreshStatus();
  }
}

export function BoxRouteList({ box }: { box: BoxStatus }) {
  const routes = box.routes ?? [];
  const client = useStore((s) => s.client);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  if (!client) return null;
  const add = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    // host:port is an address; anything else is an SSH host as ssh takes it.
    const route = /^[^@\s]+:\d+$/.test(v) ? ({ kind: "direct", address: v } as const) : ({ kind: "ssh", host: v } as const);
    await change("add the route", () => laptopApi.addRoute(client, box.name, route));
    setBusy(false);
    setValue("");
    setAdding(false);
  };
  return (
    <div className="mt-3 rounded-lg border" data-testid="box-route-list">
      {routes.map((r) => (
        <RouteRow key={r.id} box={box} route={r} />
      ))}
      <div className="border-t px-3 py-2">
        {adding ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Input
              size="sm"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="An SSH host (alex@devl) or an address (192.168.1.20:7444)"
              aria-label="SSH host or address"
              data-testid="box-route-add-input"
              className="font-mono text-mono"
            />
            <Button size="xs" type="submit" loading={busy} disabled={!value.trim()} data-testid="box-route-add">
              Add
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-tag text-muted-foreground">
              New requests take the fastest route that works. Every route checks the box's pinned key; SSH uses your own ssh and keys.
            </p>
            <Button size="xs" variant="ghost" onClick={() => setAdding(true)} data-testid="box-route-new">
              <PlusIcon /> Add a route
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function RouteRow({ box, route: r }: { box: BoxStatus; route: BoxRoute }) {
  const client = useStore((s) => s.client);
  const on = r.state !== "off";
  const removable = r.id !== "paired" && !r.suggested;
  const words = r.suggested ? "in ~/.ssh/config" : routeWords(r);
  const toggle = (next: boolean) => {
    if (!client) return;
    void change(next ? "turn the route on" : "turn the route off", () =>
      r.suggested && next ? laptopApi.addRoute(client, box.name, { kind: "ssh", host: r.detail ?? box.name }) : laptopApi.setRoute(client, box.name, r.id, next),
    );
  };
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-meta" data-testid={`box-route-${r.id}`}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          r.state === "up" ? "bg-success" : r.state === "down" || r.state === "stalled" ? "bg-destructive" : "bg-muted-foreground/40",
        )}
      />
      <span className="shrink-0">{r.label}</span>
      {r.detail && <span className="min-w-0 truncate font-mono text-tag text-muted-foreground">{r.detail}</span>}
      <span className="flex-1" />
      {r.active && <span className="shrink-0 rounded border px-1 text-tag text-muted-foreground">in use</span>}
      {r.error && r.state !== "up" ? (
        <Tip label={r.error}>
          <span className="shrink-0 text-muted-foreground tabular-nums">{words}</span>
        </Tip>
      ) : (
        <span className="shrink-0 text-muted-foreground tabular-nums">{words}</span>
      )}
      <Switch
        checked={on}
        disabled={on && !canTurnOff(box, r.id)}
        onCheckedChange={toggle}
        aria-label={`${r.label}${r.detail ? ` (${r.detail})` : ""}: ${on ? "on" : "off"}`}
      />
      {removable ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${r.label} ${r.detail ?? ""}`.trim()}
          onClick={() => client && void change("remove the route", () => laptopApi.removeRoute(client, box.name, r.id))}
        >
          <XIcon />
        </Button>
      ) : (
        <span className="size-6 shrink-0" />
      )}
    </div>
  );
}
