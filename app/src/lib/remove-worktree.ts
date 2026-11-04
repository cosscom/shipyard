import { toastError } from "@/components/error-note";
import { toastManager } from "@/components/ui/toast";
import type { Client } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { errorMessage } from "@/lib/format";
import { finishJob, setItem, startJob } from "@/lib/jobs";
import { keptReason } from "@/lib/kept-reason";
import { unpinWorktree } from "@/lib/pinned-worktrees";
import { archivedMessage, clearRemoving, inTurn, KEPT_DIRTY, markRemoving, markScript, pruneRemovals, type RemovalKind, removalKey, removalOf, removeResult, unmarked, useRemovals } from "@/lib/removing";
import { followStopRun } from "@/lib/stop-job";
import { startStopOnBox, stopRuns } from "@/lib/stop-on-box";
import { scheduleRefresh, useStore } from "@/lib/store";
import { forgetWorktree } from "@/lib/workspaces";
import { worktreesApi } from "@/lib/worktrees";

// How the removals sent with an archive script ended, by removalKey, from
// before they're sent: worktreeGone and archiveFailed say, as they drop the
// mark, for archiveEnded to read.
const waiting = new Map<string, "gone" | "failed" | undefined>();

// removeWorktreeOnBox asks the box to remove (or archive) a worktree and
// follows it through. A plain removal is done when the answer comes; with an
// archive script the box answers at once and runs it in the background, so
// the worktree is marked (lib/removing.ts) until worktree.removed or
// worktree.archive.failed arrives (lib/events.ts calls worktreeGone or
// archiveFailed). Every entry point goes through here: the sidebar's ⋯ and
// right-click, zen, the launcher and the Worktrees table.
export async function removeWorktreeOnBox(
  client: Client,
  box: string,
  location: string,
  wt: { name: string; path: string },
  kind: RemovalKind,
  opts: { force?: boolean; branch?: boolean } = {},
): Promise<{ archive?: string }> {
  markRemoving(box, wt.path, kind, wt.name);
  // Noted before it's sent: a script that fails fast can be reported
  // before the answer comes (archiveEnded).
  const key = removalKey(box, wt.path);
  waiting.set(key, undefined);
  let res: { archive?: string };
  try {
    res = removeResult(await worktreesApi.remove(client, box, location, wt.name, opts));
  } catch (err) {
    waiting.delete(key);
    clearRemoving(box, wt.path);
    throw err;
  }
  if (res.archive) markScript(box, wt.path);
  else {
    waiting.delete(key);
    clearRemoving(box, wt.path);
    forgetWorktree(box, wt.path);
    unpinWorktree(box, wt.path);
  }
  scheduleRefresh(box, ["locations", "sessions", "services"]);
  return res;
}

// queueRemoval removes or archives a worktree in the background: it is
// marked "Removing…" or "Archiving…" at once, so whatever asked (archive's
// dialog) can close, and goes when its box gets to it, one at a time per
// box. Its branch stays, and git still refuses to lose uncommitted work:
// then a toast says so, and a removal's offers to remove it anyway. An
// archive is a one-row job in the background-jobs tray (lib/jobs.ts) too,
// until the worktree is gone or kept. On a box with runs an archive is the
// box's to do (archiveOnBox); elsewhere the app sends it in the box's line
// (inTurn), which it holds until the box says the worktree went.
export function queueRemoval(box: string, location: string, wt: Leaving, opts: { kind?: RemovalKind; force?: boolean } = {}) {
  const kind = opts.kind ?? "remove";
  if (removalOf(useRemovals.getState().byKey, box, wt.path)) return;
  markRemoving(box, wt.path, kind, wt.name);
  const job = kind === "archive" ? archiveJob(box, wt) : undefined;
  if (job && !opts.force && stopRuns.onBox(box)) return void archiveOnBox(box, location, wt, job);
  void inTurn(box, () => send(box, location, wt, kind, opts.force, job));
}

const KEY = "worktree";

function archiveJob(box: string, wt: Leaving) {
  const id = startJob({ title: `Archiving ${wt.name}`, items: [{ key: KEY, group: box, label: wt.name, aside: wt.branch, message: `Waiting for ${box}` }] });
  const end = (item: Parameters<typeof setItem>[2], summary: string) => {
    setItem(id, KEY, item);
    finishJob(id, summary);
  };
  return {
    waiting: () => setItem(id, KEY, { message: `Waiting for ${box}` }),
    sent: () => setItem(id, KEY, { state: "running", message: "Archiving…" }),
    scripted: () => setItem(id, KEY, { state: "running", message: archivedMessage({ archive: "yes" }) }),
    done: () => end({ state: "done", message: archivedMessage({}) }, `Archived ${wt.name}`),
    kept: (why = KEPT_DIRTY) => end({ state: "kept", message: why }, `Kept ${wt.name}`),
    failed: (why: string) => end({ state: "failed", message: `Couldn't archive: ${why}` }, `Couldn't archive ${wt.name}`),
  };
}

type Leaving = { name: string; path: string; branch?: string };

// archiveEnded resolves once the box says how an archive whose script runs
// (removeWorktreeOnBox answered 202) ended: gone, failed, or undefined when
// its mark went some other way (the box stopped listing it, or it went
// stale).
export async function archiveEnded(box: string, path: string): Promise<"gone" | "failed" | undefined> {
  const key = removalKey(box, path);
  await unmarked(box, path);
  const how = waiting.get(key);
  waiting.delete(key);
  return how;
}

async function send(box: string, location: string, wt: Leaving, kind: RemovalKind, force?: boolean, job?: ReturnType<typeof archiveJob>) {
  try {
    const client = useStore.getState().client;
    if (!client) throw new Error("not connected");
    job?.sent();
    const res = await removeWorktreeOnBox(client, box, location, wt, kind, { force });
    if (kind === "archive" && res.archive) toastManager.add({ title: `Archiving ${wt.name}`, description: "Its archive script is running on the box; the worktree goes when it finishes.", type: "info" });
    else if (kind === "archive") toastManager.add({ title: `Archived ${wt.name}`, description: wt.branch ? `Branch ${wt.branch} is kept.` : box, type: "success" });
    if (!res.archive) return job?.done();
    // The script runs on the box: this box's turn, and the tray's row, last
    // until it says the worktree went or archiving failed.
    job?.scripted();
    if ((await archiveEnded(box, wt.path)) === "failed") job?.failed("its archive script failed, so it was left as it was");
    else job?.done();
  } catch (err) {
    clearRemoving(box, wt.path);
    const why = force ? null : keptReason(errorMessage(err));
    if (why) {
      job?.kept();
      if (kind === "archive") {
        toastManager.add({
          type: "warning",
          title: `Couldn't archive ${wt.name}`,
          description: `${wt.name} has uncommitted changes, so it was left as it is. Commit them first, or use Remove worktree to discard them.`,
        });
      } else {
        toastManager.add({
          type: "warning",
          title: `Kept ${wt.name}`,
          description: why,
          actionProps: { children: "Remove anyway", onClick: () => queueRemoval(box, location, wt, { force: true }) },
        });
      }
    } else {
      job?.failed(plainError(err));
      toastError(err, { title: `Couldn't ${kind} ${wt.name}`, box });
    }
  }
}

// archiveOnBox has a box with runs archive the worktree as a one-worktree
// stop run (lib/stop-job.ts): its sessions stop first, as archiving always
// ended them, then it's archived where it's safe, in the box's own line with
// every other archive there (archiveTurn in internal/box/api.go). The box
// finishes it while the laptop sleeps or the app is closed; the tray's row
// follows it until the worktree is gone or kept. A box that refuses the run
// (from before stop runs) gets the app's way.
async function archiveOnBox(box: string, location: string, wt: Leaving, job: ReturnType<typeof archiveJob>) {
  const sessions = (useStore.getState().boxes[box]?.sessions ?? []).filter((s) => !s.exited && (s.dir === wt.path || s.dir.startsWith(`${wt.path}/`))).map((s) => s.name);
  const started = await startStopOnBox(box, `Archive ${wt.name}`, { sessions, worktrees: [{ location, name: wt.name, path: wt.path, sessions }] }, { waiting: job.waiting });
  if (typeof started === "string") return void inTurn(box, () => send(box, location, wt, "archive", false, job));
  job.sent();
  const read = await followStopRun(stopRuns, box, started.id, {
    onRead: (r) => {
      if (r.worktrees[wt.path] === "archiving") markScript(box, wt.path);
    },
  });
  scheduleRefresh(box, ["locations", "sessions", "services"]);
  const outcome = read?.worktrees[wt.path];
  const said = read?.said[wt.path] ?? "";
  if (outcome === "archived" || outcome === "archiving") {
    if (outcome === "archived") worktreeGone(box, wt.path);
    job.done();
    toastManager.add({ title: `Archived ${wt.name}`, description: wt.branch ? `Branch ${wt.branch} is kept.` : box, type: "success" });
    return;
  }
  clearRemoving(box, wt.path);
  if (outcome === "kept") {
    job.kept(said);
    toastManager.add({
      type: "warning",
      title: `Couldn't archive ${wt.name}`,
      description: said === KEPT_DIRTY ? `${wt.name} has uncommitted changes, so it was left as it is. Commit them first, or use Remove worktree to discard them.` : `${said.replace(/^Kept: /, "")}, so it was left as it is.`,
    });
    return;
  }
  // No word on the worktree: the box lost the run, or an agent there
  // didn't stop (its row says why).
  const why = !read ? `${box} no longer has the run` : outcome ? said.replace(/^Couldn't archive: /, "") : (Object.values(read.rows).find((x) => x.state === "failed")?.message?.replace(/^Failed: /, "") ?? "it wasn't archived");
  job.failed(why);
  toastManager.add({ type: "error", title: `Couldn't archive ${wt.name}`, description: why });
}

// worktreeGone is the box saying a worktree went: its workspace (tabs,
// panes) and its pin go too, and an archive the app was waiting on says it
// is done. A failed archive keeps both (archiveFailed).
export function worktreeGone(box: string, path: string) {
  if (waiting.has(removalKey(box, path))) waiting.set(removalKey(box, path), "gone");
  const was = clearRemoving(box, path);
  forgetWorktree(box, path);
  unpinWorktree(box, path);
  if (was?.script) toastManager.add({ type: "success", title: `${was.kind === "archive" ? "Archived" : "Removed"} ${was.name ?? "the worktree"}`, description: box });
}

// archiveFailed puts the worktree back as it was; the failure itself is a
// notification of its own (lib/events.ts), with the script's output.
export function archiveFailed(box: string, path: string) {
  if (waiting.has(removalKey(box, path))) waiting.set(removalKey(box, path), "failed");
  clearRemoving(box, path);
}

// A mark for a worktree a box no longer lists is dropped, in case its event
// was missed (the app was closed, the stream dropped).
useStore.subscribe((s, prev) => {
  if (s.boxes === prev.boxes || !Object.keys(useRemovals.getState().byKey).length) return;
  for (const [name, data] of Object.entries(s.boxes)) {
    if (!data?.locations || data.locations === prev.boxes[name]?.locations) continue;
    pruneRemovals(name, new Set(data.locations.flatMap((l) => (l.worktrees ?? []).map((w) => w.path))));
  }
});
