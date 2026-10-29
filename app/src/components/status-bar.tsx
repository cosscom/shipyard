import { CircleArrowUpIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { QueueIndicator } from "@/components/queue/queue-indicator";
import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { useUpdateAll } from "@/components/upgrade-box";
import { useAgentCounts } from "@/hooks/use-agent-counts";
import { isMock } from "@/hooks/use-berth-connection";
import { AGENT_WORDS } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { restartToUpdate, useAgentRestart, useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { PluginBoundary, pluginContexts } from "@/plugins/plugin-boundary";
import { TeamStatusItem } from "@/views/team/team-entry";
import { useRegistry } from "@/plugins/registry";
import { openRenameWorktree } from "@/components/sidebar/rename-worktree";
import { homeBox, useWorkspaces } from "@/lib/workspaces";
import { findWorktree } from "@/lib/worktree-names";

// StatusBar is the strip along the bottom, under the content's card, bare
// on the window (and the window's to drag, between its items): what agents
// are doing on the left, updates and forwards on the right. Every item goes
// somewhere when clicked. The boxes themselves are the sidebar's foot (BoxesFoot), whose
// tip says how each is and how busy.
export function StatusBar() {
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  // The agent restarting after an update (lib/updater.ts) is away a moment.
  const restarting = useAgentRestart((s) => s.restarting);
  const counts = useAgentCounts();
  const items = useRegistry((s) => s.statusBarItems);
  const [syncing, setSyncing] = useState(false);
  const go = useStore((s) => s.setView);

  const forwards = status?.forwards.length ?? 0;

  return (
    <footer data-tauri-drag-region className="@container flex h-6.5 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap px-3 text-tag text-muted-foreground">
      {/* ?shots=1, used by site/scripts/capture.mjs, hides the badge. */}
      {__BERTH_DEMO__ ? (
        !new URLSearchParams(location.search).has("shots") && <Tip label="A demo: invented boxes and repositories, and nothing runs">
          <span className="rounded border border-border px-1">demo</span>
        </Tip>
      ) : isMock() && !new URLSearchParams(location.search).has("shots") && (
        <Tip label="Showing made-up data (?mock=1)">
          <span className="rounded border border-warning/40 px-1 text-warning-foreground">mock</span>
        </Tip>
      )}
      {connection.state === "offline" && restarting ? (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" />
          Restarting the Shipyard agent…
        </span>
      ) : connection.state === "offline" ? (
        <Tip label={connection.error}>
          <span className="flex items-center gap-1.5 text-destructive">
            <span className="size-1.5 rounded-full bg-destructive" />
            Agent unreachable
          </span>
        </Tip>
      ) : (
        <>
          {counts.waiting > 0 && (
            <Item className="text-warning-foreground dark:text-warning" onClick={() => go({ kind: "dashboard" })} tip="Agents waiting for your answer or permission">
              <span className="size-1.5 rounded-full bg-warning" />
              {counts.waiting} {AGENT_WORDS["needs-you"].lower}
            </Item>
          )}
          <Item onClick={() => go({ kind: "dashboard" })} tip="Open the agent dashboard">
            {counts.running} {AGENT_WORDS.working.lower}
          </Item>
        </>
      )}
      <WorktreeItem />
      <TeamStatusItem />
      <QueueIndicator />
      {items
        .filter((i) => i.item.align !== "right")
        .map(({ plugin, item }) => (
          <PluginBoundary key={`${plugin}:${item.id}`} plugin={plugin} inline>
            <item.Component berth={pluginContexts.get(plugin)!} />
          </PluginBoundary>
        ))}

      <div data-tauri-drag-region className="flex-1 self-stretch" />

      {items
        .filter((i) => i.item.align === "right")
        .map(({ plugin, item }) => (
          <PluginBoundary key={`${plugin}:${item.id}`} plugin={plugin} inline>
            <item.Component berth={pluginContexts.get(plugin)!} />
          </PluginBoundary>
        ))}
      <UpdateItem />
      <OutdatedItem />
      {forwards > 0 && (
        <Item tip="Ports forwarded to this computer" onClick={() => go({ kind: "settings", section: "developer" })}>
          {forwards} {forwards === 1 ? "forward" : "forwards"}
        </Item>
      )}
      <Tip label="Refresh" align="end">
        <button
          type="button"
          aria-label="Refresh"
          className="hover:text-foreground"
          onClick={async () => {
            setSyncing(true);
            await useStore.getState().refreshAll();
            setSyncing(false);
          }}
        >
          <RefreshCwIcon className={cn("size-3", syncing && "animate-spin")} />
        </button>
      </Tip>
    </footer>
  );
}

// WorktreeItem names the worktree in front, by its display name when it
// has one, and renames it when clicked.
function WorktreeItem() {
  const at = useWorkspaces((s) => (s.current && !homeBox(s.current) ? s.spaces[s.current]?.ref : undefined));
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const boxes = useStore((s) => s.boxes);
  const found = at?.path ? findWorktree(at.box, at.path, boxes) : undefined;
  if (!inWorkspace || !at || !found) return null;
  const { loc, wt } = found;
  const title = wt.title?.trim();
  const own = [wt.name, wt.branch && wt.branch !== wt.name ? `branch ${wt.branch}` : undefined].filter(Boolean).join(" · ");
  if (wt.main) return null;
  return (
    <Item
      data-testid="status-worktree"
      className="min-w-0 @max-[700px]:hidden"
      tip={
        <span className="flex flex-col">
          {title ? `${title} · ${own}` : own}
          <span className="text-muted-foreground">Click to rename it (F2 in the sidebar)</span>
        </span>
      }
      onClick={() => openRenameWorktree(at.box, loc, wt, { inPlace: false })}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="max-w-56 truncate">{title || wt.name}</span>
    </Item>
  );
}

// UpdateItem shows once a newer Shipyard is downloaded, and restarts into it
// when clicked. Checking and downloading stay out of sight.
function UpdateItem() {
  const update = useUpdater();
  if (update.status !== "ready" && update.status !== "installing") return null;
  const installing = update.status === "installing";
  return (
    <Item
      className="text-foreground"
      disabled={installing}
      tip={`Shipyard ${update.version} is downloaded. Restarting reopens this window; agents keep running on their boxes.`}
      onClick={() => void restartToUpdate()}
    >
      <CircleArrowUpIcon className="size-3 text-success" />
      {installing ? "Updating…" : "Restart to update"}
    </Item>
  );
}

// OutdatedItem is the calm notice that boxes run an older berthd, with
// Update all in one click and its progress while it runs. Settings → Boxes
// says the same, with each box's output.
function OutdatedItem() {
  const { outdated, busy, running, progress, updateAll } = useUpdateAll();
  if (!outdated.length && !busy) return null;
  if (busy) {
    return (
      <Item className="text-foreground" tip="Agents keep running while a box updates. Settings → Boxes shows each box's output." onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })}>
        <Spinner className="size-3" />
        Updating {running ?? "boxes"}… {progress && <span className="text-muted-foreground tabular-nums">{progress}</span>}
      </Item>
    );
  }
  const n = outdated.length;
  return (
    <span className="flex items-center gap-1.5">
      <Item tip={`${outdated.join(", ")} ${n === 1 ? "runs" : "run"} an older berthd than this Shipyard ships.`} onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })}>
        <CircleArrowUpIcon className="size-3 text-info" />
        {n === 1 ? `${outdated[0]} runs` : `${n} boxes run`} an older berthd
      </Item>
      <span aria-hidden className="text-muted-foreground/60">—</span>
      <Item className="font-medium text-foreground" tip="Updates each box in turn; agents keep running" onClick={updateAll}>
        {n === 1 ? "Update" : "Update all"}
      </Item>
    </span>
  );
}

// Item is one clickable entry, with what it means in a tooltip.
function Item({ className, tip, ...props }: React.ComponentProps<"button"> & { tip?: React.ReactNode }) {
  return (
    <Tip label={tip}>
      <button type="button" className={cn("flex items-center gap-1.5 rounded px-1 -mx-1 hover:bg-accent hover:text-foreground", className)} {...props} />
    </Tip>
  );
}
