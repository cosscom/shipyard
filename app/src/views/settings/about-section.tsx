import { ArrowUpRightIcon, BugIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { AlphaBadge } from "@/components/alpha-badge";
import { HeaderBand, useHeaderPicture } from "@/components/art/header-band";
import { Button } from "@/components/ui/button";
import { UpgradeBox } from "@/components/upgrade-box";
import { copyDiagnostics } from "@/lib/diagnostics";
import { ago, bytes } from "@/lib/format";
import { openDocs, openUrl } from "@/lib/open-url";
import { useOutdatedBoxes } from "@/lib/outdated";
import { LINUX_ALPHA, LINUX_BUGS } from "@/lib/platform";
import { NONE, useStore } from "@/lib/store";
import { checkForUpdate, restartToUpdate, updatesSupported, useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { hasWhatsNew, openWhatsNew } from "@/lib/whats-new";
import { useAppVersion } from "@/views/settings/app-version";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

const RELEASES = "https://github.com/cosscom/shipyard/releases";

export function AboutSection() {
  const version = useAppVersion();
  return (
    <SettingsPage badge={LINUX_ALPHA && <AlphaBadge />} title="About Shipyard" description="Agents on your own boxes, watched from here.">
      <Hero version={version} />
      <RunningGroup />
      <HelpGroup />
    </SettingsPage>
  );
}

// Hero is the header picture you chose over the app's name, version and
// where its updates stand: the one warm thing in Settings. With None it is
// the strip alone.
function Hero({ version }: { version: string }) {
  const picture = useHeaderPicture();
  const plain = version === "dev" || version === "unknown" || version === "…";
  const u = useUpdates();
  return (
    <div className="overflow-hidden rounded-xl border">
      {picture && <HeaderBand picture={picture} position={0.4} fade={0.2} className="h-[168px]" />}
      <div className={cn("flex items-center gap-4 bg-background px-5 py-4", picture && "border-t")}>
        <img src={`${import.meta.env.BASE_URL}berth-mark.svg`} alt="" className="size-12 shrink-0 rounded-xl shadow-sm" />
        <div className="min-w-0 flex-1">
          <div className="text-heading">Shipyard{plain ? "" : ` ${version}`}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-desc text-muted-foreground">
            {u.dot && <span className={cn("size-1.5 shrink-0 rounded-full", u.dot)} />}
            <span className="truncate">{plain ? `${version} build · ${u.line}` : u.line}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {u.action}
          {hasWhatsNew() && (
            <Button size="sm" data-testid="about-whats-new" onClick={() => openWhatsNew("about")}>
              What's new
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// useUpdates says where the app's own updates stand. Shipyard checks when it
// opens and every few hours, and downloads quietly; the only step left to
// the person is the restart (lib/updater.ts).
function useUpdates(): { line: string; dot?: string; action?: ReactNode } {
  const u = useUpdater();
  if (!updatesSupported()) return { line: "Updates come with the Shipyard app" };
  const busy = u.status === "checking" || u.status === "downloading" || u.status === "installing";
  const check = (
    <Button size="sm" variant="outline" loading={u.status === "checking"} disabled={busy} onClick={() => void checkForUpdate({ manual: true })}>
      Check for updates
    </Button>
  );
  switch (u.status) {
    case "ready":
    case "installing":
      return {
        line: `${u.version} is ready. Agents keep running through the restart.`,
        dot: "bg-info",
        action: (
          <>
            <Button size="sm" variant="ghost" onClick={() => void openUrl(`${RELEASES}/tag/v${u.version}`)}>
              Release notes
            </Button>
            <Button size="sm" variant="outline" loading={u.status === "installing"} onClick={() => void restartToUpdate()}>
              Restart to update
            </Button>
          </>
        ),
      };
    case "downloading":
      return { line: `Downloading ${u.version}: ${u.total ? `${bytes(u.received)} of ${bytes(u.total)}` : bytes(u.received)}`, dot: "bg-info", action: check };
    case "current":
      return { line: `Up to date · checked ${ago(new Date(u.checkedAt).toISOString())}`, dot: "bg-success", action: check };
    case "error":
      return { line: `Couldn't check for updates: ${u.error}`, dot: "bg-warning", action: check };
    default:
      return { line: u.status === "checking" ? "Checking for updates…" : "Checks when it opens and every few hours", action: check };
  }
}

// RunningGroup is what this window talks to: the laptop agent, and berthd
// on each box, older ones with an Update.
function RunningGroup() {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const proxy = useStore((s) => s.status?.proxy);
  const outdated = useOutdatedBoxes();
  return (
    <SettingsGroup title="What's running">
      <SettingsRow label="Laptop agent" description="Holds the connection to every box, private URLs and forwards.">
        <span className="font-mono text-muted-foreground text-mono">:1378 · proxy :{proxy?.port ?? "-"}</span>
      </SettingsRow>
      {boxes.map((b) => {
        const info = data[b.name]?.info;
        const old = outdated.includes(b.name);
        const online = b.state === "online";
        return (
          <SettingsRow
            key={b.name}
            className="min-h-0 py-3.5"
            label={
              <span className={cn("flex items-center gap-2", !online && "text-muted-foreground")}>
                <span className={cn("size-1.5 shrink-0 rounded-full", old ? "bg-warning" : online ? "bg-success" : "bg-muted-foreground/50")} />
                berthd on {b.name}
                {old && <span className="font-normal text-desc text-warning-foreground">older than this app</span>}
              </span>
            }
          >
            <span className="font-mono text-muted-foreground text-mono">{online ? (info?.build?.slice(0, 7) ?? "online") : b.state}</span>
            {old && <UpgradeBox box={b.name} size="sm" variant="outline" label="Update" />}
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

// HelpGroup copies what someone helping needs to know, in one paste
// (lib/diagnostics; `berth doctor --report` prints the same), and points at
// the docs and the release notes.
function HelpGroup() {
  const [busy, setBusy] = useState(false);
  return (
    <SettingsGroup title="Help">
      <SettingsRow label="Copy diagnostics" description="Versions, checks and recent errors. Tokens, emails and your username are taken out.">
        <Button
          size="sm"
          variant="outline"
          data-testid="copy-diagnostics"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void copyDiagnostics().finally(() => setBusy(false));
          }}
        >
          Copy
        </Button>
      </SettingsRow>
      {LINUX_ALPHA && (
        <SettingsRow label="Report a Linux bug" description="The Linux app is an alpha. Open an issue with your distribution, desktop and the diagnostics.">
          <Button size="sm" variant="outline" data-testid="report-linux-bug" onClick={() => void openUrl(LINUX_BUGS)}>
            <BugIcon />
            Report a bug
          </Button>
        </SettingsRow>
      )}
      <SettingsRow label="Documentation" description="How it works, the security model, hooks, events and the plugin SDK.">
        <Button size="sm" variant="outline" onClick={() => void openDocs("/")}>
          docs.berthd.app
          <ArrowUpRightIcon />
        </Button>
      </SettingsRow>
      <SettingsRow label="Release notes" description="Every version, on GitHub.">
        <Button size="sm" variant="outline" onClick={() => void openUrl(RELEASES)}>
          Releases
          <ArrowUpRightIcon />
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
