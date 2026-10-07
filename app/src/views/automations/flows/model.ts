import { BellIcon, BotIcon, HourglassIcon, MessageSquareTextIcon, SquareTerminalIcon, WebhookIcon , WorkflowIcon } from "lucide-react";

import type { GitHubOn, Flow, Step, StepKind, StepWhen } from "@/lib/flows";
import { CATALOG } from "@/views/automations/catalog";

// What each kind of step is, for the editor's cards and the "+" menu.
export const STEP_KINDS: Record<StepKind, { label: string; hint: string; Icon: typeof BellIcon; tone: string }> = {
  run: { label: "Run a command", hint: "In the worktree, with its environment and ports.", Icon: SquareTerminalIcon, tone: "text-sky-400" },
  prompt: { label: "Tell the agent", hint: "Type a prompt into the agent's session.", Icon: MessageSquareTextIcon, tone: "text-[#d97757]" },
  wait: { label: "Wait for the agent", hint: "Until its turn ends, or it needs you.", Icon: HourglassIcon, tone: "text-violet-400" },
  start_agent: { label: "Start an agent", hint: "Here, or in a new worktree.", Icon: BotIcon, tone: "text-emerald-400" },
  notify: { label: "Notify me", hint: "A notification on this laptop.", Icon: BellIcon, tone: "text-amber-400" },
  webhook: { label: "Call a webhook", hint: "POST JSON to Slack, Linear, anything.", Icon: WebhookIcon, tone: "text-pink-400" },
};

// kindMeta is a step kind's look, with a plain one for the run step kinds
// (loop, gate, map, …) the editor shows but does not edit.
export function kindMeta(kind: string): (typeof STEP_KINDS)[StepKind] {
  return STEP_KINDS[kind as StepKind] ?? { label: kind, hint: "A run step; edit it in the flow's JSON.", Icon: WorkflowIcon, tone: "text-muted-foreground" };
}

export const isEditableKind = (kind: string) => kind in STEP_KINDS;

export const KIND_ORDER: StepKind[] = ["run", "prompt", "wait", "start_agent", "notify", "webhook"];

export const WHEN_LABEL: Record<StepWhen, string> = {
  success: "If the previous step succeeds",
  failure: "If the previous step fails",
  always: "Always",
};

// The events a flow can start from: anything a box announces, not gates.
export const TRIGGERS = CATALOG.filter((e) => !e.gate && e.where === "box");

const TRIGGER_PHRASE: Record<string, string> = {
  "agent.finished": "an agent finishes its turn",
  "agent.waiting": "an agent needs you",
  "agent.started": "an agent starts working",
  "agent.ready": "an agent opens",
  "worktree.created": "a worktree is created",
  "worktree.removed": "a worktree is removed",
  "worktree.setup.finished": "setup finishes",
  "worktree.setup.failed": "setup fails",
  "worktree.archive.finished": "a worktree is archived",
  "task.created": "a task starts",
  "session.started": "a session starts",
  "session.stopped": "a session stops",
  "exec.finished": "a command finishes",
  "location.added": "a repo is added",
  "share.started": "a port is shared",
  "unit.restarted": "a unit restarts",
  "box.upgraded": "the box is upgraded",
};

const AGENT_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", cursor: "Cursor", grok: "Grok" };
export const agentName = (id?: string) => (id ? (AGENT_NAME[id] ?? id) : "an agent");

export const GITHUB_ONS: { on: GitHubOn; label: string; phrase: string; fields: string[] }[] = [
  { on: "review_comment", label: "A comment lands on the PR", phrase: "a comment lands on the worktree's PR", fields: ["author", "body", "file", "line", "url", "pr", "title"] },
  { on: "pr_review", label: "A review is submitted", phrase: "a review is submitted on the worktree's PR", fields: ["author", "state", "body", "url", "pr", "title"] },
  { on: "check_failed", label: "A check fails", phrase: "a check fails on the worktree's PR", fields: ["check", "state", "url", "pr", "title"] },
  { on: "pr_merged", label: "The PR is merged", phrase: "the worktree's PR is merged", fields: ["url", "pr", "title"] },
];

export const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: "0 2 * * *", label: "Every night at 02:00" },
  { value: "0 9 * * 1-5", label: "Weekdays at 09:00" },
  { value: "@hourly", label: "Every hour" },
  { value: "*/15 * * * *", label: "Every 15 minutes" },
  { value: "0 8 * * 1", label: "Mondays at 08:00" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const two = (n: string) => n.padStart(2, "0");

// describeCron says when a schedule runs, in plain words for the common
// shapes; anything else reads as the expression itself. The box checks it.
export function describeCron(expr: string): string {
  const e = expr.trim();
  const short: Record<string, string> = { "@hourly": "Every hour", "@daily": "Every day at 00:00", "@midnight": "Every day at 00:00", "@weekly": "Sundays at 00:00", "@monthly": "On the 1st of every month at 00:00", "@yearly": "Every 1 January at 00:00", "@annually": "Every 1 January at 00:00" };
  if (short[e]) return short[e];
  const f = e.split(/\s+/);
  if (f.length !== 5) return "Five fields: minute hour day month weekday, or @daily";
  const [m, h, dom, mon, dow] = f;
  const num = /^\d+$/;
  const at = num.test(m) && num.test(h) ? `at ${two(h)}:${two(m)}` : "";
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${m.slice(2)} minutes`;
  if (num.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at :${two(m)}`;
  if (at && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day ${at}`;
    if (dow === "1-5") return `Weekdays ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends ${at}`;
    if (num.test(dow) && Number(dow) <= 7) return `${DAYS[Number(dow)]}s ${at}`;
  }
  if (at && num.test(dom) && mon === "*" && dow === "*") return `On day ${dom} of every month ${at}`;
  return `On the schedule ${e}`;
}

export function triggerPhrase(flow: Flow): string {
  const { where = {} } = flow.trigger;
  const event = flow.trigger.event ?? "";
  if (flow.trigger.schedule) {
    let s = describeCron(flow.trigger.schedule).replace(/^./, (c) => c.toLowerCase());
    s += flow.trigger.each_worktree ? ", for each worktree" : "";
    if (where.location) s += ` in ${where.location}`;
    if (where.branch) s += ` on ${where.branch}`;
    return s;
  }
  if (flow.trigger.github) {
    let s = GITHUB_ONS.find((g) => g.on === flow.trigger.github?.on)?.phrase ?? "something happens on GitHub";
    if (where.location) s += ` in ${where.location}`;
    if (where.branch) s += ` on ${where.branch}`;
    return s;
  }
  let s = TRIGGER_PHRASE[event] ?? (CATALOG.find((e) => e.on === event)?.label.toLowerCase() || event);
  if (where.agent && s.startsWith("an agent")) s = s.replace("an agent", agentName(where.agent));
  else if (where.agent) s += ` (${agentName(where.agent)})`;
  if (where.location) s += ` in ${where.location}`;
  if (where.branch) s += ` on ${where.branch}`;
  return s;
}

const short = (s = "", n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function stepPhrase(step: Step): string {
  switch (step.kind) {
    case "run":
      return `run \`${short(step.command)}\``;
    case "prompt":
      return step.session ? `tell ${step.session}` : "tell the agent";
    case "wait":
      return "wait for the agent";
    case "start_agent":
      return `start ${agentName(step.agent)}${step.new_worktree ? " in a new worktree" : ""}`;
    case "notify":
      return "notify me";
    case "webhook":
      try {
        return `call ${new URL(step.url ?? "").host}`;
      } catch {
        return "call a webhook";
      }
  }
  return String(step.kind).replace("_", " ");
}

// summary is a flow in one line: "When an agent finishes in shop → run
// `pnpm test` → if it fails, tell the agent → notify me".
export function summary(flow: Flow): string {
  const parts = [`${flow.trigger.schedule ? "" : "When "}${triggerPhrase(flow)}`.replace(/^./, (c) => c.toUpperCase())];
  for (const s of flow.steps) {
    const p = stepPhrase(s);
    parts.push(s.when === "failure" ? `if it fails, ${p}` : s.when === "always" ? `then always ${p}` : p);
  }
  return parts.join(" → ");
}

export interface Variable {
  token: string;
  label: string;
  group: string;
}

// variablesAt lists what a step's text can use: the trigger event's data,
// the worktree, and what earlier steps produced.
export function variablesAt(flow: Flow, index: number): Variable[] {
  const t = flow.trigger;
  const fields = t.schedule ? ["schedule", "time"] : t.github ? (GITHUB_ONS.find((g) => g.on === t.github?.on)?.fields ?? []) : (CATALOG.find((e) => e.on === t.event)?.fields ?? ["path"]);
  const vars: Variable[] = [
    ...fields.map((f) => ({ token: `{{event.${f}}}`, label: f.replace(/_/g, " "), group: "Event" })),
    { token: "{{event.box}}", label: "box", group: "Event" },
    { token: "{{worktree.name}}", label: "name", group: "Worktree" },
    { token: "{{worktree.path}}", label: "path", group: "Worktree" },
    { token: "{{worktree.branch}}", label: "branch", group: "Worktree" },
    { token: "{{location}}", label: "repo", group: "Worktree" },
    { token: "{{agent.state}}", label: "agent's state", group: "Worktree" },
    { token: "{{now}}", label: "now", group: "Run" },
  ];
  if (index > 0) {
    vars.push({ token: "{{prev.output}}", label: "output", group: "Previous step" }, { token: "{{prev.exit_code}}", label: "exit code", group: "Previous step" });
    flow.steps.slice(0, index).forEach((s, i) => {
      if (s.id) vars.push({ token: `{{steps.${s.id}.output}}`, label: `${s.id} output`, group: `Step ${i + 1}` });
    });
  }
  return vars;
}

export interface Starter {
  id: string;
  title: string;
  description: string;
  flow: Flow;
}

export const STARTERS: Starter[] = [
  {
    id: "test-loop",
    title: "Test after every agent turn",
    description: "And send failures back to the agent to fix.",
    flow: {
      id: "test-after-turn",
      name: "Run tests after every agent turn",
      enabled: true,
      trigger: { event: "agent.finished" },
      steps: [
        { id: "tests", kind: "run", command: "pnpm test", timeout: "15m" },
        { kind: "prompt", when: "failure", text: "The tests failed:\n\n{{prev.output}}\n\nFix them, then stop." },
      ],
      max_runs_per_hour: 12,
    },
  },
  {
    id: "notify",
    title: "Notify when an agent needs me",
    description: "A notification on this laptop, from any worktree.",
    flow: {
      id: "notify-when-waiting",
      name: "Notify me when an agent needs me",
      enabled: true,
      trigger: { event: "agent.waiting" },
      steps: [{ kind: "notify", title: "{{worktree.name}} needs you", text: "An agent in {{location}} is waiting for an answer." }],
    },
  },
  {
    id: "review",
    title: "Codex reviews Claude's work",
    description: "A second agent reads the changes, without editing.",
    flow: {
      id: "codex-review",
      name: "Codex reviews Claude's work",
      enabled: true,
      trigger: { event: "agent.finished", where: { agent: "claude" } },
      steps: [{ kind: "start_agent", agent: "codex", text: "Review the uncommitted changes in {{worktree.path}}. Don't edit anything; list bugs and risks." }],
      max_runs_per_hour: 6,
    },
  },
  {
    id: "nightly",
    title: "Nightly rebase and tests",
    description: "Every worktree, every night: rebase on main, then run the tests.",
    flow: {
      id: "nightly-rebase-test",
      name: "Nightly: rebase every worktree and run tests",
      enabled: true,
      trigger: { schedule: "0 2 * * *", each_worktree: true },
      steps: [
        { id: "rebase", kind: "run", command: "git fetch origin && git rebase origin/main", timeout: "5m" },
        { kind: "run", when: "failure", command: "git rebase --abort" },
        { kind: "notify", when: "failure", title: "{{worktree.name}} needs a manual rebase", text: "{{steps.rebase.output}}" },
        { id: "tests", kind: "run", command: "pnpm test", timeout: "20m" },
        { kind: "notify", when: "failure", title: "{{worktree.name}}: tests fail after rebasing", text: "{{prev.output}}" },
      ],
    },
  },
  {
    id: "pr-comments",
    title: "PR comments to the agent",
    description: "New review comments on a worktree's PR go straight to its agent.",
    flow: {
      id: "pr-comments-to-agent",
      name: "Send new PR review comments to the agent",
      enabled: true,
      trigger: { github: { on: "review_comment", poll: "2m" } },
      steps: [{ kind: "prompt", text: "New review comment from {{event.author}} on PR #{{event.pr}} {{event.file}}\n\n{{event.body}}\n\nAddress it, then say briefly what you changed." }],
      max_runs_per_hour: 20,
    },
  },
  {
    id: "slack",
    title: "Post to Slack when setup fails",
    description: "So a broken worktree doesn't go unnoticed.",
    flow: {
      id: "slack-setup-failed",
      name: "Post to Slack when setup fails",
      enabled: true,
      trigger: { event: "worktree.setup.failed" },
      steps: [{ kind: "webhook", url: "https://hooks.slack.com/services/", text: '{"text": "Setup failed for {{worktree.name}} in {{location}} on {{event.box}}"}' }],
    },
  },
];

export function blankFlow(): Flow {
  return { id: "", name: "", enabled: true, trigger: { event: "agent.finished" }, steps: [{ kind: "notify", title: "{{worktree.name}}: agent finished" }] };
}

export function blankStep(kind: StepKind): Step {
  switch (kind) {
    case "run":
      return { kind, command: "" };
    case "prompt":
      return { kind, text: "" };
    case "wait":
      return { kind, for: ["finished", "waiting"], timeout: "30m" };
    case "start_agent":
      return { kind, agent: "codex", text: "" };
    case "notify":
      return { kind, title: "" };
    case "webhook":
      return { kind, url: "https://", text: "" };
  }
}
