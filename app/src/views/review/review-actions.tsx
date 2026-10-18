import { AlertTriangleIcon, GitCommitHorizontalIcon, GitPullRequestIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { AttachmentChips, useAttachments } from "@/components/conversation/attachments";
import { PickOne } from "@/components/pick-one";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { boxApi } from "@/lib/api";
import { withAttachments } from "@/lib/attachments";
import { agentLabel } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import { describeCode, quote } from "@/lib/git/parse";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { forgetPullRequest, markReviewed, type ReviewEntry, refreshReview, reviewName, useReview, where } from "@/views/review/review-store";
import { commitMessage, lastMessage } from "@/views/review/summary";
import { ErrorText } from "@/components/error-note";

// The three things to do with an agent's finished work: approve it
// (commit, push, open a PR), send it back with a note, or discard it.
// Every command runs with git (and gh) in the worktree on its box.

export type ApproveMode = "commit" | "push" | "pr";

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const baseBranch = (e: ReviewEntry) => (e.base ?? "main").replace(/^origin\//, "");

// approveCommand is the shell for one approval. Messages travel as base64,
// so no quoting can break them.
export function approveCommand(e: ReviewEntry, mode: ApproveMode, message: string, openPR: boolean): string {
  const parts: string[] = [];
  const msg = message.trim();
  if (e.files.length > 0) parts.push(`git add -A && printf %s '${b64(msg)}' | base64 -d | git commit -q -F -`);
  if (mode !== "commit") parts.push("git push -u origin HEAD 2>&1");
  if (mode === "pr" && openPR) {
    const [subject, ...rest] = (msg || e.commits[0]?.subject || e.branch || e.worktree).split("\n");
    const body = rest.join("\n").trim() || `Opened from Shipyard after ${agentLabel(e.agent)} finished in ${e.worktree}.`;
    parts.push(`printf %s '${b64(body)}' | base64 -d | gh pr create --title ${quote(subject.trim())} --body-file - --base ${quote(baseBranch(e))} 2>&1`);
  }
  return parts.join(" && ");
}

// submitOnCmdEnter submits a dialog on ⌘↵ wherever focus is inside it.
const submitOnCmdEnter = (go: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    go();
  }
};

export const DISCARD_COMMAND = "git restore --staged . && git checkout -- . && git clean -fd";

function useExec(entry?: ReviewEntry) {
  const client = useStore((s) => s.client);
  return async (command: string) => {
    if (!client || !entry) throw new Error("Not connected");
    const r = await boxApi.exec(client, entry.box, where(entry), command, "5m");
    if (r.exit_code !== 0) throw new Error(r.output.trim() || `exited with ${r.exit_code}`);
    return r.output;
  };
}

// After acting on an item, refresh and set its new state aside as reviewed,
// so committed-but-unmerged work does not come straight back.
async function settle(entry: ReviewEntry) {
  await refreshReview();
  const next = useReview.getState().entries.find((e) => e.key === entry.key);
  if (next) markReviewed(next);
}

function Target({ entry }: { entry: ReviewEntry }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 py-0.5 text-meta text-muted-foreground">
      <AgentIcon agent={entry.agent} />
      <span className="truncate text-foreground">{reviewName(entry)}</span>
      <span className="shrink-0">· {entry.box}</span>
    </span>
  );
}

export function ApproveDialog({ entry, initial, onClose }: { entry?: ReviewEntry; initial: ApproveMode; onClose(): void }) {
  const client = useStore((s) => s.client);
  const pr = useReview((s) => (entry ? s.prs[entry.key] : undefined));
  const run = useExec(entry);
  const hasFiles = (entry?.files.length ?? 0) > 0;
  const [mode, setMode] = useState<ApproveMode>(initial);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<string>();
  const openPR = !(pr && pr.state === "OPEN");

  // The message starts as the agent's own summary of what it did.
  useEffect(() => {
    if (!entry) return;
    setMode(!hasFiles && initial === "commit" ? "push" : initial);
    setOutput(undefined);
    setError(undefined);
    setMessage("");
    if (!client || !hasFiles) return;
    let live = true;
    boxApi
      .screen(client, entry.box, entry.session)
      .then((r) => live && setMessage((m) => m || commitMessage(lastMessage(r.screen ?? ""), entry.branch)))
      .catch(() => live && setMessage((m) => m || commitMessage([], entry.branch)));
    return () => {
      live = false;
    };
  }, [entry, client, hasFiles, initial]);

  const options = useMemo(
    () =>
      [
        ...(hasFiles ? [{ value: "commit" as const, label: "Commit", icon: <GitCommitHorizontalIcon className="size-3.5" /> }] : []),
        { value: "push" as const, label: hasFiles ? "Commit & push" : "Push", icon: <UploadIcon className="size-3.5" /> },
        { value: "pr" as const, label: openPR ? (hasFiles ? "Commit, push & open PR" : "Push & open PR") : `${hasFiles ? "Commit & push" : "Push"} to PR #${pr?.number}`, icon: <GitPullRequestIcon className="size-3.5" /> },
      ] satisfies { value: ApproveMode; label: string; icon: React.ReactNode }[],
    [hasFiles, openPR, pr?.number],
  );

  if (!entry) return null;
  const pushes = mode !== "commit";
  const valid = !hasFiles || message.trim().length > 0;
  const go = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const out = await run(approveCommand(entry, mode, message, openPR));
      setOutput(out.trim());
      const url = /https:\/\/\S+\/pull\/\d+/.exec(out)?.[0];
      toastManager.add({
        title: mode === "commit" ? `Committed on ${entry.branch}` : mode === "push" ? `Pushed ${entry.branch}` : url ? "Opened a pull request" : `Pushed to PR #${pr?.number}`,
        description: url ?? message.split("\n")[0],
        type: "success",
      });
      if (mode === "pr") forgetPullRequest(entry.key);
      await settle(entry);
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogPopup className="sm:max-w-[34rem]" showCloseButton={false} onKeyDown={submitOnCmdEnter(() => void go())}>
        <DialogHeader className="gap-1.5 px-5 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Approve</DialogTitle>
            <Target entry={entry} />
          </div>
          <DialogDescription>
            {hasFiles ? `Commits ${entry.files.length} changed file${entry.files.length === 1 ? "" : "s"} on ${entry.branch}` : `${entry.ahead || entry.base_ahead} commit${(entry.ahead || entry.base_ahead) === 1 ? "" : "s"} on ${entry.branch}`}
            {pushes && `, then pushes ${entry.branch} to origin`}
            {mode === "pr" && openPR && ` and opens a pull request into ${baseBranch(entry)}`}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 px-5 pb-5">
          <PickOne<ApproveMode> label="What to do" value={mode} options={options} onChange={setMode} />
          {hasFiles && (
            <label className="flex flex-col gap-1.5">
              <span className="text-label">Commit message</span>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                placeholder="What the agent changed, in one line, then details"
                className="font-mono text-mono"
                autoFocus
              />
              <span className="text-meta text-muted-foreground">Drafted from {agentLabel(entry.agent)}'s last message. The first line is the subject{mode === "pr" && openPR ? " and the PR's title" : ""}.</span>
            </label>
          )}
          {pushes && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2 text-meta">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-warning" />
              <span>
                This pushes <span className="font-mono">{entry.branch}</span> to origin from {entry.box}, with that box's git credentials.
              </span>
            </p>
          )}
          {(error || output) && <pre className={cn("max-h-40 overflow-auto whitespace-pre-wrap rounded-md p-2 font-mono text-mono", error ? "bg-destructive/8 text-destructive-foreground" : "bg-muted/60 text-muted-foreground")}>{error ?? output}</pre>}
        </DialogPanel>
        <DialogFooter className="items-center px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void go()} loading={busy} disabled={!valid}>
            {options.find((o) => o.value === mode)?.label}
            <Kbd className="ml-1 h-4.5 bg-primary-foreground/15 text-tag text-primary-foreground">⌘↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SendBackDialog({ entry, onClose }: { entry?: ReviewEntry; onClose(): void }) {
  const client = useStore((s) => s.client);
  const [note, setNote] = useState("Changes requested: ");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A screenshot of what's wrong, say: it goes up to the agent's worktree.
  const files = useAttachments(entry ? { box: entry.box, session: entry.session } : undefined);
  useEffect(() => {
    setNote("Changes requested: ");
    setError(undefined);
    files.clear();
    // Only when the entry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
  if (!entry) return null;
  const go = async () => {
    if (!client || busy || files.blocker || !note.replace(/^Changes requested:\s*/, "").trim()) return;
    setBusy(true);
    try {
      // The person writes this note, so it goes in even at a question.
      await boxApi.send(client, entry.box, entry.session, withAttachments(note.trim(), files.paths), true, { when: "now", force: true });
      toastManager.add({ title: `Sent back to ${agentLabel(entry.agent)}`, description: reviewName(entry), type: "success" });
      void refreshReview();
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogPopup className="sm:max-w-[32rem]" showCloseButton={false} onKeyDown={submitOnCmdEnter(() => void go())}>
        <DialogHeader className="gap-1.5 px-5 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Send back</DialogTitle>
            <Target entry={entry} />
          </div>
          <DialogDescription>Typed into {agentLabel(entry.agent)}'s session as your next prompt. It leaves the inbox while it works.</DialogDescription>
        </DialogHeader>
        <DialogPanel {...files.dropProps} className={cn("flex flex-col gap-2 px-5 pb-5", files.dragging && "outline-2 outline-ring/60 outline-dashed -outline-offset-4")}>
          <AttachmentChips items={files.items} onRemove={files.remove} onRetry={files.retry} />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onPaste={files.onPaste}
            rows={5}
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          />
          {error && <ErrorText className="rounded-md bg-destructive/8 p-2 text-meta text-destructive-foreground" text={error} />}
        </DialogPanel>
        <DialogFooter className="items-center px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void go()} loading={busy} disabled={!!files.blocker || !note.replace(/^Changes requested:\s*/, "").trim()}>
            Send back
            <Kbd className="ml-1 h-4.5 bg-primary-foreground/15 text-tag text-primary-foreground">⌘↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function DiscardDialog({ entry, onClose }: { entry?: ReviewEntry; onClose(): void }) {
  const run = useExec(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setError(undefined), [entry]);
  if (!entry) return null;
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await run(DISCARD_COMMAND);
      toastManager.add({ title: `Discarded changes in ${reviewName(entry)}`, type: "success" });
      await refreshReview();
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };
  const lost = entry.added + entry.removed;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogPopup className="sm:max-w-[32rem]" showCloseButton={false}>
        <DialogHeader className="gap-1.5 px-5 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Discard these changes?</DialogTitle>
            <Target entry={entry} />
          </div>
          <DialogDescription>
            Throws away every uncommitted change in this worktree, new files included. This can't be undone.
            {entry.base_ahead > 0 && ` Its ${entry.base_ahead} commit${entry.base_ahead === 1 ? "" : "s"} on ${entry.branch} are kept.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2 px-5 pb-5">
          <div className="flex items-baseline justify-between text-meta">
            <span className="text-label">
              {entry.files.length} file{entry.files.length === 1 ? "" : "s"} lost
            </span>
            {lost > 0 && <span className="font-mono text-muted-foreground tabular-nums">{lost} line{lost === 1 ? "" : "s"}</span>}
          </div>
          <ul className="max-h-52 overflow-auto rounded-md border bg-muted/30 py-1">
            {entry.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 px-2.5 py-0.5 font-mono text-meta">
                <span className="w-16 shrink-0 font-sans text-muted-foreground">{describeCode(f.code).label}</span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                {!f.binary && (
                  <span className="shrink-0 tabular-nums">
                    <span className="text-success-foreground">+{f.added}</span> <span className="text-destructive-foreground">−{f.removed}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="font-mono text-mono text-muted-foreground">{DISCARD_COMMAND}</p>
          {error && <ErrorText className="rounded-md bg-destructive/8 p-2 text-meta text-destructive-foreground" text={error} />}
        </DialogPanel>
        <DialogFooter className="items-center px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep them
          </Button>
          <Button variant="destructive" onClick={() => void go()} loading={busy}>
            Discard {entry.files.length} file{entry.files.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
