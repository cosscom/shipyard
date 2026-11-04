import { AlertTriangleIcon, BrushCleaningIcon, EllipsisIcon, ListChecksIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { create } from "zustand";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { sessionWord } from "@/lib/state-model";
import { PickOne } from "@/components/pick-one";
import { removeWorktree } from "@/components/sidebar/actions";
import { confirm } from "@/components/sidebar/confirm";
import { Tip } from "@/components/tip";
import { AlertDialog, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import type { SessionEntry } from "@/hooks/use-agent-counts";
import { boxApi } from "@/lib/api";
import { agentOf, type SessionState } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { archiveEnded, removeWorktreeOnBox } from "@/lib/remove-worktree";
import { load, save } from "@/lib/storage";
import { scheduleRefresh, useStore } from "@/lib/store";
import { runStopJob } from "@/lib/stop-job";
import { stopRuns } from "@/lib/stop-on-box";
import { cn } from "@/lib/utils";
import { duration } from "@/views/dashboard/agent-card";
import { type AgentNames, describeAgent, startedAt } from "@/views/dashboard/names";

// Stopping agents from the board: one from its card, the picked ones, a
// column, or the ones that have sat idle. Stopping ends the agent's session
// on its box; its worktree and files stay, so another agent can pick up
// there. Nothing working or waiting on you is stopped unless you picked it.
// The bulk dialog can also archive their worktrees after, where it's safe.

export const entryKey = (e: SessionEntry) => `${e.box}/${e.session.name}`;
const sinceOf = (e: SessionEntry) => new Date(e.session.state_since ?? e.session.created).getTime();

// Busy agents: stopping one loses the turn it is in.
const busy = (s: SessionState) => s === "running" || s === "waiting";

// stopOne ends one session and drops it from the board straight away; the
// box's next listing confirms it.
async function stopOne(box: string, name: string) {
  const client = useStore.getState().client;
  if (!client) throw new Error("Not connected to the laptop agent");
  await boxApi.stopSession(client, box, name);
  useStore.setState((s) => {
    const d = s.boxes[box];
    return d ? { boxes: { ...s.boxes, [box]: { ...d, sessions: d.sessions?.filter((x) => x.name !== name) } } } : {};
  });
  scheduleRefresh(box, ["sessions"]);
}

// stopInBackground stops the confirmed rows as a job in the tray
// (lib/stop-job.ts), archiving their worktrees where it's safe if asked: a
// box with runs does its share itself. A clean run ends with the toast it
// always had.
async function stopInBackground(rows: Row[], archive: boolean) {
  const res = await runStopJob(
    rows.map((r) => ({
      key: r.key,
      box: r.entry.box,
      session: r.entry.session.name,
      label: r.names.place,
      aside: r.names.crowded ? r.names.name : undefined,
      where: r.names.where && { location: r.names.where.location.name, worktree: r.names.where.worktree },
    })),
    archive,
    {
      stop: stopOne,
      liveAgents: async (box) => {
        const client = useStore.getState().client;
        const sessions = client ? await boxApi.sessions(client, box) : undefined;
        return sessions?.filter((s) => !s.exited && agentOf(s)).map((s) => ({ dir: s.dir, name: s.name }));
      },
      archive: (box, location, wt) => {
        const client = useStore.getState().client;
        if (!client) throw new Error("Not connected to the laptop agent");
        return removeWorktreeOnBox(client, box, location, wt, "archive");
      },
      settled: archiveEnded,
      errorText: plainError,
      runs: stopRuns,
    },
  );
  if (!res.clean) return;
  const outcomes = Object.values(res.worktrees);
  const gone = outcomes.length;
  const boxes = [...new Set(rows.map((r) => r.entry.box))].map((b) => `${rows.filter((r) => r.entry.box === b).length} on ${b}`);
  toastManager.add({
    title: `Stopped ${plural(rows.length, "agent")}${gone ? ` · ${outcomes.includes("archiving") ? "archiving" : "archived"} ${plural(gone, "worktree")}` : ""}`,
    description: `${boxes.join(", ")}. ${gone ? "Their branches are kept." : "Their worktrees are kept."}`,
    type: "success",
  });
}

function namesOf(e: SessionEntry): AgentNames {
  const d = useStore.getState().boxes[e.box];
  return describeAgent(e.session, d?.sessions, d?.locations);
}

// "shop / checkout-fix", or "shop" for the main checkout.
const atOf = (n: AgentNames) => (n.where ? (n.where.worktree.main ? n.where.location.name : `${n.where.location.name} / ${n.where.worktree.name}`) : n.place);

// confirmStop asks before stopping one agent, naming it and where it runs.
export function confirmStop(e: SessionEntry) {
  const n = namesOf(e);
  const at = atOf(n);
  confirm({
    title: `Stop ${n.name} in ${n.place}?`,
    description: `Its session in ${at} on ${e.box} ends${busy(e.state) ? `, along with the turn it is ${e.state === "waiting" ? "waiting on you in" : "in the middle of"}` : ""}. The worktree and its files are kept, so you can start another agent there.`,
    detail: (
      <>
        {e.box} · {at}
        <br />
        {n.where?.worktree.branch && (
          <>
            <span className="text-muted-foreground">branch {n.where.worktree.branch}</span>
            <br />
          </>
        )}
        <span className="text-muted-foreground">
          {e.session.name} · started {startedAt(e.session.created)}
        </span>
      </>
    ),
    confirm: "Stop agent",
    destructive: true,
    run: async () => {
      await stopOne(e.box, e.session.name);
      toastManager.add({ title: `Stopped ${n.name}`, description: `${at} on ${e.box}. Its worktree is kept.`, type: "success" });
    },
  });
}

// StopMenuItems go at the end of a card's ⋯ menu.
export function StopMenuItems({ entry }: { entry: SessionEntry }) {
  const where = namesOf(entry).where;
  const others = (useStore.getState().boxes[entry.box]?.sessions ?? []).filter((s) => s.dir === entry.session.dir && !s.exited && s.name !== entry.session.name).length;
  return (
    <>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => confirmStop(entry)}>
        <SquareIcon />
        Stop agent…
      </MenuItem>
      {where && !where.worktree.main && (
        // The sidebar's own removal, with its checks: git refuses to lose
        // uncommitted work unless told to.
        <MenuItem variant="destructive" onClick={() => removeWorktree(entry.box, where.location, where.worktree)}>
          <Trash2Icon />
          <span className="flex-1">Stop and remove worktree</span>
          {others > 0 && <span className="text-muted-foreground text-meta">+{others} more</span>}
        </MenuItem>
      )}
    </>
  );
}

// The bulk dialog: "stop" for picked agents or a column, "cleanup" for the
// idle ones in Done and Ready.
interface StopRequest {
  kind: "stop" | "cleanup";
  entries: SessionEntry[];
  // The column it came from, for the title.
  column?: string;
  id: number;
}

const useStopDialog = create<{ req?: StopRequest }>()(() => ({}));
let nextId = 0;

export const openStop = (req: Omit<StopRequest, "id">) => req.entries.length > 0 && useStopDialog.setState({ req: { ...req, id: ++nextId } });

type After = "1h" | "4h" | "1d";
const AFTER: { value: After; label: string; ms: number }[] = [
  { value: "1h", label: "1 hour", ms: 3_600_000 },
  { value: "4h", label: "4 hours", ms: 4 * 3_600_000 },
  { value: "1d", label: "1 day", ms: 86_400_000 },
];

// StopDialog is the host; the dashboard renders it once. It only asks:
// once confirmed it closes, and the stopping goes on in the tray.
export function StopDialog() {
  const req = useStopDialog((s) => s.req);
  const close = () => useStopDialog.setState({ req: undefined });
  return (
    <AlertDialog open={!!req} onOpenChange={(o) => !o && close()}>
      {req && <Body key={req.id} req={req} onClose={close} />}
    </AlertDialog>
  );
}

interface Row {
  entry: SessionEntry;
  key: string;
  names: AgentNames;
  idle: number;
}

function Body({ req, onClose }: { req: StopRequest; onClose(): void }) {
  const cleanup = req.kind === "cleanup";
  // Names are taken when the dialog opens: they renumber as agents stop.
  const [rows] = useState<Row[]>(() => {
    const now = Date.now();
    return req.entries.map((entry) => ({ entry, key: entryKey(entry), names: namesOf(entry), idle: now - sinceOf(entry) })).sort((a, b) => b.idle - a.idle);
  });
  const [after, setAfter] = useState<After>(() => load("berth.dashboard.cleanupAfter", "4h"));
  // A parked agent (turn check read it as waiting on a reply or a later
  // time) is idle on purpose: it is listed, never ticked for you.
  const overFor = (a: After) => new Set(rows.filter((r) => !r.entry.session.parked && r.idle > AFTER.find((x) => x.value === a)!.ms).map((r) => r.key));
  const [ticked, setTicked] = useState<Set<string>>(() => (cleanup ? overFor(after) : new Set(rows.map((r) => r.key))));
  const [archive, setArchive] = useState(() => load("berth.dashboard.stopArchives", false));
  const cancel = useRef<HTMLButtonElement>(null);

  const chosen = rows.filter((r) => ticked.has(r.key));
  const busyCount = chosen.filter((r) => busy(r.entry.state)).length;
  // The box shows only when there is a worktree to archive.
  const canArchive = chosen.some((r) => r.names.where && !r.names.where.worktree.main);
  const archiving = archive && canArchive;
  const boxes = [...new Set(rows.map((r) => r.entry.box))].sort();
  const toggle = (key: string, on: boolean) =>
    setTicked((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const run = () => {
    onClose();
    void stopInBackground(chosen, archiving);
  };

  const title = cleanup
    ? "Clean up idle agents"
    : req.column
      ? `Stop ${chosen.length === rows.length ? "all " : ""}${plural(chosen.length, "agent")} in ${req.column}?`
      : `Stop ${plural(chosen.length, "agent")}?`;
  const description = cleanup
    ? `Stops agents in Done and Ready that have sat idle for a while. Working agents and ones waiting on you are left alone. ${archiving ? "Their worktrees are archived where it's safe; branches are kept." : "Worktrees and their files are kept."}`
    : `Each one's session ends on its box; ${archiving ? "then its worktree is archived where it's safe, and its branch is kept." : "its worktree and files are kept."}${busyCount ? ` ${busyCount === 1 ? "One is" : `${busyCount} are`} still working or waiting on you, and ${busyCount === 1 ? "its turn ends" : "their turns end"} too.` : ""}`;

  return (
    // The keyboard starts on Cancel: Enter right after ⌫ or a menu item must
    // never stop agents mid-turn.
    <AlertDialogPopup className="sm:max-w-lg" initialFocus={cancel}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>

      {cleanup && (
        <div className="mx-6 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-body">
          <span className="text-muted-foreground">Idle longer than</span>
          <PickOne
            label="Idle longer than"
            value={after}
            options={AFTER}
            onChange={(a) => {
              setAfter(a);
              save("berth.dashboard.cleanupAfter", a);
              setTicked(overFor(a));
            }}
          />
        </div>
      )}

      <div className="mx-6 max-h-72 overflow-y-auto rounded-lg border" role="group" aria-label="Agents to stop">
        {rows.length === 0 && <p className="px-3 py-4 text-center text-muted-foreground text-meta">Nothing in Done or Ready.</p>}
        {boxes.map((box) => {
          const group = rows.filter((r) => r.entry.box === box);
          return (
            <div key={box}>
              <div className="sticky top-0 z-1 flex items-center gap-2 border-b bg-muted/80 px-3 py-1 font-mono text-meta text-muted-foreground backdrop-blur-sm">
                <span className="flex-1">{box}</span>
                <span className="tabular-nums">
                  {group.filter((r) => ticked.has(r.key)).length}/{group.length}
                </span>
              </div>
              <ul className="divide-y divide-border/60">
                {group.map((r) => (
                  <StopRow key={r.key} row={r} ticked={ticked.has(r.key)} cleanup={cleanup} onToggle={(on) => toggle(r.key, on)} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {cleanup && rows.length > 0 && (
        <p className="mx-6 mt-2 text-muted-foreground text-meta">
          {chosen.length ? `${plural(chosen.length, "agent")} of ${rows.length} picked.` : `None idle that long.`} Tick or untick any of them.
        </p>
      )}

      {canArchive && (
        <label className="mx-6 mt-3 flex cursor-pointer items-start gap-2.5 text-body">
          <Checkbox
            className="mt-0.5"
            checked={archive}
            onCheckedChange={(v) => {
              setArchive(v === true);
              save("berth.dashboard.stopArchives", v === true);
            }}
          />
          <span>
            Archive their worktrees where it's safe
            <span className="block text-muted-foreground text-meta">The archive script runs and branches are kept. One with uncommitted changes, or another agent still in it, stays as it is.</span>
          </span>
        </label>
      )}

      <AlertDialogFooter>
        <Button ref={cancel} variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={!chosen.length} onClick={run}>
          <SquareIcon />
          {chosen.length ? `Stop ${plural(chosen.length, "agent")}` : "Stop agents"}
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}

function StopRow({ row, ticked, cleanup, onToggle }: { row: Row; ticked: boolean; cleanup: boolean; onToggle(on: boolean): void }) {
  const { entry, names } = row;
  const state = entry.state;
  return (
    <li>
      <label className={cn("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-body hover:bg-accent/50", !ticked && "text-muted-foreground")}>
        <span className="flex w-4 shrink-0 justify-center">
          <Checkbox checked={ticked} onCheckedChange={(v) => onToggle(!!v)} aria-label={`Stop ${names.name} in ${names.place}`} />
        </span>
        <AgentIcon agent={agentOf(entry.session)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{names.place}</span>
            {names.crowded && <span className="shrink-0 text-muted-foreground text-meta">{names.name}</span>}
          </span>
          <span className="block truncate text-meta text-muted-foreground">
            {[entry.session.parked && "parked", names.where?.location.name, names.crowded && `started ${startedAt(entry.session.created)}`, names.where?.worktree.branch].filter(Boolean).join(" · ")}
          </span>
        </span>
        {busy(state) && !cleanup ? (
          <span className="flex shrink-0 items-center gap-1 text-meta text-warning-foreground">
            <AlertTriangleIcon className="size-3" />
            {state === "waiting" ? "needs you" : "working"}
          </span>
        ) : (
          <Tip label={`${sessionWord(state)} for ${duration(row.idle)}`}>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-meta text-muted-foreground tabular-nums">
              <StateGlyph state={state} />
              {duration(row.idle)}
            </span>
          </Tip>
        )}
      </label>
    </li>
  );
}

// ColumnMenu is a column header's ⋯: pick the column's agents, stop them
// all, or clean up the idle ones (from Done and Ready).
export function ColumnMenu({ title, items, cleanup, onPick }: { title: string; items: SessionEntry[]; cleanup?: SessionEntry[]; onPick(): void }) {
  return (
    <Menu>
      <Tip label={`${title}: actions`}>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`${title} column actions`}
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
      </Tip>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem onClick={onPick}>
          <ListChecksIcon />
          Select all {items.length}
        </MenuItem>
        {cleanup && (
          <MenuItem disabled={!cleanup.length} onClick={() => openStop({ kind: "cleanup", entries: cleanup })}>
            <BrushCleaningIcon />
            Clean up idle agents…
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => openStop({ kind: "stop", entries: items, column: title })}>
          <SquareIcon />
          Stop all {items.length} in {title}…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
