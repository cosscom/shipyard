import { Switch } from "@/components/ui/switch";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { Segmented } from "@/views/settings/controls";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Labs: things being tried, on unless turned off.
export function LabsSection() {
  const labs = usePrefs((p) => p.labs);
  const agentView = usePrefs((p) => p.agentView);
  return (
    <SettingsPage title="Labs" description="Newer ideas to try. They may change or go away.">
      <SettingsGroup>
        <SettingsRow label="Harbour home and conversations" description="With no worktree open, start work from one box under the harbour. Agent panes get a Terminal | Conversation switch.">
          <Switch checked={labs} onCheckedChange={(on) => setPrefs({ labs: on, labsChosen: true })} />
        </SettingsRow>
        {labs && (
          <SettingsRow label="Open agents as" description="How the pane of an agent that runs in its terminal shows until you switch it. The conversation needs a box whose berthd streams transcripts. Agents in chat always open as their conversation.">
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
      </SettingsGroup>
    </SettingsPage>
  );
}
