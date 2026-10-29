import { ChevronDownIcon, ExternalLinkIcon, MonitorSmartphoneIcon, PlayIcon, RotateCwIcon, ScrollTextIcon, Settings2Icon, SquareIcon, SquareTerminalIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { openProjectSettings } from "@/components/skills/project-settings-dialog";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { serviceRunning, showServiceTerminal } from "@/components/workspace/service-terminal";
import { toastManager } from "@/components/ui/toast";
import { boxApi, type WorktreeService } from "@/lib/api";
import { portUrl } from "@/lib/browser-url";
import { errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusedPane, openFor, useHereRef, type WorktreeRef } from "@/lib/workspaces";
import { contribute } from "@/plugins/registry";

type Action = "start" | "stop" | "restart";

// useWorktreeServices is a worktree's services, refetched when their events
// say something changed.
export function useWorktreeServices(ref?: WorktreeRef) {
  const client = useStore((s) => s.client);
  const [services, setServices] = useState<WorktreeService[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!client || !ref) return;
    try {
      setServices(await boxApi.worktreeServices(client, ref.box, ref.location, ref.worktree));
      setError(undefined);
    } catch (err) {
      setServices([]);
      setError(plainError(err));
    }
  }, [client, ref?.box, ref?.location, ref?.worktree]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setServices(undefined);
    void load();
    if (!ref) return;
    return contribute("handlers", {
      plugin: "app",
      item: {
        type: "service.*",
        handler: (e) => {
          if (e.box === ref.box && e.data?.path === ref.path) void load();
        },
      },
    });
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  return { services, error, reload: load, setServices };
}


// RunMenu is the tab strip's Run button: the services (dev servers, from
// its repository's .berth/config.json) of the worktree you are acting in,
// the focused pane's, each on that worktree's ports.
export function RunMenu() {
  const ref = useHereRef();
  const { services, error, reload, setServices } = useWorktreeServices(ref);
  const [busy, setBusy] = useState<string>();
  // A service in a terminal is as its session says: Ctrl-C there stops it.
  const sessions = useStore((s) => (ref ? s.boxes[ref.box]?.sessions : undefined));
  // Nothing runs on a box that is away; the button says so.
  const away = useStore((s) => !!ref && !!s.status && s.status.boxes.find((b) => b.name === ref.box)?.state !== "online");
  const live = (svc: WorktreeService) => serviceRunning(svc, sessions);
  if (!ref) return null;

  const primary = services?.find((s) => s.autostart) ?? services?.[0];
  const running = primary && live(primary);

  const act = async (svc: WorktreeService, action: Action) => {
    const client = useStore.getState().client;
    if (!client) return;
    setBusy(svc.name);
    try {
      const next = await boxApi.serviceAction(client, ref.box, ref.location, ref.worktree, svc.name, action);
      setServices((list) => list?.map((s) => (s.name === svc.name ? { ...s, ...next } : s)));
    } catch (err) {
      toastManager.add({ title: `Could not ${action} ${svc.name}`, description: errorMessage(err), type: "error" });
      void reload();
    } finally {
      setBusy(undefined);
    }
  };

  const urlFor = (svc: WorktreeService) => {
    const st = useStore.getState();
    const services = st.boxes[ref.box]?.services ?? [];
    const port = svc.port ?? services.filter((s) => s.path === ref.path).map((s) => s.port).sort((a, b) => a - b)[0];
    return port ? portUrl(port, { ref, services, urlPort: st.status?.proxy.url_port }) : undefined;
  };

  // Beside the focused pane, so the terminal and its page sit together.
  const openPage = (svc: WorktreeService) => {
    const url = urlFor(svc);
    if (url) openFor({ kind: "browser", url }, { split: focusedPane() ? "row" : undefined });
  };
  const openPreview = (svc: WorktreeService) => {
    const url = urlFor(svc);
    if (url) openFor({ kind: "preview", url });
  };
  const viewLog = (svc: WorktreeService) => openFor({ kind: "log", box: ref.box, location: ref.location, worktree: ref.worktree, service: svc.name });

  const onPrimary = () => {
    if (!primary) return;
    if (running) openPage(primary);
    else void act(primary, "start");
  };

  return (
    <div className="flex h-6.5 items-stretch rounded-md text-meta">
      <Tip label={away ? `${ref.box} is offline, so nothing can start there` : primary ? (running ? `Open ${primary.name}` : `Start ${primary.name}: ${primary.run}`) : "This repository defines no services"} side="bottom">
        <button
          type="button"
          // Not disabled when there is nothing to run, so the tooltip can say why.
          aria-disabled={!primary || busy !== undefined || away}
          onClick={() => primary && busy === undefined && !away && onPrimary()}
          className="flex items-center gap-1.5 rounded-l-md px-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-disabled:opacity-45 aria-disabled:hover:bg-transparent"
        >
          {busy ? <Spinner className="size-3" /> : running ? <span className="size-1.5 rounded-full bg-success" /> : <PlayIcon className="size-3" />}
          {running ? primary.name : "Run"}
        </button>
      </Tip>
      <Menu
        onOpenChange={(open) => {
          if (open) void reload();
        }}
      >
        <MenuTrigger render={<button type="button" aria-label="Services" className="flex min-w-6 items-center justify-center rounded-r-md px-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-popup-open:bg-foreground/9" />}>
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-64">
          {services === undefined && (
            <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground text-meta">
              <Spinner className="size-3" /> Loading services…
            </div>
          )}
          {services?.length === 0 && (
            <div className="max-w-64 px-2 py-2 text-muted-foreground text-meta">
              {error ?? `${ref.location} defines no services yet. Add a dev server so every worktree can run its own on its own ports.`}
            </div>
          )}
          {services?.map((svc, i) => (
            <MenuGroup key={svc.name}>
              {i > 0 && <MenuSeparator />}
              <MenuGroupLabel className="flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", live(svc) ? "bg-success" : svc.state === "failed" ? "bg-destructive" : "bg-muted-foreground/40")} />
                <span className="font-medium text-foreground">{svc.name}</span>
                <span className="truncate font-mono text-tag">{svc.terminal ? (live(svc) ? "running" : "stopped") : svc.state}{svc.port ? ` · :${svc.port}` : ""}</span>
              </MenuGroupLabel>
              {live(svc) ? (
                <>
                  <MenuItem onClick={() => void act(svc, "stop")}>
                    <SquareIcon />
                    Stop
                  </MenuItem>
                  <MenuItem onClick={() => void act(svc, "restart")}>
                    <RotateCwIcon />
                    Restart
                  </MenuItem>
                </>
              ) : (
                <MenuItem onClick={() => void act(svc, "start")}>
                  <PlayIcon />
                  Start
                </MenuItem>
              )}
              {svc.terminal && svc.session && (
                <MenuItem onClick={() => void showServiceTerminal(ref, svc)}>
                  <SquareTerminalIcon />
                  Show terminal
                </MenuItem>
              )}
              <MenuItem onClick={() => viewLog(svc)}>
                <ScrollTextIcon />
                View log
              </MenuItem>
              <MenuItem disabled={!urlFor(svc)} onClick={() => openPage(svc)}>
                <ExternalLinkIcon />
                Open in browser tab
              </MenuItem>
              <MenuItem disabled={!urlFor(svc)} onClick={() => openPreview(svc)}>
                <MonitorSmartphoneIcon />
                Preview sizes
              </MenuItem>
            </MenuGroup>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => openProjectSettings(ref.box, ref.location)}>
            <Settings2Icon />
            Project settings…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

