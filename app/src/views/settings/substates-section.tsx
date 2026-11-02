import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import type { BoxInfo } from "@/lib/api";
import { ago, errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { SUB_STATE_DESCRIPTION_MAX, SUB_STATE_MAX, SUB_STATE_NAME_MAX, SUB_STATES_CAPABILITY, type SubState, type SubStateSet, subStatesApi } from "@/lib/substates";
import { keepSubStateSet, useSubStateSet } from "@/lib/substates-sync";
import { turnCheckApi } from "@/lib/turncheck";
import { SettingsGroup } from "@/views/settings/rows";

// The sub-states of Needs you: a preset, an editor, and what each box makes
// of it. An edit goes to one box, which stamps it, and the app spreads it.
export function SubStatesSection({ boxes }: { boxes: string[] }) {
  const client = useStore((s) => s.client);
  const infos = useStore((s) => s.boxes);
  const set = useSubStateSet();
  const canTake = (b: string) => !!(infos[b]?.info as BoxInfo | undefined)?.capabilities?.includes(SUB_STATES_CAPABILITY);
  const capable = boxes.filter(canTake);
  const known = boxes.filter((b) => infos[b]?.info);
  const outdated = known.filter((b) => !canTake(b));
  const [draft, setDraft] = useState<SubState[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [turnCheckOff, setTurnCheckOff] = useState<string[]>([]);
  const states = draft ?? set?.states ?? [];
  const on = !!set?.states.length;
  const capableKey = capable.join("\n");

  // Sorting takes turn check: where it is off, every card is "not sorted".
  useEffect(() => {
    if (!client || !on) return setTurnCheckOff([]);
    let live = true;
    Promise.all(capable.map((b) => turnCheckApi.get(client, b).then((st) => (st.enabled ? undefined : b), () => undefined))).then((off) => {
      if (live) setTurnCheckOff(off.filter((b): b is string => !!b));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new array each render; its names are what matter.
  }, [client, on, capableKey]);

  async function apply(call: (box: string) => Promise<SubStateSet>) {
    const box = capable[0];
    if (!box) return;
    setBusy(true);
    try {
      keepSubStateSet(box, await call(box));
      setDraft(undefined);
    } catch (err) {
      toastManager.add({ type: "error", title: "Sub-states", description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  const patch = (i: number, p: Partial<SubState>) => setDraft(states.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, by: number) => {
    const next = [...states];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    setDraft(next);
  };
  const complete = states.every((s) => s.name.trim() && s.description.trim());

  return (
    <SettingsGroup
      title="Needs you columns"
      description="Split Needs you on the Agent Dashboard into columns of your own. Turn check places a waiting agent by each column's description, and whatever it can't place goes in the first with a small “not sorted” tag. With turn check on, a question form's text also goes to its provider, with anything like a secret taken out."
    >
      <div data-testid="substates" className="flex flex-col gap-3 py-4">
        {!capable.length && <p className="text-desc text-muted-foreground">{known.length ? "No box here can keep these yet: update berthd." : "Waiting for a box."}</p>}
        {states.map((s, i) => (
          <div key={s.id || `new-${i}`} data-testid="substate-row" className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Input aria-label={`Name of column ${i + 1}`} value={s.name} maxLength={SUB_STATE_NAME_MAX} placeholder="Name" onChange={(e) => patch(i, { name: e.target.value })} />
              <Textarea aria-label={`Description of column ${i + 1}`} value={s.description} maxLength={SUB_STATE_DESCRIPTION_MAX} placeholder="What it means, for turn check to place an agent by" onChange={(e) => patch(i, { description: e.target.value })} />
              {i === 0 && <p className="text-meta text-muted-foreground">The default: what can't be placed goes here.</p>}
            </div>
            <Tip label="Move up">
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${s.name || "column"} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUpIcon />
              </Button>
            </Tip>
            <Tip label="Move down">
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${s.name || "column"} down`} disabled={i === states.length - 1} onClick={() => move(i, 1)}>
                <ArrowDownIcon />
              </Button>
            </Tip>
            <Tip label="Remove: its agents go to the first column">
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${s.name || "column"}`} onClick={() => setDraft(states.filter((_, j) => j !== i))}>
                <Trash2Icon />
              </Button>
            </Tip>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {!on && !draft && (
            <Button size="xs" disabled={busy || !capable.length || !client} onClick={() => client && apply((b) => subStatesApi.preset(client, b))}>
              Use Needs a decision and Needs you to act
            </Button>
          )}
          <Button size="xs" variant="outline" disabled={busy || !capable.length || states.length >= SUB_STATE_MAX} onClick={() => setDraft([...states, { id: "", name: "", description: "" }])}>
            <PlusIcon />
            Add a column
          </Button>
          {draft && (
            <>
              <Button size="xs" disabled={busy || !complete || !client} onClick={() => client && apply((b) => subStatesApi.edit(client, b, states))}>
                Save
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
            </>
          )}
        </div>
        {turnCheckOff.length > 0 && (
          <p data-testid="substates-turncheck-off" className="text-desc text-warning-foreground">
            Turn check is off on {turnCheckOff.join(", ")}, so agents there show in the first column as not sorted.
          </p>
        )}
        {outdated.length > 0 && (
          <p data-testid="substates-outdated" className="text-desc text-muted-foreground">
            {outdated.join(", ")} {outdated.length === 1 ? "runs" : "run"} an older berthd, which can't take these: its agents show in the first column as not sorted until you update it.
          </p>
        )}
        {set?.change && (
          <p data-testid="substates-changed" className="text-meta text-muted-foreground">
            Last change: {set.change}, by {set.changed_by}
            {set.changed_at && `, ${ago(set.changed_at)}`}.
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
