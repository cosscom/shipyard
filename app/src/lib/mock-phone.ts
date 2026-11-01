import type { PhoneChange, PhoneStatus } from "@/lib/phone";

// Phone access in demo mode: each box can be turned on, and gets a made-up
// tailnet address and token.

const state: Record<string, PhoneStatus> = {};
const addr: Record<string, string> = { devl: "100.64.0.11", gpu: "100.64.0.12", build: "100.64.0.12", homelab: "100.64.0.13" };

function token() {
  return Array.from({ length: 48 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}

export function phoneCall(box: string, method: string, path: string, body: unknown, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  if (path !== "phone") return undefined;
  const st = (state[box] ??= { enabled: false });
  if (method === "GET") return delay({ ...st });
  if (method === "PUT") {
    const c = (body ?? {}) as PhoneChange;
    if (c.enabled !== undefined) st.enabled = c.enabled;
    if ((st.enabled && !st.token) || c.rotate) st.token = token();
    // A new code, or access off, forgets the phones; the demo's one phone
    // comes back with access on, as it would after pairing again.
    if (c.rotate || !st.enabled) st.push = undefined;
    else if (c.enabled) st.push = [{ id: "0123456789abcdef0123456789abcdef", name: "Acme iPhone", platform: "ios", added: new Date(Date.now() - 86_400_000).toISOString(), last_ok: new Date(Date.now() - 600_000).toISOString() }];
    if (c.remove_push) st.push = st.push?.filter((d) => d.id !== c.remove_push);
    if (c.notify) st.notify = c.notify;
    if (c.clear_notify) st.notify = undefined;
    st.url = st.enabled ? `http://${addr[box] ?? "100.64.0.1"}:1379/` : undefined;
    return delay({ ...st });
  }
  return undefined;
}
