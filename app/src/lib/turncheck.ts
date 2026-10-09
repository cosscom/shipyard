import type { Client } from "@/lib/api";

// Turn check (see internal/box/turncheck.go): when on, a box asks Jev on
// Vercel AI Gateway (or the Jev-compatible server url names) whether a
// finished turn needs you. A pasted key is kept on the box and never comes
// back; key is only ever a secret reference.

export interface TurnCheckConfig {
  enabled: boolean;
  key?: string;
  url?: string;
  model?: string;
}

export interface TurnCheckStatus extends TurnCheckConfig {
  key_set: boolean;
}

export interface TurnCheckChange extends TurnCheckConfig {
  key_value?: string;
  remove_key?: boolean;
}

export const turnCheckApi = {
  get: (c: Client, box: string) => c.box<TurnCheckStatus>(box, "GET", "turncheck"),
  put: (c: Client, box: string, change: TurnCheckChange) => c.box<TurnCheckStatus>(box, "PUT", "turncheck", change),
};

// ownServer says whether a check asks a server other than AI Gateway,
// which may need no key: by host name, as the box decides.
export function ownServer(c: TurnCheckConfig) {
  if (!c.url) return false;
  try {
    return new URL(c.url).hostname.toLowerCase() !== "ai-gateway.vercel.sh";
  } catch {
    return true;
  }
}
