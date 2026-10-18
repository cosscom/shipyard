import { PlayIcon, ServerCogIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { boxApi, type Session, type WorktreeService } from "@/lib/api";
import { worktreeOf } from "@/lib/derive";
import { errorMessage } from "@/lib/format";
import { load, save } from "@/lib/storage";
import { scheduleRefresh, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession, type WorktreeRef } from "@/lib/workspaces";

// A service with "terminal": true runs in a terminal of its own on the box
// (a tmux session that says which service it is), shown as a tab in its
// worktree. The tab is the service's window, not its life: closing it only
// hides it, Ctrl-C in it stops the service, and Start runs it again in the
// same tab.

export function ServiceIcon({ className }: { className?: string }) {
  return <ServerCogIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export const boxHasServiceTerminals = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("service.terminal");

// serviceSession is a terminal service's session as the box lists it.
export function serviceSession(sessions: Session[] | undefined, svc: Pick<WorktreeService, "session">): Session | undefined {
  return svc.session ? sessions?.find((s) => s.name === svc.session) : undefined;
}

// serviceRunning is whether a service runs, its terminal's session being
// the truth for one in a terminal: Ctrl-C there stops it between polls.
export function serviceRunning(svc: WorktreeService, sessions: Session[] | undefined): boolean {
  if (svc.terminal && svc.session && sessions) {
    const s = serviceSession(sessions, svc);
    return !!s && !s.exited;
  }
  return svc.state === "running" || svc.state === "activating" || svc.state === "active";
}

async function act(ref: Pick<WorktreeRef, "box" | "location" | "worktree">, service: string, action: "start" | "stop") {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    await boxApi.serviceAction(client, ref.box, ref.location, ref.worktree, service, action);
  } catch (err) {
    toastManager.add({ title: `Could not ${action} ${service}`, description: errorMessage(err), type: "error" });
  } finally {
    scheduleRefresh(ref.box, ["sessions", "services"]);
  }
}

// showServiceTerminal brings a service's terminal forward as a tab, starting
// the service first when it has never run.
export async function showServiceTerminal(ref: Pick<WorktreeRef, "box" | "location" | "worktree">, svc: WorktreeService) {
  if (!svc.session) return;
  const st = useStore.getState();
  if (!st.boxes[ref.box]?.sessions?.some((s) => s.name === svc.session)) {
    await act(ref, svc.name, "start");
    await st.refreshBox(ref.box, ["sessions"]);
  }
  await focusSession(ref.box, svc.session);
}

// ServiceStopped sits at the top right of a stopped service's terminal,
// clear of its last output and of tmux's own "stopped" line at the bottom,
// and starts it again there.
export function ServiceStopped({ box, session }: { box: string; session: Session }) {
  const locations = useStore((s) => s.boxes[box]?.locations);
  const [busy, setBusy] = useState(false);
  const where = worktreeOf(locations, session);
  const name = session.title?.trim() || session.service!;
  const start = async () => {
    if (!where || !session.service) return;
    setBusy(true);
    await act({ box, location: where.location.name, worktree: where.worktree.name }, session.service, "start");
    setBusy(false);
  };
  return (
    <div className="pointer-events-none absolute top-2 right-3 z-10 flex justify-end">
      <div role="status" className="pointer-events-auto flex items-center gap-2.5 rounded-lg border bg-popover/95 py-1 pr-1 pl-3 text-meta shadow-lg/5 backdrop-blur-sm">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        <span>
          <span className="font-medium">{name}</span> <span className="text-muted-foreground">stopped</span>
        </span>
        <Button size="xs" disabled={busy || !where} onClick={() => void start()}>
          {busy ? <Spinner className="size-3" /> : <PlayIcon />}
          Start
        </Button>
      </div>
    </div>
  );
}

// serviceKeepsRunning says, the first time a service's tab closes, that the
// service carries on and where its terminal is.
const TIP_KEY = "berth.serviceCloseTip";

export function serviceKeepsRunning(box: string, session: Session) {
  if (load(TIP_KEY, false)) return;
  save(TIP_KEY, true);
  const name = session.title?.trim() || session.service || "The service";
  const id = toastManager.add({
    title: session.exited ? `Closed ${name}'s terminal` : `${name} keeps running`,
    description: "Closing a service's tab only hides it, unlike an agent's. Show terminal in the Run menu or under Running in brings it back; stop it there or with Ctrl-C in its tab.",
    type: "info",
    actionProps: {
      children: "Reopen",
      onClick: () => {
        toastManager.close(id);
        void focusSession(box, session.name);
      },
    },
  });
}
