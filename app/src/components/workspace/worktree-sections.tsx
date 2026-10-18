import { CableIcon, ChevronRightIcon, CopyIcon, DatabaseIcon, GlobeIcon, MonitorIcon, MonitorSmartphoneIcon, PlayIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWorktreeServices } from "@/components/workspace/run-menu";
import { ServiceIcon, serviceRunning, showServiceTerminal } from "@/components/workspace/service-terminal";
import { boxApi, type WorktreeService } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { toastManager } from "@/components/ui/toast";
import { openBrowserAt, openPreviewAt } from "@/lib/actions";
import { hostSuffix, worktreeHost } from "@/lib/browser-url";
import { copyText } from "@/lib/clipboard";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { type LiveService, liveServices } from "@/lib/worktree-services";
import type { WorktreeRef } from "@/lib/workspaces";
import { PluginBoundary, pluginContexts } from "@/plugins/plugin-boundary";
import { useRegistry } from "@/plugins/registry";
import { useTitleAt } from "@/lib/worktree-names";

// WorktreeSections sit under the composer wherever work starts in a
// worktree (its launcher, and a new agent's first prompt): what runs there,
// each with its private URL to open in a tab or copy, then what plugins add
// with berth.addWorktreeSection.
export function WorktreeSections({ worktree: ref, className }: { worktree: WorktreeRef; className?: string }) {
  const sections = useRegistry((s) => s.worktreeSections);
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <LiveServices worktree={ref} />
      {sections.map(({ plugin, item }) => {
        const ctx = pluginContexts.get(plugin);
        if (!ctx) return null;
        const { Component } = item;
        return (
          <section key={`${plugin}:${item.id}`} aria-label={item.title}>
            {item.title && <Heading>{item.title}</Heading>}
            <PluginBoundary plugin={plugin}>
              <Component berth={ctx} box={ref.box} location={ref.location} worktree={ref.worktree} path={ref.path} main={ref.main} />
            </PluginBoundary>
          </section>
        );
      })}
    </div>
  );
}

// SessionWorktreeSections is WorktreeSections for the worktree a session
// runs in.
export function SessionWorktreeSections({ box, session, className }: { box: string; session: string; className?: string }) {
  const dir = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session)?.dir);
  const locations = useStore((s) => s.boxes[box]?.locations);
  const ref = useMemo<WorktreeRef | undefined>(() => {
    for (const l of locations ?? []) {
      const w = l.worktrees?.find((x) => x.path === dir);
      if (w) return { box, location: l.name, worktree: w.name, path: w.path, main: w.main };
    }
    return undefined;
  }, [box, dir, locations]);
  return ref ? <WorktreeSections worktree={ref} className={className} /> : null;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-1 px-2 text-label text-muted-foreground">{children}</h2>;
}

const ICONS = { dev: MonitorIcon, web: GlobeIcon, data: DatabaseIcon, other: CableIcon };

// LiveServices is what listens in the worktree: what opens in a tab and its
// data stores, then helpers (an agent's headless Chrome, a language server)
// folded away under "Other ports". With nothing yet, it says where the dev
// server's page will be.
function LiveServices({ worktree: ref }: { worktree: WorktreeRef }) {
  const services = useStore((s) => s.boxes[ref.box]?.services ?? NONE);
  const urlPort = useStore((s) => s.status?.proxy.url_port);
  const devPort = useStore((s) => s.boxes[ref.box]?.locations?.find((l) => l.name === ref.location)?.worktrees?.find((w) => w.path === ref.path)?.port);
  const own = useWorktreeServices(ref);
  const sessions = useStore((s) => s.boxes[ref.box]?.sessions);
  // What listens on the worktree's own port is its running service when the
  // box can't name the process (macOS often can't).
  const ownRun = own.services?.find((svc) => serviceRunning(svc, sessions))?.run;
  const named = useMemo(() => (ownRun ? services.map((s) => (!s.process && s.path === ref.path && s.port === devPort ? { ...s, process: ownRun } : s)) : services), [services, ownRun, ref.path, devPort]);
  const rows = useMemo(() => liveServices(named, { ref, services: named, urlPort }, devPort), [named, ref, urlPort, devPort]);
  const [showOther, setShowOther] = useState(false);
  const name = useTitleAt(ref.box, ref.path) ?? (ref.main ? ref.location : ref.worktree);
  const host = worktreeHost(ref);
  const main = rows.filter((r) => r.kind !== "other");
  const other = rows.filter((r) => r.kind === "other");

  return (
    <section aria-label={`Running in ${name}`} className="min-w-0">
      <Heading>Running in {name}</Heading>
      <TerminalServices worktree={ref} own={own} />
      {main.length ? (
        <ul className="flex min-w-0 flex-col">
          {main.map((r) => (
            <ServiceRow key={r.port} row={r} />
          ))}
        </ul>
      ) : (
        <p className="px-2 text-desc text-muted-foreground">
          Nothing to open yet.{" "}
          {devPort ? (
            <>
              A dev server on <code className="font-mono text-mono text-foreground/80">$BERTH_PORT</code> ({devPort}) opens at{" "}
              {host ? <code className="break-all font-mono text-mono text-foreground/80">{`http://${host}${hostSuffix(urlPort)}/`}</code> : "its private URL"}.
            </>
          ) : (
            "Start a dev server here and its private URL shows up."
          )}
        </p>
      )}
      {other.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={showOther}
            onClick={() => setShowOther(!showOther)}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground text-meta outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", showOther && "rotate-90")} />
            Other ports ({other.length})
          </button>
          {showOther && (
            <ul className="flex min-w-0 flex-col">
              {other.map((r) => (
                <ServiceRow key={r.port} row={r} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// TerminalServices are the worktree's services that run in a terminal of
// their own: each with its state, Start when it is stopped, and its tab.
function TerminalServices({ worktree: ref, own: { services, reload } }: { worktree: WorktreeRef; own: ReturnType<typeof useWorktreeServices> }) {
  const sessions = useStore((s) => s.boxes[ref.box]?.sessions);
  const [busy, setBusy] = useState<string>();
  const rows = (services ?? []).filter((s) => s.terminal && s.session);
  if (!rows.length) return null;
  const start = async (svc: WorktreeService) => {
    const client = useStore.getState().client;
    if (!client) return;
    setBusy(svc.name);
    try {
      await boxApi.serviceAction(client, ref.box, ref.location, ref.worktree, svc.name, "start");
      await useStore.getState().refreshBox(ref.box, ["sessions"]);
    } catch (err) {
      toastManager.add({ title: `Could not start ${svc.name}`, description: errorMessage(err), type: "error" });
    } finally {
      setBusy(undefined);
      void reload();
    }
  };
  return (
    <ul className="flex min-w-0 flex-col">
      {rows.map((svc) => {
        const running = serviceRunning(svc, sessions);
        return (
          <li key={svc.name} className="flex h-10 min-w-0 items-center gap-3 rounded-md px-2 text-body hover:bg-accent/60">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <ServiceIcon className="size-4" />
            </span>
            <span className="flex min-w-0 max-w-[45%] shrink-0 items-baseline gap-1.5">
              <span className="truncate text-row">{svc.title || svc.name}</span>
              {svc.title && svc.title !== svc.name && <span className="truncate font-mono text-meta text-muted-foreground">{svc.name}</span>}
            </span>
            <Tip label={<span className="block max-w-sm break-all font-mono text-tag">{svc.run}</span>}>
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">{svc.run}</span>
            </Tip>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-meta", running ? "text-foreground/80" : "text-muted-foreground")}>
              <span className={cn("size-1.5 rounded-full", running ? "bg-success" : "bg-muted-foreground/40")} />
              {running ? "Running" : "Stopped"}
            </span>
            {running ? (
              <span aria-hidden className="size-6 shrink-0" />
            ) : (
              <Tip label={`Start ${svc.title || svc.name}`}>
                <Button size="icon-xs" variant="ghost" aria-label={`Start ${svc.title || svc.name}`} disabled={busy === svc.name} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => void start(svc)}>
                  {busy === svc.name ? <Spinner className="size-3" /> : <PlayIcon />}
                </Button>
              </Tip>
            )}
            <Button size="xs" variant="outline" className="shrink-0" onClick={() => void showServiceTerminal(ref, svc)}>
              Show terminal
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function ServiceRow({ row: r }: { row: LiveService }) {
  const Icon = ICONS[r.kind];
  const web = r.kind === "dev" || r.kind === "web";
  const address = web ? r.url : `localhost:${r.port}`;
  return (
    <li className="flex h-10 min-w-0 items-center gap-3 rounded-md px-2 text-body hover:bg-accent/60">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <Tip label={r.command ? <span className="block max-w-sm break-all font-mono text-tag">{r.command}</span> : undefined}>
        <span className="flex min-w-0 max-w-[45%] shrink-0 items-baseline gap-1.5">
          <span className={cn("truncate text-row", r.kind === "other" && "font-normal text-muted-foreground")}>{r.label}</span>
          {r.detail && <span className="truncate text-meta text-muted-foreground">{r.detail}</span>}
        </span>
      </Tip>
      <Tip label={<span className="break-all font-mono">{r.url}</span>}>
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">{r.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
      </Tip>
      <span className="shrink-0 rounded bg-accent px-1.5 py-px font-mono text-tag text-muted-foreground tabular-nums">:{r.port}</span>
      <Tip label={web ? "Copy URL" : "Copy address"}>
        <Button size="icon-xs" variant="ghost" aria-label={`Copy ${r.label}'s ${web ? "URL" : "address"}`} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => void copyText(address, web ? "Copied the URL" : "Copied the address")}>
          <CopyIcon />
        </Button>
      </Tip>
      {web && (
        <Tip label="This page at every size: phones, tablet and Tailwind's breakpoints">
          <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => openPreviewAt(r.url)}>
            <MonitorSmartphoneIcon />
            Preview
          </Button>
        </Tip>
      )}
      {web ? (
        <Button size="xs" variant="outline" className="shrink-0" onClick={() => openBrowserAt(r.url)}>
          Open in tab
        </Button>
      ) : (
        // Keeps the rows' buttons in one column.
        <Button aria-hidden tabIndex={-1} size="xs" variant="outline" className="invisible shrink-0">
          Open in tab
        </Button>
      )}
    </li>
  );
}
