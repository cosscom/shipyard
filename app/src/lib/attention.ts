import type { AttentionItem, AttentionPost, AttentionUpdate, BerthAttention } from "@berth/plugin";

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

export const attentionApi = {
  list: async (c: Client, box: string, opts: { session?: string; open?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.session) q.set("session", opts.session);
    if (opts.open) q.set("open", "1");
    const qs = q.toString();
    return (await c.box<AttentionItem[] | null>(box, "GET", `attention${qs ? `?${qs}` : ""}`)) ?? [];
  },
  get: (c: Client, box: string, key: string) =>
    c.box<AttentionItem>(box, "GET", itemPath(key)).catch((err: unknown) => {
      if (missing(err)) return undefined;
      throw err;
    }),
  post: (c: Client, box: string, item: AttentionPost) => c.box<AttentionItem>(box, "POST", "attention", item),
  update: (c: Client, box: string, key: string, change: AttentionUpdate) => c.box<AttentionItem>(box, "PATCH", itemPath(key), change),
};

// makeAttentionApi is the store as plugins see it (berth.attention).
export function makeAttentionApi(client: Client): BerthAttention {
  return {
    list: (box, opts) => attentionApi.list(client, box, opts),
    get: (box, key) => attentionApi.get(client, box, key),
    post: (box, item) => attentionApi.post(client, box, item),
    update: (box, key, change) => attentionApi.update(client, box, key, change),
  };
}
