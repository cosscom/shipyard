import { invoke } from "@tauri-apps/api/core";
import { ChevronRightIcon, CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { endpoint, isTauri } from "@/lib/api";
import { useEventLog } from "@/lib/events";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { loadPlugins } from "@/plugins/host";
import { useRegistry } from "@/plugins/registry";
import { showOnboardingAgain } from "@/views/onboarding/onboarding-state";
import { appVersion } from "@/views/settings/app-version";
import { ConfirmButton } from "@/views/settings/confirm";
import { Code, SettingsGroup, SettingsPage, SettingsRow, Value } from "@/views/settings/rows";

// Everything here acts on this window's own storage. The agent, its files,
// ~/.berth and the boxes are never touched.

function berthKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith("berth.")) keys.push(k);
  }
  return keys;
}

function clear(keep: (key: string) => boolean = () => false, session = false) {
  try {
    for (const k of berthKeys(localStorage)) if (!keep(k)) localStorage.removeItem(k);
    if (session) sessionStorage.clear();
  } catch {
    // Storage that cannot be read holds nothing to reset.
  }
  location.reload();
}

function withQuery(params: Record<string, string> | null) {
  const url = new URL(location.href);
  for (const k of ["mock", "fresh"]) url.searchParams.delete(k);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  location.href = url.toString();
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toastManager.add({ title: `Copied ${what}`, type: "success" });
  } catch (err) {
    toastManager.add({ title: `Couldn't copy ${what}`, description: errorMessage(err), type: "error" });
  }
}

export function DeveloperSection() {
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  const [ep, setEp] = useState<{ url: string; token: string }>();
  const [reveal, setReveal] = useState(false);
  const mock = isMock();

  useEffect(() => {
    if (!mock) endpoint().then(setEp, () => {});
  }, [mock]);

  const diagnostics = async () => {
    const s = useStore.getState();
    return JSON.stringify(
      {
        app: { version: await appVersion(), tauri: isTauri(), mock, userAgent: navigator.userAgent, location: location.href.replace(/token=[^&]+/, "token=…") },
        connection: s.connection,
        status: s.status,
        boxes: Object.fromEntries(Object.entries(s.boxes).map(([name, b]) => [name, { info: b.info, error: b.error, locations: b.locations?.length, sessions: b.sessions?.map((x) => ({ name: x.name, agent: x.agent, state: x.agent_state, exited: x.exited })) }])),
        plugins: useRegistry.getState().plugins,
        events: useEventLog.getState().events.slice(0, 50),
      },
      null,
      2,
    );
  };

  return (
    <SettingsPage
      title="Developer"
      description="For working on Shipyard itself. Resets clear only this window's memory; your boxes stay as they are."
    >
      <SettingsGroup title="Reset">
        <SettingsRow label="Reset workspaces" description="Forget open tabs, splits and each worktree's layout. Sessions keep running on their boxes.">
          <ConfirmButton
            label="Reset tabs"
            title="Reset workspaces?"
            description="Open tabs and splits are forgotten and the window reloads. Every session keeps running on its box; reopen it from the sidebar."
            confirm="Reset and reload"
            onConfirm={() => clear((k) => k !== "berth.workspaces")}
          />
        </SettingsRow>
        <SettingsRow label="Reset preferences" description="Theme, terminal and notification settings, back to defaults. Tabs stay.">
          <ConfirmButton label="Reset settings" title="Reset preferences?" description="Theme, terminal and other settings go back to their defaults, and the window reloads." confirm="Reset and reload" onConfirm={() => clear((k) => k === "berth.workspaces")} />
        </SettingsRow>
        <SettingsRow label="Reset everything local" description={<>Every <Code>berth.*</Code> key in this window's storage, and its session storage.</>}>
          <ConfirmButton
            label="Reset all"
            destructive
            title="Reset everything local?"
            description="Tabs, layouts and preferences are forgotten and the window reloads as if new. Nothing changes on the agent or any box."
            confirm="Reset everything"
            onConfirm={() => clear(undefined, true)}
          />
        </SettingsRow>
        <SettingsRow label="Show onboarding again" description="In this window, until you finish or skip it, even though you have boxes. The next launch starts without it.">
          <Button
            size="xs"
            variant="outline"
            className="min-w-24"
            onClick={() => {
              showOnboardingAgain();
              useStore.getState().setView({ kind: "workspace" });
            }}
          >
            Show again
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Reload">
        <SettingsRow label="Reload plugins" description="Re-read ~/.berth/plugins and load them again.">
          <Button
            size="xs"
            variant="outline"
            className="min-w-24"
            onClick={async () => {
              const client = useStore.getState().client;
              if (client) await loadPlugins(client);
              toastManager.add({ title: "Plugins reloaded", type: "success" });
            }}
          >
            Reload plugins
          </Button>
        </SettingsRow>
        <SettingsRow label="Reload window">
          <Button size="xs" variant="outline" className="min-w-24" onClick={() => location.reload()}>
            Reload window
          </Button>
        </SettingsRow>
        {isTauri() && (
          <SettingsRow label="Developer tools" description="The Web Inspector for Shipyard's own window. A Browser tab's page has its own: Inspect in its toolbar.">
            <Button
              size="xs"
              variant="outline"
              className="min-w-24"
              onClick={() => invoke("open_devtools").catch((err) => toastManager.add({ title: "No developer tools", description: errorMessage(err), type: "error" }))}
            >
              Open tools
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Mock data">
        <SettingsRow label="Mock mode" description="Run the app on built-in sample boxes, without the agent.">
          <Button size="xs" variant="outline" className="min-w-24" onClick={() => withQuery(mock ? null : { mock: "1" })}>
            {mock ? "Turn mock off" : "Turn mock on"}
          </Button>
        </SettingsRow>
        <SettingsRow label="Fresh account preview" description="Mock mode with no boxes, to see onboarding.">
          <Button size="xs" variant="outline" className="min-w-24" onClick={() => withQuery({ mock: "1", fresh: "1" })}>
            Open preview
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Connection">
        <SettingsRow label="Agent" description={mock ? "Mock mode: no agent." : connection.state === "online" ? "Connected" : (connection.error ?? connection.state)}>
          <Value>{mock ? "mock" : (ep?.url ?? "127.0.0.1:1378")}</Value>
        </SettingsRow>
        {ep && (
          <SettingsRow label="Token" description="Anyone with it can drive your boxes from this computer. berth ui-token prints it too.">
            <button type="button" onClick={() => setReveal((r) => !r)} className="flex items-center gap-1.5 font-mono text-muted-foreground text-mono hover:text-foreground">
              {reveal ? ep.token : `${ep.token.slice(0, 4)}${"•".repeat(12)}`}
              {reveal ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </button>
            <Button size="icon-xs" variant="ghost" aria-label="Copy token" onClick={() => void copy(ep.token, "the token")}>
              <CopyIcon />
            </Button>
          </SettingsRow>
        )}
        <Collapsible className="py-3.5">
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-body">
            <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
            Agent status
            <span className="ml-auto text-muted-foreground text-meta">JSON</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-tag">{JSON.stringify(status, null, 2) ?? "No status yet."}</pre>
          </CollapsiblePanel>
        </Collapsible>
        <SettingsRow label="Diagnostics" description="Versions, connection, boxes, plugins and the last 50 events, as JSON for a bug report. The token is left out.">
          <Button size="xs" variant="outline" className="min-w-24" onClick={async () => void copy(await diagnostics(), "diagnostics")}>
            <CopyIcon /> Copy diagnostics
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
