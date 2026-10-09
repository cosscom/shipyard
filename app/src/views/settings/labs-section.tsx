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
          <SettingsRow label="Layout" description="Sidebar: places and projects down the left. Inbox: every agent in one list, what needs you on top, with the worktree you open beside it (j k to move, ↵ to open, e for done).">
            <Segmented
              value={layout}
              options={[
                { value: "sidebar", label: "Sidebar" },
                { value: "inbox", label: "Inbox" },
              ]}
              onChange={(v) => setPrefs({ layout: v })}
            />
          </SettingsRow>
        )}
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
      </SettingsGroup>
    </SettingsPage>
  );
}
