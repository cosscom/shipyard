import type { Session } from "@/lib/api";
import { keyOf, useConversations } from "@/lib/conversation-store";
import type { Helper, TranscriptPage } from "@/lib/history";
import type { ToolDetail, TranscriptItem } from "@/lib/transcript";
import { benchOlder } from "@/lib/mock-bench";
import { seedTranscript } from "@/lib/mock-conversation";
import { sessionState } from "@/lib/derive";

// The demo's stand-in for the box's history endpoints (?mock=1): older
// turns of a long chat (?long=5000 seeds one, for measuring), the helpers'
// own conversations, a fork that opens as a new tab, and a rewind.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- A long chat -----------------------------------------------------------

// Long chats by session: how many items each has. Items are made on demand
// from their index, so a 5,000-item chat costs nothing until it is read.
const long = new Map<string, number>();

const TOPICS = ["the webhook retries", "the checkout total", "flaky search tests", "the session cookie", "rate limiting", "the CSV export", "image uploads", "the billing page"];
const FILES = ["webhook.ts", "createOrder.ts", "search.test.ts", "session.ts", "limits.go", "export.py", "upload.tsx", "billing.tsx"];

// itemAt is item i of a long chat: turns of a prompt, a group of steps, an
// answer (every fourth with a table or code), and now and then an edit.
function itemAt(i: number): TranscriptItem & { off: number; uuid?: string; parent?: string } {
  const turn = Math.floor(i / 4);
  const topic = TOPICS[turn % TOPICS.length];
  const file = FILES[turn % FILES.length];
  const off = (i + 1) * 1000;
  switch (i % 4) {
    case 0:
      return { kind: "user", id: `lg${i}`, off, uuid: `u-${i}`, parent: `p-${i}`, text: `Turn ${turn + 1}: look at ${topic} and tell me what you'd change.` };
    case 1:
      return { kind: "tools", id: `lg${i}`, off, verb: turn % 3 ? "Read" : "Run", done: true, items: turn % 3 ? [{ verb: "Read", target: file, file: true }, { verb: "Read", target: `README.md`, file: true }] : [{ verb: "Run", target: `pnpm test ${file.split(".")[0]}` }] };
    case 2:
      return turn % 5 === 4 ? { kind: "edit", id: `lg${i}`, off, file: `src/${file}`, added: 3 + (turn % 9), removed: turn % 4 } : { kind: "text", id: `lg${i}`, off, text: `Reading ${file} first, then the tests around it.` };
    default:
      return {
        kind: "text",
        id: `lg${i}`,
        off,
        text:
          turn % 4 === 0
            ? `For ${topic}, the change is small:\n\n| | Now | After |\n|---|---|---|\n| Calls per request | ${2 + (turn % 3)} | 1 |\n| Retries | unlimited | 5 |\n\nTurn ${turn + 1} is done.`
            : turn % 4 === 1
              ? `Here is the fix for ${topic} in \`${file}\`:\n\n\`\`\`ts\nexport function retry(n: number) {\n  return Math.min(n * 2, ${turn % 50});\n}\n\`\`\`\n\nThe tests pass.`
              : `${topic[0].toUpperCase()}${topic.slice(1)} reads the setting twice, once per request; turn ${turn + 1} keeps it in one place, so **${file}** is the only file to change. Nothing else depends on the old behaviour.`,
      };
  }
}

// seedLongChat gives the demo's chat N items when the page asks (?long=N):
// the last 300 live, the rest a page at a time as it scrolls up.
export function seedLongChat(box: string, session: string) {
  const n = Number(new URLSearchParams(location.search).get("long") || 0);
  const key = keyOf(box, session);
  if (!n || long.get(key) === n) return;
  long.set(key, n);
  const items: TranscriptItem[] = [];
  for (let i = Math.max(0, n - 300); i < n; i++) items.push(itemAt(i));
  useConversations.setState((s) => ({ items: { ...s.items, [key]: items } }));
}

function olderPage(key: string, before: number, limit: number): TranscriptPage {
  const bench = benchOlder(key, before, limit);
  if (bench) return bench;
  const n = long.get(key) ?? 0;
  const end = Math.min(n, Math.floor(before / 1000) - 1);
  const start = Math.max(0, end - limit);
  const items: TranscriptItem[] = [];
  for (let i = start; i < end; i++) items.push(itemAt(i));
  return { source: "claude", items, next: n, more: start > 0 };
}

// demoConversation is a session's conversation in the demo: what its chat
// holds, or made up as its chat would when no one has opened it.
function demoConversation(box: string, s: Session): TranscriptItem[] {
  return useConversations.getState().items[keyOf(box, s.name)] ?? seedTranscript(box, s.name, sessionState(s), s.location?.split("/").pop() ?? s.name);
}

// demoPage is a page of a session's conversation as the box reads one
// (before=0 is its end), its items placed 1,000 bytes apart.
function demoPage(box: string, s: Session, before: number, limit: number): TranscriptPage {
  const all = demoConversation(box, s);
  const items = all.map((it, i) => ({ ...it, off: (i + 1) * 1000 })).filter((it) => before <= 0 || it.off < before);
  return { source: "claude", items: items.slice(-limit), next: all.length, more: items.length > limit };
}

// ---- Helpers ---------------------------------------------------------------

function helpersOf(key: string): Helper[] {
  const crew = useConversations.getState().crew[key] ?? [];
  return crew
    .filter((c) => c.kind === "subagent")
    .map((c) => ({
      id: c.id,
      tool: c.id,
      type: c.name.startsWith("Explore") ? "Explore" : "general-purpose",
      name: c.name.replace(/^Explore:\s*/, ""),
      prompt: `Look into ${c.name.replace(/^Explore:\s*/, "").toLowerCase()} in this repository. Read what you need, run nothing that writes, and reply with what you found in a few lines, with file:line references.`,
      started: c.since,
      updated: c.until ?? Date.now(),
      depth: 1,
      state: c.state === "finished" ? "finished" : "running",
    }));
}

function helperChat(h: Helper): TranscriptItem[] {
  const topic = h.name.toLowerCase();
  const items: TranscriptItem[] = [
    { kind: "user", id: `${h.id}-u`, text: h.prompt ?? topic },
    { kind: "text", id: `${h.id}-t1`, text: `I'll search for ${topic} first, then read the files it points to.` },
    { kind: "tools", id: `${h.id}-s`, verb: "Search", done: true, items: [{ verb: "Search", target: topic.split(" ")[0] ?? "retry", id: `${h.id}-g1` }, { verb: "Search", target: "idempotency", id: `${h.id}-g2` }] },
    { kind: "tools", id: `${h.id}-r`, verb: "Read", done: true, items: [{ verb: "Read", target: "retry.ts", file: true, id: `${h.id}-r1` }, { verb: "Read", target: "payments.test.ts", file: true, id: `${h.id}-r2` }] },
  ];
  if (h.state === "finished")
    items.push({
      kind: "text",
      id: `${h.id}-done`,
      text: `Found it.\n\n- \`retry.ts:41\` retries without a key, so a repeat charges twice.\n- \`payments.test.ts\` never sends the same event twice.\n\nA fix belongs in **createOrder**: look the key up before charging.`,
    });
  return items;
}

const helperTool = (tool: string): ToolDetail =>
  tool.includes("-g")
    ? { id: tool, name: "Grep", pattern: "retry", output: "src/payments/retry.ts:41:  return charge(event)\nsrc/payments/retry.ts:58:  retries: 5," }
    : { id: tool, name: "Read", file: tool.endsWith("1") ? "src/payments/retry.ts" : "src/payments/payments.test.ts", output: "     1\texport async function retry(event: Event) {\n     2\t  return charge(event);\n     3\t}" };

// ---- Calls -----------------------------------------------------------------

export function mockHistoryCall(
  box: string,
  method: string,
  path: string,
  body: unknown,
  st: { sessions: Record<string, Session[]>; emit(e: { type: string; box?: string; data?: Record<string, unknown> }): void },
): Promise<unknown> | undefined {
  const m = /^sessions\/([^/?]+)\/(.*)$/.exec(path);
  if (!m) return undefined;
  const session = decodeURIComponent(m[1]);
  const rest = m[2];
  const key = keyOf(box, session);
  if (method === "GET" && rest.startsWith("transcript?") && rest.includes("before=")) {
    const q = new URLSearchParams(rest.split("?")[1]);
    const before = Number(q.get("before"));
    const limit = Number(q.get("limit") || 200);
    if (!long.has(key) && !benchOlder(key, before, limit)) {
      const s = st.sessions[box]?.find((x) => x.name === session);
      if (!s) return Promise.reject(new Error("That session isn't in the demo."));
      return wait(120).then(() => demoPage(box, s, before, limit));
    }
    return wait(260).then(() => olderPage(key, before <= 0 ? Infinity : before, limit));
  }
  // A board card's read of a chat-mode agent (views/dashboard/use-chat-tail):
  // the whole demo conversation as its window, then what was added since.
  if (method === "GET" && rest.startsWith("transcript?") && rest.includes("since=")) {
    const s = st.sessions[box]?.find((x) => x.name === session);
    if (!s) return Promise.reject(new Error("That session isn't in the demo."));
    const all = demoConversation(box, s);
    const since = Number(new URLSearchParams(rest.split("?")[1]).get("since")) || 0;
    return wait(120).then(() => ({ source: "claude", items: all.slice(since), next: all.length, crew: [], gen: "demo", start: 0 }));
  }
  if (method === "GET" && rest === "subagents") return wait(150).then(() => ({ helpers: helpersOf(key) }));
  const sub = /^subagents\/([^/]+)\/(transcript|tool\/(.+))/.exec(rest);
  if (method === "GET" && sub) {
    const h = helpersOf(key).find((x) => x.id === decodeURIComponent(sub[1]));
    if (!h) return Promise.reject(new Error("That helper isn't in the demo."));
    if (sub[3]) return wait(220).then(() => helperTool(decodeURIComponent(sub[3])));
    const items = helperChat(h);
    return wait(200).then(() => ({ source: "claude", items, next: items.length, crew: [] }));
  }
  if (method === "POST" && rest === "fork") {
    const req = body as { at?: string; text?: string; title?: string; open?: string };
    const from = st.sessions[box]?.find((x) => x.name === session);
    if (!from) return Promise.reject(new Error("That session isn't in the demo."));
    const name = `${(from.location ?? "demo").replace(/\//g, "-")}-claude-fork${Date.now().toString(36).slice(-3)}`;
    const now = new Date().toISOString();
    const s: Session = { ...from, name, command: "claude --resume …", created: now, attached: 0, exited: false, agent: "claude", agent_state: req.text ? "running" : "idle", state_since: now, title: req.title } as Session;
    (st.sessions[box] ??= []).push(s);
    // The fork has the conversation up to the prompt, and its first message.
    const items = useConversations.getState().items[key] ?? [];
    const cut = req.at?.startsWith("id:") ? items.findIndex((it) => it.id === req.at!.slice(3)) : items.findIndex((it) => (it as { parent?: string }).parent === req.at);
    const before = (cut >= 0 ? items.slice(0, cut) : items).filter((it) => !it.id.startsWith("live:"));
    useConversations.setState((x) => ({ items: { ...x.items, [keyOf(box, name)]: [...before.map((it) => ({ ...it, id: `f-${it.id}` })), ...(req.text ? [{ kind: "user" as const, id: `f-u${Date.now()}`, text: req.text }] : [])] } }));
    st.emit({ type: "session.started", box, data: { name, location: s.location, path: s.dir, command: "claude" } });
    setTimeout(() => st.emit({ type: "session.open", box, data: { name, location: s.location, path: s.dir, open: req.open ?? "tab", agent: "claude" } }), 80);
    return wait(400).then(() => s);
  }
  if (method === "POST" && rest === "rewind") {
    const req = body as { text: string; nth?: number; restore?: string };
    return wait(900).then(() => {
      // As the box's record would read once the agent goes on: the prompt
      // and everything after it gone.
      const items = useConversations.getState().items[key] ?? [];
      let n = req.nth ?? 0;
      let at = -1;
      for (let i = items.length - 1; i >= 0; i--)
        if (items[i].kind === "user" && (items[i] as { text: string }).text.trim() === req.text.trim() && n-- === 0) {
          at = i;
          break;
        }
      if (at < 0) throw new Error("That prompt isn't in Claude's rewind list.");
      useConversations.setState((x) => ({ items: { ...x.items, [key]: items.slice(0, at) } }));
      return { restored: req.restore === "both" ? "both" : "conversation", text: req.text };
    });
  }
  return undefined;
}
