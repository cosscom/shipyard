import type { AttentionItem, BerthAttention } from "@berth/plugin";

import type { Client } from "@/lib/api";

// What needs a person, kept on each box (internal/box/attention.go), so a
// snooze or an answer made on one computer holds on every other. The key
// goes path-escaped: a plugin's keys may hold slashes.

const itemPath = (key: string) => `attention/${encodeURIComponent(key)}`;

// A box that holds no item at a key says so with 404 "not_found".
const missing = (err: unknown) => {
  const e = err as { status?: number; code?: string } | null;
  return e?.status === 404 && e.code === "not_found";
};

// makeAttentionApi is the store as plugins see it (berth.attention).
export function makeAttentionApi(c: Client): BerthAttention {
  return {
    list: async (box, opts = {}) => {
      const q = new URLSearchParams();
      if (opts.session) q.set("session", opts.session);
      if (opts.open) q.set("open", "1");
      const qs = q.toString();
      return (await c.box<AttentionItem[] | null>(box, "GET", `attention${qs ? `?${qs}` : ""}`)) ?? [];
    },
    get: (box, key) =>
      c.box<AttentionItem>(box, "GET", itemPath(key)).catch((err: unknown) => {
        if (missing(err)) return undefined;
        throw err;
      }),
    post: (box, item) => c.box<AttentionItem>(box, "POST", "attention", item),
    update: (box, key, change) => c.box<AttentionItem>(box, "PATCH", itemPath(key), change),
  };
}
