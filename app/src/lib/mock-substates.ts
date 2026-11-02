import type { Session } from "@/lib/api";
import type { SubState, SubStateSet } from "@/lib/substates";

// Sub-states in demo mode: none until you turn them on, kept per box, and
// only on a box whose berthd can (gpu runs an older one). As on a box, a
// stamped set is kept only if newer, and removing all leaves a set with none.

const held: Record<string, SubStateSet> = {};
const fresh = (box: string) => (held[box] ??= { states: [] });

const PRESET: SubState[] = [
  { id: "decision", name: "Needs a decision", description: "The agent needs the person to clarify, give direction, approve, or choose how to approach something. What the person does next is answer.", parent: "waiting" },
  { id: "act", name: "Needs you to act", description: "The agent needs the person to do a task it can't do itself, such as fetching a credential from another service or changing something in a UI it can't reach. What the person does next is that task, then say it's done.", parent: "waiting" },
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function keep(box: string, states: SubState[], change: string, emit: (type: string, data: Record<string, unknown>) => void): SubStateSet {
  const cur = fresh(box);
  const next: SubStateSet = {
    states: states.map((s) => ({ ...s, id: s.id || slug(s.name), parent: "waiting" })),
    revision: Math.max(Date.now(), (cur.revision ?? 0) + 1),
    stamp: Math.random().toString(16).slice(2, 14),
    changed_by: "laptop:demo",
    change,
    changed_at: new Date().toISOString(),
  };
  held[box] = next;
  emit("substates.changed", { revision: next.revision, change, changed_by: next.changed_by, count: next.states.length });
  return next;
}

export function subStatesCall(box: string, method: string, path: string, body: unknown, emit: (type: string, data: Record<string, unknown>) => void, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  if (path !== "substates" && path !== "substates/preset") return undefined;
  if (box === "gpu") return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
  if (method === "GET" && path === "substates") return delay(fresh(box));
  if (method === "POST" && path === "substates/preset") return delay(keep(box, PRESET, "turned on the preset", emit));
  if (method === "PUT") {
    const req = body as SubStateSet;
    if (!req.revision) return delay(keep(box, req.states, req.states.length ? "edited the sub-states" : "removed all sub-states", emit));
    const cur = fresh(box);
    if (req.revision > (cur.revision ?? 0) || (req.revision === cur.revision && (req.stamp ?? "") > (cur.stamp ?? ""))) {
      held[box] = req;
      emit("substates.changed", { revision: req.revision, change: req.change, changed_by: req.changed_by, count: req.states.length });
    }
    return delay(held[box]);
  }
  return undefined;
}

export const subStatesEdit = (box: string) => ({ substates_revision: held[box]?.revision, substates_stamp: held[box]?.stamp });

// mockSubStated is a box's sessions as its berthd answers with a set: the
// checkout agent was placed under "act", and any other waiting agent has no
// sub-state, as one turn check couldn't place. With no set, as they are.
export function mockSubStated(box: string, list: Session[]): Session[] {
  const ids = held[box]?.states.map((s) => s.id) ?? [];
  if (!ids.length) return list;
  return list.map((s) => (s.agent_state === "waiting" && s.name === "checkout-fix-claude" && ids.includes("act") ? { ...s, agent_sub_state: "act" } : s));
}
