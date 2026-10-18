import { ExternalLinkIcon, NetworkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { laptopApi, type NetworkInfo } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { openUrl } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ErrorText } from "@/components/error-note";

// NetworksStep reaches boxes on a tailnet this computer is not part of, such
// as a personal one while the Mac is on work's: Shipyard joins it with its own
// node after a browser sign-in, then lists that tailnet's machines.
export function NetworksStep({ onPick }: { onPick(network: string): void }) {
  const client = useStore((s) => s.client);
  const [networks, setNetworks] = useState<NetworkInfo[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client) return;
    laptopApi.networks(client).then(setNetworks, (err) => setError(plainError(err)));
  }, [client]);

  return (
    <div className="space-y-5">
      {error && <ErrorText className="text-destructive-foreground text-body" text={error} />}
      {networks === undefined && !error ? (
        <div className="flex items-center gap-2 text-muted-foreground text-body">
          <Spinner className="size-4" /> Loading…
        </div>
      ) : (
        networks &&
        networks.length > 0 && (
          <div>
            <div className="mb-2 text-muted-foreground text-meta">Joined</div>
            <ul className="divide-y divide-border/70 rounded-xl border">
              {networks.map((n) => (
                <li key={n.name} className="flex items-center gap-3 px-3.5 py-2.5">
                  <NetworkIcon className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-row">{n.name}</div>
                    <div className="truncate text-tag text-muted-foreground">
                      {n.tailnet ?? n.state}
                      {n.ips?.[0] ? ` · ${n.ips[0]}` : ""}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" onClick={() => onPick(n.name)}>
                    Use this one
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      <SignIn existing={networks?.map((n) => n.name) ?? []} onJoined={onPick} />
    </div>
  );
}

function SignIn({ existing, onJoined }: { existing: string[]; onJoined(network: string): void }) {
  const client = useStore((s) => s.client);
  const [name, setName] = useState("");
  const duplicate = existing.includes(name.trim());
  const [url, setUrl] = useState<string>();
  const [state, setState] = useState<"ready" | "waiting" | "failed">("ready");
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!client || !name.trim()) return;
    abort.current = new AbortController();
    setState("waiting");
    setError(undefined);
    setUrl(undefined);
    try {
      const joined = await laptopApi.networkLogin(
        client,
        name.trim(),
        (u) => {
          setUrl(u);
          void openUrl(u);
        },
        abort.current.signal,
      );
      onJoined(joined.name);
    } catch (err) {
      if (abort.current?.signal.aborted) return;
      setError(plainError(err));
      setState("failed");
    }
  };

  return (
    <div className="border-t pt-5">
      <div className="text-row">Sign in to a tailnet</div>
      <p className="mt-0.5 text-muted-foreground text-meta">Name it however you like; it's how Shipyard refers to that tailnet. A Tailscale sign-in page opens in your browser.</p>
      {state === "waiting" ? (
        <div className="mt-3 flex items-center gap-3 text-body">
          <Spinner className="size-4" />
          <span className="min-w-0 flex-1 text-muted-foreground">{url ? "Waiting for you to approve the sign-in in your browser…" : "Starting…"}</span>
          {url && (
            <Button size="xs" variant="ghost" onClick={() => void openUrl(url)}>
              <ExternalLinkIcon /> Open again
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              abort.current?.abort();
              setState("ready");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <Input size="sm" className="max-w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="work, personal…" aria-label="Network name" aria-invalid={duplicate || undefined} />
          <Tip label={!name.trim() ? "Name the network first" : duplicate ? "There is a network by that name already" : undefined}>
            <Button size="sm" type="submit" disabled={!name.trim() || duplicate}>
              Sign in
            </Button>
          </Tip>
        </form>
      )}
      {duplicate && state !== "waiting" && <p className="mt-2 text-destructive-foreground text-meta">Shipyard already joined a tailnet called {name.trim()}. Browse it above, or pick another name.</p>}
      {error && <p className={cn("mt-2 text-destructive-foreground text-meta")}>{error}</p>}
    </div>
  );
}
