import { useEffect, useState } from "react";

import { PickOne } from "@/components/pick-one";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { type CliLink, cliLinkStatus, installCliLink } from "@/lib/cli-link";
import { errorMessage } from "@/lib/format";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { ConfirmButton } from "@/views/settings/confirm";
import { Code, SettingsGroup, SettingsPage, SettingsRow, Value } from "@/views/settings/rows";

export function GeneralSection() {
  const confirmClose = usePrefs((p) => p.confirmCloseShells);
  const closeAgents = usePrefs((p) => p.closeAgents);
  const agentBrowser = usePrefs((p) => p.agentBrowserBeside);
  const proxy = useStore((s) => s.status?.proxy);
  const port = proxy?.url_port ?? 1377;

  return (
    <SettingsPage title="General" description="How Shipyard behaves here. Box settings live under Machines.">
      <SettingsGroup title="Closing tabs">
        <SettingsRow
          label="When you close an agent's tab"
          description={
            closeAgents === "keep"
              ? "The agent keeps running on its box. Pick it up again from its worktree."
              : closeAgents === "stop"
                ? "Stopping gives you a few seconds to undo."
                : "Asks whether to stop the agent or leave it running."
          }
        >
          <PickOne
            label="Closing an agent's tab"
            value={closeAgents}
            onChange={(v) => setPrefs({ closeAgents: v, closeAgentsChosen: true })}
            options={[
              { value: "stop", label: "Stop it" },
              { value: "keep", label: "Keep running" },
              { value: "ask", label: "Ask" },
            ]}
          />
        </SettingsRow>
        <SettingsRow label="Confirm before closing stops something" description="Applies to shells, and to agents set to stop when closed.">
          <Switch checked={confirmClose} onCheckedChange={(confirmCloseShells) => setPrefs({ confirmCloseShells })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Browser">
        <SettingsRow label="Show an agent's browser next to its chat" description="Only for the worktree you're looking at. Nothing opens while you're elsewhere.">
          <Switch checked={agentBrowser} onCheckedChange={(agentBrowserBeside) => setPrefs({ agentBrowserBeside })} />
        </SettingsRow>
      </SettingsGroup>

      <CommandLineGroup />

      <SettingsGroup title="At login">
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Open Shipyard</span>
              <Badge variant="secondary">Coming soon</Badge>
            </span>
          }
          description="Closing Shipyard never stops your boxes or their agents."
        >
          <Switch checked={false} disabled />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Private URLs" description="Dev servers on your boxes open here at names like these.">
        <SettingsRow
          label="Worktree URLs"
          description={
            <>
              <Code>{`http://checkout.shop.devl.localhost${port === 80 ? "" : `:${port}`}/`}</Code> for a worktree, <Code>{`http://shop.devl.localhost${port === 80 ? "" : `:${port}`}/`}</Code> for a repo's main checkout.
            </>
          }
        />
        <SettingsRow
          label="Port"
          description={
            port === 80 ? (
              "URLs have no port: port 80 here points at Shipyard."
            ) : (
              <>
                URLs end in <Code>:{port}</Code>. <Code>berth setup port80</Code> drops it, if nothing else uses port 80. It asks for your password once.
              </>
            )
          }
        >
          <Value>:{port}</Value>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

const LINK = "~/.local/bin/berth";

// CommandLineGroup puts the berth CLI that Shipyard.app carries on the PATH, as
// a link at ~/.local/bin/berth, so a terminal runs the same berth as the app
// and it updates with the app. It asks first, and says what it replaces.
function CommandLineGroup() {
  const [cli, setCli] = useState<CliLink | null | undefined>(undefined);
  useEffect(() => {
    cliLinkStatus().then(setCli, () => setCli(null));
  }, []);
  if (cli === undefined) return null;

  let description: React.ReactNode;
  let control: React.ReactNode = null;
  if (!cli?.bundled) {
    description = (
      <>
        The Shipyard app carries its own <Code>berth</Code>; this build has none. From a clone, run <Code>bin/berth</Code> after <Code>make all</Code>.
      </>
    );
  } else if (cli.state === "linked") {
    description = (
      <>
        <Code>{LINK}</Code> runs the copy inside Shipyard.app, so it updates with the app. If a terminal can't find <Code>berth</Code>, add <Code>~/.local/bin</Code> to your <Code>PATH</Code>.
      </>
    );
    control = <Value>Installed</Value>;
  } else {
    const replaces =
      cli.state === "symlink" ? (
        <>
          {" "}
          It replaces the link there now, to <Code>{cli.target}</Code>.
        </>
      ) : cli.state === "file" ? (
        <>
          {" "}
          The <Code>berth</Code> there now is kept as <Code>berth.previous</Code>.
        </>
      ) : null;
    description = cli.blocked ?? (
      <>
        Links <Code>{LINK}</Code> to the copy inside Shipyard.app, so <Code>berth</Code> in a terminal is the one the app runs, and updates with it.{replaces}
      </>
    );
    control = (
      <ConfirmButton
        label="Install"
        disabled={!!cli.blocked}
        title="Install the berth command?"
        description={
          <>
            This links <Code>{LINK}</Code> to <Code>{cli.bundled}</Code>.{replaces} If <Code>~/.local/bin</Code> isn't on your <Code>PATH</Code>, add <Code>{'export PATH="$HOME/.local/bin:$PATH"'}</Code> to your shell's profile.
          </>
        }
        confirm="Install"
        onConfirm={async () => {
          try {
            setCli(await installCliLink());
            toastManager.add({ title: "Installed the berth command", description: `${LINK} now runs Shipyard's copy.`, type: "success" });
          } catch (e) {
            toastManager.add({ title: "Could not install the berth command", description: errorMessage(e), type: "error" });
          }
        }}
      />
    );
  }
  return (
    <SettingsGroup title="Command line">
      <SettingsRow label="The berth command" description={description}>
        {control}
      </SettingsRow>
    </SettingsGroup>
  );
}
