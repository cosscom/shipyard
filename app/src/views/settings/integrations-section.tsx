import type { LinearStatus } from "@berth/plugin";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorText } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { linearApi } from "@/lib/linear";
import { openUrl } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Where Linear makes personal API keys.
const LINEAR_KEYS = "https://linear.app/settings/account/security";

// IntegrationsSection is the services Shipyard reads from as you: for now,
// Linear, by a personal API key the laptop keeps.
export function IntegrationsSection() {
  return (
    <SettingsPage title="Integrations" description="Services Shipyard reads from as you. Their keys never leave this computer.">
      <LinearGroup />
    </SettingsPage>
  );
}

function LinearGroup() {
  const client = useStore((s) => s.client);
  const [status, setStatus] = useState<LinearStatus>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client) return;
    let live = true;
    linearApi.status(client).then(
      (s) => live && setStatus(s),
      (err) => live && (setStatus({ connected: false }), setError(errorMessage(err))),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const run = async (work: () => Promise<LinearStatus>) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await work());
      setKey("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const connect = () => client && key.trim() && void run(() => linearApi.connect(client, key.trim()));
  const disconnect = () => client && void run(() => linearApi.disconnect(client));

  return (
    <SettingsGroup title="Linear" description="Your Linear issues in Issues, and an agent on any of them in one step.">
      {status?.connected ? (
        <SettingsRow
          label={<span data-testid="linear-connected">Connected as {status.viewer?.name ?? "you"}</span>}
          description={[status.workspace?.name, status.viewer?.email].filter(Boolean).join(" · ") || undefined}
        >
          <Button size="xs" variant="outline" className="min-w-24" disabled={busy} onClick={disconnect}>
            {busy && <Spinner className="size-3" />}
            Disconnect
          </Button>
        </SettingsRow>
      ) : (
        <SettingsRow
          label="API key"
          description={
            <>
              Make a personal API key in Linear and paste it here. It is kept in a file on this computer that only you can read, and is sent only to Linear.
              {status?.file && (
                <span className="mt-1 block break-all">
                  <Code>{status.file}</Code>
                </span>
              )}
            </>
          }
        >
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_…"
            className="w-48 font-mono [&_input::placeholder]:font-sans"
            data-testid="linear-key"
            value={key}
            disabled={busy || !status}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
          />
          <Button size="xs" className="min-w-20" disabled={busy || !key.trim()} onClick={connect}>
            {busy && <Spinner className="size-3" />}
            Connect
          </Button>
        </SettingsRow>
      )}
      <ErrorText text={error} className="py-2.5 text-destructive-foreground text-meta" />
      {status && !status.connected && (
        <SettingsRow label="Where to make one" description="Linear → Settings → Security & access → Personal API keys. Read access is enough to list issues; add write access to comment from Shipyard.">
          <Button size="xs" variant="outline" onClick={() => void openUrl(LINEAR_KEYS)}>
            <ExternalLinkIcon className="size-3" />
            Open Linear
          </Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
