import { CheckIcon, ChevronRightIcon, MinusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { SkillsPanel } from "@/components/skills/skills-panel";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { BoxError } from "@/components/upgrade-box";
import type { AgentPreset } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import { NONE, useStore } from "@/lib/store";
import { ownServer, type TurnCheckChange, type TurnCheckConfig, type TurnCheckStatus, turnCheckApi } from "@/lib/turncheck";
import { Segmented } from "@/views/settings/controls";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// How to put each built-in agent on a box's PATH.
const INSTALL: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  gemini: "npm install -g @google/gemini-cli",
  cursor: "curl https://cursor.com/install -fsS | bash",
};

const BUILTIN: Pick<AgentPreset, "id" | "name">[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "cursor", name: "Cursor Agent" },
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

      {online.length > 0 && <TurnCheck boxes={online.map((b) => b.name)} />}

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

// Turn check, per box: off until turned on, and on only with a key. The
// key is pasted once and kept on the box; a secret reference is the
// alternative.
function TurnCheck({ boxes }: { boxes: string[] }) {
  const client = useStore((s) => s.client);
  const [cfg, setCfg] = useState<Record<string, TurnCheckStatus | { error: string }>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const names = boxes.join("\n");

  const load = useCallback(
    (b: string) => {
      if (!client) return;
      turnCheckApi.get(client, b).then(
        (c) => setCfg((p) => ({ ...p, [b]: c })),
        (err) => setCfg((p) => ({ ...p, [b]: { error: errorMessage(err) } })),
      );
    },
    [client],
  );
  useEffect(() => {
    for (const b of names.split("\n")) load(b);
  }, [load, names]);

  async function save(box: string, c: TurnCheckChange): Promise<boolean> {
    if (!client) return false;
    setBusy((p) => ({ ...p, [box]: true }));
    try {
      const st = await turnCheckApi.put(client, box, c);
      setCfg((p) => ({ ...p, [box]: st }));
      return true;
    } catch (err) {
      toastManager.add({ type: "error", title: `Turn check on ${box}`, description: errorMessage(err) });
      load(box);
      return false;
    } finally {
      setBusy((p) => ({ ...p, [box]: false }));
    }
  }

  return (
    <SettingsGroup
      title="Turn check"
      description="When an agent's turn ends, ask Jev whether it stopped to ask you something (Needs you) or with its work unfinished (Idle). When on, the box sends the turn's last prompt and reply to the checker (Vercel AI Gateway by default)."
    >
      {boxes.map((b) => {
        const st = cfg[b];
        if (!st || "error" in st) {
          return (
            <SettingsRow key={b} label={b} description={st ? <BoxError className="mt-1" box={b} error={st.error} what="turn check" /> : "Checking…"}>
              <Switch checked={false} disabled aria-label={`Check finished turns with Jev on ${b}`} />
            </SettingsRow>
          );
        }
        return <TurnCheckBox key={b} box={b} st={st} busy={!!busy[b]} save={(c) => save(b, c)} />;
      })}
    </SettingsGroup>
  );
}

function TurnCheckBox({ box, st, busy, save }: { box: string; st: TurnCheckStatus; busy: boolean; save: (c: TurnCheckChange) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const [ref, setRef] = useState(st.key ?? "");
  useEffect(() => setRef(st.key ?? ""), [st.key]);
  const config: TurnCheckConfig = { enabled: st.enabled, key: st.key, url: st.url, model: st.model };
  const hasKey = st.key_set || !!st.key || ownServer(st);
  return (
    <div>
      <SettingsRow label={box} description={st.key ? <Code>{st.key}</Code> : st.key_set ? `Key saved on ${box}` : hasKey ? "Your own server" : "Save a key first"}>
        {st.key_set && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save({ ...config, enabled: st.enabled && (!!st.key || ownServer(st)), remove_key: true })}>
            Remove
          </Button>
        )}
        <Switch checked={st.enabled} disabled={busy || (!st.enabled && !hasKey)} onCheckedChange={(v) => void save({ ...config, enabled: v })} aria-label={`Check finished turns with Jev on ${box}`} />
      </SettingsRow>
      <div className="flex flex-col gap-2 px-4 pb-3">
        {!st.key_set && (
          <div className="flex gap-2">
            <Input size="sm" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste your key" className="font-mono [&_input::placeholder]:font-sans" aria-label={`AI Gateway key for ${box}`} />
            <Button size="sm" variant="outline" disabled={busy || !value.trim()} onClick={async () => (await save({ ...config, key: undefined, key_value: value.trim() })) && setValue("")}>
              Save
            </Button>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          <button type="button" onClick={() => void openUrl("https://vercel.com/docs/ai-gateway")} className="underline underline-offset-2 hover:text-foreground">
            Create an API key in Vercel's AI Gateway
          </button>
          . It stays on {box}, readable by you alone, and goes only to AI Gateway.
        </p>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
            Use a secret reference instead
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 flex gap-2">
              <Input size="sm" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="op://vault/item/field or env://NAME" className="font-mono text-xs" aria-label={`Key reference on ${box}`} />
              <Button size="sm" variant="outline" disabled={busy || ref.trim() === (st.key ?? "")} onClick={() => void save({ ...config, key: ref.trim() || undefined })}>
                Save
              </Button>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
}
