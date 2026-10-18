import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { keyOf, putRun, teamApi, type TeamStatus, useTeam } from "@/lib/team";

// Keys a team setup left without a value, and 1Password turned on later.
// A setup run with 1Password skipped asks for each shared key once; the
// ones left blank are missing, listed in Project settings beside the
// project's environment, and Use 1Password (here, or in Settings › Boxes)
// puts the team's references back and signs op in on the box.

// UseOnePassword turns 1Password on for a setup that skipped it, then
// opens Team setup, where op asks to sign in in the box's terminal.
export function UseOnePassword({ run, size = "xs" }: { run: TeamStatus; size?: "xs" | "sm" }) {
  const client = useStore((s) => s.client);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      variant="outline"
      data-testid="use-1password"
      loading={busy}
      onClick={async () => {
        if (!client) return;
        setBusy(true);
        try {
          putRun(await teamApi.useOnePassword(client, run.box, run.id));
          useStore.getState().setView({ kind: "team", org: keyOf(useTeam.getState(), run), box: run.box });
        } catch (err) {
          toastManager.add({ type: "error", title: "Couldn't turn 1Password on", description: plainError(err, { box: run.box }) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <KeyRoundIcon /> Use 1Password
    </Button>
  );
}

// BoxOnePasswordNote is Settings › Boxes' line for each team setup on the
// box that skipped 1Password.
export function BoxOnePasswordNote({ box }: { box: string }) {
  const all = useTeam((s) => s.runs);
  const runs = Object.values(all).filter((r) => r.box === box && r.onepassword_skipped);
  if (!runs.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {runs.map((r) => {
        const n = r.projects.reduce((c, p) => c + (p.deferred?.length ?? 0), 0);
        return (
          <div key={r.id} data-testid="box-1password-skipped" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-meta">
            <span className="min-w-0 flex-1 text-muted-foreground">
              <span className="text-foreground">{r.name}'s setup</span> skipped 1Password: {n === 1 ? "1 shared key was" : `${n} shared keys were`} typed or left missing.
            </span>
            <UseOnePassword run={r} />
          </div>
        );
      })}
    </div>
  );
}

// ProjectTeamKeys is Project settings' note on the keys a team setup left
// missing for this project, and 1Password for the ones it skipped.
export function ProjectTeamKeys({ box, location, env, onAdd }: { box: string; location: string; env: Record<string, string>; onAdd(keys: string[]): void }) {
  const all = useTeam((s) => s.runs);
  const runs = Object.values(all).filter((r) => r.box === box && r.projects.some((p) => p.location === location));
  const rows = runs
    .map((r) => {
      const p = r.projects.find((x) => x.location === location)!;
      return { run: r, missing: (p.missing ?? []).filter((k) => !env[k]), deferred: r.onepassword_skipped ? (p.deferred ?? []) : [] };
    })
    .filter((x) => x.missing.length || x.deferred.length);
  if (!rows.length) return null;
  return (
    <>
      {rows.map(({ run, missing, deferred }) => (
        <section key={run.id} data-testid="project-missing-keys" className="rounded-xl border border-warning/30 bg-warning/6 px-4 py-3">
          <p className="flex items-start gap-2 text-body">
            <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <span>
              {missing.length > 0 ? (
                <>
                  <span className="font-medium">Missing keys</span> from {run.name}'s setup: <span className="font-mono text-desc">{missing.join(", ")}</span>. Add them in Environment below, then Save.
                </>
              ) : (
                <>
                  {run.name}'s setup skipped 1Password for <span className="font-mono text-desc">{deferred.join(", ")}</span>; the values typed for them are used.
                </>
              )}
            </span>
          </p>
          <div className="mt-2.5 ml-6 flex flex-wrap items-center gap-2">
            {missing.length > 0 && (
              <Button size="xs" data-testid="add-missing-keys" onClick={() => onAdd(missing)}>
                <PlusIcon /> Add {missing.length === 1 ? "it" : `all ${missing.length}`} to Environment
              </Button>
            )}
            {deferred.length > 0 && (
              <>
                <UseOnePassword run={run} />
                <span className="text-meta text-muted-foreground">reads {deferred.length === 1 ? "it" : `all ${deferred.length}`} with the team's 1Password references; op signs in once on {box}</span>
              </>
            )}
          </div>
        </section>
      ))}
    </>
  );
}
