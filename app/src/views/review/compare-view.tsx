import { ArrowLeftIcon, CheckIcon, Columns2Icon, CrownIcon, GitCompareArrowsIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { ago, errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import type { RunCompare } from "@/lib/orchestrate-core";
import { allRuns, type BoxRun, runs as runsApi, scheduleRuns, useRuns } from "@/lib/runs";
import { confirm } from "@/components/sidebar/confirm";
import { cn } from "@/lib/utils";
import { focusSession, wsKey } from "@/lib/workspaces";
import { openCompare } from "@/lib/compare-actions";
import { usePrefs } from "@/lib/prefs";
import { tokens } from "@/views/automations/flows/runs-tab";
import { ErrorText } from "@/components/error-note";

// CompareStrip lists attempts runs with candidates to compare, at the top of
// Review: the ones waiting for a pick first.
export function CompareStrip({ runs, onOpen }: { runs: BoxRun[]; onOpen(r: BoxRun): void }) {
  if (!runs.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-meta">
      <GitCompareArrowsIcon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">Attempts to compare:</span>
      {runs.map((r) => (
        <Button key={`${r.box}/${r.id}`} size="xs" variant={r.status === "waiting_gate" ? "default" : "outline"} onClick={() => onOpen(r)}>
          {r.title ?? r.id}
          {r.status === "waiting_gate" && " · pick one"}
        </Button>
      ))}
    </div>
  );
}

// CompareView is Review's Compare mode for an attempts run: a column per
// attempt, with its check, diffstat, commits, the judge's ranking and
// reasons, and the files it changed. Picking one decides the run's gate;
// the run then opens its pull request and archives the rest.
export function CompareView({ box, id, onClose }: { box: string; id: string; onClose(): void }) {
  // Attempts across boxes are a group of per-box runs, compared here as one.
  const byBox = useRuns((s) => s.byBox);
  const group = allRuns(byBox).find((r) => r.box === box && r.id === id)?.group;
  const members = group ? allRuns(byBox).filter((r) => r.group === group && r.template === "attempts") : [];
  const runsKey = (members.length ? members.map((r) => `${r.box}/${r.id}`) : [`${box}/${id}`]).sort().join(",");
  const [all, setAll] = useState<{ box: string; id: string; data: RunCompare }[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const list = runsKey.split(",").map((k) => ({ box: k.slice(0, k.indexOf("/")), id: k.slice(k.indexOf("/") + 1) }));
      setAll(await Promise.all(list.map(async (r) => ({ ...r, data: await runsApi.compare(r.box, r.id) }))));
    } catch (err) {
      setError(plainError(err));
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), 4000);
    return () => clearInterval(t);
  }, [runsKey]);

  // A pick decides every run of the group: the picked one's run takes it,
  // the others pick none and archive their attempts.
  const pick = async (approve: boolean, at?: { box: string; id: string; index: number }) => {
    setBusy(true);
    try {
      for (const r of all) {
        if (!r.data.gate) continue;
        const mine = at && r.box === at.box && r.id === at.id;
        await runsApi.decide(r.box, r.id, approve ? { approve: true, pick: mine ? at.index : -1 } : { approve: false });
        scheduleRuns(r.box, 0);
      }
      toastManager.add({ type: "success", title: approve && at ? `Picked attempt ${at.index + 1}${all.length > 1 ? ` on ${at.box}` : ""}` : "Rejected every attempt", description: approve ? "The run goes on: its pull request, then the others are archived." : undefined });
      await load();
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't decide", description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const data = all.find((r) => r.box === box && r.id === id)?.data ?? all[0]?.data;
  const canPick = all.some((r) => r.data.gate?.pick);
  const multi = all.length > 1;
  // A group's runs each say how many they tried; the page shows them all.
  const titleOf = (t?: string) => (t ?? id).replace(/: \d+ attempts?$/, "");
  const cands = all.flatMap((r) => r.data.candidates.map((c) => ({ ...c, box: r.box, runId: r.id, winner: r.data.gate?.default === c.index })));
  // One winner across the group: each box's judge ranks only its own, so of
  // their first picks the one whose check passed, then the smallest change.
  const firsts = cands.filter((c) => c.judge.rank === 1);
  const best = [...firsts].sort((a, b) => Number(b.verify.passed) - Number(a.verify.passed) || a.diff.added + a.diff.removed - (b.diff.added + b.diff.removed))[0];
  const isBest = (c: (typeof cands)[number]) => !!best && c.box === best.box && c.runId === best.runId && c.index === best.index;
  const title = data ? `${titleOf(data.run.title)}: ${cands.length} attempt${cands.length === 1 ? "" : "s"}` : id;
  // Side by side (Labs): an attempt in a Compare tab beside the judge's
  // pick, or the pick beside the runner-up.
  const labs = usePrefs((p) => p.labs);
  const partner = (c: (typeof cands)[number]) => {
    const others = cands.filter((o) => o !== c && o.path);
    return (best && !isBest(c) && best.path ? best : undefined) ?? [...others].sort((x, y) => (x.judge.rank ?? 99) - (y.judge.rank ?? 99))[0];
  };
  const sideBySide = (c: (typeof cands)[number], o: (typeof cands)[number]) => {
    if (!c.path || !o.path || !openCompare(wsKey(c.box, c.path), wsKey(o.box, o.path)))
      toastManager.add({ type: "error", title: "Couldn't put them side by side", description: "One of the attempts' worktrees isn't on its box any more." });
  };
  // Picking one whose check failed takes work that does not pass: ask first.
  const choose = (c: (typeof cands)[number]) => {
    const go = () => pick(true, { box: c.box, id: c.runId, index: c.index });
    if (c.verify.passed) return void go();
    confirm({
      title: `Pick attempt ${c.index + 1}? Its check failed`,
      description: "Its pull request opens with work that doesn't pass the check, and the other attempts are archived.",
      confirm: "Pick it anyway",
      destructive: true,
      run: go,
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-6 py-2.5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeftIcon />
          Review
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-row">{title}</p>
          <p className="truncate text-meta text-muted-foreground">
            {multi ? all.map((r) => r.box).join(" and ") : box} · {data ? `${data.run.status.replace("_", " ")} · started ${ago(data.run.created)}` : "…"}
            {data?.run.usage && ` · ${tokens(data.run.usage)}`}
          </p>
        </div>
        {canPick && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pick(false)}>
            <XIcon />
            Reject all
          </Button>
        )}
      </div>
      {error && <ErrorText className="px-6 py-3 text-destructive-foreground text-body" text={error} />}
      {!data && !error && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-body">
          <Spinner className="size-4" /> Reading the attempts…
        </div>
      )}
      {data && (
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {all
            .filter((r) => r.data.judge)
            .map((r) => (
              <p key={`${r.box}/${r.id}`} className="mb-4 rounded-xl border bg-muted/30 px-4 py-2.5 text-body">
                <span className="font-medium">Judge{multi ? ` on ${r.box}` : ""}: </span>
                {r.data.judge}
              </p>
            ))}
          {!cands.length && <p className="text-muted-foreground text-body">No attempt has finished yet.</p>}
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, cands.length)}, minmax(260px, 1fr))` }}>
            {cands.map((c) => {
              const files = c.review?.files ?? [];
              return (
                <section key={`${c.box}/${c.runId}/${c.index}`} className={cn("flex min-w-0 flex-col rounded-xl border bg-card", c.picked && "border-success/60", isBest(c) && canPick && "border-primary/50")}>
                  <header className="flex items-center gap-2 border-b px-3 py-2">
                    <AgentIcon agent={c.agent} />
                    <span className="shrink-0 whitespace-nowrap text-row">Attempt {c.index + 1}</span>
                    <span className="min-w-0 truncate text-meta text-muted-foreground">{multi ? `${c.box} · ${c.worktree}` : c.worktree}</span>
                    {isBest(c) && (
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-meta text-primary">
                        <CrownIcon className="size-3" />
                        judge's pick
                      </span>
                    )}
                    {c.picked && (
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-meta text-success-foreground">
                        <CheckIcon className="size-3" />
                        picked
                      </span>
                    )}
                  </header>
                  <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 px-3 py-2 text-meta">
                    <dt className="text-muted-foreground">Check</dt>
                    <dd className={c.verify.passed ? "text-success-foreground" : "text-destructive-foreground"}>
                      {c.verify.passed ? "passed" : `failed (exit ${c.verify.exit_code})`}
                      {c.verify.rounds ? ` in ${c.verify.rounds} round${c.verify.rounds === 1 ? "" : "s"}` : ""}
                    </dd>
                    <dt className="text-muted-foreground">Changes</dt>
                    <dd className="font-mono tabular-nums">
                      {c.diff.files} files <span className="text-success-foreground">+{c.diff.added}</span> <span className="text-destructive-foreground">−{c.diff.removed}</span> · {c.diff.commits} commits
                    </dd>
                    {c.judge.rank ? (
                      <>
                        <dt className="text-muted-foreground">Judge</dt>
                        <dd>
                          #{c.judge.rank}
                          {c.judge.reason && <span className="text-muted-foreground"> · {c.judge.reason}</span>}
                        </dd>
                      </>
                    ) : null}
                    {c.tokens && (
                      <>
                        <dt className="text-muted-foreground">Spent</dt>
                        <dd>{tokens(c.tokens)}</dd>
                      </>
                    )}
                    {c.summary && (
                      <>
                        <dt className="text-muted-foreground">Commits</dt>
                        <dd className="text-muted-foreground">{c.summary}</dd>
                      </>
                    )}
                  </dl>
                  {!c.verify.passed && c.verify.tail && <pre className="mx-3 mb-2 max-h-28 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-mono text-muted-foreground">{c.verify.tail}</pre>}
                  <ul className="min-h-0 flex-1 space-y-0.5 border-t px-3 py-2 text-meta">
                    {files.slice(0, 14).map((f) => (
                      <li key={f.path} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                        <span className="font-mono text-success-foreground tabular-nums">+{f.added ?? 0}</span>
                        <span className="font-mono text-destructive-foreground tabular-nums">−{f.removed ?? 0}</span>
                      </li>
                    ))}
                    {files.length > 14 && <li className="text-muted-foreground">and {files.length - 14} more</li>}
                    {!files.length && <li className="text-muted-foreground">No uncommitted changes.</li>}
                  </ul>
                  <footer className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
                    {canPick && (
                      <Button size="xs" variant={isBest(c) && c.verify.passed ? "default" : "outline"} disabled={busy} onClick={() => choose(c)}>
                        Pick this one
                      </Button>
                    )}
                    {c.session && (
                      <Button size="xs" variant="ghost" onClick={() => void focusSession(c.box, c.session!)}>
                        <SquareTerminalIcon />
                        Open session
                      </Button>
                    )}
                    {labs && c.path && partner(c) && (() => {
                      const o = partner(c)!;
                      const which = `#${o.index + 1}${multi && o.box !== c.box ? ` on ${o.box}` : ""}`;
                      return (
                        <Button size="xs" variant="ghost" onClick={() => sideBySide(c, o)} aria-label={`Compare attempt ${c.index + 1} side by side with attempt ${which}`}>
                          <Columns2Icon />
                          Compare with {which}
                        </Button>
                      );
                    })()}
                  </footer>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
