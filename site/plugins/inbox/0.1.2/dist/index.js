// src/index.tsx
import { definePlugin } from "@berth/plugin";
import { useSyncExternalStore as useSyncExternalStore3 } from "react";

// src/screen.tsx
import { useStorage } from "@berth/plugin";
import { Badge as Badge2, Button as Button3, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Kbd as Kbd2, Skeleton as Skeleton3, ViewHeader, cn as cn2 } from "@berth/plugin/ui";
import { useCallback as useCallback2, useEffect as useEffect3, useMemo as useMemo2, useRef as useRef3, useState as useState3, useSyncExternalStore as useSyncExternalStore2 } from "react";

// src/card.tsx
import { Alert, AlertDescription, Badge, Button, Kbd, Skeleton, Textarea, cn } from "@berth/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

// src/markdown.tsx
import { jsx } from "react/jsx-runtime";
var INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
function inline(text, openUrl) {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return /* @__PURE__ */ jsx("code", { className: "rounded bg-muted px-1 font-mono text-[0.92em]", children: part.slice(1, -1) }, i);
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return /* @__PURE__ */ jsx("strong", { className: "font-medium", children: part.slice(2, -2) }, i);
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link)
      return /* @__PURE__ */ jsx("button", { type: "button", className: "underline", onClick: () => openUrl(link[2]), children: link[1] }, i);
    return part;
  });
}
function Markdown({ text, openUrl }) {
  const blocks = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(
        /* @__PURE__ */ jsx("pre", { className: "overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs", children: code.join("\n") }, i)
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) rows.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      blocks.push(
        /* @__PURE__ */ jsx("ul", { className: "flex list-disc flex-col gap-1 pl-5", children: rows.map((r, n) => /* @__PURE__ */ jsx("li", { children: inline(r, openUrl) }, n)) }, i)
      );
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(
        /* @__PURE__ */ jsx("p", { className: "font-medium", children: inline(line.replace(/^#+\s+/, ""), openUrl) }, i)
      );
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*]|\d+\.)\s/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(/* @__PURE__ */ jsx("p", { children: inline(para.join(" "), openUrl) }, i));
    }
  }
  return /* @__PURE__ */ jsx("div", { className: "flex min-w-0 flex-col gap-2 break-words", children: blocks });
}

// src/model.ts
var GROUPS = [
  { id: "decision", title: "Needs my decision" },
  { id: "action", title: "Needs an action from me" },
  { id: "review", title: "Ready to review or merge" },
  { id: "blocked", title: "Blocked or crashed" }
];
var WALK_ORDER = ["decision", "action", "blocked", "review"];
var ESTIMATE_S = { decision: 60, action: 120, review: 120, blocked: 90 };
var BLOCKED_MARK = "\u26D4";
var ASKING_MARK = "\u2753";
var MARKS = /^[\p{Extended_Pictographic}️‍\s→]+/u;
var cleanTitle = (title, fallback) => (title ?? "").replace(MARKS, "").trim() || fallback;
var waitKey = (box, s) => `${box}/${s.name}/${s.turn ?? s.state_since ?? "wait"}`;
function fromSession(box, s) {
  const base = {
    box,
    session: s.name,
    location: s.location,
    agent: s.agent,
    since: s.state_since ?? s.created,
    source: s,
    title: cleanTitle(s.title, s.name)
  };
  const title = s.title ?? "";
  if (s.exited) return s.agent ? { ...base, kind: "exited", group: "blocked", key: `${box}/${s.name}/exited`, why: "The agent's program ended" } : void 0;
  if (s.parked || s.unfinished || (s.queued ?? 0) > 0) return void 0;
  if (s.agent_state === "waiting") {
    const what = s.ask?.input && s.ask.tool !== "AskUserQuestion" ? `${s.ask.tool ?? "A tool"}: ${s.ask.input}` : void 0;
    const why = s.ask?.message || s.ask?.why || what;
    return { ...base, kind: "wait", group: s.agent_sub_state === "act" ? "action" : "decision", key: waitKey(box, s), why };
  }
  if (s.agent_state === "running") return void 0;
  if (title.startsWith(BLOCKED_MARK)) return { ...base, kind: "marked", group: "blocked", key: waitKey(box, s), why: "It says it's blocked" };
  if (title.startsWith(ASKING_MARK)) return { ...base, kind: "marked", group: "decision", key: waitKey(box, s), why: "Its title says it's asking" };
  return void 0;
}
function itemsOf(box, read) {
  const items = [];
  for (const s of read.sessions) {
    const it = fromSession(box, s);
    if (it) items.push(it);
  }
  for (const g of read.gates ?? [])
    if (g.gate)
      items.push({
        key: `${box}/run/${g.id}/${g.gate.path}`,
        kind: "gate",
        group: "decision",
        box,
        session: g.session,
        title: g.gate.title,
        why: g.gate.text,
        since: g.updated ?? g.created,
        source: g
      });
  for (const r of read.secrets ?? [])
    items.push({
      key: `${box}/secret/${r.id}`,
      kind: "secret",
      group: "action",
      box,
      session: r.session,
      location: r.location,
      title: `Add the secret ${r.name}`,
      why: r.reason,
      since: r.created,
      source: r
    });
  for (const g of read.gone ?? [])
    items.push({
      key: `${box}/${g.name}/gone/${g.gone_at}`,
      kind: "gone",
      group: "blocked",
      box,
      session: g.name,
      location: g.location,
      agent: g.agent,
      title: cleanTitle(g.title, g.name),
      why: `It ended while it was ${g.state ?? "working"}`,
      since: g.gone_at,
      source: g
    });
  return items;
}
var age = (it) => (it.since ? Date.parse(it.since) : 0) || 0;
var byAge = (a, b) => age(a) - age(b) || a.key.localeCompare(b.key);
var NO_MARKS = { snoozed: {}, resolved: {}, sent: {} };
var SENT_GRACE_MS = 6e4;
function openItems(items, marks, now) {
  return items.filter((it) => {
    if (marks.resolved[it.key]) return false;
    if ((marks.snoozed[it.key] ?? 0) > now) return false;
    const sent = marks.sent[it.key];
    return !(sent && now - sent < SENT_GRACE_MS);
  });
}
var didntLand = (it, marks, now) => {
  const sent = marks.sent[it.key];
  return !!sent && now - sent >= SENT_GRACE_MS;
};
var snoozedItems = (items, marks, now) => items.filter((it) => !marks.resolved[it.key] && (marks.snoozed[it.key] ?? 0) > now);
var inList = (items) => GROUPS.map((g) => ({ group: g.id, title: g.title, items: items.filter((i) => i.group === g.id).sort(byAge) }));
var walkOrder = (items) => WALK_ORDER.flatMap((g) => items.filter((i) => i.group === g).sort(byAge));
function nextAfter(order, key, step = 1) {
  if (!order.length) return void 0;
  const at = order.findIndex((i) => i.key === key);
  if (at < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + step))];
}
function holdCurrent(order, current, leaving) {
  const here = order.find((i) => i.key === current);
  if (here) return here;
  if (leaving && current) {
    const at = leaving.findIndex((i) => i.key === current);
    if (at >= 0) for (let i = at + 1; i < leaving.length; i++) {
      const next = order.find((o) => o.key === leaving[i].key);
      if (next) return next;
    }
  }
  return order[0];
}
function estimate(items) {
  const s = items.reduce((n, i) => n + ESTIMATE_S[i.group], 0);
  const left = `${items.length} left`;
  if (!items.length) return left;
  return s < 90 ? `${left}, about 1 min` : `${left}, about ${Math.round(s / 60)} min`;
}
function ago(since, now) {
  const t = since ? Date.parse(since) : NaN;
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 6e4));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
var snoozeTimes = (now) => {
  const d = new Date(now);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8).getTime();
  const nextWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((8 - d.getDay()) % 7 || 7), 8).getTime();
  return [
    { id: "hour", label: "In 1 hour", until: now + 36e5 },
    { id: "tomorrow", label: "Tomorrow", until: tomorrow },
    { id: "week", label: "Next week", until: nextWeek }
  ];
};
function openForm(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "question") return !it.done && it.tool && it.questions?.length ? it : void 0;
    if (it.kind === "user") return void 0;
  }
  return void 0;
}
function lastMessage(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "text" && it.text?.trim()) return it.text.trim();
    if (it.kind === "user") return void 0;
  }
  return void 0;
}
var ENDINGS = {
  interrupted: "It was interrupted, and waits for what to do instead.",
  exited: "The agent's program ended.",
  stop_failure: "Its turn ended on a failure.",
  api_error: "Its turn ended on an API error.",
  limit: "It hit a usage limit.",
  rate_limit: "It hit a rate limit.",
  auth: "It lost its sign-in.",
  billing: "It stopped on a billing problem."
};
function howItEnded(items) {
  const last = items[items.length - 1];
  return last?.kind === "notice" ? ENDINGS[last.notice ?? ""] ?? last.text : void 0;
}
var WORK = /* @__PURE__ */ new Set(["tools", "edit"]);
function workSummary(items) {
  let ran = 0;
  let read = 0;
  let edited = 0;
  for (const it of items) {
    if (it.kind === "edit") edited++;
    else for (const t of it.items?.length ? it.items : [{ verb: it.verb }]) /^read/i.test(t.verb ?? "") ? read++ : ran++;
  }
  const n = (c, one, many) => c ? `${c} ${c === 1 ? one : many}` : "";
  const parts = [ran && `ran ${n(ran, "command", "commands")}`, read && `read ${n(read, "file", "files")}`, edited && `edited ${n(edited, "file", "files")}`].filter(Boolean);
  return `Worked \xB7 ${parts.join(", ")}`;
}
function peekRows(items) {
  const rows = [];
  let run = [];
  const flush = () => {
    if (run.length) rows.push({ kind: "work", id: run[0].id, summary: workSummary(run), items: run });
    run = [];
  };
  for (const it of items) {
    if (WORK.has(it.kind)) run.push(it);
    else {
      flush();
      rows.push({ kind: "item", item: it });
    }
  }
  flush();
  return rows;
}
var RECOMMENDED = /\s*\(\s*recommended\s*\)\s*$/i;
var isRecommended = (o) => RECOMMENDED.test(o.label);
var shownLabel = (o) => o.label.replace(RECOMMENDED, "");
var oneLine = (text) => text.replace(/\s+/g, " ").trim().replace(/"/g, "\u201D");
function answerFor(q, p) {
  const note = oneLine(p.note ?? "");
  if (q.multi) return { picks: p.picks, ...note ? { other: note } : {} };
  const pick = p.picks[0];
  if (pick && note) return { other: `${oneLine(shownLabel({ label: pick }))}. ${note}` };
  if (pick) return { picks: [pick] };
  return { other: note };
}
var complete = (p) => !!p && (p.picks.length > 0 || !!oneLine(p.note ?? ""));
var CLOSE_LINE = "This session is being closed from the Inbox. Commit and push anything worth keeping, then end by running: berthd session kill $BERTH_SESSION";
var closeText = (note) => {
  const n = oneLine(note ?? "");
  return n ? `${CLOSE_LINE} Note: ${n}` : CLOSE_LINE;
};
var closeAnswers = (qs, note) => qs.map(() => ({ other: closeText(note) }));
var closeKind = (kind) => kind === "gate" ? void 0 : kind === "secret" || kind === "gone" ? "dismiss" : "close";
var UNSAVED_CHECK = "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; git status --porcelain; git log --oneline -5 HEAD --not --remotes";
var hasUnsaved = (output) => !!output?.trim();
function choicesOnScreen(screen) {
  const lines = screen.trimEnd().split("\n").slice(-16);
  const out = [];
  for (const l of lines) {
    const m = l.match(/^[\s│|]*[❯>›]?\s*(\d)\.\s+(.+?)[\s│|]*$/);
    if (m) out.push({ key: m[1], label: m[2] });
  }
  return out.filter((c, i) => out.findIndex((x) => x.key === c.key) === i);
}
var screenFoot = (screen) => screen.split("\n").map((l) => l.trimEnd()).filter((l) => l && !/^[─━-]+$/.test(l.trim())).slice(-12).join("\n");
function permissionChoices(choices) {
  const always = choices.find((c) => /don.t ask again|always|allow all|this session/i.test(c.label));
  const allow = choices.find((c) => c !== always && /^(yes|allow|approve|proceed)\b/i.test(c.label));
  const deny = choices.find((c) => /^(no|deny|reject)\b/i.test(c.label));
  if (!allow || !deny) return choices;
  return [{ key: allow.key, label: "Allow", title: allow.label }, ...always ? [{ key: always.key, label: "Always allow", title: always.label }] : [], { key: deny.key, label: "Deny", title: deny.label }];
}
var denyChoice = (choices) => choices.find((c) => /^(no|deny|reject)\b/i.test(c.label) || /^(no|deny|reject)\b/i.test(c.title ?? ""));
function trackGone(known2, sessions, stopped2, nowIso) {
  const live = new Set(sessions.map((s) => s.name));
  const gone2 = [];
  for (const [name, k] of Object.entries(known2)) if (!live.has(name) && !stopped2.has(name)) gone2.push({ ...k, name, gone_at: nowIso });
  const next = {};
  for (const s of sessions)
    if (s.agent && !s.exited && (s.agent_state === "running" || s.agent_state === "waiting")) next[s.name] = { name: s.name, title: s.title, location: s.location, agent: s.agent, state: s.agent_state };
  return { known: next, gone: gone2 };
}

// src/store.ts
var state = { reads: {}, loaded: false, marks: NO_MARKS, details: {}, now: Date.now() };
var listeners = /* @__PURE__ */ new Set();
var set = (patch) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
var getState = () => state;
var subscribe = (l) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
var berth;
var stopped = {};
var STOPPED_MS = 2 * 6e4;
var noteStopped = (box, name) => (stopped[box] ??= /* @__PURE__ */ new Map()).set(name, Date.now());
var recentlyStopped = (box) => new Set([...stopped[box] ?? /* @__PURE__ */ new Map()].filter(([, at]) => Date.now() - at < STOPPED_MS).map(([n]) => n));
var known = {};
var gone = {};
var timers = /* @__PURE__ */ new Map();
var reading = /* @__PURE__ */ new Map();
var saveMarks = () => berth.storage.set("marks", state.marks);
var saveTracked = () => {
  berth.storage.set("known", known);
  berth.storage.set("gone", gone);
};
var mark = (kind, key, value) => {
  const next = { ...state.marks[kind] };
  if (value === void 0) delete next[key];
  else next[key] = value;
  set({ marks: { ...state.marks, [kind]: next } });
  saveMarks();
};
var WEEK_MS = 7 * 24 * 36e5;
var pruned = (marks, now) => {
  const keep = (m, ms) => Object.fromEntries(Object.entries(m).filter(([, t]) => t + ms > now));
  return { snoozed: keep(marks.snoozed, WEEK_MS), resolved: keep(marks.resolved, 2 * WEEK_MS), sent: keep(marks.sent, WEEK_MS) };
};
async function optional(read, fallback) {
  try {
    return await read;
  } catch {
    return fallback;
  }
}
async function readBox(box) {
  const turn = (reading.get(box) ?? 0) + 1;
  reading.set(box, turn);
  const sessions = await berth.api.sessions(box);
  const [gates, secrets] = await Promise.all([
    optional(berth.orchestrate.runs.list(box, { status: "waiting_gate" }), []),
    optional(berth.api.request(box, "GET", "secrets/requests"), [])
  ]);
  if (reading.get(box) !== turn) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const track = trackGone(known[box] ?? {}, sessions, recentlyStopped(box), now);
  known[box] = track.known;
  if (track.gone.length) gone[box] = [...gone[box] ?? [], ...track.gone];
  saveTracked();
  set({ reads: { ...state.reads, [box]: { sessions, gates: gates ?? [], secrets: secrets ?? [], gone: gone[box] ?? [] } }, now: Date.now(), loaded: true });
}
async function readAll() {
  const boxes = await berth.api.boxes();
  const online = boxes.filter((b) => b.state === "online").map((b) => b.name);
  await Promise.all(online.map((b) => readBox(b).catch(() => {
  })));
  const reads = Object.fromEntries(Object.entries(state.reads).filter(([b]) => online.includes(b)));
  set({ reads, now: Date.now(), loaded: true });
}
var soon = (box) => {
  window.clearTimeout(timers.get(box));
  timers.set(box, window.setTimeout(() => void readBox(box).catch(() => {
  }), 500));
};
function startFeed(ctx) {
  berth = ctx;
  const now = Date.now();
  set({ marks: pruned({ ...NO_MARKS, ...berth.storage.get("marks", NO_MARKS) }, now) });
  Object.assign(known, berth.storage.get("known", {}));
  Object.assign(gone, berth.storage.get("gone", {}));
  const onEvent = (e) => {
    if (!e.box) return;
    if (e.type === "session.stopped" && typeof e.data?.name === "string") noteStopped(e.box, e.data.name);
    soon(e.box);
  };
  const offs = ["agent.*", "session.*", "run.*", "secret.*", "box.*"].map((t) => berth.on(t, onEvent));
  void readAll();
  const every = window.setInterval(() => {
    set({ now: Date.now() });
    if (!document.hidden) void readAll();
  }, 3e4);
  return () => {
    window.clearInterval(every);
    for (const off of offs) off();
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  };
}
var transcriptPath = (s) => `sessions/${encodeURIComponent(s)}/transcript`;
var readTranscript = async (box, session) => (await berth.api.request(box, "GET", transcriptPath(session))).items ?? [];
async function readAsk(box, s) {
  if (s.ask?.choices?.length) return { choices: permissionChoices(s.ask.choices) };
  const r = await berth.api.request(box, "GET", `sessions/${encodeURIComponent(s.name)}/screen`);
  const screen = r.screen ?? "";
  const choices = permissionChoices(choicesOnScreen(screen));
  return { choices, screen: choices.length ? void 0 : screenFoot(screen) };
}
async function loadDetail(item, tries = 0) {
  if (!item.session || item.kind !== "wait" && item.kind !== "marked" && item.kind !== "exited") return;
  if (tries === 0 && state.details[item.key]?.form) return;
  if (tries === 0) set({ details: { ...state.details, [item.key]: { ...state.details[item.key], loading: !state.details[item.key] } } });
  try {
    const items = await readTranscript(item.box, item.session);
    const form = item.kind === "wait" ? openForm(items) : void 0;
    const s = item.source;
    const ask = item.kind === "wait" && !form && !s.soft_wait ? await optional(readAsk(item.box, s), { choices: [] }) : { choices: [] };
    const choices = ask.choices;
    set({ details: { ...state.details, [item.key]: { form, message: lastMessage(items), choices, ended: howItEnded(items), screen: "screen" in ask ? ask.screen : void 0 } } });
    if (item.kind === "wait" && !form && !choices.length && !s.soft_wait && tries < 3) window.setTimeout(() => void loadDetail(item, tries + 1), 800 * 2 ** tries);
  } catch (err) {
    set({ details: { ...state.details, [item.key]: { error: errText(err) } } });
  }
}
var errText = (err) => err instanceof Error ? err.message : String(err);
var noteSent = (item) => {
  mark("sent", item.key, Date.now());
  soon(item.box);
};
async function answerForm(item, tool, answers) {
  await berth.api.request(item.box, "POST", `sessions/${encodeURIComponent(item.session)}/answer`, { tool, answers });
  noteSent(item);
}
async function pressKey(item, key) {
  const sessions = await berth.api.sessions(item.box);
  const now = sessions.find((s) => s.name === item.session);
  const was = item.source;
  if (!now || now.agent_state !== "waiting" || now.turn !== was.turn) throw new Error("It has moved on: this question isn't open any more.");
  await berth.orchestrate.send(item.box, item.session, key, { enter: false, when: "now", force: true });
  noteSent(item);
}
async function reply(item, text) {
  await berth.orchestrate.send(item.box, item.session, text, { when: "idle" });
  noteSent(item);
}
async function decideGate(item, approve, note) {
  const g = item.source;
  await berth.orchestrate.runs.decide(item.box, g.id, { approve, note: note || void 0, step: g.gate?.path });
  noteSent(item);
}
var snooze = (item, until) => mark("snoozed", item.key, until);
var UNDO_MS = 5e3;
var undoTimer = 0;
async function stopSession(item) {
  noteStopped(item.box, item.session);
  await berth.api.request(item.box, "DELETE", `sessions/${encodeURIComponent(item.session)}`);
  mark("resolved", item.key, Date.now());
  soon(item.box);
}
async function unsaved(item) {
  const s = item.source;
  if (!s.location) return true;
  try {
    const r = await berth.orchestrate.exec(item.box, s.location, UNSAVED_CHECK, "30s");
    return r.exit_code !== 0 || hasUnsaved(r.output);
  } catch {
    return true;
  }
}
async function closeItem(item, note, detail) {
  if (closeKind(item.kind) === "dismiss") return mark("resolved", item.key, Date.now());
  if (item.kind === "exited" || !await unsaved(item)) return stopSession(item);
  if (detail?.screen !== void 0) throw new Error("It has unsaved work and is on a screen of its own, so it can't be told to save. Open the session to close it.");
  const told = `"${item.title}" has unsaved work, so it's saving and closing itself.`;
  if (detail?.form) await answerForm(item, detail.form.tool, closeAnswers(detail.form.questions, note));
  else {
    const deny = detail?.choices && denyChoice(detail.choices);
    if (deny) {
      await pressKey(item, deny.key);
      await berth.orchestrate.send(item.box, item.session, closeText(note), { when: "idle" });
    } else await reply(item, closeText(note));
  }
  berth.notify("Inbox", told);
}
function closeSession(item, note) {
  flushUndo();
  const detail = state.details[item.key];
  mark("sent", item.key, Date.now());
  set({ undo: { item, until: Date.now() + UNDO_MS } });
  pendingSend = () => {
    closeItem(item, note, detail).catch((err) => {
      mark("sent", item.key, void 0);
      berth.notify("Couldn't close it", `${item.title}: ${errText(err)}`);
    });
  };
  undoTimer = window.setTimeout(flushUndo, UNDO_MS);
}
var pendingSend;
function flushUndo() {
  window.clearTimeout(undoTimer);
  const send = pendingSend;
  pendingSend = void 0;
  if (state.undo) set({ undo: void 0 });
  send?.();
}
function undoClose() {
  const u = state.undo;
  window.clearTimeout(undoTimer);
  pendingSend = void 0;
  if (u) mark("sent", u.item.key, void 0);
  set({ undo: void 0 });
}
async function resume(item) {
  const list = await berth.api.request(item.box, "GET", "conversations");
  const c = list.find((x) => x.session === item.session);
  if (!c) throw new Error("This box has no conversation record for it, so it can't resume from here. Open the worktree and run the agent's own resume.");
  await berth.api.request(item.box, "POST", `conversations/${encodeURIComponent(c.id)}/resume`, {});
  mark("resolved", item.key, Date.now());
  soon(item.box);
}
var openSession = (item) => {
  if (item.session) berth.openTerminal(item.box, item.session);
};

// src/card.tsx
import { Fragment, jsx as jsx2, jsxs } from "react/jsx-runtime";
function viewKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target;
  return !(t?.closest?.("input, textarea, select, [contenteditable=true], .xterm, [data-terminal]") || document.querySelector("[data-slot=dialog-popup], [data-slot=alert-dialog-popup], [data-slot=sheet-popup], [data-slot=menu-popup], [role=menu]"));
}
var drafts = /* @__PURE__ */ new Map();
var draftOf = (key) => drafts.get(key) ?? { picks: {}, note: "" };
var Key = ({ k }) => /* @__PURE__ */ jsx2(Kbd, { className: "ml-1", children: k });
function Card({ berth: berth2, item, peekOpen, onPeek }) {
  const state2 = useSyncExternalStore(subscribe, getState);
  const detail = state2.details[item.key];
  const [error, setError] = useState();
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [draft, setDraftState] = useState(() => draftOf(item.key));
  const noteRef = useRef(null);
  const latest = useRef(draft);
  latest.current = draft;
  const setDraft = useCallback(
    (d) => {
      latest.current = d;
      drafts.set(item.key, d);
      setDraftState(d);
    },
    [item.key]
  );
  useEffect(() => {
    setDraftState(draftOf(item.key));
    setError(void 0);
    setSnoozing(false);
    void loadDetail(item);
  }, [item.key]);
  const run = useCallback(async (act) => {
    setBusy(true);
    setError(void 0);
    try {
      await act();
      drafts.delete(item.key);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }, [item.key]);
  const form = detail?.form;
  const questions = form?.questions ?? [];
  const last = questions.length - 1;
  const picksOf = (i) => ({ picks: draft.picks[i] ?? [], note: i === last ? draft.note : "" });
  const formReady = questions.length > 0 && questions.every((_, i) => complete(picksOf(i)));
  const firstOpen = (picks) => Math.max(0, questions.findIndex((_, i) => !picks[i]?.length));
  const focusQ = firstOpen(draft.picks);
  const toggle = useCallback(
    (i, label) => {
      const q = questions[i];
      const now = latest.current;
      const was = now.picks[i] ?? [];
      const next = q.multi ? was.includes(label) ? was.filter((l) => l !== label) : [...was, label] : was[0] === label ? [] : [label];
      setDraft({ ...now, picks: { ...now.picks, [i]: next } });
    },
    [questions, setDraft]
  );
  const submitForm = useCallback(() => {
    if (!form || !formReady || busy) return;
    void run(() => answerForm(item, form.tool, questions.map((q, i) => answerFor(q, picksOf(i)))));
  }, [form, formReady, busy, item, questions, draft]);
  const choices = item.kind === "wait" && !form && detail?.choices || [];
  const onItsScreen = item.kind === "wait" && detail?.screen !== void 0;
  const canReply = !form && !choices.length && !onItsScreen && !!item.session && (item.kind === "wait" || item.kind === "marked");
  const noteText = oneLine(draft.note);
  const send = useCallback(() => {
    if (form) return submitForm();
    if (canReply && noteText && !busy) void run(() => reply(item, noteText));
  }, [form, submitForm, canReply, noteText, busy, item]);
  const closing = closeKind(item.kind);
  const doClose = useCallback(() => {
    if (!closing) return;
    drafts.delete(item.key);
    closeSession(item, draft.note);
  }, [item, closing, draft.note]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && e.target?.tagName === "TEXTAREA") return e.target.blur();
      if (!viewKey(e)) return;
      if (snoozing) {
        const t = snoozeTimes(Date.now())[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          snooze(item, t.until);
        } else if (e.key === "Escape") setSnoozing(false);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        if (form) {
          const at = firstOpen(latest.current.picks);
          const o = questions[at]?.options[n];
          if (o) {
            e.preventDefault();
            toggle(at, o.label);
          }
        } else if (choices[n] && !busy) {
          e.preventDefault();
          void run(() => pressKey(item, choices[n].key));
        }
        return;
      }
      if (e.key === "Enter" && !e.target?.closest?.("button, a")) {
        e.preventDefault();
        return send();
      }
      if (e.key === "h") {
        e.preventDefault();
        setSnoozing(true);
      } else if (e.key === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (e.key === "x") {
        e.preventDefault();
        doClose();
      } else if (e.key === "o") {
        e.preventDefault();
        openSession(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snoozing, item, form, questions, focusQ, toggle, choices, busy, send, doClose]);
  const groupTitle = useMemo(() => GROUPS.find((g) => g.id === item.group)?.title, [item.group]);
  const where = [item.location, item.box].filter(Boolean).join(" \xB7 ");
  const waited = ago(item.since, state2.now);
  const gate = item.kind === "gate" ? item.source.gate : void 0;
  const loading = detail?.loading && !form;
  return /* @__PURE__ */ jsxs("div", { className: "mx-auto flex w-full flex-col gap-4 p-4", style: { maxWidth: 680 }, "data-testid": "inbox-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx2("span", { children: groupTitle }),
        where && /* @__PURE__ */ jsxs("span", { children: [
          "\xB7 ",
          where
        ] }),
        waited && /* @__PURE__ */ jsxs("span", { children: [
          "\xB7 waited ",
          waited
        ] })
      ] }),
      /* @__PURE__ */ jsx2("h2", { className: "text-base font-medium", "data-testid": "inbox-card-title", children: item.title }),
      (detail?.ended ?? item.why) && /* @__PURE__ */ jsx2("p", { className: "text-sm text-muted-foreground", "data-testid": "inbox-why", children: detail?.ended ?? item.why })
    ] }),
    didntLand(item, state2.marks, state2.now) && /* @__PURE__ */ jsx2(Alert, { variant: "warning", "data-testid": "inbox-didnt-land", children: /* @__PURE__ */ jsx2(AlertDescription, { children: "You answered this a while ago and it's still waiting. Peek at the session to see what happened." }) }),
    loading && /* @__PURE__ */ jsx2(Skeleton, { className: "h-24 w-full" }),
    detail?.error && /* @__PURE__ */ jsx2(Alert, { variant: "error", children: /* @__PURE__ */ jsxs(AlertDescription, { children: [
      "Couldn't read this session: ",
      detail.error
    ] }) }),
    detail?.message && !form && /* @__PURE__ */ jsx2("div", { className: "max-h-72 overflow-auto rounded-md border p-3 text-sm", "data-testid": "inbox-last-message", children: /* @__PURE__ */ jsx2(Markdown, { text: detail.message, openUrl: (u) => berth2.openUrl(u) }) }),
    onItsScreen && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2", "data-testid": "inbox-on-its-screen", children: [
      /* @__PURE__ */ jsx2("p", { className: "text-sm", children: "It's waiting on a screen of its own, which only keys in the session can answer." }),
      /* @__PURE__ */ jsx2("pre", { className: "max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs", children: detail?.screen }),
      /* @__PURE__ */ jsx2("div", { children: /* @__PURE__ */ jsx2(Button, { onClick: () => openSession(item), children: "Open session" }) })
    ] }),
    questions.map((q, i) => /* @__PURE__ */ jsxs("fieldset", { className: "flex flex-col gap-2", "data-testid": "inbox-question", children: [
      /* @__PURE__ */ jsx2("legend", { className: "pb-2 text-sm font-medium", children: q.question }),
      q.options.map((o, n) => {
        const on = (draft.picks[i] ?? []).includes(o.label);
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            "aria-pressed": on,
            "data-testid": "inbox-option",
            onClick: () => toggle(i, o.label),
            className: cn("flex w-full items-start gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent", on && "border-primary bg-accent"),
            children: [
              i === focusQ && /* @__PURE__ */ jsx2(Kbd, { children: n + 1 }),
              /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 flex-1 flex-col gap-0.5", children: [
                /* @__PURE__ */ jsxs("span", { className: "flex flex-wrap items-center gap-2", children: [
                  /* @__PURE__ */ jsx2("span", { className: "font-medium", children: shownLabel(o) }),
                  isRecommended(o) && /* @__PURE__ */ jsx2(Badge, { variant: "secondary", "data-testid": "inbox-recommended", children: "Recommended" })
                ] }),
                o.description && /* @__PURE__ */ jsx2("span", { className: "text-xs text-muted-foreground", children: o.description })
              ] })
            ]
          },
          o.label
        );
      })
    ] }, i)),
    choices.length > 0 && /* @__PURE__ */ jsx2("div", { className: "flex flex-wrap gap-2", "data-testid": "inbox-choices", children: choices.map((c, n) => /* @__PURE__ */ jsxs(Button, { variant: n === 0 ? "default" : "outline", disabled: busy, onClick: () => void run(() => pressKey(item, c.key)), children: [
      c.label,
      /* @__PURE__ */ jsx2(Key, { k: String(n + 1) })
    ] }, c.key)) }),
    gate && /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", "data-testid": "inbox-gate", children: [
      /* @__PURE__ */ jsx2(Button, { disabled: busy, onClick: () => void run(() => decideGate(item, true, noteText)), children: gate.approve_label ?? "Approve" }),
      /* @__PURE__ */ jsx2(Button, { variant: "outline", disabled: busy, onClick: () => void run(() => decideGate(item, false, noteText)), children: gate.reject_label ?? "Reject" })
    ] }),
    (item.kind === "gone" || item.kind === "exited") && /* @__PURE__ */ jsx2("div", { className: "flex flex-wrap gap-2", children: /* @__PURE__ */ jsx2(Button, { disabled: busy, "data-testid": "inbox-resume", onClick: () => void run(() => resume(item)), children: "Resume" }) }),
    item.kind === "secret" && /* @__PURE__ */ jsx2("p", { className: "text-sm text-muted-foreground", children: "Open the session to fill in the masked card. The value goes to the box's secret store, never through this Inbox." }),
    item.kind !== "gone" && item.kind !== "exited" && item.kind !== "secret" && !onItsScreen && /* @__PURE__ */ jsx2(
      Textarea,
      {
        ref: noteRef,
        rows: 2,
        value: draft.note,
        "data-testid": "inbox-note",
        "aria-label": form ? "Add a note" : "Reply",
        placeholder: form ? "Add a note (n)" : canReply ? "Reply to the agent (n)" : "Add a note (n)",
        onChange: (e) => setDraft({ ...draft, note: e.currentTarget.value }),
        onKeyDown: (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }
      }
    ),
    error && /* @__PURE__ */ jsx2(Alert, { variant: "error", "data-testid": "inbox-error", children: /* @__PURE__ */ jsxs(AlertDescription, { children: [
      "That didn't go through, and your answer is still here. ",
      error
    ] }) }),
    snoozing ? /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", "data-testid": "inbox-snooze", children: [
      snoozeTimes(Date.now()).map((t, n) => /* @__PURE__ */ jsxs(Button, { size: "sm", variant: "outline", onClick: () => snooze(item, t.until), children: [
        t.label,
        /* @__PURE__ */ jsx2(Key, { k: String(n + 1) })
      ] }, t.id)),
      /* @__PURE__ */ jsx2(Button, { size: "sm", variant: "ghost", onClick: () => setSnoozing(false), children: "Cancel" })
    ] }) : /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
      (form || canReply) && /* @__PURE__ */ jsxs(Button, { disabled: busy || (form ? !formReady : !noteText), "data-testid": "inbox-send", onClick: send, children: [
        form ? "Send answer" : "Send reply",
        /* @__PURE__ */ jsx2(Key, { k: form ? "\u21B5" : "\u2318\u21B5" })
      ] }),
      closing && /* @__PURE__ */ jsxs(Button, { variant: "ghost", size: "sm", "data-testid": "inbox-close", onClick: doClose, children: [
        closing === "close" ? "Close session" : "Dismiss",
        /* @__PURE__ */ jsx2(Key, { k: "x" })
      ] }),
      /* @__PURE__ */ jsxs(Button, { variant: "ghost", size: "sm", "data-testid": "inbox-snooze-open", onClick: () => setSnoozing(true), children: [
        "Snooze",
        /* @__PURE__ */ jsx2(Key, { k: "h" })
      ] }),
      item.session && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs(Button, { variant: "ghost", size: "sm", "aria-pressed": peekOpen, "data-testid": "inbox-peek-toggle", onClick: onPeek, children: [
          peekOpen ? "Hide session" : "Peek",
          /* @__PURE__ */ jsx2(Key, { k: "p" })
        ] }),
        /* @__PURE__ */ jsxs(Button, { variant: "ghost", size: "sm", "data-testid": "inbox-open", onClick: () => openSession(item), children: [
          "Open session",
          /* @__PURE__ */ jsx2(Key, { k: "o" })
        ] })
      ] })
    ] })
  ] });
}

// src/peek.tsx
import { useEvent } from "@berth/plugin";
import { Button as Button2, Icon, Skeleton as Skeleton2 } from "@berth/plugin/ui";
import { useEffect as useEffect2, useLayoutEffect, useRef as useRef2, useState as useState2 } from "react";
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var KEEP = 200;
function Row({ it, openUrl }) {
  switch (it.kind) {
    case "user":
      return /* @__PURE__ */ jsx3("div", { className: "rounded-md bg-muted p-2 text-sm", "data-testid": "peek-user", children: /* @__PURE__ */ jsx3(Markdown, { text: it.text ?? "", openUrl }) });
    case "text":
      return /* @__PURE__ */ jsx3("div", { className: "text-sm", "data-testid": "peek-text", children: /* @__PURE__ */ jsx3(Markdown, { text: it.text ?? "", openUrl }) });
    case "notice":
      return /* @__PURE__ */ jsx3("p", { className: "text-xs text-muted-foreground", "data-testid": "peek-notice", children: howItEnded([it]) ?? it.text });
    case "tools": {
      const targets = (it.items ?? []).map((t) => t.target).filter(Boolean);
      return /* @__PURE__ */ jsx3("p", { className: "truncate font-mono text-xs text-muted-foreground", children: [it.verb, targets.join(", ")].filter(Boolean).join(" ") });
    }
    case "edit":
      return /* @__PURE__ */ jsxs2("p", { className: "truncate font-mono text-xs text-muted-foreground", children: [
        "Edited ",
        it.file
      ] });
    case "ask":
      return /* @__PURE__ */ jsxs2("p", { className: "text-xs text-muted-foreground", children: [
        "Asked to use ",
        it.tool,
        ": ",
        it.detail
      ] });
    case "command":
      return /* @__PURE__ */ jsx3("p", { className: "truncate font-mono text-xs text-muted-foreground", children: it.command });
    case "question":
      return /* @__PURE__ */ jsx3("div", { className: "rounded-md border p-2 text-sm", children: it.questions?.map((q, i) => /* @__PURE__ */ jsxs2("p", { children: [
        /* @__PURE__ */ jsx3("span", { className: "font-medium", children: q.question }),
        it.answers?.[i] && /* @__PURE__ */ jsxs2("span", { className: "text-muted-foreground", children: [
          " ",
          it.answers[i]
        ] })
      ] }, i)) });
    default:
      return null;
  }
}
function Work({ summary, items, openUrl }) {
  const [open, setOpen] = useState2(false);
  return /* @__PURE__ */ jsxs2("div", { className: "flex min-w-0 flex-col gap-1", "data-testid": "peek-work", children: [
    /* @__PURE__ */ jsxs2("button", { type: "button", "aria-expanded": open, className: "flex items-center gap-1 text-left text-xs text-muted-foreground", onClick: () => setOpen(!open), children: [
      /* @__PURE__ */ jsx3(Icon, { name: open ? "ChevronDown" : "ChevronRight", className: "size-3" }),
      summary
    ] }),
    open && items.map((it) => /* @__PURE__ */ jsx3(Row, { it, openUrl }, it.id))
  ] });
}
function Peek({ berth: berth2, item, onClose }) {
  const [items, setItems] = useState2();
  const [error, setError] = useState2();
  const [tick, setTick] = useState2(0);
  const end = useRef2(null);
  const scroller = useRef2(null);
  const session = item.session;
  useEvent("agent.*", (e) => {
    if (e.box === item.box && (e.data?.session === session || e.data?.name === session)) setTick((n) => n + 1);
  });
  useEffect2(() => {
    if (!session) return;
    let alive = true;
    setError(void 0);
    readTranscript(item.box, session).then(
      (t) => alive && setItems(t.slice(-KEEP)),
      (err) => alive && setError(errText(err))
    );
    return () => {
      alive = false;
    };
  }, [item.box, session, tick]);
  useEffect2(() => setItems(void 0), [item.box, session]);
  const stuck = useRef2(true);
  useLayoutEffect(() => {
    if (stuck.current) end.current?.scrollIntoView({ block: "end" });
  }, [items]);
  return /* @__PURE__ */ jsxs2("aside", { className: "flex min-h-0 min-w-0 flex-col border-l", style: { width: "44%", flexShrink: 0 }, "data-testid": "inbox-peek", children: [
    /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2 border-b px-3 py-2", children: [
      /* @__PURE__ */ jsx3("span", { className: "min-w-0 flex-1 truncate text-sm font-medium", children: item.title }),
      /* @__PURE__ */ jsx3(Button2, { size: "xs", variant: "ghost", onClick: () => openSession(item), children: "Open" }),
      /* @__PURE__ */ jsx3(Button2, { size: "icon-xs", variant: "ghost", "aria-label": "Hide session", onClick: onClose, children: /* @__PURE__ */ jsx3(Icon, { name: "X" }) })
    ] }),
    /* @__PURE__ */ jsxs2(
      "div",
      {
        ref: scroller,
        className: "flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3",
        onScroll: (e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        },
        children: [
          error && /* @__PURE__ */ jsxs2("p", { className: "text-sm text-muted-foreground", children: [
            "Couldn't read the session: ",
            error
          ] }),
          !items && !error && /* @__PURE__ */ jsx3(Skeleton2, { className: "h-40 w-full" }),
          items?.length === 0 && /* @__PURE__ */ jsx3("p", { className: "text-sm text-muted-foreground", children: "Nothing to show from this session yet." }),
          items && peekRows(items).map((r) => r.kind === "work" ? /* @__PURE__ */ jsx3(Work, { summary: r.summary, items: r.items, openUrl: (u) => berth2.openUrl(u) }, r.id) : /* @__PURE__ */ jsx3(Row, { it: r.item, openUrl: (u) => berth2.openUrl(u) }, r.item.id)),
          /* @__PURE__ */ jsx3("div", { ref: end })
        ]
      }
    )
  ] });
}

// src/screen.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
var allItems = (s) => Object.entries(s.reads).flatMap(([box, read]) => itemsOf(box, read));
var openOf = (s) => openItems(allItems(s), s.marks, s.now);
function Row2({ item, active, now, onClick }) {
  return /* @__PURE__ */ jsxs3("button", { type: "button", "data-testid": "inbox-item", "aria-current": active || void 0, onClick, className: cn2("flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", active && "bg-accent"), children: [
    /* @__PURE__ */ jsx4("span", { className: "truncate text-sm", children: item.title }),
    /* @__PURE__ */ jsxs3("span", { className: "flex min-w-0 gap-1 text-xs text-muted-foreground", children: [
      /* @__PURE__ */ jsx4("span", { className: "min-w-0 flex-1 truncate", children: [item.location, item.box].filter(Boolean).join(" \xB7 ") }),
      /* @__PURE__ */ jsx4("span", { children: ago(item.since, now) })
    ] })
  ] });
}
function InboxScreen({ berth: berth2 }) {
  const state2 = useSyncExternalStore2(subscribe, getState);
  const open = useMemo2(() => openOf(state2), [state2.reads, state2.marks, state2.now]);
  const order = useMemo2(() => walkOrder(open), [open]);
  const groups = useMemo2(() => inList(open), [open]);
  const later = useMemo2(() => snoozedItems(allItems(state2), state2.marks, state2.now), [state2.reads, state2.marks, state2.now]);
  const [walking, setWalking] = useStorage("walking", false);
  const [peekOpen, setPeekOpen] = useStorage("peek", false);
  const [currentKey, setCurrentKey] = useState3();
  const previous = useRef3([]);
  const current = holdCurrent(order, currentKey, previous.current);
  useEffect3(() => {
    previous.current = order;
    if (current?.key !== currentKey) setCurrentKey(current?.key);
  }, [order, current?.key]);
  const root = useRef3(null);
  useEffect3(() => root.current?.focus(), []);
  const step = useCallback2((by) => setCurrentKey(nextAfter(order, current?.key, by)?.key), [order, current?.key]);
  useEffect3(() => {
    const onKey = (e) => {
      if (!viewKey(e)) return;
      const act = { j: () => step(1), k: () => step(-1), w: () => setWalking(!walking), p: () => current?.session && setPeekOpen(!peekOpen) }[e.key];
      if (act) {
        e.preventDefault();
        act();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, walking, peekOpen, current?.session]);
  const left = estimate(order);
  const at = current ? order.findIndex((i) => i.key === current.key) + 1 : 0;
  return /* @__PURE__ */ jsxs3("div", { ref: root, tabIndex: -1, className: "flex h-full min-h-0 flex-col outline-none", "data-testid": "inbox-screen", children: [
    /* @__PURE__ */ jsx4(
      ViewHeader,
      {
        title: "Inbox",
        description: state2.loaded ? /* @__PURE__ */ jsx4("span", { "data-testid": "inbox-left", children: left }) : void 0,
        actions: /* @__PURE__ */ jsxs3("div", { className: "flex items-center gap-2", children: [
          walking && order.length > 0 && /* @__PURE__ */ jsxs3("span", { className: "text-xs text-muted-foreground", "data-testid": "inbox-position", children: [
            at,
            " of ",
            order.length
          ] }),
          /* @__PURE__ */ jsxs3(Button3, { size: "sm", variant: walking ? "default" : "outline", "aria-pressed": walking, "data-testid": "inbox-walk", onClick: () => setWalking(!walking), children: [
            walking ? "Show list" : "Walk through",
            /* @__PURE__ */ jsx4(Kbd2, { className: "ml-1", children: "w" })
          ] })
        ] })
      }
    ),
    !state2.loaded && /* @__PURE__ */ jsxs3("div", { className: "flex flex-col gap-2 p-4", children: [
      /* @__PURE__ */ jsx4(Skeleton3, { className: "h-10 w-full" }),
      /* @__PURE__ */ jsx4(Skeleton3, { className: "h-10 w-full" }),
      /* @__PURE__ */ jsx4(Skeleton3, { className: "h-10 w-full" })
    ] }),
    state2.loaded && !current && /* @__PURE__ */ jsx4(Empty, { "data-testid": "inbox-empty", className: "flex-1", children: /* @__PURE__ */ jsxs3(EmptyHeader, { children: [
      /* @__PURE__ */ jsx4(EmptyTitle, { children: "Nothing needs you" }),
      /* @__PURE__ */ jsx4(EmptyDescription, { children: later.length ? `${later.length} snoozed. They come back when it's time.` : "Agents post here when they need a decision, an action or your review." })
    ] }) }),
    current && /* @__PURE__ */ jsxs3("div", { className: "flex min-h-0 flex-1", children: [
      !walking && /* @__PURE__ */ jsxs3("nav", { className: "flex min-h-0 flex-col gap-3 overflow-auto border-r p-2", style: { width: 300, flexShrink: 0 }, "data-testid": "inbox-list", "aria-label": "Inbox items", children: [
        groups.map(
          (g) => g.items.length === 0 ? null : /* @__PURE__ */ jsxs3("section", { "data-testid": `inbox-group-${g.group}`, children: [
            /* @__PURE__ */ jsxs3("h3", { className: "flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground", children: [
              g.title,
              /* @__PURE__ */ jsx4(Badge2, { variant: "secondary", children: g.items.length })
            ] }),
            g.items.map((it) => /* @__PURE__ */ jsx4(Row2, { item: it, now: state2.now, active: it.key === current.key, onClick: () => setCurrentKey(it.key) }, it.key))
          ] }, g.group)
        ),
        later.length > 0 && /* @__PURE__ */ jsxs3("p", { className: "px-2 text-xs text-muted-foreground", "data-testid": "inbox-snoozed-count", children: [
          later.length,
          " snoozed"
        ] })
      ] }),
      /* @__PURE__ */ jsx4("main", { className: "min-h-0 min-w-0 flex-1 overflow-auto", children: /* @__PURE__ */ jsx4(Card, { berth: berth2, item: current, peekOpen: peekOpen && !!current.session, onPeek: () => setPeekOpen(!peekOpen) }, current.key) }),
      peekOpen && current.session && /* @__PURE__ */ jsx4(Peek, { berth: berth2, item: current, onClose: () => setPeekOpen(false) })
    ] }),
    state2.undo && /* @__PURE__ */ jsxs3("div", { className: "flex items-center gap-2 border-t px-4 py-2 text-sm", role: "status", "data-testid": "inbox-undo", children: [
      /* @__PURE__ */ jsxs3("span", { className: "min-w-0 flex-1 truncate", children: [
        'Closing "',
        state2.undo.item.title,
        '" in a few seconds.'
      ] }),
      /* @__PURE__ */ jsx4(Button3, { size: "sm", variant: "outline", onClick: undoClose, children: "Undo" })
    ] })
  ] });
}

// src/index.tsx
import { jsx as jsx5 } from "react/jsx-runtime";
function useOpenCount() {
  return useSyncExternalStore3(subscribe, () => openOf(getState()).length);
}
var index_default = definePlugin((berth2) => {
  const stop = startFeed(berth2);
  berth2.addScreen({ id: "inbox", title: "Inbox", layout: "fill", Component: () => /* @__PURE__ */ jsx5(InboxScreen, { berth: berth2 }) });
  berth2.addSidebarItem({ id: "inbox", title: "Inbox", icon: "Inbox", screen: "inbox", useCount: useOpenCount });
  berth2.addCommand({ id: "open", title: "Open Inbox", group: "Inbox", run: () => berth2.openScreen("inbox") });
  return stop;
});
export {
  index_default as default
};
