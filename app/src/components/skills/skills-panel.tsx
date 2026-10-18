import { BookOpenIcon, CheckIcon, ArrowUpCircleIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { Card, CardFrameAction, CardFrameDescription, CardFrameFooter, CardFrameHeader, CardFrameTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { type SkillAgent, type SkillRow, type SkillsChange, type SkillsReport, type SkillState, skillSummary, skillsApi } from "@/lib/skills";
import { useSkillsNotice } from "@/lib/skills-notice";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ErrorText } from "@/components/error-note";

const agentNames: Record<SkillAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// SkillsPanel shows Shipyard's skills on one box, for its user or, with a
// location, inside that repository, and installs, updates or removes them.
// hideTitle drops the panel's own title where the page around it already
// names it, as Settings → Agents does.
export function SkillsPanel({ box, location, className, hideTitle }: { box: string; location?: string; className?: string; hideTitle?: boolean }) {
  const client = useStore((s) => s.client);
  const [report, setReport] = useState<SkillsReport>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [commit, setCommit] = useState(false);
  const target = location ? "project" : "user";

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setReport(await skillsApi.list(client, box, location));
      setError(undefined);
    } catch (err) {
      setError(plainError(err));
    }
  }, [client, box, location]);

  useEffect(() => {
    void load();
  }, [load]);

  // The box's user skills as the sidebar's notice last heard them
  // (lib/skills-notice.ts): installed from there, or from the CLI, while
  // this panel is open, they show here too.
  const heard = useSkillsNotice((s) => (location ? undefined : s.reports[box]));
  useEffect(() => {
    if (heard) setReport(heard);
  }, [heard]);

  const change = async (key: string, install: boolean, req: Omit<SkillsChange, "target" | "location" | "commit">) => {
    if (!client) return;
    setBusy(key);
    try {
      const body: SkillsChange = {
        ...req,
        target,
        location,
        commit: install && target === "project" ? commit : undefined,
      };
      setReport(await (install ? skillsApi.install(client, box, body) : skillsApi.uninstall(client, box, body)));
    } catch (err) {
      toastManager.add({
        title: install ? "Could not install" : "Could not remove",
        description: errorMessage(err),
        type: "error",
      });
    } finally {
      setBusy(undefined);
    }
  };

  const states = (s: SkillRow) => (target === "project" ? s.project : s.user);
  const pending = report?.skills.some((s) => report.agents.some((a) => states(s)?.[a] !== "installed")) ?? false;
  const dirs = target === "project" ? report?.project_dirs : report?.user_dirs;

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardFrameHeader className="px-4 py-3">
        {!hideTitle && (
          <CardFrameTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-3.5 text-muted-foreground" />
            {location ? "Skills in this project" : `Skills on ${box}`}
          </CardFrameTitle>
        )}
        <CardFrameDescription className="text-meta">
          {location ? "Only agents working in this repository learn them." : "Every agent the box's user runs learns them."} They teach Claude Code and Codex to use Shipyard.
        </CardFrameDescription>
        <CardFrameAction>
          <Button size="xs" variant={pending ? "default" : "outline"} disabled={!report || !pending || !!busy} onClick={() => change("all", true, { skills: "all", agent: "all" })}>
            {busy === "all" && <Spinner className="size-3" />}
            {pending ? "Install all" : "All installed"}
          </Button>
        </CardFrameAction>
      </CardFrameHeader>

      <div className="border-t">
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] items-center border-b px-4 py-1.5 text-tag text-muted-foreground">
          <span>Skill</span>
          {(["claude", "codex"] as const).map((a) => (
            <span key={a} className="flex items-center gap-1.5">
              <AgentIcon agent={a} className="size-3" />
              {agentNames[a]}
            </span>
          ))}
        </div>
        {error && <ErrorText className="px-4 py-6 text-center text-destructive-foreground text-meta" text={error} />}
        {!report && !error && (
          <div className="flex items-center justify-center gap-2 px-4 py-6 text-muted-foreground text-meta">
            <Spinner className="size-3" /> Checking {box}…
          </div>
        )}
        {report?.skills.map((s) => (
          <div key={s.name} className="grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] items-center gap-y-1 border-b px-4 py-2.5 last:border-b-0">
            <div className="min-w-0 pr-3">
              <div className="flex items-baseline gap-2">
                <span className="font-medium font-mono text-mono">{s.name}</span>
                <span className="font-mono text-tag text-muted-foreground">{s.version.slice(0, 7)}</span>
              </div>
              <p className="line-clamp-2 text-muted-foreground text-meta" title={s.description}>
                {skillSummary(s)}
              </p>
            </div>
            {(["claude", "codex"] as const).map((a) => {
              const key = `${s.name}:${a}`;
              return (
                <StateCell
                  key={a}
                  state={states(s)?.[a]}
                  committed={target === "project" && states(s)?.[a] !== "missing" && s.excluded?.[a] === false}
                  busy={busy === key}
                  disabled={!!busy}
                  onInstall={() => change(key, true, { skills: [s.name], agent: a })}
                  onRemove={() => change(key, false, { skills: [s.name], agent: a })}
                />
              );
            })}
          </div>
        ))}
      </div>

      <CardFrameFooter className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-tag text-muted-foreground" title={dirs ? `${dirs.claude}\n${dirs.codex}` : undefined}>
          {dirs ? `${shortDir(dirs.claude)} · ${shortDir(dirs.codex)}` : " "}
        </span>
        {target === "project" && (
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-meta">
            <Switch checked={commit} onCheckedChange={setCommit} />
            Commit with the repository
          </label>
        )}
      </CardFrameFooter>
    </Card>
  );
}

function shortDir(dir: string): string {
  return dir.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function StateCell({ state, committed, busy, disabled, onInstall, onRemove }: { state?: SkillState; committed: boolean; busy: boolean; disabled: boolean; onInstall(): void; onRemove(): void }) {
  if (busy) {
    return (
      <span className="flex h-6 items-center">
        <Spinner className="size-3.5" />
      </span>
    );
  }
  if (state === "installed") {
    return (
      <span className="group/cell flex h-6 items-center gap-1">
        <span className="inline-flex items-center gap-1 text-success-foreground text-meta">
          <CheckIcon className="size-3.5" />
          {committed ? "Committed" : "Installed"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove"
                disabled={disabled}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/cell:opacity-100"
                onClick={onRemove}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipPopup>Remove</TooltipPopup>
        </Tooltip>
      </span>
    );
  }
  if (state === "outdated") {
    return (
      <span className="flex h-6 items-center">
        <Button size="xs" variant="outline" disabled={disabled} onClick={onInstall} className="text-warning-foreground">
          <ArrowUpCircleIcon />
          Update
        </Button>
      </span>
    );
  }
  return (
    <span className={cn("flex h-6 items-center", !state && "opacity-50")}>
      <Button size="xs" variant="outline" disabled={disabled || !state} onClick={onInstall}>
        Install
      </Button>
    </span>
  );
}
