import { CheckIcon, CopyIcon, ExternalLinkIcon, FileWarningIcon, GitBranchIcon, GitPullRequestIcon, HandIcon, KeyRoundIcon, LinkIcon, LogInIcon, ServerIcon, UserRoundXIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ErrorText } from "@/components/error-note";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { openBrowserAt } from "@/lib/actions";
import { ApiError, type Worktree } from "@/lib/api";
import { loginUrl, safeNext } from "@/lib/login-url";
import { worktreeOrigin } from "@/lib/login-users";
import { copyText } from "@/lib/clipboard";
import { plainError } from "@/lib/errors";
import { useEventLog } from "@/lib/events";
import { openUrl } from "@/lib/open-url";
import { reviewLink } from "@/lib/review-link";
import { associationWords, closeReviewSheet, loginLine, openReviewSheet, prReviewApi, type ReviewBox, type ReviewOpened, type ReviewSheet, type SetupChange, shortSha, usePrReview } from "@/lib/pr-review";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openPanel, selectWorktree, wsKey } from "@/lib/workspaces";
import { useRegistry } from "@/plugins/registry";
import { GitHubMark, StateIcon } from "@/views/team/team-parts";

// PrReviewSheet is what a review link opens: everything a review of the PR
// would do on your box, before anything is fetched or run. Review makes a
// worktree at the head commit shown, set up by the team's kit, then opens
// it with its dev server in a Browser tab and the Diff beside it.

type Phase = { kind: "review" } | { kind: "running"; started: number; opened?: ReviewOpened; error?: string };

// PrReviewBody is the sheet's content; its frame (pr-review-sheet.tsx) loads
// it when it first opens.
export function PrReviewBody() {
  const req = usePrReview((s) => s.sheet)!;
  const client = useStore((s) => s.client);
  const [plan, setPlan] = useState<ReviewSheet>();
  const [error, setError] = useState<string>();
  const [box, setBox] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const note = req.note;

  useEffect(() => {
    if (!client || req.invalid !== undefined) return;
    let gone = false;
    const asked = req.target
      ? { repo: req.ref.repo, pr: req.ref.pr, box: req.target.box }
      : {
          link: `${reviewLink(req.ref.repo, req.ref.pr, { as: req.ref.as, path: req.ref.path })}${req.ref.sha ? `&sha=${req.ref.sha}` : ""}`,
        };
    prReviewApi.plan(client, asked).then(
      (p) => {
        if (gone) return;
        setPlan(p);
        setBox((b) => b ?? p.box);
      },
      (err) => !gone && setError(plainError(err)),
    );
    return () => {
      gone = true;
    };
  }, [client, req]);

  if (req.invalid !== undefined) return <Invalid raw={req.invalid} />;

  const picked = plan?.boxes.find((b) => b.box === box) ?? plan?.boxes[0];
  const allowed = !!plan?.verdict.allowed && !!picked && !!plan.head;
  const update = req.mode === "update";

  const start = async () => {
    if (!client || !plan?.head || !picked) return;
    setPhase({ kind: "running", started: Date.now() });
    try {
      const opened =
        update && req.target
          ? await prReviewApi.update(client, {
              ...req.target,
              sha: plan.head.sha,
            })
          : await prReviewApi.open(client, {
              repo: plan.repo,
              pr: plan.pr,
              sha: plan.head.sha,
              box: picked.box,
              ...(plan.login?.as ? { as: plan.login.as } : {}),
              ...(plan.login?.path ? { path: plan.login.path } : {}),
            });
      await useStore.getState().refreshBox(opened.box, ["locations", "services"]);
      setPhase((p) => (p.kind === "running" ? { ...p, opened } : p));
      if (update) finish(opened, true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "moved") {
        // The PR moved on between the sheet and Review: read it again, and
        // ask again about the new head.
        openReviewSheet(req.ref, {
          mode: req.mode,
          target: req.target,
          note: "The PR moved on since you opened this. Here is its new head: check it again before you review.",
        });
        return;
      }
      setPhase((p) => (p.kind === "running" ? { ...p, error: plainError(err) } : p));
    }
  };

  return (
    <>
      <SheetHeader className="border-b pb-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <GitPullRequestIcon className="size-4.5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
              <GitHubMark className="size-3" />
              <span data-testid="pr-review-repo" className="font-mono">
                {req.ref.repo} #{req.ref.pr}
              </span>
              {plan?.draft && <span className="rounded-md border px-1.5 text-[10.5px]">draft</span>}
            </div>
            <SheetTitle data-testid="pr-review-title" className="text-balance">
              {plan?.title ?? (error ? "Couldn't read this PR" : "Reading the PR…")}
            </SheetTitle>
            <SheetDescription>
              {phase.kind === "running"
                ? `Setting it up on ${picked?.box ?? "your box"}.`
                : plan && !plan.verdict.allowed
                  ? "Not one to review in one click. Nothing was fetched or run."
                  : update
                    ? "Move this review to the PR's latest commit. Nothing changes until you confirm."
                    : "Review it on your own box. Nothing is fetched or run until you click Review."}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <SheetPanel>
        <div className="space-y-5 pt-4">
          {note && phase.kind === "review" && <p className="rounded-lg border border-info/30 bg-info/6 px-3 py-2 text-xs leading-relaxed">{note}</p>}
          {error && <ErrorText className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive-foreground text-sm" text={error} />}
          {!plan && !error && (
            <div className="space-y-3">
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-36 rounded-lg" />
            </div>
          )}
          {plan && phase.kind === "running" && picked && <Progress plan={plan} box={picked} phase={phase} update={update} />}
          {plan && phase.kind === "review" && (
            <>
              {!plan.verdict.allowed && <Refused plan={plan} />}
              <Facts plan={plan} />
              {plan.verdict.allowed && (
                <>
                  {plan.changes.length > 0 && <Changes changes={plan.changes} />}
                  {picked && <OnYourBox plan={plan} picked={picked} onPick={setBox} />}
                </>
              )}
            </>
          )}
        </div>
      </SheetPanel>

      <SheetFooter className="flex-row items-center justify-between gap-2 border-t">
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {phase.kind === "running" ? "You can close this; it carries on on the box." : plan?.verdict.allowed && picked ? `On ${picked.box}, at ${shortSha(plan.head!.sha)}` : ""}
        </span>
        <div className="flex shrink-0 gap-2">
          {phase.kind === "review" ? (
            <>
              <Button size="sm" variant="outline" onClick={closeReviewSheet}>
                {plan && !plan.verdict.allowed ? "Close" : "Cancel"}
              </Button>
              {plan && !plan.verdict.allowed ? (
                plan.url && (
                  <Button size="sm" onClick={() => void openUrl(plan.url!)}>
                    <ExternalLinkIcon /> Open on GitHub
                  </Button>
                )
              ) : (
                <Button size="sm" data-testid="pr-review-go" disabled={!allowed} onClick={() => void start()}>
                  {update ? `Update to ${plan?.head ? shortSha(plan.head.sha) : "latest"}` : "Review"}
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={closeReviewSheet}>
              {phase.error ? "Close" : "Hide"}
            </Button>
          )}
        </div>
      </SheetFooter>
    </>
  );
}

function Invalid({ raw }: { raw: string }) {
  return (
    <>
      <SheetHeader className="border-b pb-4">
        <SheetTitle>This isn't a review link Shipyard can open</SheetTitle>
        <SheetDescription>
          A review link names a repository and a PR number, and nothing else: berth://review?repo=OWNER/NAME&amp;pr=N. This one has something else in it, so it was set aside unread.
        </SheetDescription>
      </SheetHeader>
      <SheetPanel>
        {raw && (
          <p data-testid="pr-review-invalid" className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
            {raw.length > 160 ? `${raw.slice(0, 160)}…` : raw}
          </p>
        )}
      </SheetPanel>
      <SheetFooter className="border-t">
        <Button size="sm" variant="outline" onClick={closeReviewSheet}>
          Close
        </Button>
      </SheetFooter>
    </>
  );
}

function Refused({ plan }: { plan: ReviewSheet }) {
  const [head, ...rest] = (plan.verdict.reason ?? "Shipyard can't review this one for you").split(": ");
  return (
    <div data-testid="pr-review-refused" data-code={plan.verdict.code} className="flex items-start gap-3 rounded-lg border bg-muted/40 px-3.5 py-3">
      <HandIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 text-sm leading-relaxed">
        <p className="font-medium">{rest.length ? `${head}.` : head}</p>
        {rest.length > 0 && <p className="text-muted-foreground">{capital(rest.join(": "))}.</p>}
        <p className="mt-1 text-muted-foreground text-xs">{REFUSED_WHY[plan.verdict.code ?? ""] ?? ""}</p>
      </div>
    </div>
  );
}

const REFUSED_WHY: Record<string, string> = {
  fork: "Shipyard sets up reviews only for branches in the repository itself, since a fork's code would run on your box with your team's keys.",
  outsider: "Shipyard sets up reviews only for PRs by members and collaborators, since the PR's code runs on your box with your team's keys.",
  not_a_project: "Review links work for your team's projects, and for projects already on one of your boxes.",
  closed: "There is nothing left to review.",
  no_box: "The review runs in a worktree of the project on your box.",
  unreadable: "Your own GitHub sign-in decides what you can see.",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Section({ title, children, testId, aside }: { title: string; children: ReactNode; testId?: string; aside?: ReactNode }) {
  return (
    <section data-testid={testId}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-sm">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 text-[13px]">{children}</dd>
    </>
  );
}

function Facts({ plan }: { plan: ReviewSheet }) {
  const [copied, setCopied] = useState(false);
  if (!plan.author || !plan.head) return null;
  const trusted = ["MEMBER", "OWNER", "COLLABORATOR"].includes(plan.author.association);
  return (
    <Section title="Pull request" testId="pr-review-facts">
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 rounded-lg border px-3.5 py-3">
        <Fact label="Author">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium">{plan.author.login}</span>
            <span data-testid="pr-review-association" className={cn("inline-flex items-center gap-1 text-xs", trusted ? "text-success-foreground" : "text-muted-foreground")}>
              {trusted && <CheckIcon className="size-3" />}
              {associationWords(plan.author.association, plan.org)}
            </span>
          </span>
        </Fact>
        <Fact label="Branch">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {plan.head.cross && plan.head.repo ? `${plan.head.repo.split("/")[0]}:` : ""}
              {plan.head.branch}
            </span>
            {plan.base && <span className="shrink-0 text-muted-foreground">→ {plan.base.branch}</span>}
          </span>
        </Fact>
        <Fact label="Head commit">
          <span className="flex min-w-0 items-center gap-1.5">
            <span data-testid="pr-review-sha" data-sha={plan.head.sha} className="rounded bg-muted px-1.5 py-px font-mono font-medium text-xs">
              {shortSha(plan.head.sha)}
            </span>
            <Tip label={copied ? "Copied" : "Copy the full commit"}>
              <button
                type="button"
                aria-label="Copy the full commit"
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => void copyText(plan.head!.sha, "Commit").then((ok) => ok && setCopied(true))}
              >
                {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </button>
            </Tip>
          </span>
          <span className="mt-0.5 block break-all font-mono text-[10.5px] text-muted-foreground">{plan.head.sha}</span>
          {plan.verdict.allowed && <span className="mt-0.5 block text-muted-foreground text-xs">The review stays at this commit; newer ones wait until you update.</span>}
          {plan.hint && !plan.hint.matches && <span className="mt-0.5 block text-warning-foreground text-xs">The link was made at {plan.hint.sha.slice(0, 7)}; the PR has moved on since.</span>}
        </Fact>
        {/* A refused PR's files are never read, so there is no count. */}
        {(plan.verdict.allowed || plan.files > 0) && (
          <Fact label="Changes">
            <span className="text-xs">
              {plan.files} {plan.files === 1 ? "file" : "files"}
              {plan.state && plan.state !== "OPEN" ? ` · ${plan.state.toLowerCase()}` : ""}
            </span>
          </Fact>
        )}
      </dl>
    </Section>
  );
}

function Changes({ changes }: { changes: SetupChange[] }) {
  return (
    <section data-testid="pr-review-changes" className="rounded-lg border border-warning/30 bg-warning/5">
      <div className="flex items-start gap-2.5 border-warning/20 border-b px-3.5 py-2.5">
        <FileWarningIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
        <div className="text-sm leading-relaxed">
          <p className="font-medium">This PR changes files that affect setup</p>
          <p className="text-muted-foreground text-xs">Setup still comes from your team's kit, not from the PR. Worth a look before you start.</p>
        </div>
      </div>
      <ul className="divide-y divide-warning/15">
        {changes.map((c) => (
          <li key={c.kind} data-testid={`pr-review-change-${c.kind}`} className="px-3.5 py-2 pl-10">
            <p className="text-[13px]">{c.title}</p>
            {c.detail && <p className="text-muted-foreground text-xs">{c.detail}</p>}
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{c.files.join(", ")}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FROM: Record<ReviewBox["setup"]["from"], (b: ReviewBox) => string> = {
  kit: (b) => `From the ${b.setup.kit?.name ?? "team's"} kit${b.setup.kit?.version ? ` (${b.setup.kit.version})` : ""}`,
  repo: (b) => `From ${b.setup.default_branch ?? "the default branch"}'s .berth/config.json, as this box trusts it`,
  box: () => "From this box's own settings for the project",
  none: () => "Nothing: the project has no setup",
};

function OnYourBox({ plan, picked, onPick }: { plan: ReviewSheet; picked: ReviewBox; onPick(b: string): void }) {
  const s = picked.setup;
  const several = plan.boxes.length > 1;
  const opens = loginLine(plan, picked);
  return (
    <>
      <Section
        title="What will run"
        testId="pr-review-runs"
        aside={
          several ? (
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              On
              <SimpleSelect
                size="sm"
                aria-label="Box"
                className="h-7 min-w-28"
                value={picked.box}
                onChange={onPick}
                options={plan.boxes.map((b) => ({
                  value: b.box,
                  label: b.box,
                }))}
              />
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <ServerIcon className="size-3" /> On {picked.box}
            </span>
          )
        }
      >
        <div className="divide-y rounded-lg border">
          <div className="px-3.5 py-2.5">
            <p className="text-[13px]">
              Setup <span className="text-muted-foreground text-xs">· {FROM[s.from](picked)}</span>
            </p>
            {s.script && <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[11.5px] text-foreground/85">$ {s.script}</pre>}
          </div>
          {s.services.length > 0 && (
            <div className="px-3.5 py-2.5">
              <p className="mb-1 text-[13px]">Services</p>
              <ul className="space-y-1">
                {s.services.map((sv) => (
                  <li key={sv.name} className="flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="shrink-0 font-medium">{sv.title ?? sv.name}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{sv.run}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {opens && (
            <div data-testid="pr-review-login" data-allowed={opens.allowed} className="flex items-start gap-2 px-3.5 py-2.5 text-xs leading-relaxed">
              <LogInIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn(!opens.allowed && "text-muted-foreground")}>{opens.text}</span>
            </div>
          )}
          <p className="px-3.5 py-2 text-muted-foreground text-xs leading-relaxed">
            Nothing from this PR's own .berth/ runs, and git hooks are off while it's checked out.
            {s.matches_default === false ? ` This box's main checkout has a .berth/config.json other than ${s.default_branch ?? "the default branch"}'s; the one you trusted here is used.` : ""} Its
            dev server is reachable only through Shipyard's private URL
            {s.hooks > 0 ? `, and the project's ${s.hooks} ${s.hooks === 1 ? "hook runs" : "hooks run"} as in any worktree` : ""}.
          </p>
        </div>
      </Section>
      <Section title="Keys" testId="pr-review-keys">
        <div className="divide-y rounded-lg border text-xs leading-relaxed">
          <div className="flex items-start gap-2.5 px-3.5 py-2.5">
            <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[13px]">
                {picked.secrets.shared.length > 0
                  ? `The team's shared keys (${picked.secrets.shared.length}), as any worktree of ${plan.repo.split("/")[1]} gets them`
                  : "The team shares no keys for this project"}
              </p>
              {picked.secrets.shared.length > 0 && <p className="break-words font-mono text-[11px] text-muted-foreground">{picked.secrets.shared.join("  ")}</p>}
            </div>
          </div>
          {picked.secrets.withheld.length > 0 && (
            <div data-testid="pr-review-withheld" className="flex items-start gap-2.5 px-3.5 py-2.5">
              <UserRoundXIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-[13px]">Never your own keys</p>
                <p className="break-words font-mono text-[11px] text-muted-foreground">{picked.secrets.withheld.join("  ")}</p>
              </div>
            </div>
          )}
        </div>
      </Section>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {picked.existing
          ? `${picked.box} already has this review (${picked.existing.worktree}, at ${shortSha(picked.existing.sha)}): Review ${picked.existing.sha === plan.head?.sha ? "opens it" : "moves it to this commit"}. `
          : ""}
        It's removed when the PR is merged or closed{picked.idle_days > 0 ? `, or after ${picked.idle_days} days idle` : ""}
        {s.archive ? ", through the project's archive step (which drops its database)" : ""}. Never with uncommitted changes without asking.
      </p>
    </>
  );
}

// ---- Progress ----

type StepState = "todo" | "running" | "done" | "skipped" | "failed";

function Progress({ plan, box, phase, update }: { plan: ReviewSheet; box: ReviewBox; phase: Extract<Phase, { kind: "running" }>; update: boolean }) {
  const events = useEventLog((s) => s.events);
  const opened = phase.opened;
  const path = opened?.worktree.path;
  const mine = (type: string) => !!path && events.some((e) => e.type === type && e.box === opened!.box && e.data?.path === path && Date.parse(e.time) >= phase.started - 1000);
  const autostart = box.setup.services.some((s) => s.autostart);
  const setupDone = !box.setup.script || mine("worktree.setup.finished");
  const setupFailed = mine("worktree.setup.failed");
  const serverUp = !autostart || mine("service.started");
  const sha = shortSha(plan.head!.sha);

  const steps: {
    id: string;
    title: string;
    detail?: string;
    state: StepState;
  }[] = [
    {
      id: "check",
      title: "Checking the PR again",
      detail: `${plan.author?.login}, ${associationWords(plan.author?.association ?? "", plan.org).toLowerCase()}; head still ${sha}`,
      state: opened ? "done" : phase.error ? "failed" : "running",
    },
    {
      id: "fetch",
      title: `Fetching ${sha} and checking it is the commit shown`,
      state: opened ? "done" : "todo",
    },
    {
      id: "worktree",
      title: update ? `Moving ${opened?.worktree.name ?? "the review"} to ${sha}` : `Making the worktree${opened ? ` ${opened.worktree.name}` : ""}`,
      state: opened ? "done" : "todo",
    },
  ];
  if (!update) {
    steps.push({
      id: "setup",
      title: box.setup.kit ? `Setting up with the ${box.setup.kit.name} kit` : "Setting up",
      detail: box.setup.script,
      state: !opened ? "todo" : setupFailed ? "failed" : !box.setup.script ? "skipped" : setupDone ? "done" : "running",
    });
    steps.push({
      id: "server",
      title: "Starting the dev server",
      state: !opened || !setupDone || setupFailed ? "todo" : !autostart ? "skipped" : serverUp ? "done" : "running",
    });
  }
  const ready = !!opened && setupDone && serverUp && !setupFailed;

  const finished = useRef(false);
  useEffect(() => {
    if (ready && opened && !update && !finished.current) {
      finished.current = true;
      finish(opened, false, openAt(plan, box));
    }
  }, [ready, opened, update, plan, box]);

  return (
    <section data-testid="pr-review-progress" className="space-y-3">
      <ol className="divide-y rounded-lg border">
        {steps.map((s) => (
          <li key={s.id} data-testid={`pr-review-step-${s.id}`} data-state={s.state} className={cn("flex items-start gap-2.5 px-3.5 py-2.5", s.state === "failed" && "bg-destructive/5")}>
            <StateIcon state={s.state} className="mt-px" />
            <div className="min-w-0">
              <p className={cn("text-[13px]", s.state === "todo" && "text-muted-foreground")}>{s.title}</p>
              {s.detail && <p className="truncate font-mono text-[11px] text-muted-foreground">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {phase.error && <ErrorText className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive-foreground text-sm" text={phase.error} />}
      {setupFailed && <p className="text-muted-foreground text-xs">Its setup failed; the notification has its output. The worktree is there to look at.</p>}
      {opened && !ready && !update && (
        <Button size="sm" variant="outline" onClick={() => finish(opened, false, openAt(plan, box))}>
          <LinkIcon /> Open it now
        </Button>
      )}
    </section>
  );
}

// openAt is how the link asked to open the review, as far as the box's
// project allows: logged in only when its trusted login lists the user.
function openAt(plan: ReviewSheet, box: ReviewBox): { as?: string; path?: string } {
  return { as: plan.login?.as && box.login?.allowed ? plan.login.as : undefined, path: plan.login?.path };
}

// finish closes the sheet and opens the review: the worktree, its dev
// server in a Browser tab (through the login route when the link asked for
// a user the project allows, at the link's page), and its Diff beside it.
function finish(opened: ReviewOpened, update: boolean, at: { as?: string; path?: string } = {}) {
  closeReviewSheet();
  const st = useStore.getState();
  const wt: Worktree = opened.worktree;
  const ref = {
    box: opened.box,
    location: opened.location,
    worktree: wt.name,
    path: wt.path,
    main: false,
  };
  selectWorktree(ref);
  if (update) return;
  const origin = worktreeOrigin(ref, st.status?.proxy.url_port);
  const url = !origin ? "" : at.as ? loginUrl(origin, at.as, at.path) : `${origin}${safeNext(at.path)}`;
  openBrowserAt(url, { kind: "tab" }, wsKey(opened.box, wt.path));
  whenPanel("diff", "diff", () => openPanel("diff", "diff", "Diff", { split: "row" }));
}

// whenPanel runs open once a plugin's worktree panel is registered: the
// Diff is a built-in plugin, which may still be loading when a review
// opens straight after the app starts.
function whenPanel(plugin: string, id: string, open: () => void, wait = 8000) {
  const has = () => useRegistry.getState().worktreePanels.some((p) => p.plugin === plugin && p.item.id === id);
  if (has()) return open();
  const stop = useRegistry.subscribe(() => {
    if (!has()) return;
    stop();
    clearTimeout(timer);
    open();
  });
  const timer = setTimeout(stop, wait);
}
