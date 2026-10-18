import { ArrowRightIcon, GitBranchPlusIcon, KeyRoundIcon, LockIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { startWork } from "@/lib/start-work";
import { useStore } from "@/lib/store";
import { missingKeys, sudoCount, type TeamStatus, type TeamView } from "@/lib/team";
import { UseOnePassword } from "@/views/team/team-keys-note";
import { GitHubMark, OrgAvatar, SourceTag, SudoTag } from "@/views/team/team-parts";

// TeamDone is "You're set up": the team's suggested first task, ready to
// start, and each repo with the two things you do next.
export function TeamDone({ view, run, onShowPlan, onReviewUpdate }: { view: TeamView; run: TeamStatus; onShowPlan(): void; onReviewUpdate(): void }) {
  const name = view.setup?.name ?? view.org.name;
  const first = view.projects.find((p) => p.first_task);
  const firstLoc = first && run.projects.find((p) => p.id === first.id)?.location;
  const [task, setTask] = useState(first?.first_task ?? "");
  const [busy, setBusy] = useState(false);
  const sudo = sudoCount(view);
  const ready = run.projects.filter((p) => p.state === "ready");
  const go = async () => {
    if (!firstLoc) return;
    setBusy(true);
    await startWork({ text: task, box: run.box, location: firstLoc, where: "new", picks: [{ agent: "claude", model: "", effort: "" }] });
    setBusy(false);
  };
  return (
    <div data-testid="team-done">
      <div className="border-b bg-gradient-to-b from-success/8 to-transparent">
        <div className="mx-auto max-w-4xl px-8 pt-8 pb-6 @max-[819px]:px-5 @max-[819px]:pt-6">
          <div className="flex items-center gap-4">
            <OrgAvatar org={view.org} size={44} />
            <div className="min-w-0">
              <h1 className="text-title">You're set up for {name}</h1>
              <p className="mt-0.5 text-muted-foreground text-subtitle">
                {run.box} matches {name}'s team setup at <span className="font-mono">{run.commit}</span>
                {view.source?.kind === "link" && (
                  <>
                    , loaded from <span className="font-mono">{view.source.label}</span>
                  </>
                )}
                . Its repos are in the sidebar.
              </p>
            </div>
          </div>
          {view.update && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/6 px-3 py-2 text-body">
              <span className="min-w-0 flex-1">
                {name}'s setup changed: {view.update.changes.length} changes in {view.update.commits} commits by {view.update.author}
                {view.update.sudo.length ? ", one asks for your password" : ""}.
              </span>
              <Button size="sm" onClick={onReviewUpdate}>
                Review update
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-8 pt-6 pb-16 @max-[819px]:px-5">
        <MissingKeys run={run} />
        {first && firstLoc && (
          <section className="rounded-xl border bg-card p-4" aria-label="Your first task">
            <p className="text-section">Your first task, suggested by {name}</p>
            <Textarea className="mt-2 text-body" value={task} onChange={(e) => setTask(e.target.value)} aria-label="First task" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-meta text-muted-foreground">
                on {first.id} · Claude Code · a new worktree on {run.box}
              </span>
              <Button data-testid="start-first-task" disabled={busy || !task.trim()} onClick={go}>
                Start the agent <ArrowRightIcon />
              </Button>
            </div>
          </section>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3 @max-[819px]:grid-cols-1">
          {ready.map((r) => {
            const p = view.projects.find((x) => x.id === r.id);
            return (
              <div key={r.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-row">{r.repo}</span>
                  {p?.private && <LockIcon className="size-3 text-muted-foreground" />}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                  {p && <SourceTag source={p.source} />}
                  {p?.services.join(", ")}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="xs" variant="outline" onClick={() => r.location && useStore.getState().openNewWorktree({ box: run.box, location: r.location })}>
                    <GitBranchPlusIcon /> New task
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => r.location && useStore.getState().setView({ kind: "project", box: run.box, location: r.location })}>
                    <Settings2Icon /> Project settings
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-muted-foreground">
          {sudo > 0 && (
            <span className="flex items-center gap-2">
              <SudoTag /> sudo asked for your password on {run.box} for {sudo} steps. Shipyard never had it, and nothing kept it.
            </span>
          )}
          <button type="button" onClick={onShowPlan} className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline">
            <GitHubMark className="size-3" /> See what ran
          </button>
        </div>
      </div>
    </div>
  );
}

// MissingKeys lists the keys left blank, by repo, with where to add them,
// and 1Password to turn on when it was skipped.
function MissingKeys({ run }: { run: TeamStatus }) {
  const missing = missingKeys(run);
  if (!missing.length && !run.onepassword_skipped) return null;
  return (
    <section data-testid="team-missing-keys" className="mb-5 rounded-xl border border-warning/30 bg-warning/6 px-4 py-3">
      <p className="flex items-center gap-2 text-section">
        <KeyRoundIcon className="size-4 text-warning-foreground" />
        {missing.length ? "Missing keys: add them in Project settings" : "1Password skipped: the keys you typed are used"}
      </p>
      {missing.length > 0 && (
        <ul className="mt-2 ml-6 space-y-1.5">
          {missing.map((m) => (
            <li key={m.project} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
              <span className="font-medium font-mono">{m.project}</span>
              <span className="min-w-0 font-mono text-muted-foreground">{m.keys.join(", ")}</span>
              {m.location && (
                <Button size="xs" variant="ghost" className="ms-auto" onClick={() => useStore.getState().setView({ kind: "project", box: run.box, location: m.location! })}>
                  <Settings2Icon /> Project settings
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {run.onepassword_skipped && (
        <div className="mt-2.5 ml-6 flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <UseOnePassword run={run} />
          <span className="min-w-0">
            reads the shared keys from the team's 1Password instead; op signs in once on <span className="whitespace-nowrap">{run.box}</span>
          </span>
        </div>
      )}
    </section>
  );
}
