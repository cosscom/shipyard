import { CheckIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { SkillsPanel } from "@/components/skills/skills-panel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentPreset } from "@/lib/api";
import { NONE, useStore } from "@/lib/store";
import { Segmented } from "@/views/settings/controls";
import { Code, SettingsGroup, SettingsPage } from "@/views/settings/rows";

// How to put each built-in agent on a box's PATH.
const INSTALL: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  gemini: "npm install -g @google/gemini-cli",
  cursor: "curl https://cursor.com/install -fsS | bash",
  grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
};

const BUILTIN: Pick<AgentPreset, "id" | "name">[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "cursor", name: "Cursor Agent" },
  { id: "grok", name: "Grok CLI" },
];

export function AgentsSection() {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const online = boxes.filter((b) => b.state === "online");
  const [skillsBox, setSkillsBox] = useState<string>();
  const shownSkills = online.some((b) => b.name === skillsBox) ? skillsBox! : online[0]?.name;

  // Every agent any box has, built-ins first, then each box's own.
  const found = new Map<string, AgentPreset>();
  for (const b of online) for (const a of data[b.name]?.info?.agents ?? []) if (!found.has(a.id)) found.set(a.id, a);
  const rows = [...BUILTIN.map((a) => found.get(a.id) ?? { ...a, command: "" }), ...[...found.values()].filter((a) => !BUILTIN.some((x) => x.id === a.id))];

  return (
    <SettingsPage
      title="Agents"
      description={
        <>
          The agent CLIs each box can start, and the skills that teach them to use Shipyard. A repository adds its own agents, or changes how one starts, in <Code>.berth/config.json</Code>.
        </>
      }
    >
      {online.length === 0 ? (
        <p className="rounded-xl border px-4 py-6 text-center text-muted-foreground text-sm">No box is online. Agents are listed once one connects.</p>
      ) : (
        <SettingsGroup title="Agent CLIs" description="Found on each box's PATH when berthd checks.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 text-left font-normal">Agent</th>
                  {online.map((b) => (
                    <th key={b.name} className="w-24 px-2 py-2 text-center font-normal">
                      {b.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <AgentIcon agent={a.id} className="size-3.5" />
                        {a.name}
                      </div>
                      <div className="mt-0.5 pl-5.5 font-mono text-[11px] text-muted-foreground">{!found.has(a.id) ? "not found on any box" : a.command ? a.command + (a.prompt_flag ? ` ${a.prompt_flag} …` : "") : "$SHELL -l"}</div>
                    </td>
                    {online.map((b) => {
                      const has = data[b.name]?.info?.agents?.some((x) => x.id === a.id);
                      return (
                        <td key={b.name} className="px-2 py-2.5 text-center">
                          {has ? (
                            <CheckIcon className="mx-auto size-4 text-success-foreground" aria-label={`On ${b.name}`} />
                          ) : (
                            <Tooltip>
                              <TooltipTrigger render={<button type="button" className="inline-flex cursor-help rounded text-muted-foreground/50 outline-none focus-visible:ring-2 focus-visible:ring-ring" />} aria-label={`Not on ${b.name}`}>
                                <MinusIcon className="size-4" />
                              </TooltipTrigger>
                              <TooltipPopup className="max-w-72">
                                Not on {b.name}'s PATH.{INSTALL[a.id] && <span className="mt-1 block font-mono text-[11px]">{INSTALL[a.id]}</span>}
                              </TooltipPopup>
                            </Tooltip>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsGroup>
      )}

      {shownSkills && (
        <section>
          <div className="mb-2 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-medium text-[13px] text-muted-foreground">Skills{online.length === 1 ? ` on ${shownSkills}` : ""}</h2>
            </div>
            {online.length > 1 && <Segmented label="Box" value={shownSkills} options={online.map((b) => ({ value: b.name, label: b.name }))} onChange={setSkillsBox} />}
          </div>
          <SkillsPanel key={shownSkills} box={shownSkills} hideTitle />
        </section>
      )}

      {boxes.length > online.length && <p className="text-muted-foreground text-xs">Offline boxes are listed once they reconnect.</p>}
    </SettingsPage>
  );
}
