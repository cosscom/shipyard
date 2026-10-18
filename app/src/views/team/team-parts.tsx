import { BadgeCheckIcon, CheckIcon, ChevronRightIcon, GitCommitHorizontalIcon, KeyRoundIcon, LockIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { ago } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import { type ProjectSource, type RepoState, SOURCE_LABEL, type StepState, type TeamOrg, type TeamView } from "@/lib/team";
import { cn } from "@/lib/utils";

// The pieces the Team setup page is made of: the org's avatar, GitHub's
// mark, the tags a plan row carries, a row's state, and the commands a row
// opens to.

// GitHub's mark (Octicons, MIT).
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 shrink-0 fill-current", className)}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

// OrgAvatar is the org's GitHub avatar, or its initial while there is none.
export function OrgAvatar({ org, size = 40, className }: { org: Pick<TeamOrg, "login" | "name" | "avatar_url">; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (org.avatar_url && !broken) {
    return <img src={org.avatar_url} alt="" aria-hidden style={style} onError={() => setBroken(true)} className={cn("shrink-0 rounded-[22%] bg-muted ring-1 ring-foreground/10", className)} />;
  }
  return (
    <span aria-hidden style={{ ...style, fontSize: size * 0.42 }} className={cn("inline-flex shrink-0 items-center justify-center rounded-[22%] bg-muted font-semibold text-muted-foreground ring-1 ring-foreground/10", className)}>
      {(org.name || org.login).slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Avatar({ src, name, size = 16 }: { src?: string; name: string; size?: number }) {
  if (src) return <img src={src} alt="" aria-hidden className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SudoTag({ className }: { className?: string }) {
  return (
    <Tip label="Asks for your password on the box, in its terminal. Shipyard never sees it.">
      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/35 bg-warning/8 px-1.5 py-px font-medium text-tag text-warning-foreground", className)}>
        <KeyRoundIcon className="size-2.5" /> sudo
      </span>
    </Tip>
  );
}

export function BerthTag() {
  return (
    <Tip label="Shipyard's own step, in every team setup: the box signs in to GitHub itself, so this computer's sign-in is never copied there">
      <span className="inline-flex shrink-0 items-center rounded-md border px-1.5 py-px text-tag text-muted-foreground">Shipyard</span>
    </Tip>
  );
}

const SOURCE_TIP: Record<ProjectSource, string> = {
  repo: "Set up by the repo's own committed .berth/config.json, trusted as you reviewed it",
  kit: "Set up by the kit the team setup names for it, pinned to a commit",
  none: "Cloned as it is; add ports and services later in Project settings",
};

export function SourceTag({ source }: { source: ProjectSource }) {
  const tone = { repo: "border-success/35 bg-success/8 text-success-foreground", kit: "border-info/35 bg-info/8 text-info-foreground", none: "border-border bg-muted/60 text-muted-foreground" }[source];
  return (
    <Tip label={SOURCE_TIP[source]}>
      <span className={cn("inline-flex shrink-0 items-center rounded-md border px-1.5 py-px font-mono text-tag", tone)}>{SOURCE_LABEL[source]}</span>
    </Tip>
  );
}

export function PrivateTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-tag text-muted-foreground">
      <LockIcon className="size-2.5" /> private
    </span>
  );
}

export function StateIcon({ state, className }: { state: StepState | RepoState; className?: string }) {
  const base = cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full", className);
  if (state === "done" || state === "ready") return <span role="img" aria-label="done" className={cn(base, "bg-success text-white")}><CheckIcon className="size-2.5" strokeWidth={3} /></span>;
  if (state === "skipped") return <span role="img" aria-label="already done" className={cn(base, "border border-success/60 text-success")}><CheckIcon className="size-2.5" strokeWidth={3} /></span>;
  if (state === "running" || state === "cloning" || state === "setting-up") return <Spinner aria-label="running" className={cn("size-4 shrink-0 text-foreground", className)} />;
  if (state === "waiting") return <span role="img" aria-label="waiting for you" className={cn(base, "bg-warning/20 text-warning-foreground ring-1 ring-warning/55")}><KeyRoundIcon className="size-2.5" /></span>;
  if (state === "failed") return <span role="img" aria-label="failed" className={cn(base, "bg-destructive font-bold text-tag text-white")}>!</span>;
  return <span role="img" aria-label="to do" className={cn(base, "border border-muted-foreground/35")} />;
}

// Cmds is what a row runs, exactly: commands with a prompt, comments dim.
export function Cmds({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <pre className={cn("overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-mono text-foreground/85", className)}>
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("#") ? "text-muted-foreground" : undefined}>
          {l.startsWith("#") || l.startsWith(" ") ? l : `$ ${l}`}
        </div>
      ))}
    </pre>
  );
}

// Row is one line of the plan. In review it opens to its commands; while
// running it carries its state instead, and what it needs from you below.
export function Row({
  state,
  head,
  trailing,
  open,
  onToggle,
  detail,
  children,
  tone,
  testId,
}: {
  state?: StepState | RepoState;
  head: ReactNode;
  trailing?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  // Opens with the chevron, in review.
  detail?: ReactNode;
  // Shown always (a prompt, a failure).
  children?: ReactNode;
  tone?: "waiting" | "failed" | "muted";
  testId?: string;
}) {
  const toggles = !!onToggle && !!detail && !state;
  const lead = state ? <StateIcon state={state} className="mt-px" /> : toggles ? <ChevronRightIcon className={cn("mt-px size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : <span className="size-4 shrink-0" />;
  return (
    <div data-testid={testId} data-state={state} className={cn("px-4 py-2.5", tone === "failed" && "bg-destructive/5", tone === "waiting" && "bg-warning/5", tone === "muted" && "opacity-70")}>
      <div className="flex items-start gap-2.5">
        {toggles ? (
          <button type="button" aria-expanded={open} onClick={onToggle} className="-m-1 flex min-w-0 flex-1 items-start gap-2.5 rounded-md p-1 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring">
            {lead}
            <div className="min-w-0 flex-1">{head}</div>
          </button>
        ) : (
          <>
            {lead}
            <div className="min-w-0 flex-1">{head}</div>
          </>
        )}
        {trailing && <div className="flex shrink-0 items-center gap-2 self-center">{trailing}</div>}
      </div>
      {toggles && open && <div className="mt-2 ml-6.5">{detail}</div>}
      {children && <div className="mt-2.5 ml-6.5">{children}</div>}
    </div>
  );
}

export function Section({ title, aside, children, className, id }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section aria-labelledby={id} className={cn("mb-6", className)}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={id} className="text-section">
          {title}
        </h2>
        {aside && <span className="text-meta text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// whereFrom names where a setup was read: <org>/.berth, or the link's label.
export const whereFrom = (view: Pick<TeamView, "org" | "source">) => (view.source?.kind === "link" ? view.source.label : `${view.org.login}/.berth`);

export const card = "divide-y overflow-hidden rounded-xl border bg-card";

// OrgHeader reads like the org's repo on GitHub, so the page is GitHub
// continued: who publishes this setup, which repo, who changed it last and
// when, and the commit Shipyard will use. A setup loaded from a link names the
// repo and branch it came from instead, and claims nothing for the team it
// is for: it isn't that team's own .berth.
export function OrgHeader({ view, compact, badge, from }: { view: TeamView; compact?: boolean; badge?: ReactNode; from?: string }) {
  const { org, repo, commit, source } = view;
  const link = source?.kind === "link";
  const name = view.setup?.name ?? org.name;
  return (
    <div className="border-b bg-gradient-to-b from-muted/50 to-transparent">
      <div className={cn("mx-auto max-w-6xl px-8 @max-[819px]:px-5", compact ? "py-4" : "pt-6 pb-5")}>
        {from === "link" && (
          <p className="mb-3 inline-flex max-w-full items-center gap-1.5 truncate rounded-full border bg-card px-2.5 py-0.5 text-muted-foreground text-meta">
            Opened from a link · <span className="truncate font-mono">{link ? `berth://team?src=${source.key}` : `berth://team?org=${org.login}`}</span>
          </p>
        )}
        {from === "suggestion" && (
          <p data-testid="team-suggested" className="mb-3 inline-flex max-w-full items-center gap-1.5 truncate rounded-full border bg-card px-2.5 py-0.5 text-muted-foreground text-meta">
            Suggested because your projects come from {org.login} · nothing runs until you choose
          </p>
        )}
        <div className="flex items-start gap-4 @max-[819px]:gap-3">
          <OrgAvatar org={org} size={compact ? 40 : 52} className="@max-[819px]:size-10!" />
          <div className="min-w-0 flex-1">
            {link ? (
              <button
                type="button"
                data-testid="team-source"
                onClick={() => void openUrl(source.html_url)}
                className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 rounded text-left font-mono text-muted-foreground text-body outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GitHubMark className="size-3.5 text-foreground/80" />
                <span className="min-w-0 truncate">{source.label}</span>
                {repo && <span className="ml-1 rounded-full border px-1.5 py-px font-sans text-tag">{repo.private ? "Private" : "Public"}</span>}
              </button>
            ) : (
              <p className="flex flex-wrap items-center gap-x-1.5 font-mono text-muted-foreground text-body">
                <GitHubMark className="size-3.5 text-foreground/80" />
                <span>{org.login}</span>
                <span>/</span>
                <span className="font-semibold text-foreground">.berth</span>
                {repo && <span className="ml-1 rounded-full border px-1.5 py-px font-sans text-tag">{repo.private ? "Private" : "Public"}</span>}
              </p>
            )}
            <h1 className="mt-1 text-title">{name} team setup</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-meta">
              {link ? (
                <span data-testid="team-provenance">
                  A team setup for {name}, loaded from {org.login}'s repo, not from <span className="font-mono">{view.setup?.org ?? "its org"}/.berth</span>
                </span>
              ) : (
                <span data-testid="team-provenance">Published by {org.name} on GitHub</span>
              )}
              {!link && org.verified && (
                <Tip label="GitHub has verified a domain this org owns">
                  <span className="inline-flex items-center gap-1">
                    <BadgeCheckIcon className="size-3 text-info" /> Verified
                  </span>
                </Tip>
              )}
              {commit && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    Updated {ago(commit.date)} by <Avatar src={commit.author_avatar} name={commit.author} size={14} /> {commit.author}
                  </span>
                  <span aria-hidden>·</span>
                  <Tip label={`Shipyard uses this commit, as you reviewed it: ${commit.message}`}>
                    <span data-testid="team-commit" className="inline-flex items-center gap-1 font-mono">
                      <GitCommitHorizontalIcon className="size-3" />
                      {commit.short}
                    </span>
                  </Tip>
                </>
              )}
            </p>
          </div>
          {badge && <div className="shrink-0 pt-1 @max-[819px]:hidden">{badge}</div>}
        </div>
      </div>
    </div>
  );
}
