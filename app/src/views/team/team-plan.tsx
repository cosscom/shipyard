import { CopyIcon, ExternalLinkIcon, FileCodeIcon, KeyRoundIcon, LockIcon, RotateCwIcon, SquareTerminalIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TerminalView } from "@/components/workspace/terminal-view";
import { copyText } from "@/lib/clipboard";
import { bytes } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import { plural } from "@/lib/format";
import { durationOf, type ExistingClone, type PlanStep, type ProjectView, type TeamStatus, type TeamUpdate, type TeamView } from "@/lib/team";
import { cn } from "@/lib/utils";
import { adoptedLine, FoundClones } from "@/views/team/team-found";
import { shortTitle } from "@/views/team/team-rail";
import { BerthTag, whereFrom, card, Cmds, PrivateTag, Row, Section, SourceTag, StateIcon, SudoTag } from "@/views/team/team-parts";

// The plan is what you'll get, and while it runs, the progress: the same
// rows, so what you read is what runs.

export interface PlanProps {
  view: TeamView;
  run?: TeamStatus;
  box?: string;
  picked: Set<string>;
  onPick(id: string, on: boolean): void;
  onRetry(from: string): void;
  onOpenTerminal(): void;
  // Opens a repo's first-time setup terminal on the box.
  onOpenSession?(session: string): void;
  onStartOn(project: string): void;
  onFiles(): void;
  update?: TeamUpdate | null;
  // 1Password skipped: its keys are typed on the checklist instead.
  skipOP?: boolean;
  // Which clone on the box each repo uses, by project id: a folder there,
  // or "" for a fresh clone. Repos with no clone found aren't in it.
  use?: Record<string, string>;
  onUse?(id: string, path: string): void;
  onPull?(p: ProjectView, c: ExistingClone): Promise<void>;
}

function StepHead({ s }: { s: PlanStep }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="shrink-0 text-row">{s.title}</span>
      {s.sudo && <SudoTag className="self-center" />}
      {s.berth && <span className="self-center"><BerthTag /></span>}
      {s.detail && <span className="min-w-0 truncate text-desc text-muted-foreground">{s.detail}</span>}
    </div>
  );
}

function ProjectHead({ p, view }: { p: ProjectView; view: TeamView }) {
  const keys = view.setup?.keys?.[p.id];
  const nKeys = Object.keys(keys?.shared ?? {}).length + (keys?.ask?.length ?? 0);
  const facts = [p.services.length ? `${p.services.join(" and ")} ${p.services.length === 1 ? "service" : "services"}` : "", nKeys ? plural(nKeys, "key") : "", p.size_kb ? bytes(p.size_kb * 1024) : "", p.required ? "required" : ""].filter(Boolean);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium font-mono text-desc">{p.repo}</span>
        {p.private && <PrivateTag />}
        <SourceTag source={p.source} />
      </div>
      {facts.length > 0 && <p className="mt-0.5 text-meta text-muted-foreground">{facts.join(" · ")}</p>}
    </div>
  );
}

function ProjectDetail({ p, use }: { p: ProjectView; use?: ExistingClone }) {
  const commands = use ? [`# uses your existing checkout ${use.display}, as it is: no clone, checkout, stash, reset or pull`, ...p.commands.filter((c) => !c.startsWith("git clone "))] : p.commands;
  return (
    <div className="space-y-2 text-meta">
      <p className="text-muted-foreground">
        {use ? (
          <>
            Runs in your existing checkout <span className="font-mono text-foreground">{use.display}</span>; nothing is cloned.{" "}
          </>
        ) : (
          <>
            Into <span className="font-mono text-foreground">{p.path}</span>, as you, with the box's own GitHub sign-in.{" "}
          </>
        )}
        {p.source === "repo" && p.config_hash && (
          <>
            Its <span className="font-mono">.berth/config.json</span> is trusted as you see it now (<span className="font-mono">{p.config_hash.slice(0, 7)}</span>); a later change asks again.
          </>
        )}
        {p.source === "kit" && p.kit && (
          <>
            Set up by <span className="text-foreground">{p.kit.name}</span> · <span className="font-mono">{p.kit.ref}</span>
          </>
        )}
      </p>
      {p.init_detail && <p className="text-muted-foreground">Then once in {use ? "your existing checkout" : "the main checkout"}: {p.init_detail}.</p>}
      <Cmds lines={commands} />
    </div>
  );
}

// DeviceCode is the box's own GitHub sign-in: the code gh printed in its
// terminal, to enter on github.com from this computer.
function DeviceCode({ code, url }: { code: string; url?: string }) {
  const link = url ?? "https://github.com/login/device";
  return (
    <div data-testid="device-code" className="space-y-2">
      <p className="text-meta">The box is signing in to GitHub with its own credential. Enter this code at <span className="font-mono">github.com/login/device</span>:</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg border bg-background px-3 py-1.5 font-mono text-heading tracking-[0.18em]">{code}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy the code"
          onClick={() => void copyText(code, "Copied the code")}
        >
          <CopyIcon />
        </Button>
        <Button size="sm" onClick={() => void openUrl(link)}>
          Open github.com/login/device <ExternalLinkIcon />
        </Button>
      </div>
      <p className="text-meta text-muted-foreground">GitHub asks you to authorize GitHub CLI for the box. You can revoke it any time in GitHub's settings.</p>
    </div>
  );
}

function Terminal({ box, session }: { box: string; session: string }) {
  return (
    <div className="flex h-44 flex-col overflow-hidden rounded-lg border">
      <TerminalView box={box} session={session} wsKey="" tab="" pane={`team:${session}`} visible focused={false} onFocus={() => {}} onClose={() => {}} />
    </div>
  );
}

export function Plan(p: PlanProps) {
  const { view, run } = p;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showSteps, setShowSteps] = useState(false);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const steps = view.steps ?? [];
  const sudo = steps.filter((s) => s.sudo).length;
  const stepOf = (id: string) => run?.steps.find((s) => s.id === id);
  const boxDone = !!run && (run.phase === "projects" || run.phase === "done" || (run.phase === "failed" && !run.steps.some((s) => s.state === "failed")));
  const secs = run?.steps.reduce((n, s) => n + (s.secs ?? 0), 0) ?? 0;
  const readable = view.projects.filter((x) => x.access);
  const unreadable = view.projects.filter((x) => !x.access);
  const repoOf = (id: string) => run?.projects.find((x) => x.id === id);
  const runRepos = run ? view.projects.filter((x) => repoOf(x.id)) : readable;
  // Repos a run added that the plan didn't list (an update's new one).
  const extra = run?.projects.filter((x) => !view.projects.some((v) => v.id === x.id)) ?? [];
  // Repos that use a clone the box has already, rather than a new one.
  const reusing = run ? run.projects.filter((x) => x.adopted).length : readable.filter((x) => p.use?.[x.id]).length;
  const reposAside = `${plural(run ? runRepos.length + extra.length : readable.length, "repo")}, ${reusing ? `${reusing} from ${reusing === 1 ? "a clone" : "clones"} you have, the rest cloned as you` : "cloned as you"} · setup from the repo itself when it has one`;
  const asks = view.keys.ask;
  const anyKeys = view.keys.shared + asks.length > 0;

  return (
    <div data-testid="team-plan">
      {p.update && <UpdateDiff update={p.update} />}
      {!run && view.setup?.description && <p className="mb-5 max-w-[68ch] text-muted-foreground text-subtitle @max-[819px]:hidden">{view.setup.description} Open any line for its exact commands.</p>}

      <Section id="plan-box" title="On your box, once" aside={boxDone ? `${plural(steps.length, "step")} done${secs ? ` in ${durationOf(secs)}` : ""}` : `${plural(steps.length, "step")}${sudo ? ` · ${sudo} ask for your password` : ""}`}>
        <div className={card}>
          {boxDone && !showSteps ? (
            <Row
              state="done"
              head={<span className="text-desc">{steps.map((s) => s.title.replace(/ (with|in) .*/, "")).join(", ")}</span>}
              trailing={
                <Button size="xs" variant="ghost" onClick={() => setShowSteps(true)}>
                  Show
                </Button>
              }
            />
          ) : (
            steps.map((s) => {
              const st = stepOf(s.id);
              const state = st?.state;
              return (
                <Row
                  key={s.id}
                  testId={`step-${s.id}`}
                  state={run ? (state ?? "todo") : undefined}
                  tone={state === "failed" ? "failed" : state === "waiting" ? "waiting" : undefined}
                  head={<StepHead s={s} />}
                  open={!!open[s.id]}
                  onToggle={() => toggle(s.id)}
                  detail={<Cmds lines={s.commands} />}
                  trailing={state === "done" && st?.secs !== undefined ? <span className="text-meta text-muted-foreground tabular-nums">{durationOf(st.secs)}</span> : state === "skipped" ? <span className="text-muted-foreground text-meta">already done</span> : undefined}
                >
                  {run && state === "waiting" && s.id === "github" && st?.code && <DeviceCode code={st.code} url={st.url} />}
                  {run && state === "waiting" && s.id !== "github" && (
                    <div className="space-y-2">
                      <p className="flex items-start gap-1.5 text-warning-foreground text-label">
                        <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
                        {s.id === "1password"
                          ? `op on ${run.box} is asking you to sign in to 1Password. Answer it in the terminal below: what you type stays on the box, and Shipyard keeps only op's session there, for the team's shared keys.`
                          : `sudo on ${run.box} is asking for your password. Type it in the terminal below; Shipyard doesn't see or keep it.`}
                      </p>
                      {run.session && <Terminal box={run.box} session={run.session} />}
                    </div>
                  )}
                  {run && state === "failed" && (
                    <div className="space-y-2.5">
                      {st?.error && <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-destructive/25 bg-background px-3 py-2 font-mono text-mono text-destructive-foreground">{st.error}</pre>}
                      <p className="text-desc text-muted-foreground">Fix it on {run.box}, then retry: the steps above are kept, and this one checks first.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => p.onRetry(s.id)}>
                          <RotateCwIcon /> Retry from {shortTitle(s.title)}
                        </Button>
                        <Button size="sm" variant="outline" onClick={p.onOpenTerminal}>
                          <SquareTerminalIcon /> Open the terminal
                        </Button>
                      </div>
                    </div>
                  )}
                </Row>
              );
            })
          )}
        </div>
      </Section>

      <Section
        id="plan-repos"
        title="Repos"
        aside={reposAside}
      >
        <div className={card}>
          {(run ? runRepos : view.projects).map((x) => {
            const r = repoOf(x.id);
            if (!x.access && !run) {
              return (
                <Row
                  key={x.id}
                  testId={`repo-${x.id}`}
                  tone="muted"
                  head={
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium font-mono text-desc">{x.repo}</span>
                        <LockIcon className="size-3 text-muted-foreground" />
                      </div>
                      <p className="mt-0.5 text-desc text-muted-foreground">You can't read it, so it's left out. Ask an admin{view.setup?.contact ? ` in ${view.setup.contact}` : ""}, then check again.</p>
                    </div>
                  }
                />
              );
            }
            return (
              <Row
                key={x.id}
                testId={`repo-${x.id}`}
                state={run ? (r?.state ?? "queued") === "queued" ? "todo" : r?.state : undefined}
                tone={r?.state === "failed" ? "failed" : undefined}
                head={<ProjectHead p={x} view={view} />}
                open={!!open[`p:${x.id}`]}
                onToggle={() => toggle(`p:${x.id}`)}
                detail={<ProjectDetail p={x} use={x.existing?.find((c) => c.path && c.path === p.use?.[x.id])} />}
                trailing={
                  run ? (
                    r?.state === "ready" && run.phase !== "done" ? (
                      <Button size="xs" onClick={() => p.onStartOn(x.id)}>
                        Start on {x.id}
                      </Button>
                    ) : r?.state === "setting-up" && r.session && p.onOpenSession ? (
                      // Its first-time setup runs in a terminal of its own:
                      // its last line here, and the terminal a click away,
                      // in front when it asks something.
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn("max-w-48 truncate text-meta", r.waiting ? "text-warning-foreground" : "text-muted-foreground")} data-testid={`repo-line-${x.id}`}>
                          {r.waiting ? "waiting for you" : (r.line ?? "setting up")}
                        </span>
                        <Button size="xs" variant={r.waiting ? "default" : "ghost"} onClick={() => p.onOpenSession?.(r.session!)} data-testid={`repo-terminal-${x.id}`}>
                          <SquareTerminalIcon /> {r.waiting ? "Answer in its terminal" : "Terminal"}
                        </Button>
                      </span>
                    ) : r?.state === "cloning" || r?.state === "setting-up" ? (
                      <span className="max-w-48 truncate text-meta text-muted-foreground">{r.line ?? (r.state === "cloning" ? "cloning" : "setting up")}</span>
                    ) : r?.state === "queued" ? (
                      <span className="text-meta text-muted-foreground">queued</span>
                    ) : undefined
                  ) : !x.required ? (
                    <Checkbox className="not-dark:border-foreground/25" aria-label={`Set up ${x.repo}`} checked={p.picked.has(x.id)} onCheckedChange={(v) => p.onPick(x.id, !!v)} />
                  ) : undefined
                }
              >
                {!run && x.access && !!x.existing?.length && p.onUse && (
                  <FoundClones id={x.id} repo={x.repo} clones={x.existing} use={p.use?.[x.id] ?? ""} onUse={(path) => p.onUse?.(x.id, path)} note={x.existing_note} initDetail={x.init_detail} onPull={p.onPull ? (c) => p.onPull!(x, c) : undefined} />
                )}
                {run && r && adoptedLine(r) && (
                  <p data-testid={`adopted-${x.id}`} className="text-muted-foreground text-meta">
                    {adoptedLine(r)}
                  </p>
                )}
                {r?.state === "failed" && (
                  <div className="space-y-2">
                    {r.error && <pre className="whitespace-pre-wrap rounded-md border border-destructive/25 bg-background px-3 py-2 font-mono text-mono text-destructive-foreground">{r.error}</pre>}
                    <Button size="sm" onClick={() => p.onRetry(x.id)}>
                      <RotateCwIcon /> Retry {x.id}
                    </Button>
                  </div>
                )}
              </Row>
            );
          })}
          {extra.map((r) => (
            <Row
              key={r.id}
              testId={`repo-${r.id}`}
              state={r.state === "queued" ? "todo" : r.state}
              head={<span className="font-medium font-mono text-desc">{r.repo}</span>}
              trailing={r.state === "ready" && run?.phase !== "done" ? <Button size="xs" onClick={() => p.onStartOn(r.id)}>Start on {r.id}</Button> : r.line ? <span className="text-meta text-muted-foreground">{r.line}</span> : undefined}
            />
          ))}
          {run && unreadable.length > 0 && (
            <p className="flex items-center gap-1.5 px-4 py-2 text-meta text-muted-foreground">
              <LockIcon className="size-3" /> Left out: {unreadable.map((u) => u.repo).join(", ")} (you can't read {unreadable.length === 1 ? "it" : "them"} yet)
            </p>
          )}
        </div>
      </Section>

      {anyKeys && (
        <Section id="plan-keys" title="Keys" aside="what the repos' .env.example asks for; ports, URLs and databases are the kits' job">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-4 py-3 text-desc">
            {run ? <StateIcon state={run.phase === "steps" ? "todo" : "done"} /> : <KeyRoundIcon className="size-4 text-muted-foreground" />}
            {p.skipOP ? (
              <span data-testid="plan-keys-skip">
                1Password skipped: {plural((view.keys.onepassword?.length ?? 0) + asks.length, "key")} to enter ({[...(view.keys.onepassword ?? []), ...asks].map((a) => a.key).join(", ")}); blank ones are listed as missing
              </span>
            ) : (
              <>
                {view.keys.shared > 0 && <span>From 1Password: {plural(view.keys.shared, "key")}</span>}
                {asks.length > 0 && (
                  <span className="text-muted-foreground">
                    · {asks.length} to enter ({asks.map((a) => a.key).join(", ")})
                  </span>
                )}
              </>
            )}
            <span className="ml-auto text-meta text-muted-foreground">Values stay on your box, never in git</span>
          </div>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-meta">
        <button type="button" data-testid="read-every-command" onClick={p.onFiles} className="inline-flex items-center gap-1.5 rounded text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <FileCodeIcon className="size-3.5 text-muted-foreground" /> Read every command
          <span className="text-muted-foreground">· the {view.files?.length ?? 0} files in {whereFrom(view)}</span>
        </button>
        {view.repo && (
          <button type="button" onClick={() => void openUrl(view.source?.kind === "link" ? view.source.html_url : `${view.repo!.html_url}${view.commit ? `/tree/${view.commit.sha}` : ""}`)} className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            View on GitHub <ExternalLinkIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// UpdateDiff is a newer commit of the setup, as changes to review before
// anything runs: added, changed and removed lines, and any new step that
// asks for a password called out.
export function UpdateDiff({ update }: { update: TeamUpdate }) {
  return (
    <Section id="plan-update" title={`What changed since you set up`} aside={`${update.from} → ${update.to} · ${plural(update.commits, "commit")} by ${update.author}`} className="mb-7">
      <ul data-testid="team-diff" className={card}>
        {update.changes.map((c) => (
          <li key={`${c.area}:${c.id}`} className="flex items-start gap-3 px-4 py-2.5">
            <span
              aria-label={c.kind === "add" ? "added" : c.kind === "remove" ? "removed" : "changed"}
              className={cn(
                "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded font-bold text-tag",
                c.kind === "add" && "bg-success/15 text-success-foreground",
                c.kind === "change" && "bg-info/15 text-info-foreground",
                c.kind === "remove" && "bg-destructive/12 text-destructive-foreground",
              )}
            >
              {c.kind === "add" ? "+" : c.kind === "remove" ? "−" : "~"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className={cn("font-medium text-desc", (c.area === "project" || c.area === "key" || c.area === "file" || c.area === "setting") && "font-mono")}>{c.text}</span>
                <span className="text-tag text-muted-foreground uppercase tracking-wide">{c.area === "project" ? "repo" : c.area}</span>
                {c.sudo && <SudoTag />}
              </p>
              {c.detail && <p className="text-desc text-muted-foreground">{c.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className={cn("mt-2 flex items-start gap-1.5 text-meta", update.sudo.length ? "text-warning-foreground" : "text-muted-foreground")}>
        <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
        {update.sudo.length ? `${update.sudo.join(", ")} ${update.sudo.length === 1 ? "is a new step that asks" : "ask"} for your password on the box. You type it there; Shipyard doesn't keep it.` : "Nothing here asks for your password."} Nothing runs until you press Update; steps you already have are skipped.
      </p>
    </Section>
  );
}
