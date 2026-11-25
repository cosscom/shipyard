import { useCallback, useEffect, useMemo, useState } from "react";

import { useEventLog } from "@/lib/events";
import { type Flow, flowsApi, type ScopedFlow, type Scope, scopeLocation } from "@/lib/flows";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";

export interface BoxFlows {
  box: string;
  flows?: ScopedFlow[];
  error?: string;
}

// useFlows loads every online box's flows, and saves one scope at a time: a
// box's own flows replace its list, and a repository's flows on this box are
// written into the location's local config. Committed flows are never
// written; overriding one adds a local flow with the same id.
export function useFlows() {
  const client = useStore((s) => s.client);
  const status = useStore((s) => s.status);
  const boxes = useMemo(() => status?.boxes.filter((b) => b.state === "online").map((b) => b.name) ?? [], [status]);
  const [byBox, setByBox] = useState<Record<string, BoxFlows>>({});

  const load = useCallback(
    async (box: string) => {
      if (!client) return;
      try {
        const flows = await flowsApi.list(client, box);
        setByBox((s) => ({ ...s, [box]: { box, flows } }));
      } catch (err) {
        setByBox((s) => ({ ...s, [box]: { box, error: errorMessage(err) } }));
      }
    },
    [client],
  );

  const key = boxes.join(",");
  useEffect(() => {
    for (const b of key.split(",").filter(Boolean)) void load(b);
  }, [key, load]);

  // What the runs-per-hour limit refused comes with no event, and drops out
  // of its hour: read it again each minute.
  useEffect(() => {
    const id = setInterval(() => {
      for (const b of key.split(",").filter(Boolean)) void load(b);
    }, 60_000);
    return () => clearInterval(id);
  }, [key, load]);

  // Another window, a box's CLI, or a flow's run changes what's there.
  const latest = useEventLog((s) => s.events.find((e) => e.type === "flows.changed" || e.type === "config.changed" || e.type === "flow.finished"));
  useEffect(() => {
    if (latest?.box) void load(latest.box);
  }, [latest, load]);

  // writeScope replaces the editable flows of one scope on one box.
  const writeScope = useCallback(
    async (box: string, scope: Scope, flows: Flow[]) => {
      if (!client) throw new Error("not connected");
      const loc = scopeLocation(scope);
      if (!loc) await flowsApi.saveBox(client, box, flows);
      else {
        const cfg = await flowsApi.config(client, box, loc);
        await flowsApi.saveConfig(client, box, loc, { ...cfg.local, flows });
      }
      await load(box);
    },
    [client, load],
  );

  const own = useCallback(
    (box: string, scope: Scope) => (byBox[box]?.flows ?? []).filter((f) => f.scope === scope && f.editable).map((f) => f.flow),
    [byBox],
  );

  // save puts flow into its scope, replacing the one it was (previousId).
  const save = useCallback(
    async (box: string, scope: Scope, flow: Flow, previousId?: string) => {
      const list = own(box, scope).filter((f) => f.id !== (previousId ?? flow.id) && f.id !== flow.id);
      const at = own(box, scope).findIndex((f) => f.id === (previousId ?? flow.id));
      list.splice(at < 0 ? list.length : at, 0, flow);
      await writeScope(box, scope, list);
    },
    [own, writeScope],
  );

  const remove = useCallback(async (box: string, scope: Scope, id: string) => writeScope(box, scope, own(box, scope).filter((f) => f.id !== id)), [own, writeScope]);

  const setEnabled = useCallback(
    async (box: string, sf: ScopedFlow, enabled: boolean) => {
      // A committed flow is switched off by a local override of it.
      await save(box, sf.scope, { ...sf.flow, enabled });
    },
    [save],
  );

  return { boxes, byBox, reload: load, save, remove, setEnabled };
}
