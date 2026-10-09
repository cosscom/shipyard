import { Switch } from "@/components/ui/switch";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { Segmented } from "@/views/settings/controls";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Labs: things being tried, on unless turned off.
export function LabsSection() {
  const labs = usePrefs((p) => p.labs);
  const agentView = usePrefs((p) => p.agentView);
  const layout = usePrefs((p) => p.layout);
  return (
    <SettingsPage title="Labs" description="Newer ideas, on by default. They may change or go away.">
      <SettingsGroup>
        <SettingsRow label="Harbour home and conversations" description="With no worktree open, start work from one box under the harbour. Agent panes get a Terminal | Conversation switch.">
          <Switch checked={labs} onCheckedChange={(on) => setPrefs({ labs: on, labsChosen: true })} />
        </SettingsRow>
        {labs && (
          <SettingsRow label="Open agents as" description="How an agent's pane shows until you switch it. The conversation needs a box whose berthd streams transcripts.">
            <Segmented
              value={agentView}
              options={[
                { value: "terminal", label: "Terminal" },
                { value: "conversation", label: "Conversation" },
              ]}
              onChange={(v) => setPrefs({ agentView: v })}
            />
          </SettingsRow>
        )}
        {labs && (
          <SettingsRow label="Layout" description="Sidebar: projects down the side, a worktree's tabs across the top. Workspaces: no sidebar; named workspaces of agent panes side by side, every other agent in a strip along the bottom.">
            <Segmented
              value={layout}
              options={[
                { value: "sidebar", label: "Sidebar" },
                { value: "workspace", label: "Workspaces" },
              ]}
              onChange={(v) => setPrefs({ layout: v })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
