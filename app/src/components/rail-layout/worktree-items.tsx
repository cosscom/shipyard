import { GitBranchIcon, GitBranchPlusIcon, HomeIcon, ListIcon, ServerOffIcon, SettingsIcon } from "lucide-react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuShortcut, MenuSub, MenuSubPopup, MenuSubTrigger } from "@/components/ui/menu";
import { useState } from "react";

import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { boxApi } from "@/lib/api";
import { ago } from "@/lib/format";
import { permissionChoices } from "@/lib/screen";
import { useAsk } from "@/lib/transcript-feed";
import { keysFor } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LANE_WORDS, LANES, type ProjectEntry, openWt, type WtEntry } from "@/components/rail-layout/model";

// How many quiet worktrees a list shows before "All worktrees".
const QUIET_MAX = 5;

// BoxTag names a worktree's box, only where a project lives on more than
// one, or the box is away.
export function BoxTag({ box, away }: { box: string; away?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded bg-accent/70 px-1 py-px font-mono text-[10px] text-muted-foreground leading-none", away && "opacity-70")}>
      {away && <ServerOffIcon className="size-2.5" />}
      {box}
    </span>
  );
}

function Lead({ w }: { w: WtEntry }) {
  if (w.away) return <ServerOffIcon className="size-3.5 text-muted-foreground" />;
  if (w.state === "waiting" || w.state === "running" || w.state === "finished") return <StateGlyph state={w.state} className="size-4" />;
  return <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{w.wt.main ? <HomeIcon /> : <GitBranchIcon />}</span>;
}

const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;

// AskLine is what a waiting agent asks, and, for a permission, Deny and
// Allow once right there, as Home's Needs you card has: answered without
// going to it. Its choices are read off the agent's screen while the list
// is open.
function AskLine({ w }: { w: WtEntry }) {
  const client = useStore((s) => s.client);
  const a = w.agents[0];
  const s = a.session;
  const tool = s.ask?.tool;
  const question = !tool || QUESTION_TOOLS.test(tool);
  const ask = useAsk(a.box, s.name, !question, s.state_since);
  const choices = ask && !ask.form ? permissionChoices(ask.choices) : undefined;
  const allow = choices?.find((c) => c.label === "Allow");
  const deny = choices?.find((c) => c.label === "Deny");
  const [sent, setSent] = useState<{ at?: string; label: string }>();
  const answered = sent && sent.at === s.state_since ? sent.label : undefined;
  if (!w.ask && !allow) return null;
  const answer = (e: React.MouseEvent, key: string, label: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (!client) return;
    setSent({ at: s.state_since, label });
    // The person answered, so the box may type into a waiting agent.
    boxApi.send(client, a.box, s.name, key, false, { when: "now", force: true }).catch((err) => {
      setSent(undefined);
      toastError(err, { title: "Couldn't answer", box: a.box });
    });
  };
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {w.ask && <span className="min-w-0 flex-1 truncate rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{w.ask}</span>}
      {answered ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{answered === "Deny" ? "Denied" : "Allowed"} · resuming</span>
      ) : allow && deny ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" data-testid="peek-deny" className="h-5 rounded-[5px] px-1.5 text-[11px]" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => answer(e, deny.key, "Deny")} aria-label={`Deny: ${w.doing ?? w.name}`}>
            Deny
          </Button>
          <Button size="xs" data-testid="peek-allow" className="h-5 rounded-[5px] px-1.5 text-[11px]" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => answer(e, allow.key, "Allow")} aria-label={`Allow once: ${w.doing ?? w.name}`}>
            Allow once
          </Button>
        </span>
      ) : null}
    </span>
  );
}

// WorktreeItem is one worktree as a peek or the breadcrumb lists it: its
// state, its name (and box, when that matters), and under it what it is
// doing; a second line in mono for what its agent waits on.
function WorktreeItem({ w, everywhere }: { w: WtEntry; everywhere?: boolean }) {
  const since = w.agents[0]?.session.state_since;
  const chip = w.chip;
  return (
    <MenuItem
      data-testid="rail-wt"
      data-worktree={`${w.box}/${w.wt.main ? w.loc.name : w.wt.name}`}
      data-lane={w.lane}
      aria-current={w.selected || undefined}
      disabled={!!w.away}
      onClick={() => openWt(w)}
      className={cn("items-start gap-2.5 py-1.5", w.selected && "bg-accent/50")}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <Lead w={w} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate", w.selected && "font-medium")}>
            {everywhere && <span className="text-muted-foreground">{w.project} / </span>}
            {w.name}
          </span>
          {(chip || w.away) && <BoxTag box={w.box} away={w.away} />}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-muted-foreground text-xs">
            {w.agents.slice(0, 3).map((a) => (
              <AgentIcon key={a.session.name} agent={a.agent} className="size-3" />
            ))}
            {w.agents.length > 3 && <span className="tabular-nums">+{w.agents.length - 3}</span>}
            {since && w.lane !== "quiet" && <span className="tabular-nums">{ago(since).replace(" ago", "")}</span>}
          </span>
        </span>
        {w.doing && <span className={cn("truncate text-muted-foreground text-xs", w.lane === "quiet" && "text-muted-foreground/80")}>{w.doing}</span>}
        {w.lane === "waiting" && w.agents[0] && <AskLine w={w} />}
      </span>
    </MenuItem>
  );
}

// WorktreeItems lists a project's worktrees by what they need from you:
// those that need you, work or are done in full, the quiet ones folded
// into one row, so a peek stays short. A worktree's several agents are
// the breadcrumb's to tell apart, not the peek's.
export function WorktreeItems({ worktrees, compact, everywhere }: { worktrees: WtEntry[]; compact?: boolean; everywhere?: boolean }) {
  const groups = LANES.filter((l) => l !== "quiet").map((lane) => ({ lane, list: worktrees.filter((w) => w.lane === lane) })).filter((g) => g.list.length);
  // Everywhere (Home's peek) is what is going on; the quiet ones are each
  // project's.
  const quiet = everywhere ? [] : worktrees.filter((w) => w.lane === "quiet");
  const shownQuiet = quiet.slice(0, compact ? 6 : QUIET_MAX * 2);
  return (
    <>
      {groups.map(({ lane, list }) => (
        <MenuGroup key={lane} data-testid="rail-lane" data-lane={lane}>
          <MenuGroupLabel className={cn("pt-2 pb-1", lane === "waiting" && "text-warning-foreground")}>{LANE_WORDS[lane]}</MenuGroupLabel>
          {list.map((w) => (
            <WorktreeItem key={w.key} w={w} everywhere={everywhere} />
          ))}
        </MenuGroup>
      ))}
      {quiet.length > 0 && (
        <MenuGroup data-testid="rail-lane" data-lane="quiet">
          {groups.length > 0 && <MenuSeparator />}
          <MenuSub>
            <MenuSubTrigger data-testid="rail-quiet" className="text-muted-foreground">
              <span className="flex size-4 items-center justify-center">
                <GitBranchIcon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {quiet.length} quiet worktree{quiet.length === 1 ? "" : "s"}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup className="w-80">
              {shownQuiet.map((w) => (
                <WorktreeItem key={w.key} w={w} />
              ))}
              {quiet.length > shownQuiet.length && (
                <MenuItem onClick={() => useStore.getState().setView({ kind: "worktrees" })} className="text-muted-foreground text-xs">
                  {quiet.length - shownQuiet.length} more…
                </MenuItem>
              )}
            </MenuSubPopup>
          </MenuSub>
        </MenuGroup>
      )}
    </>
  );
}

// ProjectFooter is a peek's ways onward: new work in the project, its
// worktrees in full, its settings.
export function ProjectFooter({ p }: { p: ProjectEntry }) {
  const def = p.project.members.find((m) => m.box.name === p.project.defaultBox) ?? p.project.members[0];
  return (
    <>
      <MenuSeparator />
      <MenuItem data-testid="rail-new-task" onClick={() => useStore.getState().openNewWorktree({ box: def?.box.name, location: def?.loc.name })}>
        <GitBranchPlusIcon />
        New task in {p.name}…<MenuShortcut>{keysFor("new-worktree")}</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => useStore.getState().setView({ kind: "worktrees" })}>
        <ListIcon />
        All worktrees
      </MenuItem>
      {def && (
        <MenuItem onClick={() => useStore.getState().setView({ kind: "project", box: def.box.name, location: def.loc.name })}>
          <SettingsIcon />
          Project settings
        </MenuItem>
      )}
    </>
  );
}

// ProjectHead heads a peek: the project, its boxes, and how its agents are.
// Its counts are of agents, as the badge and the dots are; the lists under
// it are of worktrees.
export function ProjectHead({ p, hint }: { p: ProjectEntry; hint?: React.ReactNode }) {
  const parts = [p.waiting && `${p.waiting} need${p.waiting === 1 ? "s" : ""} you`, p.running && `${p.running} working`, p.finished && `${p.finished} done`].filter(Boolean);
  return (
    <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
      <span className="font-medium text-sm">{p.name}</span>
      <span className="truncate text-muted-foreground text-xs">{p.project.members.map((m) => m.box.name).join(" · ")}</span>
      <span className="ml-auto shrink-0 text-muted-foreground text-xs">{parts.length ? parts.join(" · ") : "Nothing running"}</span>
      {hint}
    </div>
  );
}

