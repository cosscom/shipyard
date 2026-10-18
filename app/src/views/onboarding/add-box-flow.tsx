import { ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { StepHeader } from "@/components/step-header";
import { Tip } from "@/components/tip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DialogPanel } from "@/components/ui/dialog";
import { offerLocalBox, useLocalBox } from "@/lib/local-box";
import { useStore } from "@/lib/store";
import { useTeamAddBox } from "@/lib/team";
import { cn } from "@/lib/utils";
import { InstallCommand } from "@/views/onboarding/install-command";
import { UseThisMac } from "@/views/onboarding/local-box";
import { NetworksStep } from "@/views/onboarding/networks-step";
import { PasteLink } from "@/views/onboarding/paste-link";
import { SshSetup } from "@/views/onboarding/ssh-setup";
import { boxable, sourcesOf, useTailnets } from "@/views/onboarding/tailnet";
import { TailnetMachines, UseTailscale } from "@/views/onboarding/tailnet-machines";

// What the flow is doing, for onboarding's scene: arriving while it waits,
// the lighthouse while a box is being set up or paired, the signal lamp
// while signing in to another tailnet, moored once paired.
export type AddBoxStage = "start" | "working" | "tailnet" | "paired";

type From = "link" | "ssh" | "tailnet";

// AddBoxFlow is every way to add a box, on one screen. When this computer
// reaches a tailnet (its own Tailscale, or one Shipyard signed in to), that
// tailnet's machines come first, each set up in a click; then the install
// command to run on any box and the field for the link it prints; then
// setting a box up over SSH by hand. Without a tailnet, the tailnet path
// sits below the command as "Or use Tailscale". Use this Mac (local-box.tsx),
// when this computer can be a box and isn't one yet, comes first without a
// tailnet and right below its machines with one. The screen is laid out once,
// when it knows which, and keeps that layout. Onboarding and the Add a box
// dialog both show it under one StepHeader; onExit, when given, is where the
// back arrow leads from the first screen.
export function AddBoxFlow({
  intro,
  variant,
  onDone,
  onExit,
  onStage,
  lead,
}: {
  intro: { title: ReactNode; description: ReactNode };
  // lead, when given, comes first on the first screen: another way in.
  lead?: ReactNode;
  variant: "dialog" | "page";
  onDone(box: string): void;
  onExit?(): void;
  onStage?(stage: AddBoxStage): void;
}) {
  const [signingIn, setSigningIn] = useState<From>();
  const [network, setNetwork] = useState<string>();
  const [sshOpen, setSshOpen] = useState(false);
  const [tailscaleOpen, setTailscaleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<string>();
  // Bumped to make the path that was waiting on a tailnet try again.
  const [retry, setRetry] = useState({ link: 0, ssh: 0 });
  const done = useRef(onDone);
  done.current = onDone;
  // The guided install's last button: on to the next step of the first
  // run, back to Team setup when it opened this, else to the box.
  const fromTeam = useStore((s) => s.view.kind === "team");
  const readyLabel = variant === "page" ? "Continue" : fromTeam ? "Back to Team setup" : undefined;
  // From Team setup, adding a box is the guided install, with the team's
  // steps after Shipyard's; anywhere else it is the quick one.
  const teamCtx = useTeamAddBox((s) => s.ctx);
  const team = fromTeam ? teamCtx : undefined;

  const tailnets = useTailnets();
  const sources = sourcesOf(tailnets.system, tailnets.networks);
  const [source, setSource] = useState<string>();
  // Where the tailnet's machines go, decided once: first when there are
  // machines to show, else below the command.
  const [placement, setPlacement] = useState<"top" | "bottom">();
  // Whether to offer this Mac itself, decided with the placement.
  const local = useLocalBox();
  const [thisMac, setThisMac] = useState(false);
  useEffect(() => {
    if (placement || !tailnets.ready || !local.ready) return;
    setPlacement(boxable(tailnets.system) || tailnets.networks.length > 0 ? "top" : "bottom");
    setThisMac(offerLocalBox(local.status));
  }, [placement, tailnets.ready, tailnets.system, tailnets.networks, local.ready, local.status]);

  useEffect(() => {
    onStage?.(paired ? "paired" : signingIn ? "tailnet" : busy ? "working" : "start");
  }, [onStage, paired, signingIn, busy]);

  // A beat on "Paired" before moving on.
  useEffect(() => {
    if (!paired) return;
    const t = setTimeout(() => done.current(paired), 900);
    return () => clearTimeout(t);
  }, [paired]);

  const head = signingIn
    ? {
        title: "Sign in to another tailnet",
        description: "For a box on a tailnet this computer isn't on: a personal one while this Mac is on work's, say. Shipyard joins it as its own device, so nothing changes for the rest of this Mac.",
      }
    : intro;
  const onBack = signingIn ? () => setSigningIn(undefined) : onExit;

  const machines = sources.length > 0 && (
    <TailnetMachines
      sources={sources}
      system={tailnets.system}
      active={source ?? sources[0].key}
      onActive={setSource}
      autoFocus={placement === "top"}
      onRunning={setBusy}
      onPaired={setPaired}
      onSignIn={() => setSigningIn("tailnet")}
      readyLabel={readyLabel}
      team={team}
    />
  );

  const useThisMac = thisMac && local.status && (
    <UseThisMac status={local.status} compact={placement === "top"} autoFocus={placement === "bottom"} className={placement === "top" ? "mt-3" : undefined} onRunning={setBusy} onPaired={setPaired} />
  );
  const anyBox = (
    <div aria-hidden className="my-6 flex items-center gap-3 text-muted-foreground text-meta">
      <span className="h-px flex-1 bg-border" />
      or, on any box
      <span className="h-px flex-1 bg-border" />
    </div>
  );

  // The main screen stays mounted while signing in, hidden, so the pasted
  // link and the SSH host are still there to try again with.
  const body = (
    <>
      {signingIn && (
        <NetworksStep
          onPick={(joined) => {
            if (signingIn === "tailnet") {
              // Its machines, in the list.
              setSource(`network:${joined}`);
              setTailscaleOpen(true);
              tailnets.refresh();
            } else {
              setNetwork(joined);
              setRetry((r) => ({ ...r, [signingIn]: r[signingIn] + 1 }));
            }
            setSigningIn(undefined);
          }}
        />
      )}
      {placement && (
        <div hidden={!!signingIn}>
          {lead}
          {placement === "top" && (
            <>
              {machines}
              {useThisMac}
              {anyBox}
            </>
          )}
          {placement === "bottom" && useThisMac && (
            <>
              {useThisMac}
              {anyBox}
            </>
          )}
          <Step n={1} title="On the box, run">
            <InstallCommand />
            <p className="mt-2 text-muted-foreground text-meta">It installs berthd for your user (no root), starts it, and prints a pairing link.</p>
          </Step>
          <Step n={2} title="Paste what it printed" className="mt-5">
            <PasteLink network={network} retry={retry.link} autoFocus={placement === "bottom" && !useThisMac} onBusy={setBusy} onPaired={setPaired} onSignIn={() => setSigningIn("link")} />
          </Step>

          {network && (
            <div className="mt-3 flex items-center gap-1.5 text-muted-foreground text-meta">
              Reaching boxes through the <span className="text-foreground">{network}</span> tailnet
              <Tip label="Use this computer's own network">
                <button type="button" aria-label="Use this computer's own network" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={() => setNetwork(undefined)}>
                  <XIcon className="size-3" />
                </button>
              </Tip>
            </div>
          )}

          <div className="mt-6 space-y-3 border-t pt-4">
            {placement === "bottom" && (
              <Collapsible open={tailscaleOpen} onOpenChange={setTailscaleOpen}>
                <Trigger>Or use Tailscale</Trigger>
                <CollapsiblePanel>
                  <div className="pt-3">{machines || <UseTailscale system={tailnets.system} onRefresh={tailnets.refresh} onSignIn={() => setSigningIn("tailnet")} />}</div>
                </CollapsiblePanel>
              </Collapsible>
            )}
            <Collapsible open={sshOpen} onOpenChange={setSshOpen}>
              <Trigger>Or let Shipyard set it up over SSH</Trigger>
              <CollapsiblePanel>
                <div className="pt-3">
                  <SshSetup network={network} retry={retry.ssh} onRunning={setBusy} onPaired={setPaired} onSignIn={() => setSigningIn("ssh")} readyLabel={readyLabel} team={team} />
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        </div>
      )}
    </>
  );

  if (variant === "dialog") {
    return (
      <>
        <StepHeader title={head.title} description={head.description} onBack={onBack} />
        <DialogPanel className="px-5 pb-5">{body}</DialogPanel>
      </>
    );
  }
  return (
    <div>
      <StepHeader variant="page" title={head.title} description={head.description} onBack={onBack} />
      <div className="mt-6">{body}</div>
    </div>
  );
}

function Trigger({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      {children}
    </CollapsibleTrigger>
  );
}

function Step({ n, title, className, children }: { n: number; title: string; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <h2 className="mb-2 flex items-center gap-2 text-row">
        <span aria-hidden className="flex size-5 items-center justify-center rounded-full border font-mono text-tag text-muted-foreground">
          {n}
        </span>
        {title}
      </h2>
      <div className={cn("ps-7")}>{children}</div>
    </section>
  );
}
