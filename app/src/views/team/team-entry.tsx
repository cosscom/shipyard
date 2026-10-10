import { ArrowRightIcon, CircleAlertIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { isTauri } from "@/lib/api";
import { useStore } from "@/lib/store";
import { activeRun, keyOf, loadTeams, onRepoReady, recentlyDone, teamRef, type TeamStatus, useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";
import { GitHubMark } from "@/views/team/team-parts";
import { runSummary } from "@/views/team/team-rail";
import { OrgField } from "@/views/team/org-field";

// The ways into Team setup, and what shows of it around the app while it
// runs: the welcome screen's "Joining a team?", Add a box's "Set this box up
// for a team", the berth://team?org= link, the sidebar's card, the status
// bar's line, and a toast when a repo is ready while the page is away.

export function openTeam(org?: string, from?: "onboarding" | "addbox" | "link" | "sidebar" | "palette") {
  useStore.getState().setView({ kind: "team", org, from });
}

// JoinTeamCard is first run's way in for someone whose company publishes a
// team setup: the org's name (or a link to a setup), and the page.
export function JoinTeamCard() {
  const [v, setV] = useState("");
  const ref = teamRef(v);
  return (
    <section aria-label="Joining a team?" className="mt-2 rounded-xl border bg-card/40 px-4 py-3.5">
      <h2 className="flex items-center gap-2 font-medium text-sm">
        <GitHubMark className="size-3.5" /> Joining a team?
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">Type your company's GitHub org, or paste a link to a team setup. Shipyard sets your box up the way the team's are: tools, services and repos.</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ref) openTeam(ref, "onboarding");
        }}
      >
        <OrgField value={v} onChange={setV} />
        <Button type="submit" variant="outline" disabled={!ref}>
          Continue <ArrowRightIcon />
        </Button>
      </form>
    </section>
  );
}

// TeamBoxEntry sits first in Add a box: setting a box up for a team pairs
// it (or picks one) on the page that follows.
export function TeamBoxEntry({ onPick }: { onPick(): void }) {
  return (
    <button type="button" data-testid="addbox-team" onClick={onPick} className="mb-5 flex w-full items-center gap-3 rounded-xl border border-foreground/15 bg-card px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
        <GitHubMark />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-sm">Set this box up for a team</span>
        <span className="block text-muted-foreground text-xs">Your company's team setup from GitHub: its tools, services and repos, in one go.</span>
      </span>
      <ArrowRightIcon className="size-4 text-muted-foreground" />
    </button>
  );
}

const REPO_WORDS: Record<string, string> = { queued: "queued", cloning: "cloning", "setting-up": "setting up", ready: "new", failed: "failed", skipped: "left out" };

// TeamSidebarCard: a setup under way (its repos queued → setting up →
// new), a newer commit to review, or a moment after, what it set up.
export function TeamSidebarCard() {
  const run = useTeam((s) => activeRun(s) ?? recentlyDone(s));
  const updates = useTeam((s) => s.updates);
  const update = Object.entries(updates)[0];
  const view = useStore((s) => s.view);
  if (run) {
    const sum = runSummary(run);
    const done = run.phase === "done";
    return (
      <button
        type="button"
        data-testid="team-sidebar"
        onClick={() => useStore.getState().setView({ kind: "team", org: keyOf(useTeam.getState(), run), box: run.box, from: "sidebar" })}
        className={cn("mx-2 mt-3 block w-[calc(100%-16px)] rounded-lg border bg-card px-2.5 py-2 text-left hover:bg-accent/40", view.kind === "team" && "border-foreground/20")}
      >
        <span className="flex items-center gap-1.5 font-medium text-[12px]">
          {sum.tone === "failed" ? <CircleAlertIcon className="size-3.5 text-destructive" /> : sum.tone === "waiting" ? <KeyRoundIcon className="size-3.5 text-warning-foreground" /> : done ? <GitHubMark className="size-3.5" /> : <Spinner className="size-3.5" />}
          <span className="min-w-0 flex-1 truncate">{done ? `Set up for ${run.name}` : `${run.name} on ${run.box}`}</span>
        </span>
        {!done && (
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full rounded-full", sum.tone === "failed" ? "bg-destructive" : "bg-foreground/70")} style={{ width: `${Math.max(4, sum.pct * 100)}%` }} />
          </span>
        )}
        <span className="mt-1.5 block space-y-0.5">
          {run.projects
            .filter((p) => p.state !== "skipped")
            .map((p) => (
              <span key={p.id} className="flex items-center gap-1.5 text-[11.5px]">
                <span className={cn("min-w-0 flex-1 truncate", p.state === "queued" && "text-muted-foreground")}>{p.id}</span>
                <span className={cn("flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground", p.state === "ready" && "rounded bg-info/15 px-1 font-medium text-info-foreground", p.state === "failed" && "text-destructive-foreground")}>
                  {(p.state === "cloning" || p.state === "setting-up") && <Spinner className="size-2.5" />}
                  {REPO_WORDS[p.state]}
                </span>
              </span>
            ))}
        </span>
      </button>
    );
  }
  if (update) {
    const [org, u] = update;
    const name = useTeam.getState().accepted.find((a) => (a.key ?? a.org) === org)?.name ?? org;
    return (
      <div data-testid="team-update-card" className="mx-2 mt-3 rounded-lg border bg-card px-2.5 py-2">
        <p className="flex items-center gap-1.5 font-medium text-[12px]">
          <GitHubMark className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{name}'s setup changed</span>
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {u.changes.length} changes · {u.from} → {u.to}
          {u.sudo.length ? " · asks for your password" : ""}
        </p>
        <Button size="xs" variant="outline" className="mt-2 w-full" onClick={() => useStore.getState().setView({ kind: "team", org, from: "sidebar", update: true })}>
          Review update
        </Button>
      </div>
    );
  }
  return null;
}

// TeamStatusItem is the status bar's line while a setup runs.
export function TeamStatusItem() {
  const run = useTeam((s) => activeRun(s));
  if (!run) return null;
  const sum = runSummary(run);
  return (
    <Tip label="Open Team setup">
      <button
        type="button"
        data-testid="team-status"
        onClick={() => useStore.getState().setView({ kind: "team", org: keyOf(useTeam.getState(), run), box: run.box })}
        className={cn("-mx-1 flex min-w-0 max-w-[50%] shrink items-center gap-1.5 whitespace-nowrap rounded px-1 hover:bg-accent hover:text-foreground", sum.tone === "failed" && "text-destructive-foreground", sum.tone === "waiting" && "text-warning-foreground dark:text-warning")}
      >
        {sum.tone === "failed" ? <CircleAlertIcon className="size-3" /> : sum.tone === "waiting" ? <KeyRoundIcon className="size-3" /> : <Spinner className="size-3" />}
        <span className="truncate @max-[1000px]:hidden">{sum.tone === "failed" ? `${run.name} setup ${sum.status}` : `Setting up ${run.box} for ${run.name} · ${sum.status}`}</span>
        <span className="truncate @min-[1001px]:hidden">{`${run.name} setup · ${sum.status}`}</span>
      </button>
    </Tip>
  );
}

// useTeamWatch reads the setups the laptop accepted and the boxes ran, on
// connect and whenever the set of online boxes changes, and says when a
// repo is ready while the page isn't in front.
export function useTeamWatch() {
  const online = useStore((s) => (s.status?.boxes ?? []).filter((b) => b.state === "online").map((b) => b.name).join(","));
  const connected = useStore((s) => !!s.client);
  useEffect(() => {
    if (connected) void loadTeams();
  }, [connected, online]);
  useEffect(
    () =>
      onRepoReady((run: TeamStatus, p) => {
        const view = useStore.getState().view;
        if (view.kind === "team") return;
        const left = run.projects.filter((x) => x.state !== "ready" && x.state !== "skipped").length;
        toastManager.add({
          type: "success",
          title: `${p.id} is ready`,
          description: left ? `Cloned and set up on ${run.box}. ${left} more still setting up.` : `Cloned and set up on ${run.box}.`,
          actionProps: p.location ? { children: `Start on ${p.id}`, onClick: () => useStore.getState().openNewWorktree({ box: run.box, location: p.location }) } : undefined,
        });
      }),
    [],
  );
}

// A team link someone shares opens the page: berth://team?org=acme for
// an org's .berth, berth://team?src=<link> for a setup anywhere else. In the
// browser build ?team-link=acme and ?team-link-src=<link> do the same, for
// trying them out, and ?team-page= opens the page as the sidebar would.
function openLink(url: string) {
  if (!/^berth:\/\/team\b/i.test(url)) return;
  const ref = teamRef(url);
  if (ref) openTeam(ref, "link");
}

function takeParam(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const v = params.get(name);
  if (v === null) return null;
  params.delete(name);
  const rest = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  return v;
}

export function useTeamDeepLinks() {
  useEffect(() => {
    const page = takeParam("team-page");
    const ref = page && teamRef(page);
    if (ref) openTeam(ref);
    const org = takeParam("team-link");
    if (org) openLink(org.startsWith("berth://") ? org : `berth://team?org=${encodeURIComponent(org)}`);
    const src = takeParam("team-link-src");
    if (src) openLink(`berth://team?src=${encodeURIComponent(src)}`);
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const dl = await import("@tauri-apps/plugin-deep-link");
        for (const u of (await dl.getCurrent()) ?? []) openLink(u);
        const unlisten = await dl.onOpenUrl((urls) => urls.forEach(openLink));
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch (err) {
        console.warn("team links are not available", err);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
