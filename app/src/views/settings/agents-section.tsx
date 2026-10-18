import { CheckIcon, ChevronRightIcon, MinusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { useMinute } from "@/components/notifications/notification-center";
import { PickOne } from "@/components/pick-one";
import { SkillsPanel } from "@/components/skills/skills-panel";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { SimpleSelect } from "@/components/simple-select";
import { BoxError } from "@/components/upgrade-box";
import type { AgentPreset } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { errorMessage } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import { type Project, projectActions, useProjects } from "@/lib/project-groups";
import { endSnooze, setRemind, useSkillsNotice } from "@/lib/skills-notice";
import { neverRemind, untilText } from "@/lib/skills-notice-model";
import { NONE, useStore } from "@/lib/store";
import { layaPlaceholder, type TurnCheckChange, type TurnCheckConfig, type TurnCheckProvider, type TurnCheckStatus, turnCheckApi, turnCheckProviders, turnCheckReady } from "@/lib/turncheck";
import { Segmented } from "@/views/settings/controls";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// How to put each built-in agent on a box's PATH.
const INSTALL: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  gemini: "npm install -g @google/gemini-cli",
  cursor: "curl https://cursor.com/install -fsS | bash",
  omp: "bun install -g @oh-my-pi/pi-coding-agent",
  grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
};

const BUILTIN: Pick<AgentPreset, "id" | "name">[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "cursor", name: "Cursor Agent" },
  { id: "omp", name: "oh-my-pi" },
  { id: "grok", name: "Grok CLI" },
];

export function AgentsSection() {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const online = boxes.filter((b) => b.state === "online");
  // The sidebar's notice opens this page on its box ("Open Settings"), each
  // time it is asked, whichever box was picked here since.
  const view = useStore((s) => s.view);
  const asked = view.kind === "settings" ? view.box : undefined;
  const [skillsBox, setSkillsBox] = useState(asked);
  useEffect(() => {
    if (asked) setSkillsBox(asked);
  }, [asked, view]);
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
          The agents each box can start. A repo can add its own in <Code>.berth/config.json</Code>.
        </>
      }
    >
      {online.length === 0 ? (
        <p className="rounded-xl border px-4 py-6 text-center text-muted-foreground text-body">No box is online. Agents are listed once one connects.</p>
      ) : (
        <SettingsGroup title="Agent CLIs" description="Found on each box's PATH when berthd checks.">
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b text-tag text-muted-foreground">
                  <th className="py-2 pr-4 text-left font-normal">Agent</th>
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
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2 text-row">
                        <AgentIcon agent={a.id} className="size-3.5" />
                        {a.name}
                      </div>
                      <div className="mt-0.5 pl-5.5 font-mono text-tag text-muted-foreground">{!found.has(a.id) ? "not found on any box" : a.command ? a.command + (a.prompt_flag ? ` ${a.prompt_flag} …` : "") : "$SHELL -l"}</div>
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
                                Not on {b.name}'s PATH.{INSTALL[a.id] && <span className="mt-1 block font-mono text-tag">{INSTALL[a.id]}</span>}
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
              <h2 className="text-section text-foreground">Skills{online.length === 1 ? ` on ${shownSkills}` : ""}</h2>
            </div>
            {online.length > 1 && <Segmented label="Box" value={shownSkills} options={online.map((b) => ({ value: b.name, label: b.name }))} onChange={setSkillsBox} />}
          </div>
          <SkillsPanel key={shownSkills} box={shownSkills} hideTitle />
          <SkillsReminder key={`remind-${shownSkills}`} box={shownSkills} />
        </section>
      )}

      <OffBoard />

      {boxes.length > online.length && <p className="text-muted-foreground text-meta">Offline boxes are listed once they reconnect.</p>}
    </SettingsPage>
  );
}

// SkillsReminder is where the sidebar's notice about a box's skills
// (lib/skills-notice.ts) is seen and undone: a snooze ends with Remind me
// now, and "Don't remind me for this box" is the switch, off.
function SkillsReminder({ box }: { box: string }) {
  const prefs = useSkillsNotice((s) => s.prefs);
  const loaded = useSkillsNotice((s) => s.loaded);
  const off = neverRemind(prefs, box);
  const snooze = prefs.snoozed[box];
  const until = snooze ? Date.parse(snooze.until) : 0;
  // Looked at again each minute, so a snooze that ends says so.
  const now = useMinute();
  // A snooze holds for the state it was made in; Settings says which.
  const snoozed = !off && until > now;
  const description = off
    ? `Off. The sidebar says nothing about ${box}'s skills until you turn this back on.`
    : snoozed
      ? `Snoozed until ${untilText(until, now)}, while its skills ${snooze.kind === "outdated" ? "are out of date" : "aren't installed"}.`
      : `The sidebar says so when ${box}'s skills aren't installed or are out of date, with Install now and Snooze.`;
  return (
    <div data-testid="skills-reminder" className="mt-2 border-border/60 border-b">
      <SettingsRow label={`Remind me about ${box}'s skills`} description={description}>
        {snoozed && (
          <Button size="sm" variant="outline" onClick={() => void endSnooze(box)}>
            Remind me now
          </Button>
        )}
        <Switch checked={!off} disabled={!loaded} onCheckedChange={(on) => void setRemind(box, on)} />
      </SettingsRow>
    </div>
  );
}

// OffBoard is the projects whose agents stay off the Agent Dashboard and
// its counts: work followed somewhere else, such as a plugin's own board.
// The choice is the project's, on every box, and kept on the laptop agent
// with its name and section.
function OffBoard() {
  const { projects } = useProjects();
  const [error, setError] = useState<string>();
  const off = projects.filter((p) => p.dashboardHidden);
  const on = projects.filter((p) => !p.dashboardHidden);
  const set = (p: Project, hidden: boolean) => {
    setError(undefined);
    projectActions.setDashboardHidden(p, hidden).catch((err) => setError(plainError(err)));
  };
  if (!projects.length) return null;
  return (
    <SettingsGroup title="Agent Dashboard" description="Projects kept off the dashboard and its counts. Their agents still show everywhere else.">
      {off.map((p) => (
        <SettingsRow key={p.id} label={p.name} description={p.members.length > 1 ? `Kept off, on ${p.members.map((m) => m.box.name).join(", ")}` : "Kept off"}>
          <Button size="sm" variant="outline" onClick={() => set(p, false)}>
            Show
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow label="Keep a project off" description={error ?? (off.length ? undefined : "Every project shows on the dashboard.")}>
        <SimpleSelect
          size="sm"
          className="w-48"
          placeholder="Choose a project…"
          value=""
          options={on.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => {
            const p = on.find((x) => x.id === id);
            if (p) set(p, true);
          }}
        />
      </SettingsRow>
    </SettingsGroup>
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
      description="When a turn ends, a model you pick says whether the agent needs you, is still working, or is idle. The box sends it the turn's last prompt and reply and the session's title, capped, with anything like a secret taken out."
    >
      {boxes.map((b) => {
        const st = cfg[b];
        if (!st || "error" in st) {
          return (
            <SettingsRow key={b} label={b} description={st ? <BoxError className="mt-1" box={b} error={st.error} what="turn check" /> : "Checking…"}>
              <Switch checked={false} disabled aria-label={`Check finished turns on ${b}`} />
            </SettingsRow>
          );
        }
        return <TurnCheckBox key={b} box={b} st={st} busy={!!busy[b]} save={(c) => save(b, c)} />;
      })}
    </SettingsGroup>
  );
}

function TurnCheckBox({ box, st, busy, save }: { box: string; st: TurnCheckStatus; busy: boolean; save: (c: TurnCheckChange) => Promise<boolean> }) {
  const p = st.provider;
  const info = p ? turnCheckProviders[p] : undefined;
  const [value, setValue] = useState("");
  const [ref, setRef] = useState(st.key ?? "");
  useEffect(() => setRef(st.key ?? ""), [st.key]);
  const [model, setModel] = useState(st.model ?? "");
  useEffect(() => setModel(st.model ?? ""), [st.model]);
  const [server, setServer] = useState(st.url ?? "");
  useEffect(() => setServer(st.url ?? ""), [st.url]);
  const config: TurnCheckConfig = { enabled: st.enabled, provider: p, key: st.key, url: st.url, model: st.model };
  const description = !p
    ? "Choose who checks turns"
    : p === "laya"
      ? st.url
        ? <Code>{st.url}</Code>
        : "Set your Laya server's address"
      : !st.model
        ? "Choose a model"
        : st.key
          ? <Code>{st.key}</Code>
          : st.key_set
            ? `${info?.keyName} key saved on ${box}`
            : "Save a key first";
  const choose = (v: TurnCheckProvider | "") => {
    // Off until turned on again: a new provider is a new place turns go.
    if (v && v !== p) void save({ enabled: false, provider: v, model: turnCheckProviders[v].model });
  };
  return (
    <div data-testid={`turncheck-${box}`}>
      <SettingsRow label={box} description={description}>
        {st.key_set && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save({ ...config, enabled: st.enabled && !!st.key, remove_key: true })}>
            Remove
          </Button>
        )}
        <Switch checked={st.enabled} disabled={busy || (!st.enabled && !turnCheckReady(st))} onCheckedChange={(v) => void save({ ...config, enabled: v })} aria-label={`Check finished turns on ${box}`} />
      </SettingsRow>
      <div className="flex flex-col gap-2 pb-3.5">
        {/* No provider or model is chosen for you: your transcripts, your choice. */}
        <PickOne<TurnCheckProvider | ""> label={`Who checks turns on ${box}`} value={p ?? ""} options={(Object.keys(turnCheckProviders) as TurnCheckProvider[]).map((v) => ({ value: v, label: turnCheckProviders[v].label }))} onChange={choose} />
        {p === "laya" && (
          <div className="flex gap-2">
            <Input size="sm" value={server} onChange={(e) => setServer(e.target.value)} placeholder={layaPlaceholder} className="font-mono text-mono" aria-label={`Laya server on ${box}`} />
            <Button size="sm" variant="outline" disabled={busy || server.trim() === (st.url ?? "")} onClick={() => void save({ ...config, enabled: st.enabled && !!server.trim(), url: server.trim() || undefined })}>
              Save
            </Button>
          </div>
        )}
        {p && (
          <div className="flex gap-2">
            <Input size="sm" value={model} onChange={(e) => setModel(e.target.value)} placeholder={p === "laya" ? "Model (optional): english, multilingual or typed-decisions" : "Model"} className="font-mono text-mono [&_input::placeholder]:font-sans" aria-label={`Model that checks turns on ${box}`} />
            <Button size="sm" variant="outline" disabled={busy || model.trim() === (st.model ?? "")} onClick={() => void save({ ...config, enabled: st.enabled && (p === "laya" || !!model.trim()), model: model.trim() || undefined })}>
              Save
            </Button>
          </div>
        )}
        {p === "laya" && (
          <p className="text-muted-foreground text-meta">
            Run{" "}
            <button type="button" onClick={() => void openUrl("https://huggingface.co/convaiinnovations/laya")} className="underline underline-offset-2 hover:text-foreground">
              Laya
            </button>
            's <Code>laya-serve</Code> (<Code>pip install "laya[serve]"</Code>) where {box} can reach it. Turns stay on your machines, and it gets no key. One on {box} itself or a private address needs that address in <Code>allow_outbound</Code> in <Code>~/.berth/network.json</Code>.
          </p>
        )}
        {info?.keyName && (
          <>
            {!st.key_set && (
              <div className="flex gap-2">
                <Input size="sm" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste your key" className="font-mono [&_input::placeholder]:font-sans" aria-label={`${info.keyName} key for ${box}`} />
                <Button size="sm" variant="outline" disabled={busy || !value.trim()} onClick={async () => (await save({ ...config, key: undefined, key_value: value.trim() })) && setValue("")}>
                  Save
                </Button>
              </div>
            )}
            <p className="text-muted-foreground text-meta">
              <button type="button" onClick={() => info.keyLink && void openUrl(info.keyLink)} className="underline underline-offset-2 hover:text-foreground">
                {info.keyHelp}
              </button>
              . It stays on {box}, readable by you alone, and goes only to {info.keyName}.
            </p>
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground text-meta hover:text-foreground">
                <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
                Use a secret reference instead
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="mt-2 flex gap-2">
                  <Input size="sm" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="op://vault/item/field or env://NAME" className="font-mono text-mono" aria-label={`Key reference on ${box}`} />
                  <Button size="sm" variant="outline" disabled={busy || ref.trim() === (st.key ?? "")} onClick={() => void save({ ...config, key: ref.trim() || undefined })}>
                    Save
                  </Button>
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </>
        )}
      </div>
    </div>
  );
}
