import { CopyIcon, LaptopIcon, MonitorIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import { StepHeader } from "@/components/step-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogPanel, DialogPopup } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { type BoxStatus, ApiError } from "@/lib/api";
import { boxList, computersApi, countdown, type Invite, type TrustedComputer } from "@/lib/computers";
import { useEventLog } from "@/lib/events";
import { ago, errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { JoinFlow, useSecondsLeft } from "@/views/onboarding/join-step";
import { ConfirmDialog } from "@/views/settings/confirm";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";
import { ErrorText } from "@/components/error-note";
import { BoxError } from "@/components/upgrade-box";

// ComputersSection is Shipyard on more than one computer: add another (a join
// link), join from another, and the computers each box trusts, with a way to
// remove one.
export function ComputersSection() {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const [inviting, setInviting] = useState(false);
  const [joining, setJoining] = useState(false);
  return (
    <SettingsPage
      title="Computers"
      description={
        <>
          Use Shipyard on more than one computer. Each pairs with your boxes with its own key.
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow label="Add another computer" description="A link that pairs another computer of yours with the boxes you choose. It works once per box, for ten minutes.">
          <Button size="xs" variant="outline" className="min-w-24" disabled={boxes.length === 0} onClick={() => setInviting(true)}>
            Add another computer
          </Button>
        </SettingsRow>
        <SettingsRow label="Join from another computer" description="Paste a link made on your other computer to pair this one with its boxes.">
          <Button size="xs" variant="outline" className="min-w-24" onClick={() => setJoining(true)}>
            Use a join link
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {boxes.map((b) => (
        <BoxComputers key={b.name} box={b} />
      ))}

      <InviteDialog open={inviting} onOpenChange={setInviting} boxes={boxes} />
      <Dialog open={joining} onOpenChange={setJoining}>
        <DialogPopup className="sm:max-w-xl" anchored>
          {joining && (
            <JoinFlow
              variant="dialog"
              onDone={(paired) => {
                setJoining(false);
                if (paired.length) toastManager.add({ title: `Paired with ${boxList(paired)}`, type: "success" });
              }}
            />
          )}
        </DialogPopup>
      </Dialog>
    </SettingsPage>
  );
}

// BoxComputers lists the computers one box trusts.
function BoxComputers({ box }: { box: BoxStatus }) {
  const client = useStore((s) => s.client);
  const online = box.state === "online";
  const [list, setList] = useState<TrustedComputer[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // A computer paired or removed, from any computer: read the list again.
  const changed = useEventLog((s) => s.events.find((e) => e.box === box.name && e.type.startsWith("client."))?.time);

  const load = useCallback(async () => {
    if (!client || !online) return;
    setLoading(true);
    try {
      setList(await computersApi.clients(client, box.name));
      setError(undefined);
    } catch (err) {
      // A 404 here is the route, not a computer: the box predates the list.
      setError(err instanceof ApiError && err.status === 404 ? "404 page not found" : errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client, online, box.name]);
  useEffect(() => void load(), [load, changed]);

  return (
    <SettingsGroup
      title={list ? `${box.name} · ${list.length === 1 ? "1 computer" : `${list.length} computers`}` : box.name}
      actions={
        online && (
          <Button size="icon-xs" variant="ghost" aria-label={`Read ${box.name}'s list again`} disabled={loading} onClick={() => void load()}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
        )
      }
    >
      {!online ? (
        <p className="py-3.5 text-muted-foreground text-body">{box.name} is {box.state}, so its list can't be read.</p>
      ) : error ? (
        <BoxError className="mx-4 my-3" box={box.name} error={error} what="its paired computers" />
      ) : !list ? (
        <div className="flex items-center gap-2 py-3.5 text-muted-foreground text-body">
          <Spinner className="size-4" /> Loading…
        </div>
      ) : (
        list.map((c) => <ComputerRow key={c.fingerprint} box={box.name} computer={c} onRemoved={load} />)
      )}
    </SettingsGroup>
  );
}

function ComputerRow({ box, computer, onRemoved }: { box: string; computer: TrustedComputer; onRemoved(): void }) {
  const [removing, setRemoving] = useState(false);
  const Icon = computer.you ? LaptopIcon : MonitorIcon;
  return (
    <div className="flex min-h-12 items-center gap-3 py-3">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-row">{computer.name}</span>
          {computer.you && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-tag text-muted-foreground">This computer</span>}
        </div>
        <div className="truncate font-mono text-tag text-muted-foreground">
          {computer.fingerprint.slice(0, 12)} · paired {ago(computer.paired_at)}
        </div>
      </div>
      {!computer.you && (
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(true)}>
          Remove…
        </Button>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${computer.name} from ${box}?`}
        description={`${computer.name} can no longer reach ${box}: its terminals, forwards and event streams there close at once. Agents and worktrees on ${box} keep running. To use ${box} on it again, add it from here with Add another computer.`}
        confirm="Remove"
        onConfirm={async () => {
          const client = useStore.getState().client;
          if (!client) return;
          try {
            await computersApi.removeClient(client, box, computer.name);
            toastManager.add({ title: `${computer.name} can no longer reach ${box}`, type: "success" });
            onRemoved();
          } catch (err) {
            toastManager.add({ title: `Couldn't remove ${computer.name}`, description: errorMessage(err), type: "error" });
          }
        }}
      />
    </div>
  );
}

// InviteDialog makes a join link: choose boxes, confirm what that gives
// away, then the link, its QR code and how long it lasts.
function InviteDialog({ open, onOpenChange, boxes }: { open: boolean; onOpenChange(open: boolean): void; boxes: BoxStatus[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl" anchored>
        {open && <InviteFlow boxes={boxes} onClose={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function InviteFlow({ boxes, onClose }: { boxes: BoxStatus[]; onClose(): void }) {
  const client = useStore((s) => s.client);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(boxes.filter((b) => b.state === "online").map((b) => b.name)));
  const [invite, setInvite] = useState<Invite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const names = boxes.filter((b) => chosen.has(b.name)).map((b) => b.name);

  const make = async () => {
    if (!client || names.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      setInvite(await computersApi.invite(client, names));
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  if (invite) return <InviteLink invite={invite} onBack={() => setInvite(undefined)} onAgain={() => void make()} again={busy} onClose={onClose} />;

  return (
    <>
      <StepHeader title="Add another computer" description="Choose the boxes the other computer should use. It pairs with each with its own key; this computer stays paired." />
      <DialogPanel className="px-5 pb-4">
        <ul className="divide-y divide-border/70 rounded-xl border" aria-label="Boxes">
          {boxes.map((b) => {
            const online = b.state === "online";
            return (
              <li key={b.name}>
                <label className={cn("flex items-center gap-3 px-3.5 py-2.5", online ? "cursor-pointer" : "opacity-64")}>
                  <Checkbox
                    checked={chosen.has(b.name)}
                    disabled={!online}
                    onCheckedChange={(on) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(b.name);
                        else next.delete(b.name);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body">{b.name}</span>
                    <span className="block truncate font-mono text-tag text-muted-foreground">
                      {online ? [b.address, b.network && `via ${b.network}`].filter(Boolean).join(" · ") : `${b.state}: it can't make a code until it's back`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {/* The confirmation is the step itself: what the link gives away. */}
        <div className="mt-4 flex gap-2.5 rounded-lg border border-warning/32 bg-warning/6 px-3.5 py-3 text-body">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="min-w-0">
            <p>{names.length ? <>This lets another computer control {boxList(names)}.</> : "Choose at least one box."}</p>
            <p className="mt-1 text-muted-foreground text-meta">It can run commands, read code and open terminals there, as this computer can. Open the link only on a computer of yours, and don't post it in a chat or a ticket: anyone who has it can pair until it expires.</p>
          </div>
        </div>
        {error && <ErrorText className="mt-3 text-destructive-foreground text-body" text={error} />}
      </DialogPanel>
      <DialogFooter variant="bare" className="px-5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={names.length === 0} loading={busy} onClick={() => void make()}>
          Make the link
        </Button>
      </DialogFooter>
    </>
  );
}

function InviteLink({ invite, again, onBack, onAgain, onClose }: { invite: Invite; again: boolean; onBack(): void; onAgain(): void; onClose(): void }) {
  const [svg, setSvg] = useState("");
  const left = useSecondsLeft(invite.expires);
  const expired = left === 0;
  useEffect(() => {
    QRCode.toString(invite.link, { type: "svg", margin: 1, errorCorrectionLevel: "L", color: { dark: "#16181bff", light: "#ffffffff" } }).then(setSvg, () => setSvg(""));
  }, [invite.link]);
  const copy = () =>
    navigator.clipboard.writeText(invite.link).then(
      () => toastManager.add({ type: "success", title: "Join link copied", description: "Paste it only on your other computer." }),
      () => toastManager.add({ type: "error", title: "Could not copy" }),
    );

  return (
    <>
      <StepHeader
        title="Open this on the other computer"
        description={
          <>
            In Shipyard there, choose <span className="text-foreground">I already use Shipyard on another computer</span> (or Settings → Computers → Use a join link) and paste it. In a terminal: <Code>berth join '…'</Code>.
          </>
        }
        onBack={onBack}
        backLabel="Choose other boxes"
      />
      <DialogPanel className="px-5 pb-4">
        <div className="flex gap-5 max-sm:flex-col">
          <div className={cn("size-40 shrink-0 overflow-hidden rounded-lg bg-white p-1.5 [&_svg]:size-full", expired && "opacity-24")} aria-label="QR code of the join link" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex h-9 items-center gap-2 rounded-lg border bg-muted/40 ps-3 pe-1">
              <code className="min-w-0 flex-1 truncate font-mono text-mono text-muted-foreground">{invite.link}</code>
              <Button size="xs" variant="outline" className="shrink-0" disabled={expired} onClick={() => void copy()}>
                <CopyIcon /> Copy
              </Button>
            </div>
            <div aria-live="polite" className={cn("text-meta", expired ? "text-warning-foreground" : "text-muted-foreground")}>
              {expired ? (
                <span className="flex items-center gap-2">
                  This link has expired.
                  <Button size="xs" variant="outline" loading={again} onClick={onAgain}>
                    Make a new one
                  </Button>
                </span>
              ) : (
                <>
                  Works once per box · expires in <span className="font-mono text-foreground tabular-nums">{countdown(left)}</span>
                </>
              )}
            </div>
            <div className="text-body">
              <div className="mb-1 text-muted-foreground text-meta">In the link</div>
              <div className="flex flex-wrap gap-1.5">
                {invite.boxes.map((b) => (
                  <span key={b.name} className="rounded-md border px-2 py-0.5 text-meta">
                    {b.name}
                    {b.network && <span className="text-muted-foreground"> · {b.tailnet ?? b.network}</span>}
                  </span>
                ))}
              </div>
            </div>
            {invite.skipped.length > 0 && (
              <div className="text-meta">
                <div className="mb-1 text-muted-foreground">Left out</div>
                <ul className="space-y-0.5">
                  {invite.skipped.map((s) => (
                    <li key={s.name} className="text-muted-foreground">
                      <span className="text-foreground">{s.name}</span>: {s.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        <p className="mt-4 text-muted-foreground text-meta">The QR code is the same link, for your phone's camera to copy across. The link holds a one-time code per box and the boxes' addresses and keys; never this computer's key.</p>
      </DialogPanel>
      <DialogFooter variant="bare" className="px-5">
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}
