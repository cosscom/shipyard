import { CopyIcon, EllipsisIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { BoxError } from "@/components/upgrade-box";
import { newNtfyTopic, type PairedBox, pairingLink, phoneApi, type PhoneStatus } from "@/lib/phone";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/views/settings/confirm";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Settings → Phone: turn on each box's phone app, pair a phone with one QR
// code, and send "needs you" notifications through ntfy.
export function PhoneSection() {
  const client = useStore((s) => s.client);
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const online = useMemo(() => boxes.filter((b) => b.state === "online"), [boxes]);
  const [phone, setPhone] = useState<Record<string, PhoneStatus | { error: string; unsupported: true }>>({});
  const [busy, setBusy] = useState<string>();
  const [rotate, setRotate] = useState<string>();

  const load = useCallback(async () => {
    if (!client) return;
    const entries = await Promise.all(
      online.map(async (b) => {
        try {
          return [b.name, await phoneApi.status(client, b.name)] as const;
        } catch (err) {
          return [b.name, { error: errorMessage(err), unsupported: true as const }] as const;
        }
      }),
    );
    setPhone(Object.fromEntries(entries));
  }, [client, online]);
  useEffect(() => {
    void load();
  }, [load]);

  async function change(box: string, c: Parameters<typeof phoneApi.change>[2]) {
    if (!client) return;
    setBusy(box);
    try {
      const st = await phoneApi.change(client, box, c);
      setPhone((p) => ({ ...p, [box]: st }));
    } catch (err) {
      toastManager.add({ type: "error", title: `Phone access on ${box}`, description: errorMessage(err) });
    } finally {
      setBusy(undefined);
    }
  }

  const paired: PairedBox[] = online.flatMap((b) => {
    const st = phone[b.name];
    return st && "enabled" in st && st.enabled && st.url && st.token ? [{ name: b.name, url: st.url, token: st.token }] : [];
  });
  const link = pairingLink(paired);

  return (
    <SettingsPage
      title="Phone"
      description="Answer agents from your phone. Boxes serve it, so it works while this computer sleeps."
    >
      <SettingsGroup title="Boxes" description="Phone access is off until you turn it on. Only devices on your tailnet can reach it, and only with the code below.">
        {online.length === 0 && <p className="px-4 py-6 text-center text-muted-foreground text-body">No boxes are online.</p>}
        {online.map((b) => {
          const st = phone[b.name];
          const unsupported = st && "unsupported" in st;
          const on = !!st && "enabled" in st && st.enabled;
          return (
            <SettingsRow
              key={b.name}
              label={b.name}
              description={
                !st ? (
                  "Checking…"
                ) : unsupported ? (
                  <BoxError className="mt-1" box={b.name} error={st.error} what="phone access" />
                ) : "error" in st && st.error ? (
                  <span className="text-destructive">{st.error}</span>
                ) : on ? (
                  <Code>{st.url}</Code>
                ) : (
                  "Off"
                )
              }
            >
              {on && (
                <Menu>
                  <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`More for ${b.name}`} />}>
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setRotate(b.name)}>
                      <RefreshCwIcon /> New code…
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )}
              <Switch checked={on} disabled={!st || unsupported || busy === b.name} onCheckedChange={(v) => change(b.name, { enabled: v })} aria-label={`Phone access on ${b.name}`} />
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Pair your phone" description="One code pairs every box above that has phone access on.">
        <PairCode link={link} count={paired.length} />
      </SettingsGroup>

      <Notifications boxes={paired.map((p) => p.name)} phone={phone} onChange={change} />

      <ConfirmDialog
        open={!!rotate}
        onOpenChange={(o) => !o && setRotate(undefined)}
        title={`New code for ${rotate}?`}
        description="Phones paired with the old code stop reaching this box until you scan the new one."
        confirm="Make a new code"
        onConfirm={async () => {
          if (rotate) await change(rotate, { rotate: true });
          setRotate(undefined);
        }}
      />
    </SettingsPage>
  );
}

function PairCode({ link, count }: { link?: string; count: number }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    if (!link) return setSvg("");
    QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#16181bff", light: "#ffffffff" } }).then(setSvg, () => setSvg(""));
  }, [link]);
  if (!link) {
    return (
      <div className="flex items-center gap-3 py-5 text-muted-foreground text-body">
        <SmartphoneIcon className="size-5 shrink-0" />
        Turn on phone access for a box to get a pairing code.
      </div>
    );
  }
  return (
    <div className="flex gap-5 py-4 max-sm:flex-col">
      {/* The code holds the tokens, so it is shown here and nowhere else. */}
      <div className="size-44 shrink-0 overflow-hidden rounded-lg bg-white p-1.5 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="flex min-w-0 flex-col gap-2.5 text-body">
        <p className="font-medium">
          Scan with your phone's camera ({count} {count === 1 ? "box" : "boxes"})
        </p>
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Your phone needs the Tailscale app, signed in to the same tailnet as the boxes.</li>
          <li>Scan the code, then add the page to your home screen (Share → Add to Home Screen).</li>
          <li>Anyone with this code can answer your agents. Make a new code if it leaks.</li>
        </ol>
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(link).then(
                () => toastManager.add({ type: "success", title: "Pairing link copied" }),
                () => toastManager.add({ type: "error", title: "Could not copy" }),
              );
            }}
          >
            <CopyIcon /> Copy link
          </Button>
        </div>
      </div>
    </div>
  );
}

function Notifications({ boxes, phone, onChange }: { boxes: string[]; phone: Record<string, PhoneStatus | { error: string; unsupported: true }>; onChange: (box: string, c: Parameters<typeof phoneApi.change>[2]) => Promise<void> }) {
  const current = boxes.map((b) => phone[b]).find((s) => s && "notify" in s && s.notify) as PhoneStatus | undefined;
  const [url, setUrl] = useState(current?.notify?.url ?? "");
  const [finished, setFinished] = useState(!!current?.notify?.on?.includes("finished"));
  useEffect(() => {
    if (current?.notify) {
      setUrl(current.notify.url);
      setFinished(!!current.notify.on?.includes("finished"));
    }
  }, [current?.notify]);
  const saved = !!current?.notify;
  const valid = /^https?:\/\/\S+\/\S+$/.test(url.trim());

  async function save() {
    for (const b of boxes) await onChange(b, { notify: { url: url.trim(), on: finished ? ["waiting", "finished"] : ["waiting"] } });
    toastManager.add({ type: "success", title: "Notifications on", description: `Send a test by waiting for an agent, or subscribe to the topic in ntfy first.` });
  }
  async function off() {
    for (const b of boxes) await onChange(b, { clear_notify: true });
    setUrl("");
  }

  return (
    <SettingsGroup
      title="Notifications"
      description={
        <>
          Boxes push to an <Code>ntfy</Code> topic when an agent needs you, and the ntfy app shows it on iOS and Android. Tapping it opens that agent here.
        </>
      }
    >
      {boxes.length === 0 ? (
        <p className="py-5 text-muted-foreground text-body">Turn on phone access for a box first.</p>
      ) : (
        <div className="flex flex-col gap-3 py-4">
          <div className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://ntfy.sh/your-private-topic" className="font-mono text-mono" aria-label="ntfy topic URL" />
            <Button size="sm" variant="outline" onClick={() => setUrl(newNtfyTopic())}>
              New topic
            </Button>
          </div>
          <label className="flex items-center gap-2 text-body">
            <Switch checked={finished} onCheckedChange={setFinished} />
            Also when an agent finishes its turn
          </label>
          <p className="text-muted-foreground text-meta">
            Install ntfy on your phone and subscribe to the same topic. The topic name is the only secret, so keep it long and random; anyone who knows it can read these notifications, which say which worktree needs you, never what the agent wrote.
          </p>
          <div className={cn("flex gap-2", !saved && "justify-start")}>
            <Button size="sm" disabled={!valid} onClick={save}>
              {saved ? "Update" : "Turn on notifications"}
            </Button>
            {saved && (
              <Button size="sm" variant="ghost" onClick={off}>
                Turn off
              </Button>
            )}
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
