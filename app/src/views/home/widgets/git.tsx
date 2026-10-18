import { useMemo } from "react";

import { Tip } from "@/components/tip";
import { exec } from "@/lib/orchestrate";
import { useProjects } from "@/lib/projects";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useAppWidgetData } from "@/lib/widget-data";

import { useHomeWidget } from "./env";
import { compactNumber, DiffStat, WidgetEmpty, WidgetSkeleton } from "./parts";

// Git activity: commits and lines changed a day over the last two weeks,
// across every project, by you and your agents alike. One `git log` per
// project's main checkout (all its branches, so worktrees count too), kept
// for 15 minutes and read only while the widget is on screen.

const DAYS = 14;
// At most this many projects are read; the rest wait for a bigger Home.
const MAX_PROJECTS = 8;
const MARK = "# berth-home:git";

export interface Day {
  // Local date, YYYY-MM-DD.
  day: string;
  commits: number;
  add: number;
  del: number;
}

export interface GitActivity {
  days: Day[];
  byProject: { name: string; commits: number }[];
  failed: string[];
}

export const gitLogCommand = () => `git log --all --no-merges --since=${DAYS}.days.ago --format=@%ct --shortstat 2>/dev/null; true ${MARK}`;

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// lastDays lists the local dates of the last n days, oldest first.
export function lastDays(n = DAYS, now = Date.now()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(localDay(now - i * 86_400_000));
  return out;
}

// parseGitLog adds `git log --format=@%ct --shortstat` up by local day.
export function parseGitLog(output: string, into: Map<string, Day>): number {
  let day: Day | undefined;
  let commits = 0;
  for (const line of output.split("\n")) {
    const at = /^@(\d+)$/.exec(line.trim());
    if (at) {
      day = into.get(localDay(Number(at[1]) * 1000));
      if (day) {
        day.commits++;
        commits++;
      }
      continue;
    }
    if (!day) continue;
    const add = /(\d+) insertion/.exec(line);
    const del = /(\d+) deletion/.exec(line);
    if (add) day.add += Number(add[1]);
    if (del) day.del += Number(del[1]);
  }
  return commits;
}

export function GitWidget() {
  const { span } = useHomeWidget();
  const { projects } = useProjects();
  // Each project read once, on its default box when that is online.
  const targets = useMemo(
    () =>
      projects
        .map((p) => {
          const m = p.members.find((x) => x.box.name === p.defaultBox && x.box.state === "online") ?? p.members.find((x) => x.box.state === "online");
          return m && m.loc.repo !== false ? { name: p.name, box: m.box.name, location: m.loc.name } : undefined;
        })
        .filter((t): t is { name: string; box: string; location: string } => !!t)
        .slice(0, MAX_PROJECTS),
    [projects],
  );
  const key = `git:${targets.map((t) => `${t.box}/${t.location}`).join(",")}`;
  const { data, loading, error } = useAppWidgetData<GitActivity>(
    key,
    async () => {
      const days = new Map(lastDays().map((d) => [d, { day: d, commits: 0, add: 0, del: 0 }]));
      const byProject: GitActivity["byProject"] = [];
      const failed: string[] = [];
      await Promise.all(
        targets.map(async (t) => {
          try {
            const r = await exec(t.box, t.location, gitLogCommand(), "30s");
            byProject.push({ name: t.name, commits: parseGitLog(r.output, days) });
          } catch {
            failed.push(t.name);
          }
        }),
      );
      return { days: [...days.values()], byProject: byProject.sort((a, b) => b.commits - a.commits), failed };
    },
    { every: 15 * 60_000 },
  );

  if (!targets.length && !loading) return <WidgetEmpty scene="chart" title="No projects to chart" hint="Add a repository on a box and its commits show here." action="Add a project" onAction={() => useStore.getState().openAddProject()} />;
  if (!data) return error ? <WidgetEmpty scene="storm" title="Couldn't read git" hint={error} compact /> : <ChartSkeleton />;
  const total = data.days.reduce((n, d) => n + d.commits, 0);
  const add = data.days.reduce((n, d) => n + d.add, 0);
  const del = data.days.reduce((n, d) => n + d.del, 0);
  const tall = span.r > 1;
  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-1">
      <div className="flex items-baseline gap-2">
        <span className="font-heading text-title tabular-nums tracking-tight">{total}</span>
        <span className="text-meta text-muted-foreground">commits · {DAYS} days</span>
        <DiffStat add={add} del={del} className="ml-auto" />
      </div>
      <Bars days={data.days} />
      {tall && data.byProject.length > 0 && (
        <ul className="flex flex-col gap-1 text-meta">
          {data.byProject.slice(0, 4).map((p) => (
            <li key={p.name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-muted-foreground tabular-nums">{p.commits}</span>
            </li>
          ))}
        </ul>
      )}
      {data.failed.length > 0 && <p className="truncate text-meta text-muted-foreground">Couldn't read {data.failed.join(", ")}</p>}
    </div>
  );
}

const weekday = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" });
const longDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

// Bars: one per day, commits as height, today last. Each says its numbers
// on hover and to a screen reader.
function Bars({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((d) => d.commits));
  return (
    <div className="flex max-h-44 min-h-0 flex-1 flex-col gap-1">
      <div className="flex min-h-10 flex-1 items-end gap-[2px]" role="list" aria-label="Commits a day">
        {days.map((d, i) => (
          <Tip key={d.day} label={`${longDay(d.day)} · ${d.commits} ${d.commits === 1 ? "commit" : "commits"}${d.commits ? ` · +${compactNumber(d.add)} −${compactNumber(d.del)}` : ""}`}>
            <span role="listitem" aria-label={`${longDay(d.day)}: ${d.commits} commits, ${d.add} lines added, ${d.del} removed`} className="flex h-full min-w-0 flex-1 items-end rounded-[3px] hover:bg-accent/60">
              <span
                className={cn("block w-full rounded-t-[4px] rounded-b-[1px]", d.commits ? (i === days.length - 1 ? "bg-info" : "bg-info/55") : "bg-muted")}
                style={{ height: d.commits ? `${Math.max(6, (d.commits / max) * 100)}%` : 2 }}
              />
            </span>
          </Tip>
        ))}
      </div>
      <div className="flex gap-[2px] text-tag text-muted-foreground" aria-hidden>
        {days.map((d) => (
          <span key={d.day} className="flex-1 text-center">
            {weekday(d.day)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-1" role="status" aria-busy="true" aria-label="Loading">
      <WidgetSkeleton rows={1} className="-mx-2" />
      <div className="flex flex-1 items-end gap-[2px]">
        {Array.from({ length: DAYS }, (_, i) => (
          <span key={i} className="flex-1 animate-pulse rounded-t-[4px] bg-muted motion-reduce:animate-none" style={{ height: `${20 + ((i * 37) % 60)}%` }} />
        ))}
      </div>
    </div>
  );
}
