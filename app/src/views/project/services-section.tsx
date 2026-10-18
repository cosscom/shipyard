import { PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, SquareTerminalIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { serviceRunning, showServiceTerminal } from "@/components/workspace/service-terminal";
import { sortedWorktrees } from "@/lib/derive";
import { type RepoConfig, type ServiceStatus, flowsApi, type WorktreeService } from "@/lib/flows";
import { errorMessage } from "@/lib/format";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Section, SourceBadge } from "@/views/project/parts";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ServicesSection is what every worktree runs, each on its own ports, and
// below it, what is running in each worktree right now.
export function ServicesSection({ repo, draft, setDraft, box, location, urlPort }: { repo: RepoConfig | null; draft: RepoConfig; setDraft(c: RepoConfig): void; box: string; location: string; urlPort: number }) {
  const committed = repo?.services ?? [];
  const own = draft.services ?? [];
  const names = [...new Set([...committed.map((s) => s.name), ...own.map((s) => s.name)])];
  const setOwn = (services: WorktreeService[]) => setDraft({ ...draft, services });
  const update = (name: string, patch: Partial<WorktreeService>) => setOwn(own.map((s) => (s.name === name ? { ...s, ...patch } : s)));
  const host = `<worktree>.${location}.${box}.localhost${urlPort === 80 ? "" : `:${urlPort}`}`;
  // Boxes that can run a service in a terminal of its own offer it.
  const terminals = useStore((s) => !!s.boxes[box]?.info?.capabilities?.includes("service.terminal"));
  const cols = terminals ? "grid-cols-[9rem_minmax(0,1fr)_5.5rem_5rem_auto_3.5rem]" : "grid-cols-[9rem_minmax(0,1fr)_5.5rem_auto_3.5rem]";

  return (
    <Section
      id="services"
      title="Services"
      description={
        <>
          Long-running programs every worktree runs, like its dev server. Each gets the worktree's environment and listens on its own <code className="font-mono">$BERTH_PORT</code>, reachable at <code className="font-mono">{host}</code>.
        </>
      }
      actions={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            let n = own.length + committed.length + 1;
            while (names.includes(n === 1 ? "web" : `svc-${n}`)) n++;
            setOwn([...own, { name: n === 1 ? "web" : `svc-${n}`, run: "", autostart: true }]);
          }}
        >
          <PlusIcon />
          Add service
        </Button>
      }
    >
      {names.length === 0 ? (
        <p className="px-4 py-3 text-muted-foreground text-body">
          No services. Add the dev server, for example <code className="font-mono text-mono">pnpm dev --port $BERTH_PORT</code>, and every worktree gets its own.
        </p>
      ) : (
        <div className="divide-y divide-border/70">
          <div className={cn("grid gap-3 px-4 py-1.5 text-label text-muted-foreground", cols)}>
            <span>Name</span>
            <span>Run</span>
            <span>Autostart</span>
            {terminals && (
              <Tip label="Run it in a terminal of its own, shown as a tab in each worktree. Ctrl-C there stops it.">
                <span>Terminal</span>
              </Tip>
            )}
            <span />
            <span />
          </div>
          {names.map((name, i) => {
            const c = committed.find((s) => s.name === name);
            const mine = own.find((s) => s.name === name);
            const s = mine ?? c!;
            const source = mine ? (c ? "override" : "box") : "repo";
            const bad = mine && !NAME.test(mine.name);
            return (
              // By position, so renaming a service keeps its field focused.
              <div key={i} className={cn("grid items-center gap-3 px-4 py-2", cols)}>
                {mine && !c ? (
                  // Always the same tooltip: switching it on as the name goes bad would remount the field mid-word.
                  <Tip label="Lowercase letters, digits and dashes">
                    <Input value={mine.name} onChange={(e) => update(name, { name: e.target.value })} size="sm" className="font-mono text-mono" aria-invalid={!!bad} />
                  </Tip>
                ) : (
                  <code className="truncate font-mono text-mono">{name}</code>
                )}
                {mine ? (
                  <Input value={mine.run} onChange={(e) => update(name, { run: e.target.value })} placeholder="pnpm dev --port $BERTH_PORT" size="sm" className="font-mono text-mono" spellCheck={false} />
                ) : (
                  <code className="truncate px-2.5 font-mono text-muted-foreground text-mono" title={s.run}>
                    {s.run}
                  </code>
                )}
                <Switch checked={!!s.autostart} disabled={!mine} onCheckedChange={(v) => update(name, { autostart: v })} aria-label={`Start ${name} with each new worktree`} />
                {terminals && <Switch checked={!!s.terminal} disabled={!mine} onCheckedChange={(v) => update(name, { terminal: v })} aria-label={`Run ${name} in a terminal tab`} />}
                <SourceBadge source={source} box={box} field="services" entry={name} />
                <span className="flex justify-end">
                  {!mine && (
                    <Tip label={`Override on ${box}`}>
                      <Button size="icon-xs" variant="ghost" aria-label={`Override ${name} on ${box}`} onClick={() => setOwn([...own, { ...c! }])}>
                        <PlusIcon />
                      </Button>
                    </Tip>
                  )}
                  {mine && (
                    <Tip label={c ? "Use the repo's" : "Remove"}>
                      <Button size="icon-xs" variant="ghost" aria-label={c ? `Use the repo's ${name}` : `Remove ${name}`} onClick={() => setOwn(own.filter((x) => x.name !== name))}>
                        {c ? <Undo2Icon /> : <Trash2Icon />}
                      </Button>
                    </Tip>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <LiveServices box={box} location={location} />
    </Section>
  );
}

// LiveServices shows the saved services' state in each worktree, with
// start, stop and restart.
function LiveServices({ box, location }: { box: string; location: string }) {
  const client = useStore((s) => s.client);
  const loc = useStore((s) => s.boxes[box]?.locations?.find((l) => l.name === location));
  const worktrees = loc ? sortedWorktrees(loc) : NONE;
  const [state, setState] = useState<Record<string, ServiceStatus[] | string>>({});
  const [busy, setBusy] = useState<string>();
  const sessions = useStore((s) => s.boxes[box]?.sessions);

  const load = useCallback(async () => {
    if (!client) return;
    const entries = await Promise.all(
      worktrees.slice(0, 12).map(async (wt) => {
        try {
          return [wt.name, await flowsApi.services(client, box, location, wt.name)] as const;
        } catch (err) {
          return [wt.name, errorMessage(err)] as const;
        }
      }),
    );
    setState(Object.fromEntries(entries));
  }, [client, box, location, worktrees.map((w) => w.name).join(",")]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (wt: string, svc: string, action: "start" | "stop" | "restart") => {
    if (!client) return;
    setBusy(`${wt}/${svc}`);
    try {
      await flowsApi.serviceAction(client, box, location, wt, svc, action);
      await load();
    } finally {
      setBusy(undefined);
    }
  };

  const rows = worktrees.filter((wt) => Array.isArray(state[wt.name]) && (state[wt.name] as ServiceStatus[]).length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="border-t bg-muted/20">
      <div className="px-4 pt-2.5 pb-1 text-label text-muted-foreground">Running now</div>
      <div className="divide-y divide-border/50 pb-1">
        {rows.map((wt) => (
          <div key={wt.name} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2">
            <span className="w-36 truncate text-row">{wt.main ? location : wt.name}</span>
            {(state[wt.name] as ServiceStatus[]).map((s) => {
              const running = s.terminal ? serviceRunning(s, sessions) : s.state === "running" || s.state === "active";
              const key = `${wt.name}/${s.name}`;
              return (
                <span key={s.name} className="inline-flex items-center gap-1.5 rounded-lg border bg-card py-0.5 pr-0.5 pl-2 text-meta">
                  <span className={cn("size-1.5 rounded-full", running ? "bg-success" : "bg-muted-foreground/40")} />
                  <code className="font-mono">{s.name}</code>
                  {s.port && <span className="font-mono text-muted-foreground tabular-nums">:{s.port}</span>}
                  {s.terminal && s.session && (
                    <Tip label="Show terminal">
                      <Button size="icon-xs" variant="ghost" aria-label={`Show ${s.name}'s terminal in ${wt.name}`} onClick={() => void showServiceTerminal({ box, location, worktree: wt.name }, s)}>
                        <SquareTerminalIcon />
                      </Button>
                    </Tip>
                  )}
                  {running ? (
                    <>
                      <Button size="icon-xs" variant="ghost" aria-label={`Restart ${s.name} in ${wt.name}`} disabled={busy === key} onClick={() => void act(wt.name, s.name, "restart")}>
                        <RotateCwIcon />
                      </Button>
                      <Button size="icon-xs" variant="ghost" aria-label={`Stop ${s.name} in ${wt.name}`} disabled={busy === key} onClick={() => void act(wt.name, s.name, "stop")}>
                        <SquareIcon />
                      </Button>
                    </>
                  ) : (
                    <Button size="icon-xs" variant="ghost" aria-label={`Start ${s.name} in ${wt.name}`} disabled={busy === key} onClick={() => void act(wt.name, s.name, "start")}>
                      <PlayIcon />
                    </Button>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
