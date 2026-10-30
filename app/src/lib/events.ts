import { create } from "zustand";

import type { BerthEvent } from "@/lib/api";
import { handleBrowserOpened } from "@/lib/agent-browser-open";
import { handleArtifactEvent } from "@/lib/art/model";
import { agentLabel, agentOf, sessionAgent, sessionName } from "@/lib/derive";
import { isLive, useLoops } from "@/lib/loops";
import { flowKey, resolveFromEvent, route, secretKey, secretRequestKey, serviceKey } from "@/lib/notifications";
import { askLine, SECRET_TOOL } from "@/lib/secret-request";
import { handlePreview } from "@/lib/preview";
import { handleQueueEvent } from "@/lib/queue";
import { scheduleRuns } from "@/lib/runs";
import { handleTeamEvent } from "@/lib/team";
import { handleSessionOpen } from "@/lib/session-open";
import { handleSkillsEvent } from "@/lib/skills-notice";
import { archiveFailed, worktreeGone } from "@/lib/remove-worktree";
import { markRemoving, markScript, removalOf, useRemovals } from "@/lib/removing";
import { type BoxPart, scheduleRefresh, useStore } from "@/lib/store";
import { noteTranscriptChanged } from "@/lib/transcript-pings";
import { dispatch } from "@/plugins/registry";
import { titleAt } from "@/lib/worktree-names";

// What each kind of event invalidates on its box.
const refreshes: [prefix: string, parts: BoxPart[]][] = [
  ["location.", ["locations", "services"]],
  ["worktree.", ["locations", "services"]],
  ["session.", ["sessions"]],
  // A service in a terminal is a session too.
  ["service.", ["sessions", "services"]],
  ["agent.", ["sessions", "stats"]],
  // A task is a new worktree and the agent in it.
  ["task.", ["locations", "sessions"]],
  // A PR review opened, moved on or removed: its worktree and its mark.
  ["review.", ["locations"]],
  // Agent CLIs added or found on the box: the agents it offers.
  ["agents.", ["info"]],
  // A secret asked for, saved, declined or timed out: the session's card.
  ["secret.", ["sessions"]],
];

// The most recent events, newest first, for the Automations view.
export const useEventLog = create<{ events: BerthEvent[] }>()(() => ({ events: [] }));

// handleEvent is the one place events land: plugins hear them, the store
// refetches what they changed, and agents that need someone notify.
export function handleEvent(e: BerthEvent) {
  // An agent wrote to a transcript a chat shows: chatter, a few a second,
  // for that chat alone (lib/transcript-pings).
  if (e.type === "transcript.changed") return noteTranscriptChanged(e);
  useEventLog.setState((s) => ({ events: [e, ...s.events].slice(0, 200) }));
  dispatch(e);
  const store = useStore.getState();

  if (e.type.startsWith("box.") || e.type.startsWith("forward.")) {
    void store.refreshStatus();
    const name = (e.data?.box as string | undefined) ?? e.box;
    if (e.type === "box.connected" && name) scheduleRefresh(name, ["locations", "sessions", "stats", "services", "info"]);
  }
  if (e.box && (e.type.startsWith("run.") || e.type.startsWith("flow."))) scheduleRuns(e.box);
  if (e.box) {
    for (const [prefix, parts] of refreshes) {
      if (e.type.startsWith(prefix)) scheduleRefresh(e.box, parts);
    }
  }

  // Prompts queued for a box that was away: the list, and what came of them.
  if (e.type.startsWith("queue.")) handleQueueEvent(e);
  // A team setup's runner on a box, or a newer commit of one (lib/team).
  if (e.type.startsWith("team.") || e.type === "box.connected") handleTeamEvent(e);
  // A box's skills installed or removed, or the reminder's snooze changed
  // in another window (lib/skills-notice).
  if (e.type.startsWith("skills.") || e.type === "app.changed") handleSkillsEvent(e);
  notifyFor(e);
}

// notifyFor turns the events that concern the person into notifications,
// through the centre's router, and settles the ones whose cause cleared.
function notifyFor(e: BerthEvent) {
  resolveFromEvent(e);
  const d = e.data ?? {};
  const box = e.box;
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));

  if (e.type === "agent.waiting" || e.type === "agent.finished") {
    const where = describeAgent(e);
    const waiting = e.type === "agent.waiting";
    // A loop ends a turn every round and says itself how it went, so its
    // agent finishing is not news.
    const sessions = box ? useStore.getState().boxes[box]?.sessions : undefined;
    const looped = !waiting && useLoops.getState().loops.some((l) => isLive(l) && l.box === box && (l.session === where.session || (!!where.path && sessions?.find((s) => s.name === l.session)?.dir === where.path)));
    // Waiting on a secret it asked for: secret.requested says that, better.
    const forSecret = waiting && (d.tool === SECRET_TOOL || sessions?.find((s) => s.name === where.session)?.ask?.tool === SECRET_TOOL);
    // Stopped from the chat (Esc, Stop): the person knows; it isn't done.
    if (!looped && !forSecret && d.source !== "interrupt") {
      route({
        category: waiting ? "waiting" : "finished",
        title: waiting ? `${where.agent} needs you` : `${where.agent} is done`,
        tone: waiting ? "warning" : "success",
        box,
        path: where.path,
        project: where.project,
        worktree: where.worktree,
        session: where.session,
        action: where.session && box ? { kind: "session", box, session: where.session } : where.path && box ? { kind: "worktree", box, path: where.path } : undefined,
        // Each agent its own row, even several in one worktree.
        key: `${waiting ? "waiting" : "finished"}|${box}|${where.session ?? where.path ?? where.agent}`,
      });
    }
  }
  if (e.type === "preview.open") handlePreview(e);
  // An agent opened its browser: its live view beside it, when it's showing.
  if (e.type === "browser.opened") handleBrowserOpened(e);
  // An artifact added, rewritten or removed: the worktree's list, live.
  if (e.type.startsWith("artifact.")) handleArtifactEvent(e);
  if (e.type === "session.open") handleSessionOpen(e);
  // A removed worktree's workspace goes too, wherever it was removed from;
  // one being archived (from here, the CLI or another laptop) shows as
  // Archiving… until then, and comes back if archiving fails.
  if (e.type === "worktree.removed" && box && str(d.path)) worktreeGone(box, str(d.path)!);
  if (e.type === "worktree.archive.started" && box && str(d.path)) {
    if (!removalOf(useRemovals.getState().byKey, box, str(d.path)!)) markRemoving(box, str(d.path)!, "archive", str(d.name));
    markScript(box, str(d.path)!);
  }
  if (e.type === "worktree.archive.failed" && box && str(d.path)) archiveFailed(box, str(d.path)!);
  if (e.type === "worktree.setup.failed" || e.type === "worktree.archive.failed") {
    const name = str(d.name);
    route({
      category: "setupFailed",
      title: `${e.type === "worktree.archive.failed" ? "Archiving" : "Setup"} failed for ${(box && str(d.path) && titleAt(box, str(d.path)!)) || name || "a worktree"}`,
      detail: e.error,
      tone: "error",
      box,
      path: str(d.path),
      project: str(d.location),
      worktree: name !== d.location ? name : undefined,
      action: box ? { kind: "worktree", box, path: str(d.path), location: str(d.location), worktree: name } : undefined,
      key: `setupFailed|${box}|${d.path ?? `${d.location}/${name}`}`,
    });
  }
  if (e.type === "service.failed" && box) {
    const wt = str(d.name);
    route({
      category: "serviceFailed",
      title: `${str(d.service) ?? "A service"} failed to start`,
      detail: str(d.error) ?? e.error,
      tone: "error",
      box,
      path: str(d.path),
      project: str(d.location),
      worktree: wt !== d.location ? wt : undefined,
      action: { kind: "worktree", box, path: str(d.path), location: str(d.location), worktree: wt },
      key: serviceKey(box, d.location, d.name, d.service),
    });
  }
  if (e.type === "flow.finished" && d.status === "failed" && box) {
    const flow = str(d.flow) ?? "An automation";
    route({
      category: "flowFailed",
      title: `${flow} failed`,
      detail: e.error ?? (d.run ? `Run ${String(d.run).slice(0, 8)}` : undefined),
      tone: "error",
      box,
      path: str(d.path),
      action: { kind: "run", box, flow: str(d.flow), scope: str(d.scope), run: str(d.run) },
      key: flowKey(box, d.flow, d.scope),
    });
  }
  if (e.type === "guard.acted" && box) {
    const services = Array.isArray(d.services) ? (d.services as string[]) : [];
    const place = [d.location, d.name !== d.location ? d.name : undefined].filter(Boolean).join("/");
    route({
      category: "guard",
      title: d.action === "pause_worktree" ? `Paused ${place || "a worktree"} to free memory` : `Stopped ${services.join(", ") || "services"} to free memory`,
      detail: str(d.reason) ?? (d.memory_percent ? `Memory was at ${Math.round(Number(d.memory_percent))}%` : undefined),
      tone: "warning",
      box,
      path: str(d.path),
      project: str(d.location),
      worktree: d.name !== d.location ? str(d.name) : undefined,
      action: { kind: "worktree", box, path: str(d.path), location: str(d.location), worktree: str(d.name) },
      key: `guard|${box}|${d.action}|${d.path ?? place}`,
    });
  }
  if (e.type === "kit.installed" && box && Array.isArray(d.warnings) && d.warnings.length) {
    const warnings = d.warnings as string[];
    route({
      category: "kit",
      title: `${str(d.kit) ?? "A kit"} installed with ${warnings.length === 1 ? "a warning" : `${warnings.length} warnings`}`,
      detail: warnings[0],
      tone: "warning",
      box,
      project: str(d.location),
      action: d.location ? { kind: "project", box, location: String(d.location) } : undefined,
      key: `kit|${box}|${d.location}|${d.kit}`,
    });
  }
  // A variable naming a secret was left unset. The event never carries the
  // value, only which variable, its reference and why.
  if (e.type === "secret.failed" && box) {
    const variable = str(d.variable) ?? "A variable";
    const wt = str(d.name);
    route({
      category: "secret",
      title: `${variable} was left unset`,
      detail: [str(d.reason) ?? e.error, str(d.ref)].filter(Boolean).join(" · ") || undefined,
      tone: "warning",
      box,
      path: str(d.path),
      project: str(d.location),
      worktree: wt !== d.location ? wt : undefined,
      action: d.location ? { kind: "project", box, location: String(d.location) } : undefined,
      key: secretKey(box, d.location, d.variable),
    });
  }
  // An agent asks for a secret: it waits on the person as at a question.
  // The event names the secret and why, never a value; the card in its
  // chat (or on the board) takes it. Settled by secret.request.ended.
  if (e.type === "secret.requested" && box) {
    // The event names the session, not its folder: the folder is its.
    const dir = useStore.getState().boxes[box]?.sessions?.find((s) => s.name === d.session)?.dir;
    const where = describeAgent({ ...e, data: { ...d, path: d.path ?? dir } });
    const session = str(d.session) ?? where.session;
    const name = str(d.name) ?? "a secret";
    route({
      category: "waiting",
      title: `${where.agent} asks for a secret`,
      detail: askLine({ name, reason: str(d.reason) }),
      tone: "warning",
      box,
      path: where.path,
      project: where.project ?? str(d.location),
      worktree: where.worktree,
      session,
      action: session ? { kind: "session", box, session } : str(d.location) ? { kind: "project", box, location: str(d.location)! } : undefined,
      key: secretRequestKey(box, d.id),
    });
  }
  // A flow's notify step: its own title and body, from whichever box.
  if (e.type === "notify") {
    const path = str(d.path);
    const [loc, wt] = (str(d.location) ?? "").split("/");
    route({
      category: "notify",
      title: str(d.title) ?? "Shipyard",
      detail: str(d.body),
      box,
      path,
      project: loc || undefined,
      worktree: wt || undefined,
      action: box && (path || loc) ? { kind: "worktree", box, path, location: loc || undefined, worktree: wt || undefined } : undefined,
      key: `notify|${box}|${d.flow ?? ""}|${d.title}`,
    });
  }
}

// describeAgent names an agent event's agent and place the same way every
// time: "Claude Code 2" in "shop / qa-deck · devl". The event names its
// session when Shipyard started the agent; otherwise the agent in that
// worktree is it, when there is only one. With several and no name, the
// agent's plain name is all that can be said.
function describeAgent(e: BerthEvent): { agent: string; place: string; session?: string; path?: string; project?: string; worktree?: string } {
  const path = e.data?.path as string | undefined;
  const named = e.data?.session as string | undefined;
  const data = e.box ? useStore.getState().boxes[e.box] : undefined;
  const kind = (e.data?.agent as string | undefined) ?? e.origin;
  const here = (data?.sessions ?? []).filter((s) => s.dir === path && !s.exited);
  const agents = here.filter((s) => agentOf(s) && (!kind || agentOf(s) === kind || (kind === "cursor" && agentOf(s) === "cursor-agent")));
  const session = (named ? data?.sessions?.find((s) => s.name === named) : undefined) ?? (agents.length === 1 ? agents[0] : here.length === 1 ? here[0] : undefined);
  const loc = data?.locations?.find((l) => l.worktrees?.some((w) => w.path === path));
  const wt = loc?.worktrees?.find((w) => w.path === path);
  const raw = (session && agentOf(session)) ?? kind ?? "an agent";
  const where = loc && wt ? (wt.main ? loc.name : `${loc.name} / ${wt.name}`) : (path?.split("/").pop() ?? "");
  // Named after its work when it has a title ("Fix checkout webhook
  // finished"), its agent then first in the place below it.
  const place = [session && sessionAgent(session), where, e.box].filter(Boolean).join(" · ");
  const agent = session ? sessionName(session, { sessions: data?.sessions }) : agentLabel(raw);
  return { agent, place, session: session?.name, path, project: loc?.name ?? path?.split("/").pop(), worktree: wt && !wt.main ? wt.name : undefined };
}
