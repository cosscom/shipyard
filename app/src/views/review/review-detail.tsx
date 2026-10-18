import { CheckCheckIcon, CheckIcon, ChevronDownIcon, GitBranchIcon, GitCommitHorizontalIcon, GitPullRequestIcon, GlobeIcon, MessageSquareReplyIcon, MessageSquareTextIcon, SendIcon, SquareArrowOutUpRightIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Tip } from "@/components/tip";
import { AgentIcon } from "@/components/agent-glyph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { boxApi } from "@/lib/api";
import { useShotUrl } from "@/lib/agent-browser";
import { agentLabel } from "@/lib/derive";
import { ago } from "@/lib/format";
import { DiffView, FileRow, type LineComments, type Run } from "@/lib/git/diff-view";
import type { FileChange } from "@/lib/git/parse";
import { useLoops } from "@/lib/loops";
import { addComment, commentsPrompt, dismissComments, type LineComment, pending, removeComment, sendComments, useComments } from "@/lib/review-comments";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { useSessionTitle } from "@/hooks/use-session-name";
import { cn } from "@/lib/utils";
import type { ApproveMode } from "@/views/review/review-actions";
import { type ReviewEntry, useReview, useReviewName, where } from "@/views/review/review-store";
import { lastMessage } from "@/views/review/summary";

export interface DetailActions {
  approve(mode: ApproveMode): void;
  sendBack(): void;
  discard(): void;
  open(): void;
  markReviewed(): void;
}

// ReviewDetail is one item: what the agent said last, what it changed, its
// commits, its last check, and the four things to do about it.
export function ReviewDetail({ entry, actions }: { entry: ReviewEntry; actions: DetailActions }) {
  const pr = useReview((s) => s.prs[entry.key]);
  const run = useReview((s) => s.runs[entry.key]);
  const loop = useLoops((s) => s.loops.filter((l) => l.box === entry.box && l.session === entry.session).at(-1));
  const hasFiles = entry.files.length > 0;
  const unpushed = entry.upstream ? entry.ahead : entry.base_ahead;
  // Led by the work the agent did, when its session has a title.
  const work = useSessionTitle(entry.box, entry.session);
  const name = useReviewName(entry);
  const title = work ?? name;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b px-6 pt-4 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <AgentIcon agent={entry.agent} className="size-4" />
              <h2 className="truncate text-heading">{title}</h2>
              {entry.agent_state === "waiting" ? (
                <Badge variant="warning" size="sm">
                  Waiting for you
                </Badge>
              ) : (
                <span className="shrink-0 text-meta text-muted-foreground">
                  {agentLabel(entry.agent)} finished {ago(entry.state_since)}
                </span>
              )}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
              <span>
                {work && `${name} · `}
                {entry.box} · {entry.location}
              </span>
              {entry.branch && (
                <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                  <GitBranchIcon className="size-3" />
                  <span className="truncate">{entry.branch}</span>
                  {entry.base && <span className="text-muted-foreground">→ {entry.base.replace(/^origin\//, "")}</span>}
                </span>
              )}
              {unpushed > 0 && (
                <span>
                  {unpushed} commit{unpushed === 1 ? "" : "s"} {entry.upstream ? "not pushed" : "not on origin yet"}
                </span>
              )}
              {pr && (
                <button type="button" onClick={() => void openUrl(pr.url)} className="inline-flex items-center gap-1 hover:text-foreground">
                  <GitPullRequestIcon className="size-3" />
                  PR #{pr.number}
                  <span className="text-muted-foreground">· {pr.isDraft ? "draft" : pr.state.toLowerCase()}</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex">
            <Button size="sm" className="rounded-r-none" onClick={() => actions.approve(hasFiles ? "commit" : "push")}>
              <CheckIcon />
              Approve…
              <Kbd className="ml-0.5 hidden h-4.5 bg-primary-foreground/15 text-tag text-primary-foreground xl:inline-flex">A</Kbd>
            </Button>
            <Menu>
              <MenuTrigger render={<Button size="sm" className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5" aria-label="More ways to approve" />}>
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                {hasFiles && (
                  <MenuItem onClick={() => actions.approve("commit")}>
                    <GitCommitHorizontalIcon />
                    Commit…
                  </MenuItem>
                )}
                <MenuItem onClick={() => actions.approve("push")}>
                  <CheckIcon />
                  {hasFiles ? "Commit & push…" : "Push…"}
                </MenuItem>
                <MenuItem onClick={() => actions.approve("pr")}>
                  <GitPullRequestIcon />
                  {pr?.state === "OPEN" ? `${hasFiles ? "Commit & push" : "Push"} to PR #${pr.number}…` : `${hasFiles ? "Commit, push & open PR" : "Push & open PR"}…`}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
          <Button size="sm" variant="outline" onClick={actions.sendBack}>
            <MessageSquareReplyIcon />
            Send back…
            <Kbd className="ml-0.5 hidden h-4.5 text-tag xl:inline-flex">S</Kbd>
          </Button>
          <Tip label={hasFiles ? undefined : "Nothing uncommitted to discard"}>
            <Button size="sm" variant="outline" onClick={actions.discard} disabled={!hasFiles}>
              <Trash2Icon />
              Discard…
              <Kbd className="ml-0.5 hidden h-4.5 text-tag xl:inline-flex">D</Kbd>
            </Button>
          </Tip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="ghost" onClick={actions.open}>
            <SquareArrowOutUpRightIcon />
            <span className="hidden xl:inline">Open worktree</span>
            <span className="xl:hidden">Open</span>
            <Kbd className="ml-0.5 hidden h-4.5 text-tag xl:inline-flex">↵</Kbd>
          </Button>
          <Tip label="Mark reviewed (E): it comes back if the agent changes anything">
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={actions.markReviewed}>
              <CheckCheckIcon />
              <span className="hidden xl:inline">Mark reviewed</span>
              <Kbd className="ml-0.5 hidden h-4.5 text-tag xl:inline-flex">E</Kbd>
            </Button>
          </Tip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-6 py-4">
          <LastWords entry={entry} />
          {(run || loop) && <LastCheck run={run} loop={loop} />}
          {entry.browser && <AgentBrowserArtifacts entry={entry} />}
          <CommentsBar entry={entry} />
          <Changes entry={entry} />
          {entry.commits.length > 0 && <Commits entry={entry} />}
        </div>
      </div>
    </div>
  );
}

// AgentBrowserArtifacts shows what the agent saw in its browser: its last
// shots, the page it ended on, and the console errors it left.
function AgentBrowserArtifacts({ entry }: { entry: ReviewEntry }) {
  const b = entry.browser!;
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle className="flex items-center gap-2 text-section">
          <GlobeIcon className="size-3.5 text-muted-foreground" />
          The agent's browser
          {b.url && <span className="truncate font-mono font-normal text-meta text-muted-foreground">{b.url}</span>}
        </FrameTitle>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-2">
        {(b.shots?.length ?? 0) > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {b.shots!.map((name) => (
              <Shot key={name} entry={entry} name={name} />
            ))}
          </div>
        )}
        {(b.errors?.length ?? 0) > 0 && (
          <pre className="max-h-32 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-mono text-destructive-foreground">{b.errors!.join("\n")}</pre>
        )}
      </FramePanel>
    </Frame>
  );
}

function Shot({ entry, name }: { entry: ReviewEntry; name: string }) {
  const url = useShotUrl(entry.box, entry.location, entry.worktree, name);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border">
      <img src={url} alt={`The agent's screenshot ${name}`} className="aspect-[16/10] w-full object-cover object-top" />
    </a>
  ) : (
    <div className="aspect-[16/10] rounded-lg border bg-muted/40" />
  );
}

function LastWords({ entry }: { entry: ReviewEntry }) {
  const client = useStore((s) => s.client);
  const [lines, setLines] = useState<string[]>();
  useEffect(() => {
    if (!client) return;
    let live = true;
    setLines(undefined);
    boxApi
      .screen(client, entry.box, entry.session)
      .then((r) => live && setLines(lastMessage(r.screen ?? "")))
      .catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [client, entry.box, entry.session, entry.state_since]);
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 px-4 py-2.5">
        <AgentIcon agent={entry.agent} />
        <FrameTitle className="text-section">{agentLabel(entry.agent)}'s last message</FrameTitle>
      </FrameHeader>
      <FramePanel className="px-4 py-3">
        {lines === undefined ? (
          <div className="h-12 animate-pulse rounded bg-muted/60" />
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground text-body">Nothing on its screen to show.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto font-mono text-mono">
            {lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {l || " "}
              </div>
            ))}
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}

function LastCheck({ run, loop }: { run?: ReturnType<typeof useReview.getState>["runs"][string]; loop?: ReturnType<typeof useLoops.getState>["loops"][number] }) {
  // The loop is newer when it started after the flow run.
  const useLoop = loop && (!run || loop.started > Date.parse(run.started));
  const passed = useLoop ? loop!.outcome === "passed" : run!.status === "succeeded";
  const pending = useLoop ? !loop!.outcome : run!.status === "running";
  const failedStep = !useLoop ? run!.steps.find((s) => s.status === "failed") : undefined;
  const output = useLoop ? loop!.output : (failedStep ?? run!.steps.filter((s) => s.kind === "run").at(-1))?.output;
  const what = useLoop ? `Loop: ${loop!.check}` : `Flow: ${run!.flow}`;
  const when = useLoop ? ago(new Date(loop!.ended ?? loop!.started).toISOString()) : ago(run!.finished ?? run!.started);
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 px-4 py-2.5">
        <span className={cn("inline-flex size-4 items-center justify-center rounded-full", pending ? "bg-muted" : passed ? "bg-success/15 text-success-foreground" : "bg-destructive/15 text-destructive-foreground")}>
          {pending ? <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" /> : passed ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
        </span>
        <FrameTitle className="min-w-0 truncate text-section">
          Last check {pending ? "running" : passed ? "passed" : "failed"}
        </FrameTitle>
        <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">{what}</span>
        <span className="ml-auto shrink-0 text-meta text-muted-foreground">{when}</span>
      </FrameHeader>
      {!passed && output && (
        <FramePanel className="px-4 py-3">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-mono text-muted-foreground">{output.trim()}</pre>
        </FramePanel>
      )}
    </Frame>
  );
}

function Changes({ entry }: { entry: ReviewEntry }) {
  const client = useStore((s) => s.client);
  const groups = useMemo(
    () =>
      [
        { id: "uncommitted" as const, label: "Uncommitted", files: entry.files as FileChange[] },
        { id: "committed" as const, label: `On ${entry.branch ?? "the branch"}`, files: entry.committed as FileChange[] },
      ].filter((g) => g.files.length > 0),
    [entry],
  );
  const [group, setGroup] = useState<"uncommitted" | "committed">(groups[0]?.id ?? "uncommitted");
  const [selected, setSelected] = useState<string>();
  const current = groups.find((g) => g.id === group) ?? groups[0];
  const file = current?.files.find((f) => f.path === selected) ?? current?.files[0];
  // It changes only when where it runs does: the diff below loads again
  // whenever it is a new function.
  const at = where(entry);
  const run: Run = useCallback((command: string) => (client ? boxApi.exec(client, entry.box, at, command, "60s") : Promise.reject(new Error("Not connected"))), [client, entry.box, at]);
  const all = useComments((s) => s.byKey[entry.key]) ?? NO_COMMENTS;
  const comments = useMemo<LineComments | undefined>(
    () =>
      file && {
        list: all.filter((c) => c.file === file.path),
        onAdd: (line, side, text) => addComment(entry.key, { file: file.path, line, side, text }),
        onRemove: (id) => removeComment(entry.key, id),
      },
    [all, file, entry.key],
  );
  const counts = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of pending(all)) n[c.file] = (n[c.file] ?? 0) + 1;
    return n;
  }, [all]);

  useEffect(() => {
    // "Open in Review" from a conversation names the file to show.
    const focus = useComments.getState().focus;
    if (focus?.key === entry.key) {
      const g = groups.find((x) => x.files.some((f) => f.path === focus.file));
      setGroup(g?.id ?? groups[0]?.id ?? "uncommitted");
      setSelected(focus.file);
      useComments.setState({ focus: undefined });
      return;
    }
    setGroup(groups[0]?.id ?? "uncommitted");
    setSelected(undefined);
  }, [entry.key, groups]);

  if (!current) return null;
  const added = current.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = current.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-1 px-2 py-1.5">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => {
              setGroup(g.id);
              setSelected(undefined);
            }}
            className={cn("rounded-md px-2.5 py-1 text-desc text-foreground/80 hover:bg-background/60", g.id === current.id && "bg-background font-medium text-foreground shadow-xs/5")}
          >
            {g.label}
            <span className="ml-1.5 font-mono text-meta text-muted-foreground tabular-nums">{g.files.length}</span>
          </button>
        ))}
        <span className="ml-auto pr-2 font-mono text-meta tabular-nums">
          <span className="text-success-foreground">+{added}</span> <span className="text-destructive-foreground">−{removed}</span>
        </span>
      </FrameHeader>
      <FramePanel className="flex h-[30rem] min-h-0 overflow-hidden p-0">
        <ul className="w-60 shrink-0 overflow-y-auto border-r p-1.5">
          {current.files.map((f) => (
            <FileRow key={`${current.id}:${f.path}`} file={f} active={f.path === file?.path} onSelect={() => setSelected(f.path)} comments={counts[f.path]} />
          ))}
        </ul>
        {file && <DiffView key={`${entry.key}:${current.id}:${file.path}:${entry.head}`} file={file} run={run} base={current.id === "committed" ? entry.base : undefined} comments={comments} />}
      </FramePanel>
    </Frame>
  );
}

const NO_COMMENTS: LineComment[] = [];

// CommentsBar collects the notes left on this worktree's diff and sends
// them to its agent as one short prompt, held until the agent is idle.
function CommentsBar({ entry }: { entry: ReviewEntry }) {
  const all = useComments((s) => s.byKey[entry.key]) ?? NO_COMMENTS;
  const [busy, setBusy] = useState(false);
  const todo = pending(all);
  const sent = all.filter((c) => c.sent);
  const who = agentLabel(entry.agent);
  if (!all.length) {
    return null;
  }
  const fit = commentsPrompt(todo).included.length;
  const send = async () => {
    setBusy(true);
    try {
      const r = await sendComments(entry.box, entry.session, entry.key);
      toastManager.add({
        type: "success",
        title: `Sent ${r.sent} comment${r.sent === 1 ? "" : "s"} to ${who}`,
        description: r.queued ? `Queued: ${who} gets them when its turn ends.` : r.left ? `${r.left} more didn't fit in one message; send again for them.` : undefined,
      });
    } catch (err) {
      toastManager.add({ type: "error", title: `Couldn't send the comments to ${who}`, description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  if (!todo.length) {
    const last = Math.max(...sent.map((c) => c.sent ?? 0));
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-4 py-2.5 text-desc">
        <CheckIcon className="size-3.5 text-success-foreground" />
        <span className="min-w-0 flex-1 truncate">
          Sent {sent.length} comment{sent.length === 1 ? "" : "s"} to {who} {ago(new Date(last).toISOString())}
        </span>
        <Button size="xs" variant="ghost" onClick={() => dismissComments(entry.key, true)}>
          Clear
        </Button>
      </div>
    );
  }
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 px-4 py-2.5">
        <MessageSquareTextIcon className="size-3.5 text-muted-foreground" />
        <FrameTitle className="min-w-0 flex-1 truncate text-section">
          {todo.length} comment{todo.length === 1 ? "" : "s"} for {who}
        </FrameTitle>
        <Button size="xs" variant="ghost" onClick={() => dismissComments(entry.key, false)}>
          Discard
        </Button>
        <Button size="xs" loading={busy} onClick={() => void send()}>
          <SendIcon />
          Send to {who}
        </Button>
      </FrameHeader>
      <FramePanel className="px-4 py-2.5">
        <ul className="flex flex-col gap-1 text-desc">
          {todo.slice(0, 5).map((c) => (
            <li key={c.id} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-meta text-muted-foreground">
                {c.file.split("/").pop()}:{c.line}
                {c.side === "old" && " (removed)"}
              </span>
              <span className="min-w-0 truncate">{c.text}</span>
            </li>
          ))}
          {todo.length > 5 && <li className="text-meta text-muted-foreground">and {todo.length - 5} more</li>}
        </ul>
        <p className="mt-2 text-meta text-muted-foreground">
          {fit < todo.length
            ? `The first ${fit} fit in one message (2 KB); send again for the rest.`
            : `${who} gets each file and line with your note, not the code: it reads the file itself. It waits until ${who} is idle.`}
        </p>
      </FramePanel>
    </Frame>
  );
}

function Commits({ entry }: { entry: ReviewEntry }) {
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 px-4 py-2.5">
        <GitCommitHorizontalIcon className="size-3.5 text-muted-foreground" />
        <FrameTitle className="text-section">
          {entry.base_ahead} commit{entry.base_ahead === 1 ? "" : "s"} not on {(entry.base ?? "base").replace(/^origin\//, "")}
        </FrameTitle>
      </FrameHeader>
      <FramePanel className="p-0">
        <ul className="divide-y">
          {entry.commits.map((c) => (
            <li key={c.sha} className="flex items-center gap-3 px-4 py-2 text-desc">
              <span className="shrink-0 font-mono text-meta text-muted-foreground">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{c.subject}</span>
              <span className="shrink-0 text-meta text-muted-foreground">
                {c.author} · {ago(c.when)}
              </span>
            </li>
          ))}
        </ul>
        {entry.base_ahead > entry.commits.length && <p className="border-t px-4 py-2 text-meta text-muted-foreground">and {entry.base_ahead - entry.commits.length} older</p>}
      </FramePanel>
    </Frame>
  );
}
