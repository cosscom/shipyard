import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { isOverridden, type Scope, type ScopedFlow } from "@/lib/flows";
import { useProjects } from "@/lib/project-groups";
import { rescueFocus } from "@/lib/focus-home";
import { load, save } from "@/lib/storage";
import { NONE, useStore, type View } from "@/lib/store";
import { ViewHeader } from "@/views/view-header";
import { type EditTarget, FlowEditor } from "@/views/automations/flows/flow-editor";
import { FlowList } from "@/views/automations/flows/flow-list";
import { blankFlow, type Starter } from "@/views/automations/flows/model";
import { defaultScope } from "@/views/automations/flows/project-label";
import { RunsTab } from "@/views/automations/flows/runs-tab";
import { useFlows } from "@/views/automations/flows/use-flows";
import { useRuns } from "@/views/automations/flows/use-runs";
import { ShellHooks } from "@/views/automations/shell-hooks";

type Tab = "flows" | "runs" | "hooks";

// AutomationsView is what runs on its own: flows (a trigger and steps, per
// box or per repository), their runs, and, for anything a flow can't do,
// raw shell hooks.
export function AutomationsView() {
  const view = useStore((s) => s.view);
  const boxesData = useStore((s) => s.boxes);
  const { boxes, byBox, save: saveFlow, remove, setEnabled } = useFlows();
  const { runs, lastRun: lastRunOn } = useRuns(boxes);
  const { projects } = useProjects();
  const [tab, setTab] = useState<Tab>(() => load("berth.automations.tab", "flows"));
  const [editing, setEditing] = useState<EditTarget>();

  // Every place a new flow can live: each box, and each repo on it. A flow
  // for a project on every box is committed to the repository's
  // .berth/config.json (or its kit), which each box runs from.
  const scopes = useMemo(
    () => boxes.flatMap((box) => [{ box, scope: "box" as Scope }, ...(boxesData[box]?.locations ?? NONE).map((l) => ({ box, scope: `repo:${l.name}` }))]),
    [boxes, boxesData],
  );

  const lastRun = (box: string, scope: string, id: string) => lastRunOn(box, scope, id);

  const open = (box: string, f: ScopedFlow) =>
    setEditing({ box, scope: f.scope, flow: f.flow, savedId: f.flow.id, readOnly: !f.editable, source: f.source, rate: { refused_last_hour: f.refused_last_hour, last_refused_at: f.last_refused_at, fires_per_hour: f.fires_per_hour } });
  const create = (box: string, scope: Scope, starter?: Starter) => setEditing({ box, scope, flow: structuredClone(starter?.flow ?? blankFlow()) });
  // A new flow starts on the project open in the sidebar; "Runs for" in the
  // editor changes it.
  const createHere = (starter?: Starter) => {
    const at = defaultScope();
    if (at) create(at.box, at.scope, starter);
  };

  // Another page (Project settings) can ask for a flow, or a new one.
  const request = view.kind === "automations" ? view.open : undefined;
  const settled = useRef<View>(view);
  const settle = () => {
    const v: View = { kind: "automations" };
    settled.current = v;
    useStore.getState().setView(v);
  };
  useEffect(() => {
    if (!request) return;
    if (!request.id) {
      create(request.box, request.scope);
      settle();
      return;
    }
    // The flow that runs: an override, not the committed or kit flow it replaces.
    const all = byBox[request.box]?.flows ?? [];
    const f = all.find((x) => x.scope === request.scope && x.flow.id === request.id && !isOverridden(x, all));
    if (f) {
      open(request.box, f);
      settle();
    }
  }, [request, byBox]);

  // Automations in the sidebar, clicked again, leaves the editor for the list.
  useEffect(() => {
    if (view === settled.current || (view.kind === "automations" && view.open)) return;
    settled.current = view;
    if (view.kind === "automations") setEditing(undefined);
  }, [view]);

  const closeEditor = () => {
    setEditing(undefined);
    // Its back button is gone: the keyboard goes to the list's tabs.
    rescueFocus();
  };

  const pickTab = (t: Tab) => {
    setTab(t);
    save("berth.automations.tab", t);
  };

  if (editing) {
    return (
      <FlowEditor
        key={`${editing.box}|${editing.scope}|${editing.savedId ?? "new"}|${editing.readOnly ? "ro" : "rw"}`}
        target={editing}
        scopes={scopes}
        onClose={closeEditor}
        onSave={async (box, scope, flow, previousId) => {
          // Saved where it goes, then taken out of where it was.
          const moved = !!editing.savedId && (box !== editing.box || scope !== editing.scope);
          await saveFlow(box, scope, flow, moved ? undefined : previousId);
          if (moved) await remove(editing.box, editing.scope, editing.savedId!);
        }}
        onDelete={editing.savedId ? () => remove(editing.box, editing.scope, editing.savedId!) : undefined}
        onOverride={editing.readOnly ? () => setEditing({ ...editing, readOnly: false, savedId: undefined }) : undefined}
      />
    );
  }

  const nameOf = (box: string, scope: string, id: string) => byBox[box]?.flows?.find((f) => f.scope === scope && f.flow.id === id)?.flow.name ?? id;

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Automations"
        description="Steps that run on a box when something happens there."
        actions={
          tab !== "hooks" && (
            <Button size="sm" disabled={!scopes.length} onClick={() => createHere()}>
              <PlusIcon />
              New flow
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => pickTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b px-page">
          <TabsList variant="underline" className="-mb-px">
            <TabsTab value="flows" data-focus-home="">
              Flows
            </TabsTab>
            <TabsTab value="runs">
              Runs
              {runs.some((r) => r.status === "running") && <span className="ml-1.5 size-1.5 animate-pulse rounded-full bg-primary" />}
            </TabsTab>
            <TabsTab value="hooks">Advanced: shell hooks</TabsTab>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "flows" && (
            <div className="h-full overflow-y-auto px-page pt-5 pb-12">
              <FlowList boxes={boxes} byBox={byBox} projects={projects} lastRun={lastRun} onEdit={open} onToggle={(box, f, on) => void setEnabled(box, f, on)} onNew={create} onStarter={(st) => createHere(st)} />
            </div>
          )}
          {tab === "runs" && (
            <div className="h-full overflow-y-auto px-page pt-5 pb-12">
              <RunsTab runs={runs} boxes={boxes} names={nameOf} />
            </div>
          )}
          {tab === "hooks" && (
            <div className="h-full pt-4">
              <ShellHooks />
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
