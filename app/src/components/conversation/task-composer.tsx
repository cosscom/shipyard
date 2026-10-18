import { ArrowUpIcon, FolderIcon, GitBranchIcon, SendIcon, ServerIcon, ShieldAlertIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, StatusDot } from "@/components/agent-glyph";
import { Scene } from "@/components/art/scenes";
import { AttemptsOptions, type AttemptValues, SendOptions, type SendValues, WorktreeOptions, type WorktreeValues } from "@/components/conversation/composer-options";
import { AddProjectItem, AgentsPicker, type Chosen, DefaultBoxItem, entryKey, expand, Pick, SavedPrompts, TargetsPicker, toChosen } from "@/components/conversation/composer-pickers";
import { useBranches, useResolve } from "@/components/new-worktree/use-resolve";
import { withDefaults } from "@/components/prompts/shared";
import { RepoWants, trustRepo, useRepoTrustFor } from "@/components/repo-trust";
import { RequirementsCard, useRequirementsCard } from "@/components/requirements-card";
import { AttachmentChips, type Attachments, useAttachments } from "@/components/conversation/attachments";
import { type ComposerMenu, useComposerMenu } from "@/components/conversation/command-menu";
import { ErrorText, toastError } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameFooter, FramePanel } from "@/components/ui/frame";
import { Kbd } from "@/components/ui/kbd";
import { toastManager } from "@/components/ui/toast";
import { type SessionEntry, useAllSessions } from "@/hooks/use-agent-counts";
import { agentPresets } from "@/lib/actions";
import { type AttachTarget, withAttachments } from "@/lib/attachments";
import { type ComposerDraft, openComposer } from "@/lib/composer";
import { agentLabel, agentOf, sessionName, sessionState } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import { sessionLocation } from "@/lib/orchestrate";
import { handoffPrompt, reviewPrompt } from "@/lib/orchestrate";
import { loadProjects, projectActions, useProjects } from "@/lib/project-groups";
import { promptFor, type ResolveKind, worktreeSlug } from "@/lib/projects";
import { askedVariables, builtinValues, fill as fillPrompt, isBuiltin, usePrompts, variablesIn } from "@/lib/prompts";
import { boxHasRuns } from "@/lib/runs";
import { AGENT_WORDS } from "@/lib/state-model";
import { type StartDraft, sendWork, startWork } from "@/lib/start-work";
import { load, save } from "@/lib/storage";
import { NONE, useStore } from "@/lib/store";
import { fill as fillTemplate, templateVariables } from "@/lib/templates";
import { type InstalledKitOn, kitsApi } from "@/lib/kits";
import { cn } from "@/lib/utils";
import { openAddBox } from "@/views/onboarding/add-box-dialog";

export type { AgentPick } from "@/lib/composer";

// TaskComposer is the one way to start work (lib/composer): what to do, on
// which project and box, in a new worktree or the main checkout, and with
// which agents (one is a task, several are attempts, none is the worktree
// alone); or, as "Running agents", a prompt for agents already at work. The
// same frame sits on home, in an empty worktree, before an agent's first
// prompt, and in the ⌘N dialog, where its options are open.

export interface TaskComposerProps {
  draft?: ComposerDraft;
  placeholder?: string;
  autoFocus?: boolean;
  // Work in this worktree, already open: no project, box or where pickers.
  fixed?: { box: string; location: string; at: string; name: string; branch?: string };
  // The first prompt for this one agent, ready in its worktree.
  to?: { box: string; session: string; agent?: string };
  onSend?(text: string): Promise<void>;
  // How a failed first prompt is told (the pane's toast with next steps).
  onFail?(err: unknown): void;
  // In the dialog: its options start open, and it says when it is done.
  dialog?: boolean;
  onMode?(mode: "start" | "send"): void;
  // What it would do now, for the dialog's title.
  onKind?(kind: ComposerKind): void;
  onDone?(how: { mode: "start" | "send"; results?: boolean }): void;
  // The dialog's "Create more": stay open after starting.
  keepOpen?: boolean;
  className?: string;
}

export type ComposerKind = "start" | "attempts" | "worktree" | "send" | "loop";

const EMPTY: ComposerDraft = {};
const LAST_PROJECT = "berth.newWorktree.project.v2";
const lastBoxKey = (project: string) => `berth.newWorktree.box.${project}`;
const picksKey = (box: string, loc: string) => `berth.composer.picks.${box}/${loc}`;
const checkKey = (box: string, loc: string) => `berth.loop.check.${box}/${loc.split("/")[0]}`;

// defaultCheck is the check last used for a project, else the one its box
// knows: the repo config's "check", or how the repository tests (package.json,
// go.mod, Cargo.toml, a Makefile). Empty when there is none: it is optional.
export function defaultCheck(box: string, loc: string): string {
  const name = loc.split("/")[0];
  const known = useStore.getState().boxes[box]?.locations?.find((l) => l.name === name)?.check ?? "";
  return load(checkKey(box, name), known);
}

export function TaskComposer(props: TaskComposerProps) {
  const draft = props.draft ?? EMPTY;
  const [mode, setMode] = useState<"start" | "send">(draft.mode ?? "start");
  // What to do is kept across the two modes.
  const [text, setText] = useState(() => {
    if (draft.text) return draft.text;
    if (draft.promptId) return usePrompts.getState().prompts.find((p) => p.id === draft.promptId)?.body ?? "";
    return "";
  });
  const switchMode = (m: "start" | "send") => {
    setMode(m);
    props.onMode?.(m);
  };
  if (props.to) return <ToBody {...props} to={props.to} />;
  const tabs = !props.fixed && !draft.from ? <ModeTabs mode={mode} onMode={switchMode} /> : null;
  return mode === "send" ? <SendBody {...props} draft={draft} text={text} setText={setText} tabs={tabs} /> : <StartBody {...props} draft={draft} text={text} setText={setText} tabs={tabs} />;
}

interface BodyProps extends TaskComposerProps {
  draft: ComposerDraft;
  text: string;
  setText(t: string): void;
  tabs: React.ReactNode;
}

// ---- Starting work ------------------------------------------------------

function StartBody({ draft, text, setText, tabs, fixed, dialog, autoFocus, placeholder, onDone, onKind, keepOpen, className }: BodyProps) {
  const status = useStore((s) => s.status);
  const templates = useStore((s) => s.templates);
  const { projects: all } = useProjects();
  const settled = useStore((s) => !!s.status && s.status.boxes.every((b) => b.state !== "online" || s.boxes[b.name]?.locations !== undefined));
  useEffect(() => void loadProjects(), []);
  const projects = useMemo(() => all.map((p) => ({ ...p, places: p.members.filter((m) => m.loc.repo && m.box.state === "online") })).filter((p) => p.places.length), [all]);

  // Following a session: its box and worktree.
  const from = draft.from;
  const fromAt = useMemo(() => {
    if (!from) return undefined;
    try {
      return sessionLocation(from.box, from.session);
    } catch {
      return undefined;
    }
  }, [from]);
  const fromSession = useStore((s) => (from ? s.boxes[from.box]?.sessions?.find((x) => x.name === from.session) : undefined));
  const pinned = fixed ?? (from ? { box: from.box, location: (fromAt ?? "").split("/")[0], at: fromAt ?? "", name: "", branch: undefined } : undefined);

  // Project first, then the box it goes to: the one chosen, the project's
  // default, the last used for it, or the first online.
  const [lastProject] = useState(() => load(LAST_PROJECT, ""));
  const [projectId, setProjectId] = useState<string>();
  const [boxChoice, setBoxChoice] = useState<string | undefined>(draft.box);
  const inDraft = (p: (typeof projects)[number]) => !!draft.box && !!draft.location && p.places.some((m) => m.box.name === draft.box && m.loc.name === draft.location);
  const project = pinned
    ? undefined
    : (projects.find((p) => p.id === projectId) ??
      projects.find(inDraft) ??
      projects.find((p) => p.id === lastProject) ??
      (draft.box ? projects.find((p) => p.places.some((m) => m.box.name === draft.box)) : undefined) ??
      projects[0]);
  const boxFor = (p: (typeof projects)[number]) => {
    const has = (b?: string) => (b && p.places.some((m) => m.box.name === b) ? b : undefined);
    return has(boxChoice) ?? has(p.defaultBox) ?? has(load(lastBoxKey(p.id), "")) ?? p.places[0].box.name;
  };
  const box = pinned ? pinned.box : project ? boxFor(project) : "";
  const location = useStore((s) => (pinned ? s.boxes[pinned.box]?.locations?.find((l) => l.name === pinned.location) : undefined)) ?? project?.places.find((m) => m.box.name === box)?.loc;
  const locName = pinned?.location ?? location?.name ?? "";
  const presets = box ? agentPresets(box, locName) : [];

  // Where: a new worktree or the main checkout; beside the session or a new
  // worktree for a hand-off; the worktree itself when it is fixed.
  const [where, setWhere] = useState<"new" | "main" | "here">(pinned ? "here" : (draft.where ?? "new"));
  const fresh = where === "new";

  // The agents: as the draft says; for Try N ways the first two; for a
  // review another agent than the author; otherwise the one used last here
  // (attempts are chosen each time), or the first. Until someone picks,
  // they follow the project and box as those arrive and change.
  const initialAgents = (): Chosen => {
    if (draft.agents?.length) return toChosen(draft.agents);
    if (draft.attempts) return toChosen(presets.slice(0, 2).map((p) => ({ agent: p.id })));
    if (from?.kind === "review") {
      const other = presets.find((p) => p.id !== (fromSession && agentOf(fromSession)));
      return other ? toChosen([{ agent: other.id }]) : {};
    }
    if (from) return fromSession && agentOf(fromSession) ? toChosen([{ agent: agentOf(fromSession)! }]) : {};
    const saved = box ? load<{ agent: string; model?: string; effort?: string }[]>(picksKey(box, locName), []) : [];
    return saved.length === 1 ? toChosen(saved) : {};
  };
  const [chosen, setChosen] = useState<Chosen>(initialAgents);
  const agentsTouched = useRef(false);
  const agentPlace = `${box}/${locName}/${presets.map((p) => p.id).join(",")}/${fromSession ? agentOf(fromSession) : ""}`;
  useEffect(() => {
    if (!agentsTouched.current) setChosen(initialAgents());
    // Only when where they would come from changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPlace]);
  const pickAgents = (c: Chosen) => {
    agentsTouched.current = true;
    setChosen(c);
  };
  const [copies, setCopies] = useState(1);
  const [noAgent, setNoAgent] = useState(!!draft.noAgent);
  const live: Chosen = Object.fromEntries(Object.entries(chosen).filter(([id, c]) => c.models.length && presets.some((p) => p.id === id)));
  const sel: Chosen = Object.keys(live).length ? live : presets[0] ? { [presets[0].id]: { models: [""], effort: "" } } : {};
  const picks = noAgent ? [] : expand(sel, from ? 1 : copies).slice(0, from ? 1 : undefined);
  const attempts = picks.length > 1;
  useEffect(() => onKind?.(noAgent ? "worktree" : attempts ? "attempts" : "start"), [onKind, noAgent, attempts]);

  // A hand-off or a review starts from what the agent should read.
  const touched = useRef(!!draft.text);
  useEffect(() => {
    if (!from || touched.current) return;
    const path = fromSession?.dir ?? "";
    const worktree = (fromAt ?? "").split("/")[1] ?? fromAt ?? from.session;
    // "Review the changes Claude Code made": the agent, not its task.
    const who = fromSession && agentOf(fromSession) ? agentLabel(agentOf(fromSession)!) : from.session;
    setText(from.kind === "review" ? reviewPrompt(who) : handoffPrompt({ worktree, path }, where === "here"));
    // Until edited, the prompt follows where the next agent works.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, where]);

  // The new worktree: what it starts from, and its details as worked out.
  // With no agent, the text above is what it starts from.
  const [startFrom, setStartFrom] = useState(draft.name ?? "");
  const [kind, setKind] = useState<ResolveKind>("smart");
  const input = noAgent ? text : startFrom;
  const resolving = fresh && !from;
  const { resolution, pending, error: resolveError } = useResolve(resolving ? box : "", locName, input, kind);
  const branches = useBranches(box, locName, resolving && kind === "branch");
  const [wt, setWt] = useState<WorktreeValues>({ name: "", branch: "", base: draft.base ?? "", template: draft.template ?? "", vars: {} });
  const [edited, setEdited] = useState<Set<keyof WorktreeValues>>(new Set());
  const setWorktree = (patch: Partial<WorktreeValues>, by?: (keyof WorktreeValues)[]) => {
    setWt((v) => ({ ...v, ...patch }));
    if (by?.length) setEdited((e) => new Set([...e, ...by]));
  };
  const template = templates.find((t) => t.id === wt.template);
  const variables = templateVariables(template);
  useEffect(() => {
    setWt((v) => ({
      ...v,
      name: edited.has("name") ? v.name : (resolution?.name ?? ""),
      branch: edited.has("branch") ? v.branch : (resolution?.branch ?? ""),
      base: edited.has("base") ? v.base : (resolution?.base ?? v.base),
    }));
    // A pull request or an issue suggests the task, until you write one.
    if (resolution && !noAgent && !touched.current) {
      const p = promptFor(resolution);
      if (p) setText(p);
    }
    // edited is read, not followed: typing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution]);
  // A template fills the agent, branch, base and prompt it has.
  useEffect(() => {
    if (!template) return;
    if (template.agent) {
      setChosen({ [template.agent]: { models: [""], effort: "" } });
      setNoAgent(false);
    }
    setWt((v) => ({ ...v, branch: template.branch ?? v.branch, base: template.base ?? v.base, vars: Object.fromEntries(variables.map((x) => [x.id, v.vars[x.id] ?? x.default ?? ""])) }));
    setEdited((e) => new Set([...e, ...(template.branch ? ["branch" as const] : []), ...(template.base ? ["base" as const] : [])]));
    if (template.prompt && !touched.current) setText(template.prompt);
    // Only when the template changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt.template]);

  // Try N ways: the check, the judge and what the pick gets.
  const [att, setAtt] = useState<AttemptValues>(() => ({
    check: defaultCheck(box, locName),
    judge: presets.find((p) => p.id === "claude")?.id ?? presets[0]?.id ?? "claude",
    auto: false,
    pr: true,
    extras: [],
  }));
  // Another project, another check, until the person types their own.
  const checkTouched = useRef(false);
  useEffect(() => {
    if (!checkTouched.current) setAtt((a) => ({ ...a, check: defaultCheck(box, locName) }));
  }, [box, locName]);
  const boxesData = useStore((s) => s.boxes);
  const otherBoxes = Object.keys(boxesData).filter((b) => b !== box && boxHasRuns(b) && status?.boxes.some((x) => x.name === b && x.state === "online") && boxesData[b]?.locations?.some((l) => l.name === locName));

  const [optionsOpen, setOptionsOpen] = useState(() => !!dialog && (!!draft.attempts || !!draft.template || !!draft.name || from?.kind === "handoff"));
  useEffect(() => {
    if (attempts) setOptionsOpen(true);
  }, [attempts]);
  const hasOptions = attempts || (fresh && !from) || (from?.kind === "handoff" && fresh);

  // The repository's committed config waits to be trusted on this box: say
  // what it would run, and start with or without it.
  const pendingTrust = useRepoTrustFor(box, resolving ? locName : undefined, location?.repo_trust);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Files dropped or pasted for the agent go up to the box before it
  // starts, and their paths go with the task: into the worktree it works
  // in when that is there (the main checkout, the one open, the session's
  // it follows), else the project's main checkout, as a new worktree has
  // yet to be made. A worktree alone takes no files.
  const pinnedWt = pinned?.at?.split("/")[1];
  const worktrees = useStore((s) => s.boxes[box]?.locations?.find((l) => l.name === locName)?.worktrees) ?? location?.worktrees;
  const mainWt = worktrees?.find((w) => w.main)?.name;
  const attachTo: AttachTarget | undefined = noAgent
    ? undefined
    : from
      ? { box: from.box, session: from.session }
      : box && locName && (pinnedWt ?? mainWt)
        ? { box, location: locName, worktree: (pinnedWt ?? mainWt)! }
        : undefined;
  // A project chosen whose checkout is still loading: the files wait for it.
  const files = useAttachments(attachTo, {
    waiting: !noAgent && !attachTo && !!box && !!locName,
    without: noAgent ? "A worktree alone takes no files: pick an agent to give them to." : "Choose a project first: the files go up to its box.",
  });

  // What the box lacks to run an agent (tmux, the agent's CLI), from the
  // box itself, before anything is created: its card says how to install it.
  const reqAgent = picks.length === 1 && !template?.command ? picks[0].agent : undefined;
  const reqCard = useRequirementsCard(box || undefined, { agent: reqAgent, noAgent });

  const name = worktreeSlug(wt.name || resolution?.name || (resolveError ? input : ""));
  const blocker = !box
    ? settled && !projects.length && !pinned
      ? "Add a project first"
      : "Waiting for a box"
    : !locName
      ? "Choose a project"
      : reqCard === "tmux"
        ? `tmux isn't installed on ${box}`
        : !noAgent && (!picks.length || reqCard === "agent")
        ? `No agent CLI on ${box}`
        : !noAgent && !text.trim() && (attempts || from || !dialog)
          ? attempts
            ? "Describe the task for the attempts"
            : "Describe the task first"
          : !noAgent && files.blocker
            ? files.blocker
            : input.trim() && pending && resolving
            ? "Reading what it starts from…"
            : attempts && !boxHasRuns(box)
              ? `${box} needs a newer berthd to try several ways`
              : undefined;

  const action = from ? (from.kind === "review" ? "Start review" : "Hand off") : noAgent ? "Create worktree" : attempts ? `Try ${picks.length} ways` : "Start";

  // Trust alone: the repository's config runs from the next worktree on,
  // with or without a task typed yet.
  const trustOnly = async () => {
    if (!pendingTrust || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await trustRepo(box, locName, pendingTrust);
    } catch (err) {
      setError(plainError(err, { box }));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (trustFirst = false) => {
    if (blocker || busy) return;
    setBusy(true);
    setError(undefined);
    if (trustFirst && pendingTrust) {
      try {
        await trustRepo(box, locName, pendingTrust);
      } catch (err) {
        setError(plainError(err, { box }));
        setBusy(false);
        return;
      }
    }
    const values = { ...wt.vars, name: name || "" };
    const d: StartDraft = {
      text: noAgent ? "" : withAttachments(fillTemplate(text.trim(), values) ?? text.trim(), files.paths),
      box,
      location: locName,
      where,
      at: pinned?.at,
      picks,
      worktree: fresh
        ? {
            name: name || undefined,
            branch: fillTemplate(wt.branch.trim(), values) || resolution?.branch || undefined,
            base: wt.base.trim() || resolution?.base || undefined,
            pr: resolution?.pr,
            ref: resolution?.ref,
            command: template?.command,
          }
        : undefined,
      attempts: attempts ? { ...att, base: draft.base ?? (fixed ? fixed.branch : undefined) } : undefined,
      from,
    };
    const ok = await startWork(d);
    setBusy(false);
    if (!ok) return;
    if (project) {
      save(LAST_PROJECT, project.id);
      save(lastBoxKey(project.id), box);
    }
    touched.current = false;
    setText("");
    files.clear();
    setStartFrom("");
    setWt((v) => ({ name: "", branch: "", base: "", template: v.template, vars: v.vars }));
    setEdited(new Set());
    if (!keepOpen) onDone?.({ mode: "start" });
  };

  // Which box to choose, said in words: how loaded each is, whether its
  // kit is there and current, and which is the project's default.
  const multi = (project?.places.length ?? 0) > 1;
  const [kits, setKits] = useState<InstalledKitOn[]>([]);
  useEffect(() => {
    const client = useStore.getState().client;
    if (!multi || !client) return;
    let live = true;
    kitsApi.installed(client).then(
      (k) => live && setKits(k),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [multi]);
  const boxDetail = (b: string, loc: string) => {
    if (!multi) return undefined;
    const stats = boxesData[b]?.stats;
    const memory = stats?.memory.total ? Math.round((stats.memory.used / stats.memory.total) * 100) : undefined;
    const working = stats?.agents.filter((a) => a.state === "running").length ?? 0;
    const kit = kits.find((k) => k.box === b && k.location === loc);
    return [b === project?.defaultBox && "default", memory !== undefined && `${memory}% memory`, working > 0 && `${working} working`, kit && (kit.outdated ? "kit outdated" : `${kit.kit.name} kit`)].filter(Boolean).join(" · ") || undefined;
  };

  // Nothing to start work in: say why, and offer the one way on.
  if (!pinned && settled && projects.length === 0) return <NoProjects className={className} tabs={tabs} />;

  const setDefault = async (b: string) => {
    if (!project) return;
    try {
      await projectActions.setDefaultBox(project, b);
      toastManager.add({ title: `New ${project.name} work goes to ${b}`, type: "success" });
    } catch (err) {
      toastError(err, { title: "Could not save the default box" });
    }
  };

  const whereOptions =
    from?.kind === "handoff"
      ? [
          { value: "here", label: "Beside it" },
          { value: "new", label: "New worktree" },
        ]
      : [
          { value: "new", label: "New worktree" },
          { value: "main", label: "Main checkout" },
        ];

  const options = optionsOpen && hasOptions && (
    <>
      {fresh && !attempts && (
        <WorktreeOptions
          nameOnly={!!from}
          showStartFrom={!noAgent}
          startFrom={startFrom}
          onStartFrom={setStartFrom}
          kind={kind}
          onKind={setKind}
          resolution={resolution}
          pending={pending}
          error={resolveError}
          branches={branches}
          location={location}
          v={wt}
          set={setWorktree}
          placeholders={{
            name: resolution?.name || (text.trim() ? slugOf(text) : "generated"),
            branch: resolution?.branch || name || "same as the folder",
            base: resolution?.base || location?.default_branch || "main",
          }}
          templates={from ? [] : templates}
          variables={from ? [] : variables}
        />
      )}
      {attempts && (
        <AttemptsOptions
          picks={picks}
          presets={presets}
          box={box}
          otherBoxes={otherBoxes}
          v={att}
          set={(p) => {
            if ("check" in p) checkTouched.current = true;
            setAtt((v) => ({ ...v, ...p }));
          }}
          runsHere={boxHasRuns(box)}
          names={{ name: wt.name, base: wt.base, namePlaceholder: slugOf(text).slice(0, 24) || "refunds", basePlaceholder: draft.base ?? fixed?.branch ?? location?.default_branch ?? "main", set: (p) => setWorktree(p, Object.keys(p) as (keyof WorktreeValues)[]) }}
        />
      )}
    </>
  );

  const followed = from && (fromSession ? sessionName(fromSession, { agent: true }) : from.session);

  return (
    <Shell
      className={className}
      drop={files}
      head={
        (tabs || followed || hasOptions) && (
          <>
            {tabs}
            {followed && (
              <span className="flex min-w-0 items-center gap-1.5 px-2 text-muted-foreground text-meta">
                {from.kind === "review" ? "Reviews" : "Picks up from"}
                <span className="flex min-w-0 items-center gap-1 rounded-md bg-background/70 px-1.5 py-0.5 text-foreground">
                  <AgentIcon agent={fromSession && agentOf(fromSession)} className="size-3" />
                  <span className="truncate">{followed}</span>
                </span>
              </span>
            )}
            <span className="ml-auto" />
            {!noAgent && <SavedPrompts onPick={(_, body) => setText(text.trim() ? `${text.trimEnd()}\n\n${body}` : body)} />}
            {hasOptions && <OptionsToggle open={optionsOpen} onOpen={setOptionsOpen} />}
          </>
        )
      }
      editor={
        <Editor
          value={text}
          onChange={(v) => {
            touched.current = true;
            setText(v);
          }}
          onSubmit={() => void submit()}
          onPaste={files.onPaste}
          above={!noAgent && <AttachmentChips items={files.items} onRemove={files.remove} onRetry={files.retry} className="px-3.5 pt-3" />}
          autoFocus={autoFocus}
          label={noAgent ? "What the worktree starts from" : "What should your agents work on?"}
          placeholder={
            noAgent
              ? "A name, #1234, a branch, or a GitHub, GitLab or Jira link (empty makes a name up)"
              : (placeholder ?? (attempts ? "Describe the task: each agent tries it in its own worktree…" : "Describe a task, a bug to fix, an idea to try…"))
          }
          hint={noAgent && input.trim() ? <Resolved resolution={resolution} pending={pending} error={resolveError} /> : undefined}
        />
      }
      options={options}
      notice={
        <>
          {box && <RequirementsCard box={box} agent={reqAgent} noAgent={noAgent} className="mx-1 mt-1" />}
          {pendingTrust?.wants && fresh && (
            <Alert variant="warning" className="mt-1">
              <ShieldAlertIcon />
              <AlertTitle>This repository wants to run commands on {box}</AlertTitle>
              <AlertDescription>
                <p>
                  {pendingTrust.state === "changed" ? "Its .berth/config.json changed since it was trusted here." : "Its .berth/config.json has not been trusted on this box."} Without trust, the
                  worktree is made but none of this runs.
                </p>
                <RepoWants wants={pendingTrust.wants} />
                <div className="mt-2 flex items-center gap-2">
                  {/* Trusting needs no task; starting does, and says so
                      rather than sitting there disabled. */}
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => void trustOnly()}>
                    Trust
                  </Button>
                  <Tip label={blocker ?? `Trust it, then ${action.toLowerCase()}`}>
                    <span>
                      <Button size="xs" variant="ghost" disabled={!!blocker || busy} onClick={() => void submit(true)}>
                        Trust and {action.toLowerCase()}
                      </Button>
                    </span>
                  </Tip>
                  {blocker && <span className="text-muted-foreground text-meta">{blocker}</span>}
                </div>
              </AlertDescription>
            </Alert>
          )}
          {error && <ErrorText className="px-3 pt-2 text-destructive-foreground text-body" text={error} />}
        </>
      }
      footer={
        <>
          {fixed && (
            <span className="flex min-w-0 items-center gap-1.5 px-2.5 text-muted-foreground text-meta">
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">{attempts ? "Each attempt in a new worktree from this branch" : `In ${fixed.name}`}</span>
            </span>
          )}
          {!pinned && (
            <>
              <Pick
                label="Project"
                icon={<FolderIcon />}
                value={project?.id ?? ""}
                options={projects.map((p) => ({ value: p.id, label: p.name, detail: p.places.length > 1 ? `${p.places.length} boxes` : p.places[0].box.name }))}
                onPick={(id) => {
                  setProjectId(id);
                  setBoxChoice(undefined);
                }}
                empty={settled ? "No project" : "Loading…"}
                footer={<AddProjectItem box={box} />}
              />
              {/* With one box there is nothing to choose or tell apart. */}
              {(status?.boxes.length ?? 0) > 1 && <Pick
                label="Box"
                icon={<StatusDot state="online" />}
                value={box}
                options={(project?.places ?? []).map((m) => ({ value: m.box.name, label: m.box.name, detail: boxDetail(m.box.name, m.loc.name) }))}
                onPick={setBoxChoice}
                empty={status ? "No box online" : "Connecting…"}
                footer={project && project.places.length > 1 && box !== project.defaultBox ? <DefaultBoxItem box={box} onSet={() => void setDefault(box)} /> : undefined}
              />}
            </>
          )}
          {(!pinned || from?.kind === "handoff") && !attempts && <Pick label="Where" icon={<GitBranchIcon />} value={where} options={whereOptions} onPick={(v) => setWhere(v as "new" | "main" | "here")} />}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <AgentsPicker
              presets={presets}
              sel={sel}
              copies={copies}
              none={noAgent}
              single={!!from}
              allowNone={fresh && !from && !fixed}
              onChange={pickAgents}
              onCopies={setCopies}
              onNone={setNoAgent}
            />
            <SendButton label={action} dialog={dialog} blocker={blocker} busy={busy} onClick={() => void submit()} />
          </div>
        </>
      }
    />
  );
}

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 32);

// Resolved says what the box made of the text, for the worktree alone.
function Resolved({ resolution, pending, error }: { resolution?: { name?: string; branch?: string; title?: string }; pending: boolean; error?: string }) {
  if (pending) return <span className="text-muted-foreground">Reading it…</span>;
  if (error) return <span className="text-muted-foreground">A new worktree named as typed</span>;
  if (!resolution) return null;
  return (
    <span className="text-muted-foreground">
      {resolution.title ? `${resolution.title} · ` : ""}
      <span className="font-mono">{resolution.branch || resolution.name}</span>
    </span>
  );
}

// ---- A prompt for agents already running ---------------------------------

const free = (e: SessionEntry) => e.state === "ready" || e.state === "finished";

function SendBody({ draft, text, setText, tabs, dialog, autoFocus, onDone, onKind, className }: BodyProps) {
  const prompts = usePrompts((s) => s.prompts);
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const all = useAllSessions();
  const [promptId, setPromptId] = useState(draft.promptId);
  const prompt = prompts.find((p) => p.id === promptId);
  // Its variables, while the text is still the saved prompt's.
  const vars = useMemo(() => askedVariables({ body: text, variables: prompt && text.includes(prompt.body.slice(0, 24)) ? prompt.variables : undefined }), [text, prompt]);
  const [values, setValues] = useState<Record<string, string>>({});
  const asked = withDefaults(vars, values);
  const builtinsUsed = variablesIn(text).filter(isBuiltin);

  const agents = all.filter((e) => e.state !== "exited" && agentOf(e.session));
  // Agents on boxes that are away, as the app last saw them: their prompts
  // wait in the offline queue until the box is back.
  const away = useMemo(() => {
    const off = new Set(status?.boxes.filter((b) => b.state !== "online").map((b) => b.name));
    return Object.entries(boxes)
      .filter(([box]) => off.has(box))
      .flatMap(([box, bd]) => (bd.sessions ?? []).map((session) => ({ box, session, state: sessionState(session, bd.stats) })))
      .filter((e) => e.state !== "exited" && agentOf(e.session));
  }, [boxes, status]);
  const awayBoxes = useMemo(() => new Set(away.map((e) => e.box)), [away]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set((draft.targets ?? []).map((t) => `${t.box}/${t.session}`)));
  const [onlyFree, setOnlyFree] = useState(!draft.targets?.length);
  const preselected = useMemo(() => new Set((draft.targets ?? []).map((t) => `${t.box}/${t.session}`)), [draft.targets]);
  const shown = [...agents.filter((e) => !onlyFree || free(e) || preselected.has(entryKey(e)) || selected.has(entryKey(e))), ...away];
  const chosen = shown.filter((e) => selected.has(entryKey(e)));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string>();
  const first = chosen[0];
  const firstLoc = first ? (first.session.location ?? "") : "";
  const [v, setV] = useState<SendValues>(() => ({
    wait: load("berth.broadcast.wait", true),
    queueOffline: true,
    loop: !!draft.loop,
    check: draft.targets?.[0] ? defaultCheck(draft.targets[0].box, sessionLocationSafe(draft.targets[0].box, draft.targets[0].session)) : "",
    rounds: 5,
  }));
  const [optionsOpen, setOptionsOpen] = useState(!!dialog);
  useEffect(() => {
    if (v.loop) setOptionsOpen(true);
    onKind?.(v.loop ? "loop" : "send");
  }, [v.loop, onKind]);

  // Files go up to the first agent's worktree, and every agent picked is
  // given their paths: so the agents must share a box, which can read them.
  const oneBox = chosen.length > 0 && chosen.every((e) => e.box === chosen[0].box);
  const files = useAttachments(oneBox ? { box: chosen[0].box, session: chosen[0].session.name } : undefined, {
    without: chosen.length ? "The agents picked are on more than one box: pick agents on one box to give them files." : "Pick the agents first: the files go up to their box.",
  });

  const textFor = (e: SessionEntry) => overrides[entryKey(e)] ?? fillPrompt(text, { ...builtinValues(e.box, e.session, boxes[e.box]?.locations), ...asked });
  const missingFor = (e: SessionEntry) => {
    const have = builtinValues(e.box, e.session, boxes[e.box]?.locations);
    return builtinsUsed.filter((n) => !have[n]);
  };
  const awayChosen = chosen.filter((e) => awayBoxes.has(e.box)).length;
  // An agent asked for by name that has ended takes no prompt: say so, and
  // offer to hand its work to a new one instead.
  const ended = (draft.targets ?? []).filter((t) => {
    const listed = boxes[t.box]?.sessions;
    if (!listed) return false;
    const found = listed.find((x) => x.name === t.session);
    return !found || found.exited;
  });
  const endedNames = ended.map((t) => {
    const found = boxes[t.box]?.sessions?.find((x) => x.name === t.session);
    return found ? sessionName(found, { agent: true }) : t.session;
  });
  const blocker =
    ended.length && !chosen.length
      ? `${endedNames.join(", ")} has ended`
      : !chosen.length
        ? "Pick the agents to send to"
        : !text.trim() && !files.paths.length && !v.loop
          ? "Write the prompt first"
          : v.loop && !v.check.trim()
            ? "Give the check to run"
            : files.items.length && !oneBox
              ? "Files go to agents on one box: pick agents on one box, or remove the files"
              : files.blocker;
  const action = v.loop ? (chosen.length > 1 ? `Loop ${chosen.length} agents` : "Start loop") : chosen.length > 1 ? `Send to ${chosen.length} agents` : "Send";

  const submit = () => {
    if (blocker) return;
    const title = prompt?.title ?? (text.trim().split("\n")[0].slice(0, 60) || "Prompt");
    const ok = sendWork({
      targets: chosen.map((e) => ({ box: e.box, session: e.session.name })),
      texts: chosen.map((e) => withAttachments(textFor(e), files.paths)),
      title,
      wait: v.wait && !v.loop,
      queueOffline: v.queueOffline,
      promptId: prompt?.id,
      loop: v.loop ? { check: v.check, rounds: v.rounds, location: firstLoc } : undefined,
    });
    if (!ok) return;
    if (!v.loop && chosen.length === 1 && !v.wait) toastManager.add({ type: "success", title: `Sent to ${sessionName(chosen[0].session, { agent: true })}` });
    setText("");
    files.clear();
    setOverrides({});
    onDone?.({ mode: "send", results: !v.loop && (chosen.length > 1 || v.wait) });
  };

  return (
    <Shell
      className={className}
      drop={files}
      head={
        <>
          {tabs}
          <span className="ml-auto" />
          <SavedPrompts
            onPick={(id, body) => {
              setPromptId(id);
              setText(text.trim() ? `${text.trimEnd()}\n\n${body}` : body);
            }}
          />
          <OptionsToggle open={optionsOpen} onOpen={setOptionsOpen} />
        </>
      }
      editor={
        <Editor
          value={text}
          onChange={setText}
          onSubmit={submit}
          onPaste={files.onPaste}
          above={<AttachmentChips items={files.items} onRemove={files.remove} onRetry={files.retry} className="px-3.5 pt-3" />}
          autoFocus={autoFocus}
          label="What to tell them"
          placeholder={v.loop ? "The first prompt (empty runs the check first)" : "What should they do next? Variables like {{branch}} fill in for each agent."}
        />
      }
      notice={
        ended.length > 0 && (
          <div role="status" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-background/60 px-3 py-2 text-body">
            <span className="min-w-0 flex-1">
              {endedNames.join(", ")} {ended.length === 1 ? "has" : "have"} ended, so {ended.length === 1 ? "it can't" : "they can't"} take a prompt. Hand the work to a new agent instead.
            </span>
            {ended.length === 1 && (
              <Button type="button" size="xs" variant="outline" onClick={() => openComposer({ from: { kind: "handoff", box: ended[0].box, session: ended[0].session }, text: text.trim() || undefined })}>
                Hand off instead
              </Button>
            )}
          </div>
        )
      }
      options={
        optionsOpen && (
          <SendOptions
            vars={vars}
            values={values}
            onValue={(n, val) => setValues((s) => ({ ...s, [n]: val }))}
            chosen={chosen}
            textFor={textFor}
            edited={(e) => entryKey(e) in overrides}
            missingFor={missingFor}
            onEdit={(e, t) => {
              const k = entryKey(e);
              setOverrides((s) => (t == null ? Object.fromEntries(Object.entries(s).filter(([x]) => x !== k)) : { ...s, [k]: t }));
            }}
            open={open}
            onOpen={setOpen}
            awayChosen={awayChosen}
            v={v}
            set={(p) => setV((x) => ({ ...x, ...p }))}
          />
        )
      }
      footer={
        <>
          <TargetsPicker
            shown={shown}
            away={awayBoxes}
            selected={selected}
            onlyFree={onlyFree}
            onOnlyFree={setOnlyFree}
            onToggle={(k, on) =>
              setSelected((s) => {
                const n = new Set(s);
                if (on) n.add(k);
                else n.delete(k);
                return n;
              })
            }
            onAll={(on) => setSelected(new Set(on ? shown.map(entryKey) : []))}
          />
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <SendButton label={action} icon={<SendIcon />} dialog={dialog} blocker={blocker} onClick={submit} />
          </div>
        </>
      }
    />
  );
}

function sessionLocationSafe(box: string, session: string): string {
  try {
    return sessionLocation(box, session);
  } catch {
    return "";
  }
}

// ---- The first prompt for one agent --------------------------------------

function ToBody({ to, onSend, onFail, autoFocus, className }: TaskComposerProps & { to: NonNullable<TaskComposerProps["to"]> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const who = to.agent ? agentLabel(to.agent) : "the agent";
  // Images and files pasted or dropped here go up to the agent's worktree,
  // and their paths go with the prompt.
  const att = useAttachments({ box: to.box, session: to.session });
  // "/" and "@": the agent's commands and the worktree's files.
  const menu = useComposerMenu({ box: to.box, session: to.session, agent: to.agent, text, setText, side: "bottom" });
  const ready = !!text.trim() || att.paths.length > 0;
  const go = async () => {
    if (!ready || busy || att.blocker || !onSend) return;
    setBusy(true);
    try {
      await onSend(withAttachments(text.trim(), att.paths));
      setText("");
      att.clear();
    } catch (err) {
      if (onFail) onFail(err);
      else toastError(err, { title: "Couldn't send it", box: to.box });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      className={className}
      drop={att}
      editor={
        <Editor
          value={text}
          onChange={setText}
          onSubmit={() => void go()}
          onPaste={att.onPaste}
          above={<AttachmentChips items={att.items} onRemove={att.remove} onRetry={att.retry} className="px-3.5 pt-3" />}
          menu={menu}
          autoFocus={autoFocus}
          label={`What should ${who} do?`}
          placeholder={`What should ${who} do?`}
        />
      }
      footer={
        <>
          <span className="flex min-w-0 items-center gap-1.5 px-2.5 text-muted-foreground text-meta">
            <AgentIcon agent={to.agent} className="size-3.5" />
            {who} · {AGENT_WORDS.idle.lower}, waiting for a first task
          </span>
          <div className="ml-auto">
            <SendButton label="Send" blocker={att.blocker ?? (ready ? undefined : "Write the first prompt")} busy={busy} onClick={() => void go()} />
          </div>
        </>
      }
    />
  );
}

// ---- The frame ------------------------------------------------------------

// drop: the composer's attachments, which a file dropped anywhere on the
// frame joins; while one is held over it, the frame is outlined.
function Shell({ head, editor, options, notice, footer, drop, className }: { head?: React.ReactNode; editor: React.ReactNode; options?: React.ReactNode; notice?: React.ReactNode; footer: React.ReactNode; drop?: Attachments; className?: string }) {
  return (
    <Frame data-testid="task-composer" data-dragging={drop?.dragging || undefined} {...drop?.dropProps} className={cn("w-full shadow-lg/5", drop?.dragging && "outline-2 outline-ring/60 outline-dashed outline-offset-4", className)}>
      {head && <div className="-mt-0.5 mb-0.5 flex h-8 min-w-0 items-center gap-0.5 px-0.5">{head}</div>}
      <FramePanel className="p-0 ring-ring/24 transition-shadow has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-[3px]">{editor}</FramePanel>
      {options && <FramePanel className="flex max-h-[min(46vh,30rem)] flex-col gap-4 overflow-y-auto p-3.5">{options}</FramePanel>}
      {notice}
      <FrameFooter className="flex min-w-0 items-center gap-0.5 px-1 pt-1 pb-0">{footer}</FrameFooter>
    </Frame>
  );
}

function Editor({ value, onChange, onSubmit, onPaste, above, autoFocus, label, placeholder, hint, menu }: { value: string; onChange(v: string): void; onSubmit(): void; onPaste?(e: React.ClipboardEvent): void; above?: React.ReactNode; autoFocus?: boolean; label: string; placeholder: string; hint?: React.ReactNode; menu?: ComposerMenu }) {
  return (
    <>
      {above}
      <textarea
        onPaste={onPaste}
        // biome-ignore lint/a11y/noAutofocus: the composer is where typing goes
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={menu?.onSelect}
        onKeyDown={(e) => {
          if (menu?.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        aria-label={label}
        placeholder={placeholder}
        className="field-sizing-content block max-h-60 min-h-[76px] w-full resize-none rounded-[inherit] bg-transparent px-3.5 py-3 text-body outline-none placeholder:text-muted-foreground/72"
      />
      {hint && <p className="-mt-1 truncate px-3.5 pb-2.5 text-meta">{hint}</p>}
      {menu?.chip}
      {menu?.menu}
    </>
  );
}

function SendButton({ label, icon, dialog, blocker, busy, onClick }: { label: string; icon?: React.ReactNode; dialog?: boolean; blocker?: string; busy?: boolean; onClick(): void }) {
  const tip = blocker ?? (
    <span className="flex items-center gap-1.5">
      {label} <Kbd>⏎</Kbd>
    </span>
  );
  if (dialog) {
    return (
      <Tip label={blocker}>
        {/* A disabled button takes no pointer: the wrapper keeps the tip. */}
        <span className="inline-flex">
          <Button size="sm" disabled={!!blocker} loading={busy} onClick={onClick}>
            {icon}
            {label}
            <Kbd className="-me-1 bg-primary-foreground/16 text-primary-foreground/80">⏎</Kbd>
          </Button>
        </span>
      </Tip>
    );
  }
  return (
    <Tip label={tip}>
      <span className="inline-flex">
        <Button size="icon-sm" aria-label={blocker ? `${label}: ${blocker}` : label} disabled={!!blocker} loading={busy} onClick={onClick}>
          <ArrowUpIcon />
        </Button>
      </span>
    </Tip>
  );
}

function OptionsToggle({ open, onOpen }: { open: boolean; onOpen(open: boolean): void }) {
  return (
    <Tip label={open ? "Hide options" : "Options"}>
      <Button size="icon-sm" variant="ghost" aria-label="Options" aria-pressed={open} className={cn("text-muted-foreground hover:text-foreground", open && "bg-background/70 text-foreground")} onClick={() => onOpen(!open)}>
        <SlidersHorizontalIcon />
      </Button>
    </Tip>
  );
}

// ModeTabs switches between new work and a prompt for running agents.
function ModeTabs({ mode, onMode }: { mode: "start" | "send"; onMode(m: "start" | "send"): void }) {
  const running = useStore((s) => Object.values(s.boxes).reduce((n, b) => n + (b.sessions ?? NONE).filter((x) => !x.exited && agentOf(x)).length, 0));
  // With no agent running there is nothing to prompt yet: no tabs.
  if (!running && mode === "start") return null;
  const tab = (m: "start" | "send", label: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => onMode(m)}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-label outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        mode === m ? "bg-background text-foreground shadow-xs/5" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Start new work, or prompt running agents" className="flex items-center gap-0.5">
      {tab("start", "New task")}
      {tab(
        "send",
        <>
          Running agents
          {running > 0 && <span className="text-muted-foreground tabular-nums">{running}</span>}
        </>,
      )}
    </div>
  );
}

// NoProjects is the composer when no online box has a project: with no box
// yet, add one; with none online, see to them; otherwise add a project.
function NoProjects({ className, tabs }: { className?: string; tabs?: React.ReactNode }) {
  const boxes = useStore((s) => s.status?.boxes ?? NONE_BOXES);
  const online = boxes.some((b) => b.state === "online");
  const state = boxes.length === 0 ? "no-boxes" : !online ? "offline" : "no-projects";
  const copy = {
    "no-boxes": { scene: "dock", title: "No boxes yet", text: "Work happens in a project on a box: this Mac, a VPS or a dev machine. Add a box, then a project on it." },
    offline: { scene: "offline", title: "No box is online", text: "Work starts on a box that is online. Check on your boxes in Settings." },
    "no-projects": { scene: "dock", title: "No projects yet", text: "Work happens in a project: a git repository on one of your boxes. Add one first." },
  }[state] as { scene: "dock" | "offline"; title: string; text: string };
  const go = () => {
    if (state === "no-boxes") openAddBox();
    else if (state === "offline") useStore.getState().setView({ kind: "settings", section: "boxes" });
    else useStore.getState().openAddProject();
  };
  return (
    <Frame className={cn("w-full shadow-lg/5", className)}>
      {tabs && <div className="-mt-0.5 mb-0.5 flex h-8 items-center px-0.5">{tabs}</div>}
      <FramePanel className="flex flex-col items-center justify-center gap-1 px-8 py-8 text-center">
        <Scene name={copy.scene} width={120} className="mb-3" />
        <p className="text-row">{copy.title}</p>
        <p className="max-w-xs text-balance text-muted-foreground text-meta">{copy.text}</p>
        <Button size="sm" className="mt-3" onClick={go}>
          <ServerIcon />
          {state === "no-boxes" ? "Add a box" : state === "offline" ? "Open Boxes" : "Add a project"}
        </Button>
      </FramePanel>
    </Frame>
  );
}

const NONE_BOXES: { name: string; state: string }[] = [];
