import { Switch } from "@/components/ui/switch";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { Segmented } from "@/views/settings/controls";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Labs: things being tried, on unless turned off.
export function LabsSection() {
  const labs = usePrefs((p) => p.labs);
  const agentView = usePrefs((p) => p.agentView);
  const structured = usePrefs((p) => p.structuredClaude);
  const approvals = usePrefs((p) => p.approvals);
  const columns = usePrefs((p) => p.sidebarLayout === "columns");
  return (
    <SettingsPage title="Labs" description="Newer ideas to try. They may change or go away.">
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
            label="Structured agents"
            description="New Claude Code, Codex, OpenCode, Gemini CLI, Cursor Agent and oh-my-pi agents run without their terminal: the box drives them through their own protocol (Claude Code's stream, Codex's app server, ACP for the rest) and keeps its own record. They open as conversations; Claude Code's own terminal is one switch away."
          >
            <Switch checked={structured} onCheckedChange={(on) => setPrefs({ structuredClaude: on })} />
          </SettingsRow>
        )}
        {labs && structured && (
          <SettingsRow label="Permissions" description="Bypass lets the box allow what a structured agent asks to do; its questions and plans still come to you. Ask brings every permission to you.">
            <Segmented
              value={approvals}
              options={[
                { value: "bypass", label: "Bypass" },
                { value: "ask", label: "Ask" },
              ]}
              onChange={(v) => setPrefs({ approvals: v })}
            />
          </SettingsRow>
        )}
        <SettingsRow label="Two-column sidebar" description="Your projects in one column, and the tasks of the one you pick in the next.">
          <Switch aria-label="Two-column sidebar" data-testid="labs-sidebar-columns" checked={columns} onCheckedChange={(on) => setPrefs({ sidebarLayout: on ? "columns" : "list" })} />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
