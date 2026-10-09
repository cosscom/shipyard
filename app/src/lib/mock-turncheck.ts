import type { TurnCheckChange, TurnCheckStatus } from "@/lib/turncheck";

// Turn check in demo mode: off on every box until turned on.

const state: Record<string, TurnCheckStatus> = {};

export function turnCheckCall(box: string, method: string, path: string, body: unknown, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  if (path !== "turncheck") return undefined;
  const st = (state[box] ??= { enabled: false, key_set: false });
  if (method === "PUT") {
    const { key_value, remove_key, ...cfg } = body as TurnCheckChange;
    // The last one set wins, as on a box.
    state[box] = { ...cfg, key: key_value ? undefined : cfg.key, key_set: key_value ? true : remove_key || cfg.key ? false : st.key_set };
  }
  if (method === "GET" || method === "PUT") return delay({ ...state[box] });
  return undefined;
}
