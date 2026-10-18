import { ChevronDownIcon, CircleAlertIcon, GitBranchIcon, GitPullRequestIcon, InfoIcon, LoaderIcon, SparklesIcon, TicketIcon, TypeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Frame, FramePanel } from "@/components/ui/frame";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import type { Branch, ResolveKind, Resolution } from "@/lib/projects";
import { cn } from "@/lib/utils";

const modes: { kind: ResolveKind; label: string; hint: string; placeholder: string; Icon: typeof SparklesIcon }[] = [
  { kind: "smart", label: "Smart", hint: "Works out what you typed", placeholder: "A name, #1234, a branch, or a GitHub, GitLab or Jira link", Icon: SparklesIcon },
  { kind: "github", label: "GitHub", hint: "#123, or a pull request or issue link", placeholder: "#1234, or a pull request or issue link", Icon: GitPullRequestIcon },
  { kind: "gitlab", label: "GitLab", hint: "!123, or a merge request or issue link", placeholder: "!1234, or a merge request or issue link", Icon: GitPullRequestIcon },
  { kind: "branch", label: "Branch", hint: "Check out a branch that exists", placeholder: "Search branches", Icon: GitBranchIcon },
  { kind: "name", label: "Name", hint: "A new branch, named as typed", placeholder: "A name for the worktree and its new branch", Icon: TypeIcon },
];

// StartFrom is the one field that says what to make: a name, a branch, a
// pull request or an issue. Its mode narrows how the input is read; the row
// under it shows what the box made of it.
export function StartFrom({
  value,
  onChange,
  kind,
  onKind,
  resolution,
  pending,
  error,
  branches,
  defaultBranch,
  focus = true,
}: {
  value: string;
  onChange(v: string): void;
  kind: ResolveKind;
  onKind(k: ResolveKind): void;
  resolution?: Resolution;
  pending: boolean;
  error?: string;
  branches?: { default?: string; branches: Branch[] };
  defaultBranch?: string;
  // Take the keyboard once open (a dialog of its own); the composer keeps it.
  focus?: boolean;
}) {
  const mode = modes.find((m) => m.kind === kind) ?? modes[0];
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // The dialog moves focus to its first control as it opens; this field is
  // where typing should go, so take it back once it has.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [focus]);
  const shownBranches = useMemo(() => {
    if (kind !== "branch" || !branches) return [];
    const q = value.trim().toLowerCase();
    const sorted = [...branches.branches].sort((a, b) => Number(!!a.remote) - Number(!!b.remote));
    return (q ? sorted.filter((b) => b.name.toLowerCase().includes(q)) : sorted).slice(0, 50);
  }, [kind, branches, value]);

  return (
    <Frame className="rounded-xl p-0.5">
      <FramePanel className="rounded-[10px] p-0 shadow-none before:hidden dark:bg-input/32">
        <div className="flex items-center gap-1 ps-1.5 pe-2">
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Read as: ${mode.label}`}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-desc text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            >
              <mode.Icon className="size-3.5" />
              {mode.label}
              <ChevronDownIcon className="size-3 opacity-60" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-64">
              <MenuRadioGroup
                value={kind}
                onValueChange={(v) => {
                  onKind(v as ResolveKind);
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
              >
                {modes.map((m) => (
                  <MenuRadioItem key={m.kind} value={m.kind} closeOnClick className="py-1.5">
                    <span className="flex min-w-0 items-start gap-2">
                      <m.Icon className="mt-0.5 size-3.5 shrink-0 opacity-80" />
                      <span className="flex min-w-0 flex-col">
                        <span>{m.label}</span>
                        <span className="text-muted-foreground text-meta">{m.hint}</span>
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          <input
            ref={inputRef}
            value={value}
            placeholder={mode.placeholder}
            aria-label="Start from"
            spellCheck={false}
            onChange={(e) => {
              onChange(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (kind !== "branch" || !shownBranches.length) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, shownBranches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && shownBranches[active] && shownBranches[active].name !== value) {
                e.preventDefault();
                onChange(shownBranches[active].name);
              }
            }}
            className="h-9 min-w-0 flex-1 bg-transparent px-1.5 text-body outline-none placeholder:text-muted-foreground/72"
          />
        </div>
        {kind === "branch" && branches && (
          <div className="relative border-t">
            <div role="listbox" aria-label="Branches" className="h-[9.25rem] overflow-y-auto p-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]">
              {shownBranches.length === 0 && <p className="px-2 py-1.5 text-muted-foreground text-desc">No branch matches, so this makes a new one.</p>}
              {shownBranches.map((b, n) => (
                <div key={`${b.remote ? "r" : "l"}:${b.name}`}>
                  {(n === 0 || !!shownBranches[n - 1].remote !== !!b.remote) && <p className="px-2 pt-1.5 pb-0.5 font-medium text-tag text-muted-foreground">{b.remote ? "Remote" : "Local"}</p>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={b.name === value}
                    onMouseMove={() => setActive(n)}
                    onClick={() => onChange(b.name)}
                    className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-mono", n === active && "bg-accent")}
                  >
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{b.name}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-sans text-muted-foreground text-meta">
                      {b.current && "checked out"}
                      {!b.current && b.name === branches.default && "default"}
                      {b.remote && <span className="rounded border px-1 text-tag">origin</span>}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </FramePanel>
      <Preview kind={kind} value={value} resolution={resolution} pending={pending} error={error} defaultBranch={defaultBranch} />
    </Frame>
  );
}

function Preview({ kind, value, resolution, pending, error, defaultBranch }: { kind: ResolveKind; value: string; resolution?: Resolution; pending: boolean; error?: string; defaultBranch?: string }) {
  const row = "flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-desc";
  if (!value.trim())
    return (
      <div className={cn(row, "text-muted-foreground")}>
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {kind === "branch"
            ? "Pick a branch to check out in a new worktree."
            : kind === "github" || kind === "gitlab"
              ? "Paste a link or a number to start from a pull request or issue."
              : `Empty makes a new branch from ${defaultBranch ?? "the default branch"}, with a generated name.`}
        </span>
      </div>
    );
  if (error)
    return (
      <div className={cn(row, "text-muted-foreground")}>
        <CircleAlertIcon className="size-3.5 shrink-0 text-warning" />
        <span className="truncate">Couldn't look it up, so it will be used as a name. {error}</span>
      </div>
    );
  if (!resolution)
    return (
      <div className={cn(row, "text-muted-foreground")}>
        <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
        Looking it up…
      </div>
    );
  const r = resolution;
  const Icon = r.kind === "pr" ? GitPullRequestIcon : r.kind === "issue" ? TicketIcon : GitBranchIcon;
  const issueNumber = /\/(?:-\/)?issues\/(\d+)/.exec(r.url ?? "")?.[1];
  const [what, how] =
    r.kind === "pr"
      ? [`PR #${r.pr}`, r.branch]
      : r.kind === "issue"
        ? [`Issue${issueNumber ? ` #${issueNumber}` : ""}`, `new branch ${r.branch}`]
        : r.kind === "remote-branch"
          ? ["Remote branch", `origin/${r.branch}`]
          : r.exists
            ? ["Existing branch", r.branch]
            : ["New branch", `${r.branch} from ${r.base ?? defaultBranch ?? "the default branch"}`];
  return (
    <div className={cn("flex flex-col", pending && "opacity-60")}>
      <div className={row}>
        <Icon className={cn("size-3.5 shrink-0", r.kind === "pr" || r.kind === "issue" ? "text-success" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium">{what}</span>
        <span className={cn("min-w-0 truncate font-mono text-mono text-muted-foreground", r.title && "max-w-[40%] shrink-0")}>{how}</span>
        {r.title && <span className="min-w-0 flex-1 truncate text-foreground/80">{r.title}</span>}
      </div>
      {r.note && (
        <div className={cn(row, "-mt-1.5 text-muted-foreground text-meta")}>
          <InfoIcon className="size-3.5 shrink-0" />
          <span className="truncate">{r.note}</span>
        </div>
      )}
    </div>
  );
}
