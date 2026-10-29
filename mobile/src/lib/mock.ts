import type { TranscriptItem } from "@berth/core/transcript.ts";

import type { Box, PhoneSession, PhoneTranscript, Run } from "./types";

// The demo: two made-up boxes with acme's agents on them, for trying the
// app without a box (and for App Review, which can't join a tailnet).
// Nothing leaves the phone.

export const DEMO_BOXES: Box[] = [
  { id: "demo-devl", name: "devl", url: "mock://devl", token: "demo" },
  { id: "demo-build", name: "build", url: "mock://build", token: "demo" },
];

export const isDemo = (b: Box) => b.url.startsWith("mock://");

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const sessions = (): Record<string, PhoneSession[]> => ({
  devl: [
    {
      name: "acme-checkout-fix-claude-1a",
      location: "acme/checkout-fix",
      worktree_title: "Checkout fix",
      dir: "/home/dev/acme/checkout-fix",
      agent: "claude",
      agent_state: "waiting",
      state_since: at(3),
      created: at(40),
      attached: 0,
      exited: false,
      ask: { tool: "Edit", input: "src/webhook.ts", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again this session" }, { key: "3", label: "No, and tell Claude what to do differently" }] },
    },
    { name: "acme-qa-deck-codex-1b", location: "acme/qa-deck", dir: "/home/dev/acme/qa-deck", agent: "codex", agent_state: "running", state_since: at(1), created: at(22), attached: 0, exited: false },
    { name: "acme-hello-claude-1c", location: "acme/hello", dir: "/home/dev/acme/hello", agent: "claude", agent_state: "finished", state_since: at(12), created: at(50), attached: 0, exited: false },
  ],
  build: [{ name: "acme-pr-claude-2a", location: "acme/pr", dir: "/home/dev/acme/pr", agent: "claude", agent_state: "idle", state_since: at(30), created: at(30), attached: 0, exited: false }],
});

const screens: Record<string, string> = {
  "acme-checkout-fix-claude-1a":
    "● I need to change the payment webhook handler, which touches checkout.\n\n Do you want to make this edit to webhook.ts?\n ❯ 1. Yes\n   2. Yes, and don't ask again this session\n   3. No, and tell Claude what to do differently\n",
  "acme-qa-deck-codex-1b": "• Running pnpm test --filter=@acme/web\n  PASS apps/web/test/cart.test.ts\n  PASS apps/web/test/orders.test.ts\n",
  "acme-hello-claude-1c": "❯ Reply with just the word: ready\n● ready\n✻ Brewed for 1s\n",
};

const chats: Record<string, TranscriptItem[]> = {
  "acme-checkout-fix-claude-1a": [
    { kind: "user", id: "1", text: "The checkout webhook double-charges when Stripe retries. Fix it and add a test." },
    { kind: "text", id: "2", text: "I'll look at how the webhook handles retries first." },
    { kind: "tools", id: "3", verb: "Read", done: true, items: [{ verb: "Read", target: "src/webhook.ts" }, { verb: "Search", target: "idempotency" }] },
    { kind: "text", id: "4", text: "The handler charges before it records the event, so a retry charges again. I'll record the event id first and skip ones already seen." },
  ],
  "acme-hello-claude-1c": [
    { kind: "user", id: "1", text: "Reply with just the word: ready" },
    { kind: "text", id: "2", text: "ready" },
  ],
};

const gateRun = (): Run => ({
  id: "r_demo1",
  template: "attempts",
  title: "refunds: 3 attempts",
  status: "waiting_gate",
  created: at(35),
  gate: { path: "2.t.0", title: "Pick the best attempt at refunds", text: "Winner: attempt 3. Smallest diff with tests.", pick: true, default: 2 },
  candidates: [
    { index: 0, agent: "claude", diff: { added: 140, removed: 22 }, verify: { passed: false }, judge: { rank: 3 } },
    { index: 1, agent: "codex", diff: { added: 96, removed: 18 }, verify: { passed: true }, judge: { rank: 2 } },
    { index: 2, agent: "claude", diff: { added: 61, removed: 9 }, verify: { passed: true }, judge: { rank: 1 } },
  ],
  steps: [
    { id: "attempts", kind: "map", status: "succeeded" },
    { id: "judge", kind: "judge", status: "succeeded", output: "Winner: attempt 3." },
  ],
});

export async function mockCall(box: Box, method: string, path: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  // A current box, less what needs a real one: a stream and notifications.
  if (path === "/phone/v1/info") return { box: box.name, version: 2, capabilities: ["transcript", "interrupt"] };
  if (path === "/phone/v1/sessions") return sessions()[box.name] ?? [];
  if (path === "/phone/v1/runs") return box.name === "devl" ? [gateRun(), { id: "r_demo2", template: "loop", title: "Loop until pnpm test passes", status: "running", cursor: "1.r2.0", created: at(8) }] : [];
  if (path.startsWith("/phone/v1/runs/") && method === "GET") return gateRun();
  const m = path.match(/^\/phone\/v1\/sessions\/([^/]+)\/(screen|transcript)/);
  if (m && m[2] === "screen") return { screen: screens[decodeURIComponent(m[1])] ?? "$ " };
  if (m && m[2] === "transcript") {
    const items = chats[decodeURIComponent(m[1])] ?? [];
    return { source: items.length ? "claude" : "none", items, next: items.length, reason: items.length ? undefined : "This agent's conversation can't be read here." } satisfies PhoneTranscript;
  }
  return { sent: true };
}
