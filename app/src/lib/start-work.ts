import { toastError } from "@/components/error-note";
import { noteTmuxMissing, tmuxMissing } from "@/components/requirements-card";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { agentPresets } from "@/lib/actions";
import { offerAgentHooks } from "@/lib/agent-hooks";
import type { Session, TaskResult, Worktree } from "@/lib/api";
import { ApiError, boxApi } from "@/lib/api";
import { startBroadcast } from "@/lib/broadcast";
import type { AgentPick, ComposerTarget } from "@/lib/composer";
import { agentLabel } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import { handoff, loop, review } from "@/lib/orchestrate";
import { worktreeSlug } from "@/lib/projects";
import { usePrompts } from "@/lib/prompts";
import { boxHasRuns, runs, scheduleRuns } from "@/lib/runs";
import { save } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { findSession, focusSession, selectWorktree, setPaneContent, splitPane } from "@/lib/workspaces";

// startWork does what the composer gathered (lib/composer): a task in a new
// worktree, an agent in the main checkout or a worktree already open, a
// worktree alone, several attempts compared by a judge, a hand-off or a
// review of another session, or a prompt for agents already running. It
// says how it went in toasts and resolves to whether it started.

export interface StartDraft {
  text: string;
  box: string;
  location: string;
  // new: a new worktree; main: the main checkout; here: the worktree at
  // `at` ("shop" or "shop/checkout-fix"), already open.
  where: "new" | "main" | "here";
  at?: string;
  // One is a task, several are attempts, none is the worktree alone.
  picks: AgentPick[];
  // The new worktree: its name, branch and base, the pull request or ref it
  // checks out, and a template's command instead of the agent's.
  worktree?: { name?: string; branch?: string; base?: string; pr?: number; ref?: string; command?: string };
  attempts?: AttemptOptions;
  from?: { kind: "handoff" | "review"; box: string; session: string };
}

export interface AttemptOptions {
  check: string;
  judge: string;
  // Take the judge's pick (one box only), and open a draft PR for the pick.
  auto: boolean;
  pr: boolean;
  // Per attempt, in the order of the picks: a line added to its prompt, and
  // another box with the project to run it on.
  extras: { suffix?: string; box?: string }[];
  base?: string;
}

export interface SendDraft {
  targets: ComposerTarget[];
  // Each target's own text, its variables filled in.
  texts: string[];
  title: string;
  wait: boolean;
  queueOffline: boolean;
  promptId?: string;
  loop?: { check: string; rounds: number; location?: string };
}

// The name a task's worktree gets from its prompt: its first words.
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 32) || "task";

// A name for a worktree nobody named: short, readable, unlikely to clash.
const words = ["amber", "brisk", "cedar", "dune", "ember", "fern", "harbor", "iris", "juniper", "kelp", "lumen", "maple", "north", "olive", "pine", "quartz", "reed", "sable", "tidal", "umber"];
export const randomName = () => `${words[Math.floor(Math.random() * words.length)]}-${Math.random().toString(36).slice(2, 6)}`;

// freeName is name, or name-2, -3… when the project has a worktree by it.
export function freeName(box: string, location: string, name: string): string {
  const taken = new Set(useStore.getState().boxes[box]?.locations?.find((l) => l.name === location)?.worktrees?.map((w) => w.name));
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${name}-${i}`;
  return n;
}

const fail = (title: string, err: unknown, box?: string) => {
  // The box has no tmux: its card (the composer's, onboarding's) says how
  // to install it, once it has asked the box again.
  if (box && err instanceof ApiError && err.code === "tmux_missing") noteTmuxMissing(box);
  toastError(err, { title, box });
  return false;
};

export async function startWork(d: StartDraft): Promise<boolean> {
  const client = useStore.getState().client;
  if (!client) return false;
  if (d.from) return follow(d);
  if (d.picks.length > 1) return startAttempts(d);
  const pick = d.picks[0];
  const presets = agentPresets(d.box, d.location);
  // An agent can't start without tmux: say so before a worktree is made.
  if (pick && tmuxMissing(d.box)) return fail("Couldn't start it", new ApiError("tmux is not installed on this box", 503, "tmux_missing"), d.box);
  try {
    let session: string | undefined;
    if (!pick) {
      // The worktree alone.
      const wt = await client.box<Worktree>(d.box, "POST", `locations/${encodeURIComponent(d.location)}/worktrees`, {
        name: d.worktree?.name || randomName(),
        branch: d.worktree?.branch || undefined,
        base: d.worktree?.base || undefined,
        pr: d.worktree?.pr,
        ref: d.worktree?.ref,
      });
      await useStore.getState().refreshBox(d.box, ["locations", "sessions"]);
      selectWorktree({ box: d.box, location: d.location, worktree: wt.name, path: wt.path, main: wt.main });
      toastManager.add({ type: "success", title: `Created ${wt.name}`, description: `${wt.branch ?? ""} on ${d.box}` });
      return true;
    }
    const how = { agent: pick.agent, prompt: d.text || undefined, model: pick.model || undefined, effort: pick.effort || undefined };
    if (d.where === "new") {
      const name = d.worktree?.name || freeName(d.box, d.location, d.text ? slug(d.text) : randomName());
      const res = await client.box<TaskResult>(d.box, "POST", "tasks", {
        location: d.location,
        name,
        branch: d.worktree?.branch || undefined,
        base: d.worktree?.base || undefined,
        pr: d.worktree?.pr,
        ref: d.worktree?.ref,
        ...how,
        ...(d.worktree?.command ? { agent: undefined, command: d.worktree.command, model: undefined, effort: undefined } : {}),
      });
      session = res.session.name;
    } else {
      session = (await boxApi.startSession(client, d.box, { location: d.where === "here" ? (d.at ?? d.location) : d.location, ...how })).name;
    }
    // The demo plays a scripted turn; it starts before the pane opens, so
    // the pane finds the conversation already begun.
    if (isMock() && d.text) void import("@/lib/mock-conversation").then((m) => m.playTurn(d.box, session, d.text));
    await useStore.getState().refreshBox(d.box, ["locations", "sessions"]);
    await focusSession(d.box, session);
    save(`berth.composer.picks.${d.box}/${d.location}`, d.picks);
    void offerAgentHooks(d.box, d.worktree?.command ?? presets.find((p) => p.id === pick.agent)?.command ?? pick.agent, session);
    return true;
  } catch (err) {
    return fail("Couldn't start it", err, d.box);
  }
}

// startAttempts runs the attempts template: each pick tries the task in its
// own worktree, a check verifies them (sending the failing tail back for a
// round or two), a judge ranks them, and the pick gets a draft PR. Attempts
// may run on other boxes with the project: one run per box, grouped, and
// compared together in Review.
async function startAttempts(d: StartDraft): Promise<boolean> {
  const o = d.attempts ?? { check: "", judge: "claude", auto: false, pr: true, extras: [] };
  if (!boxHasRuns(d.box)) return fail("Couldn't try several ways", new Error(`${d.box} runs an older berthd without runs. Upgrade it from Settings → Boxes.`), d.box);
  const list = d.picks.map((p, i) => ({ ...p, suffix: o.extras[i]?.suffix?.trim() ?? "", box: o.extras[i]?.box || d.box }));
  const byBox = new Map<string, typeof list>();
  for (const a of list) byBox.set(a.box, [...(byBox.get(a.box) ?? []), a]);
  const group = byBox.size > 1 ? `g_${Date.now().toString(36)}` : undefined;
  if (o.check.trim()) save(`berth.loop.check.${d.box}/${d.location}`, o.check.trim());
  const name = worktreeSlug(d.worktree?.name || d.text.split("\n")[0]).slice(0, 24) || "attempt";
  try {
    let first: { box: string; id: string } | undefined;
    for (const [box, items] of byBox) {
      const run = await runs.start(box, {
        template: "attempts",
        group,
        params: {
          location: d.location,
          name,
          prompt: d.text.trim(),
          base: o.base ?? d.worktree?.base ?? "",
          attempts: items.map((a) => ({
            agent: a.agent,
            ...(a.model ? { model: a.model } : {}),
            ...(a.effort ? { effort: a.effort } : {}),
            ...(a.suffix ? { prompt_suffix: a.suffix } : {}),
          })),
          verify: { check: o.check.trim() || "true", max_rounds: 2 },
          judge: { by: "agent", agent: o.judge, criteria: "correctness, tests, the smallest diff that does it" },
          pick: o.auto && !group ? "auto" : "human",
          then: o.pr ? { pr: { draft: true } } : {},
        },
      });
      scheduleRuns(box, 0);
      first ??= { box, id: run.id };
    }
    save(`berth.composer.picks.${d.box}/${d.location}`, d.picks);
    const run = first!;
    toastManager.add({
      type: "success",
      title: `Trying ${list.length} ways on ${[...byBox.keys()].join(" and ")}`,
      description: o.auto ? "The judge's pick, if its check passes, gets a draft PR." : "You pick in Review once the judge has ranked them.",
      actionProps: { children: "Compare", onClick: () => useStore.getState().setView({ kind: "review", run: { box: run.box, id: run.id } }) },
    });
    return true;
  } catch (err) {
    return fail("Couldn't try several ways", err, d.box);
  }
}

// follow hands a session's work to another agent, or has one review it. The
// new agent opens beside the session while it starts; a hand-off to a new
// worktree says so instead.
async function follow(d: StartDraft): Promise<boolean> {
  const f = d.from!;
  const pick = d.picks[0];
  if (!pick) return false;
  const wt = f.kind === "handoff" && d.where === "new" ? { name: d.worktree?.name || freeName(d.box, d.location, slug(d.text)) } : undefined;
  const at = !wt ? findSession(f.box, f.session) : undefined;
  const pane = at ? splitPane(at.key, at.tab, at.pane.id, "row", { kind: "starting", label: agentLabel(pick.agent) }) : undefined;
  const started = (s: Session) => at && pane && setPaneContent(at.key, at.tab, pane, { kind: "terminal", box: f.box, session: s.name });
  const start =
    f.kind === "review"
      ? review({ box: f.box, from: f.session, agent: pick.agent, prompt: d.text, onStarted: started })
      : handoff({ box: f.box, from: f.session, location: d.at, agent: pick.agent, prompt: d.text, worktree: wt, onStarted: started });
  void start.catch((err) => {
    if (at && pane) setPaneContent(at.key, at.tab, pane, { kind: "error", message: plainError(err, { box: f.box }) });
    else fail(f.kind === "review" ? "Review failed" : "Hand off failed", err, f.box);
  });
  if (wt) toastManager.add({ title: `Starting ${agentLabel(pick.agent)} in ${wt.name}`, type: "info" });
  return true;
}

// sendWork sends a prompt to agents already running: one after another, so
// a box that fails or is slow never leaves the rest half sent; or starts a
// loop on each, prompting until its check passes.
export function sendWork(d: SendDraft): boolean {
  if (d.promptId) usePrompts.getState().used([d.promptId]);
  if (d.loop) {
    try {
      for (const [i, t] of d.targets.entries()) loop({ box: t.box, session: t.session, prompt: d.texts[i].trim(), check: d.loop.check.trim(), max: d.loop.rounds });
      if (d.loop.location) save(`berth.loop.check.${d.targets[0].box}/${d.loop.location}`, d.loop.check.trim());
      return true;
    } catch (err) {
      return fail("Couldn't start the loop", err);
    }
  }
  save("berth.broadcast.wait", d.wait);
  startBroadcast({ title: d.title, wait: d.wait, queueOffline: d.queueOffline, items: d.targets.map((t, i) => ({ ...t, text: d.texts[i] })) });
  return true;
}
