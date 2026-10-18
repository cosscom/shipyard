import { PuzzleIcon } from "lucide-react";

import { useWorktreeRef } from "@/lib/workspaces";
import { PluginBoundary, pluginContexts } from "@/plugins/plugin-boundary";
import { useRegistry } from "@/plugins/registry";
import { Icon } from "@/plugins/ui";

// PanelIcon is the icon a plugin gave its panel, for tabs and pane headers.
export function PanelIcon({ plugin, panel, className }: { plugin: string; panel: string; className?: string }) {
  const icon = useRegistry((s) => s.worktreePanels.find((c) => c.plugin === plugin && c.item.id === panel)?.item.icon);
  return icon ? <Icon name={icon} className={className} /> : <PuzzleIcon className={className} />;
}

// PanelPane shows a plugin's worktree panel for the pane's worktree
// (paneWorktree: its own, else its tab's), given as wsKey. It waits quietly while plugins load, and says so when the
// plugin that added the panel is gone or turned off.
export function PanelPane({ wsKey, plugin, panel }: { wsKey: string; plugin: string; panel: string }) {
  const ref = useWorktreeRef(wsKey);
  const entry = useRegistry((s) => s.worktreePanels.find((c) => c.plugin === plugin && c.item.id === panel));
  const status = useRegistry((s) => s.plugins.find((p) => p.id === plugin));
  const ctx = pluginContexts.get(plugin);

  if (!entry || !ctx || !ref) {
    const text =
      !status || status.state === "loading"
        ? "Loading…"
        : status.state === "failed"
          ? `${status.name} failed to load: ${status.error ?? "unknown error"}`
          : entry && ctx
            ? "Its worktree is no longer on its box."
            : "This panel's plugin is turned off.";
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-body">
        <PuzzleIcon className="size-4" />
        {text}
      </div>
    );
  }
  const { Component } = entry.item;
  return (
    <div data-testid="panel" data-panel={`${plugin}/${panel}`} className="min-h-0 flex-1 overflow-auto">
      <PluginBoundary plugin={plugin}>
        <Component berth={ctx} box={ref.box} location={ref.location} worktree={ref.worktree} path={ref.path} main={ref.main} />
      </PluginBoundary>
    </div>
  );
}
