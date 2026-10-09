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
          <SettingsRow
            label="Layout"
            description="Sidebar keeps your projects and places down the left. Command gives the whole window to the worktree: one line across the top says where you are and who needs you, and ⌘K, ⌘E and ⌘1–9 get you around."
          >
            <Segmented
              value={layout}
              options={[
                { value: "sidebar", label: "Sidebar" },
                { value: "command", label: "Command" },
              ]}
              onChange={(v) => setPrefs({ layout: v })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
