import { CheckIcon, CircleAlertIcon, PackageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { ErrorText } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { scheduleRefresh, useStore } from "@/lib/store";
import { teamApi, type TeamKitPlan, type TeamView } from "@/lib/team";
import { sentence } from "@/lib/team-suggest-model";
import { focusSession } from "@/lib/workspaces";
import { reloadKits } from "@/views/kits/kits-store";

// "Just the kit": a project's kit from its org's team setup, for a project
// already on the box (internal/agent/teamkit.go). Only the kit: no box
// steps, sudo, clone or 1Password. The kit's tools are checked on the box
// first; the project's shared keys and its init are each a choice, off
// unless ticked. The kit follows the team setup's newer commits, as an
// update to review in Project settings.

interface Target {
  org: string;
  // The org's name as people say it ("Acme").
  name: string;
  box: string;
  location: string;
}

const useTeamKitSheet = create<{ target?: Target }>()(() => ({}));

export function openTeamKit(target: Target) {
  useTeamKitSheet.setState({ target });
}

export function TeamKitSheet() {
  const target = useTeamKitSheet((s) => s.target);
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && useTeamKitSheet.setState({ target: undefined })}>
      <DialogPopup className="sm:max-w-lg">{target && <Body key={`${target.org}/${target.box}/${target.location}`} target={target} />}</DialogPopup>
    </Dialog>
  );
}

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

function Body({ target }: { target: Target }) {
  const { org, name, box, location } = target;
  const [plan, setPlan] = useState<TeamKitPlan>();
  const [error, setError] = useState<string>();
  const [keys, setKeys] = useState(false);
  const [init, setInit] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = useStore.getState().client;
    if (!client) return;
    teamApi.kitPlan(client, org, box, location).then(setPlan, (err) => setError(errorMessage(err)));
  }, [org, box, location]);

  const apply = async () => {
    const client = useStore.getState().client;
    if (!client || !plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await teamApi.applyKit(client, org, { box, location, commit: plan.commit, hash: plan.kit.hash, keys: keys || undefined, init: init || undefined });
      scheduleRefresh(box, ["locations"]);
      void reloadKits();
      void useStore.getState().refreshStatus();
      useTeamKitSheet.setState({ target: undefined });
      const session = res.session;
      toastManager.add({
        type: "success",
        title: `${location} follows ${name}'s kit`,
        description: res.first_open ? `New worktrees get ${plan.kit.name}; the ${res.first_open === 1 ? "one" : res.first_open} already there ${res.first_open === 1 ? "gets it when it is" : "get it when each is"} first opened.` : `New worktrees get ${plan.kit.name}.`,
        actionProps: session ? { children: "Open its first-time setup", onClick: () => void focusSession(box, session) } : undefined,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const missing = plan?.requires.filter((r) => r.found === false) ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Use {name}'s kit for {location}
        </DialogTitle>
        <DialogDescription>
          Only {location}'s kit from <span className="font-mono">{org}/.berth</span>
          {plan ? ` at ${plan.short}` : ""}. No box steps, no sudo, no clone, no 1Password.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4" data-testid="team-kit-sheet">
        {!plan && !error && (
          <div className="space-y-3">
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </div>
        )}
        {plan && (
          <>
            <div className="flex items-start gap-3 rounded-lg border bg-card/50 px-3 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                <PackageIcon className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1 text-body">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{plan.kit.name}</span>
                  <span className="truncate font-mono text-muted-foreground text-mono">{plan.kit.ref}</span>
                </p>
                {plan.sets_up.length > 0 && <p className="text-muted-foreground text-meta">{sentence(`Sets up ${list(plan.sets_up)}`)}</p>}
              </div>
            </div>
            <p data-testid="team-kit-scope" className="text-muted-foreground text-meta">
              {plan.applied
                ? `${location} has this kit already, as it is now.`
                : `New worktrees of ${location} get it${plan.worktrees ? `, and the ${plan.worktrees === 1 ? "one already there gets it" : `${plan.worktrees} already there get it`} the first time ${plan.worktrees === 1 ? "it is" : "each is"} opened` : ""}. Your checkout stays as it is.`}
              {plan.replaces ? ` It replaces ${location}'s kit, ${plan.replaces}.` : ""}
            </p>
            {plan.requires.length > 0 && (
              <section aria-label="What the kit needs" data-testid="team-kit-requires">
                <h3 className="mb-1.5 text-label">Needs on {box}</h3>
                <ul className="space-y-1 text-meta">
                  {plan.requires.map((r) => (
                    <li key={r.tool} className="flex items-start gap-1.5">
                      {r.found === false ? <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-warning-foreground" /> : r.found ? <CheckIcon className="mt-px size-3.5 shrink-0 text-success" /> : <span className="size-3.5 shrink-0" />}
                      <span>
                        <span className="font-mono">{r.tool}</span>
                        {r.found === false ? <span className="text-muted-foreground"> missing{r.hint ? `: ${r.hint}` : ""}</span> : r.found ? <span className="text-muted-foreground"> found</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 && <p className="mt-1.5 text-muted-foreground text-meta">The kit is used anyway; its setup may stop until {missing.length === 1 ? "it is" : "they are"} installed.</p>}
              </section>
            )}
            {(plan.keys.length > 0 || plan.init) && (
              <div className="space-y-3 border-t pt-3">
                {plan.keys.length > 0 && (
                  <label className="flex items-start gap-2.5 text-body">
                    <Checkbox className="mt-0.5" checked={keys} onCheckedChange={(v) => setKeys(!!v)} data-testid="team-kit-keys" />
                    <span>
                      Add {location}'s shared keys
                      <span className="block text-muted-foreground text-meta">
                        <span className="font-mono">{list(plan.keys.map((k) => k.name))}</span>
                        {plan.keys.some((k) => k.onepassword) ? `, read with 1Password on ${box}` : ""}.
                        {plan.keys.some((k) => k.used_by.length) ? ` Used by ${list([...new Set(plan.keys.flatMap((k) => k.used_by))])}.` : ""}
                      </span>
                    </span>
                  </label>
                )}
                {plan.init && (
                  <label className="flex items-start gap-2.5 text-body">
                    <Checkbox className="mt-0.5" checked={init} onCheckedChange={(v) => setInit(!!v)} data-testid="team-kit-init" />
                    <span>
                      Run {name}'s first-time setup in your checkout
                      <span className="block text-muted-foreground text-meta">
                        {plan.init.detail ? `${plan.init.detail[0].toUpperCase()}${plan.init.detail.slice(1)}` : "Once"}, with <span className="font-mono">{plan.init.script}</span>, in a terminal you can watch.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}
          </>
        )}
        {error && <ErrorText className="text-destructive-foreground text-body" text={error} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button loading={busy} disabled={!plan || plan.applied} onClick={() => void apply()} data-testid="team-kit-apply">
          Use the kit
        </Button>
      </DialogFooter>
    </>
  );
}

// KitChoices is the Team setup page's second way, for each repo that is a
// Shipyard project on the box already and gets its setup from a kit: the
// whole setup (the page as it is), or just that project's kit.
export function KitChoices({ view, box }: { view: TeamView; box?: string }) {
  if (!box || view.state !== "found") return null;
  const name = view.setup?.name ?? view.org.name;
  const rows = view.projects.flatMap((p) => {
    const loc = p.access && p.source === "kit" ? p.existing?.find((c) => c.location)?.location : undefined;
    return loc ? [{ p, loc }] : [];
  });
  if (!rows.length) return null;
  return (
    <section aria-label="Everything, or just the kit" data-testid="team-kit-choices" className="mb-6 rounded-xl border bg-card/40 px-4 py-3">
      <h2 className="text-section">{rows.length === 1 ? `You have ${rows[0].loc} on ${box} already` : `You have ${list(rows.map((r) => r.loc))} on ${box} already`}</h2>
      <p className="mt-0.5 text-desc text-muted-foreground">Set up everything below, or take just a project's kit: its per-worktree setup, without the box steps, sudo or clone.</p>
      <div className="mt-2.5 space-y-1.5">
        {rows.map(({ p, loc }) => (
          <div key={p.id} data-testid={`kit-choice-${p.id}`} className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="secondary" aria-pressed>
              <CheckIcon /> Set up everything
            </Button>
            <Button size="xs" variant="ghost" className="text-muted-foreground" aria-pressed={false} onClick={() => openTeamKit({ org: view.org.login, name, box, location: loc })}>
              Just the kit for {loc}…
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
