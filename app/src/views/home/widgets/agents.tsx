import { CornerDownLeftIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { type SessionEntry, useAllSessions } from "@/hooks/use-agent-counts";
import { lastOf } from "@/lib/last-of";
import { boxApi, type Session } from "@/lib/api";
import { agentLabel, agentOf, worktreeOf } from "@/lib/derive";
import { parseScreen } from "@/lib/screen-status";
import { permissionChoices } from "@/lib/screen";
import { type BoxData, useStore } from "@/lib/store";
import { useAsk } from "@/lib/transcript-feed";
import { cn } from "@/lib/utils";
import { focusSession, homeBox, selectWorktree, useWorkspaces, type WorktreeRef } from "@/lib/workspaces";
import { useReview } from "@/views/review/review-store";

import { fitRows, useHomeWidget } from "./env";
import { DiffStat, More, shortAgo, WidgetEmpty, WidgetRow, WidgetSkeleton } from "./parts";
import { placeLabel, worktreeLabel } from "@/lib/worktree-names";

// The agents' widgets: what needs you (answered in place where it can be),
// what is working and on which step, what just finished, and where you and
// your agents have been working. All from sessions the app already has;
// the only reads of their own are a waiting agent's screen (for its
// options) and a working agent's (for its step), and only while on screen.

export interface AgentRow {
  key: string;
  box: string;
  session: Session;
  agent: string;
  title: string;
  // "shop / checkout-fix · devl"
  where: string;
  worktree?: WorktreeRef;
  state: "waiting" | "running" | "finished";
  since?: string;
}

export function useAgentRows(): AgentRow[] {
  const all = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  return agentRows(all, boxes);
}

// Worked out once for every widget and count that asks (lastOf).
const agentRows = lastOf((all: SessionEntry[], boxes: Record<string, BoxData>): AgentRow[] => {
  const rows: AgentRow[] = [];
  for (const e of all) {
    const agent = agentOf(e.session);
    if (!agent || (e.state !== "waiting" && e.state !== "running" && e.state !== "finished")) continue;
    const wt = worktreeOf(boxes[e.box]?.locations, e.session);
    const place = wt ? (wt.worktree.main ? wt.location.name : `${wt.location.name} / ${worktreeLabel(wt.worktree)}`) : "";
    rows.push({
      key: `${e.box}/${e.session.name}`,
      box: e.box,
      session: e.session,
      agent,
      title: e.session.title?.trim() || place || e.session.name,
      where: [e.session.title?.trim() ? place : "", e.box].filter(Boolean).join(" · "),
      worktree: wt ? { box: e.box, location: wt.location.name, worktree: wt.worktree.name, path: wt.worktree.path, main: wt.worktree.main } : undefined,
      state: e.state,
      since: e.session.state_since ?? e.session.created,
    });
  }
  return rows.sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
});

// Until the agent and every online box have answered, agent lists are
// loading, not empty.
export function useAgentsLoading(): boolean {
  return useStore((s) => !s.status || s.status.boxes.some((b) => b.state === "online" && !s.boxes[b.name]?.sessions));
}

// Boxes that are paired but not reachable: their agents aren't listed.
export function useOfflineBoxes(): string[] {
  const boxes = useStore((s) => s.status?.boxes);
  return useMemo(() => (boxes ?? []).filter((b) => b.state !== "online").map((b) => b.name), [boxes]);
}

const byState = (rows: AgentRow[], s: AgentRow["state"]) => rows.filter((r) => r.state === s);

export const useWaitingCount = () => {
  const n = byState(useAgentRows(), "waiting").length;
  return { n, urgent: n > 0 };
};
export const useWorkingCount = () => ({ n: byState(useAgentRows(), "running").length });
export const useFinishedCount = () => ({ n: byState(useAgentRows(), "finished").length });


function OfflineNote({ boxes }: { boxes: string[] }) {
  if (!boxes.length) return null;
  return <p className="truncate px-2 pt-1 text-[11px] text-muted-foreground">{boxes.length === 1 ? `${boxes[0]} is offline: its agents aren't listed` : `${boxes.length} boxes offline: their agents aren't listed`}</p>;
}

// ---------- Needs you ----------

// A question's tools: these are answered in the agent's own form, not with
// Allow or Deny.
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;

export function NeedsYouWidget() {
  const { lines, height } = useHomeWidget();
  const rows = byState(useAgentRows(), "waiting").reverse();
  const loading = useAgentsLoading();
  const offline = useOfflineBoxes();
  if (loading && !rows.length) return <WidgetSkeleton rows={Math.min(lines, 3)} />;
  if (!rows.length)
    return (
      <div className="flex h-full flex-col">
        <WidgetEmpty scene="calm" title="Nothing needs you" hint="An agent that asks for a permission or an answer shows here first." />
        <OfflineNote boxes={offline} />
      </div>
    );
  const shown = rows.slice(0, fitRows(height, 54));
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((r) => (
        <WaitingRow key={r.key} r={r} />
      ))}
      <More n={rows.length - shown.length} label="waiting" onClick={() => useStore.getState().setView({ kind: "dashboard" })} />
    </div>
  );
}

function WaitingRow({ r }: { r: AgentRow }) {
  const { visible, preview } = useHomeWidget();
  const client = useStore((s) => s.client);
  const s = r.session;
  const tool = s.ask?.tool;
  const question = !tool || QUESTION_TOOLS.test(tool);
  // A permission's options are on the agent's screen: read them while the
  // row can be seen, as the agent's own pane does.
  const ask = useAsk(r.box, s.name, visible && !preview && !question, s.state_since);
  const choices = ask && !ask.form ? permissionChoices(ask.choices) : undefined;
  const allow = choices?.find((c) => c.label === "Allow");
  const deny = choices?.find((c) => c.label === "Deny");
  const [sent, setSent] = useState<{ at?: string; label: string }>();
  const answered = sent && sent.at === s.state_since ? sent.label : undefined;
  const detail = tool && !question ? [tool === "Bash" ? "" : tool, s.ask?.input].filter(Boolean).join(" ") : s.ask?.message || ask?.detail || (question ? "Asks you a question" : "Waiting for you");

  const answer = (key: string, label: string) => {
    if (!client) return;
    setSent({ at: s.state_since, label });
    // The person answered, so the box may type into a waiting agent.
    boxApi.send(client, r.box, s.name, key, false, { when: "now", force: true }).catch((err) => {
      setSent(undefined);
      toastError(err, { title: "Couldn't answer", box: r.box });
    });
  };
  const open = () => void focusSession(r.box, s.name);

  return (
    <div className="group/row flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <button type="button" onClick={open} className="flex w-full min-w-0 items-center gap-2.5 rounded-sm text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StateGlyph state="waiting" />
        <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{shortAgo(r.since)}</span>
      </button>
      <span className="flex min-w-0 items-center gap-2 pl-6 text-muted-foreground text-xs">
        <span className={cn("min-w-0 flex-1 truncate", tool && !question && "font-mono text-[11px]")}>{detail}</span>
        {answered ? (
          <span className="shrink-0 text-[11px]">{answered === "Deny" ? "Denied" : "Allowed"} · resuming</span>
        ) : allow && deny ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="outline" className="h-5 rounded-[5px] px-1.5 text-[11px]" onClick={() => answer(deny.key, "Deny")} aria-label={`Deny: ${r.title}`}>
              Deny
            </Button>
            <Button size="xs" className="h-5 rounded-[5px] px-1.5 text-[11px]" onClick={() => answer(allow.key, "Allow")} aria-label={`Allow once: ${r.title}`}>
              Allow once
            </Button>
          </span>
        ) : (
          <Button size="xs" variant="outline" className="h-5 shrink-0 rounded-[5px] px-1.5 text-[11px]" onClick={open} aria-label={`Answer: ${r.title}`}>
            Answer
            <CornerDownLeftIcon className="size-3" />
          </Button>
        )}
      </span>
    </div>
  );
}

// ---------- Working now ----------

export function WorkingWidget() {
  const { lines, height } = useHomeWidget();
  const rows = byState(useAgentRows(), "running");
  const loading = useAgentsLoading();
  const offline = useOfflineBoxes();
  if (loading && !rows.length) return <WidgetSkeleton rows={Math.min(lines, 3)} />;
  if (!rows.length)
    return (
      <div className="flex h-full flex-col">
        <WidgetEmpty scene="moored" title="No agent is working" hint="Describe a task above and an agent starts on it." />
        <OfflineNote boxes={offline} />
      </div>
    );
  const shown = rows.slice(0, fitRows(height, 48));
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((r) => (
        <WorkingRow key={r.key} r={r} />
      ))}
      <More n={rows.length - shown.length} label="working" onClick={() => useStore.getState().setView({ kind: "dashboard" })} />
    </div>
  );
}

// useLiveStep is what a working agent's screen says it is doing: its step
// ("Running pnpm test…"), what that step printed last, and its status
// line's clock. Read every 12s while the row is on screen.
function useLiveStep(box: string, session: string, agent: string, enabled: boolean) {
  const client = useStore((s) => s.client);
  const [step, setStep] = useState<{ now?: string; sub?: string; elapsed?: string }>();
  useEffect(() => {
    if (!client || !enabled) return;
    let alive = true;
    const read = () => {
      if (document.hidden) return;
      boxApi
        .screen(client, box, session)
        .then((r) => alive && setStep(readStep(r.screen ?? "", agent)))
        .catch(() => {});
    };
    read();
    const t = window.setInterval(read, 12_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [client, box, session, agent, enabled]);
  return step;
}

export function readStep(screen: string, agent: string): { now?: string; sub?: string; elapsed?: string } {
  const status = parseScreen(screen, agent).status;
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[⏺●•]\s+(\S.*)$/.exec(lines[i]);
    if (!m || (status && lines[i].includes(status.word))) continue;
    const sub = lines
      .slice(i + 1, i + 6)
      .map((l) => /^\s*⎿\s+(.*)$/.exec(l)?.[1]?.trim())
      .filter(Boolean)
      .pop();
    return { now: m[1].trim(), sub, elapsed: status?.elapsed };
  }
  return { now: status?.word, elapsed: status?.elapsed };
}

function WorkingRow({ r }: { r: AgentRow }) {
  const { visible, preview } = useHomeWidget();
  const step = useLiveStep(r.box, r.session.name, r.agent, visible && !preview);
  return (
    <button
      type="button"
      onClick={() => void focusSession(r.box, r.session.name)}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex w-full min-w-0 items-center gap-2.5 text-sm">
        <StateGlyph state="running" />
        <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
        <AgentIcon agent={r.agent} className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{step?.elapsed ?? shortAgo(r.since)}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-6 text-muted-foreground text-xs">
        <span className="min-w-0 truncate font-mono text-[11px]">{step?.now ?? `${agentLabel(r.agent)} · ${r.where}`}</span>
        {step?.sub && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground @max-[300px]:hidden">· {step.sub}</span>}
      </span>
    </button>
  );
}

// ---------- Recently finished ----------

export function FinishedWidget() {
  const { lines, height } = useHomeWidget();
  const rows = byState(useAgentRows(), "finished");
  const loading = useAgentsLoading();
  const entries = useReview((s) => s.entries);
  if (loading && !rows.length) return <WidgetSkeleton rows={Math.min(lines, 3)} />;
  if (!rows.length) return <WidgetEmpty scene="bottle" title="Nothing finished yet" hint="Turns that end wait here for a look." />;
  const shown = rows.slice(0, rows.length > lines ? fitRows(height, 36) : lines);
  return (
    <div className="flex flex-col">
      {shown.map((r) => {
        const e = r.worktree && entries.find((x) => x.box === r.box && x.path === r.worktree!.path);
        return (
          <WidgetRow key={r.key} onClick={() => void focusSession(r.box, r.session.name)}>
            <StateGlyph state="finished" />
            <span className="min-w-0 flex-1 truncate">{r.title}</span>
            {e && (e.added || e.removed) ? <DiffStat add={e.added} del={e.removed} className="@max-[280px]:hidden" /> : <span className="min-w-0 truncate text-muted-foreground text-xs @max-[340px]:hidden">{r.where}</span>}
            <span className="w-8 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{shortAgo(r.since)}</span>
          </WidgetRow>
        );
      })}
      <More n={rows.length - shown.length} label="finished" onClick={() => useStore.getState().setView({ kind: "review" })} />
    </div>
  );
}

// ---------- Recent areas ----------

interface Area {
  ref: WorktreeRef;
  label: string;
  project: string;
  at: number;
  agents: AgentRow[];
}

// useAreas ranks worktrees by when you last opened one or an agent last
// changed state in it, whichever is later.
export function useAreas(): Area[] {
  const spaces = useWorkspaces((s) => s.spaces);
  const boxes = useStore((s) => s.boxes);
  const rows = useAgentRows();
  return useMemo(() => {
    const out = new Map<string, Area>();
    const touch = (ref: WorktreeRef, at: number, agent?: AgentRow) => {
      const k = `${ref.box}:${ref.path}`;
      const a = out.get(k) ?? { ref, label: placeLabel(ref, boxes), project: ref.location, at: 0, agents: [] };
      a.at = Math.max(a.at, at);
      if (agent) a.agents.push(agent);
      out.set(k, a);
    };
    for (const [key, w] of Object.entries(spaces)) if (!homeBox(key) && w.visitedAt && w.ref?.path) touch(w.ref, w.visitedAt);
    for (const r of rows) if (r.worktree) touch(r.worktree, Date.parse(r.since ?? "") || 0, r);
    return [...out.values()].sort((a, b) => b.at - a.at);
  }, [spaces, rows, boxes]);
}

export function AreasWidget() {
  const { lines, span } = useHomeWidget();
  const areas = useAreas();
  const loading = useAgentsLoading();
  const hasProjects = useStore((s) => Object.values(s.boxes).some((b) => b.locations?.length));
  if (loading && !areas.length) return <WidgetSkeleton rows={Math.min(lines, 3)} />;
  if (!areas.length)
    return hasProjects ? (
      <WidgetEmpty scene="dock" title="Nowhere yet" hint="Worktrees you open and your agents work in show here." />
    ) : (
      <WidgetEmpty scene="first-crate" title="No projects yet" hint="Add a repository on a box to start work in it." action="Add a project" onAction={() => useStore.getState().openAddProject()} />
    );
  return (
    <div className="flex flex-col">
      {areas.slice(0, lines).map((a) => {
        const waiting = a.agents.filter((r) => r.state === "waiting").length;
        const running = a.agents.filter((r) => r.state === "running").length;
        return (
          <WidgetRow key={`${a.ref.box}:${a.ref.path}`} onClick={() => selectWorktree(a.ref)}>
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {waiting > 0 && <StateGlyph state="waiting" className="size-3" />}
              {running > 0 && <StateGlyph state="running" className="size-3" />}
            </span>
            {span.c > 1 && <span className="shrink-0 font-mono text-[11px] text-muted-foreground @max-[260px]:hidden">{a.ref.box}</span>}
            <span className="w-7 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{shortAgo(a.at)}</span>
          </WidgetRow>
        );
      })}
    </div>
  );
}
