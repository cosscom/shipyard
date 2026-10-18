// A plugin's helper on a box, for every plugin that carries one
// (@berth/plugin/ui's HelperBox and useHelperState): whether the program is
// off, installing, running, failed or can't run there, with Turn on (after a
// confirm that names the program), Update, Turn off and Remove data. The
// words that are a plugin's own (what its program does, what its data is)
// come in as `copy`; the states and what each one offers are the same for
// all of them, because the laptop agent and the box treat them the same.
import type { BerthPluginContext, HelperService, HelperStatus } from "@berth/plugin";
import { CircleAlert, Server, ServerOff, TriangleAlert } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

const NamedIcon = lazy(() => import("@/plugins/dynamic-icon"));

// What a plugin says of its own helper. Everything else HelperBox says is
// the same for every plugin.
export interface HelperCopy {
  // The plugin, as a sentence names it: "Leadline".
  name: string;
  // The program it puts on a box: "berth-leadline".
  program: string;
  // A lucide icon for the plugin, where it introduces itself.
  icon?: string;
  // The confirm before the program is installed or replaced: what it does
  // once it runs on the box, after the sentence that names it.
  does(box: string): ReactNode;
  // A panel on a box where it is off: what turning it on there gets you.
  about(box: string): ReactNode;
  // A box's row while it is off.
  off(box: string): ReactNode;
  // Removing what the program kept on a box.
  remove: {
    // "Remove what Leadline recorded on devl?"
    title(box: string): string;
    // What goes, after "This stops <program> on <box>, removes it, and".
    body(box: string): ReactNode;
    // The notification once it is gone: "Removed Leadline's data on devl".
    done(box: string): string;
  };
  // A helper that changes the environment of the services a box starts
  // leaves them pointing at it when it is turned off. left says so in the
  // box's row, of the services the box named ("web in acme/fix-orders", and
  // how many). A helper that changes nothing leaves this out.
  left?(services: string, count: number): string;
}

export interface HelperFault {
  message: string;
  code?: string;
  status?: number;
  hint?: string;
}

// The helper on a box, as far as it is known: its status, or why it could
// not be read. old is a laptop agent from before helpers.
export interface HelperView {
  status?: HelperStatus;
  fault?: HelperFault;
  old?: boolean;
}

function faultOf(err: unknown): HelperFault {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; status?: unknown; detail?: { error?: { hint?: unknown } } };
  const hint = e.detail?.error && typeof e.detail.error === "object" ? e.detail.error.hint : undefined;
  return {
    message: typeof e.message === "string" && e.message ? e.message : String(err),
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    hint: typeof hint === "string" ? hint : undefined,
  };
}

function shared<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

// Every plugin's helper on every box, by "plugin\nbox": a row on a screen
// and a panel in a worktree read the same answer.
const views = shared<Record<string, HelperView>>({});
const reading = new Map<string, Promise<void>>();
// The services a box was left with when a helper was turned off: started
// while it was on, still running, and still pointed at it.
const left = shared<Record<string, HelperService[]>>({});
const NONE: HelperService[] = [];

const keyOf = (berth: BerthPluginContext, box: string) => `${berth.id}\n${box}`;
const put = (key: string, view: HelperView) => views.set({ ...views.get(), [key]: view });

// readHelper asks the box what it has of the helper, once at a time.
function readHelper(berth: BerthPluginContext, box: string): Promise<void> {
  const key = keyOf(berth, box);
  let p = reading.get(key);
  if (!p) {
    p = berth.helper
      .status(box)
      .then(
        (status) => put(key, { status }),
        (err) => {
          const fault = faultOf(err);
          // The route itself is missing: the agent on this computer is older.
          put(key, { fault, old: fault.status === 404 && !fault.code });
        },
      )
      .finally(() => reading.delete(key));
    reading.set(key, p);
  }
  return p;
}

// turnOn installs the helper on a box, or updates it, and turns it on. The
// caller has asked the person first.
async function turnOn(berth: BerthPluginContext, box: string): Promise<void> {
  const key = keyOf(berth, box);
  try {
    put(key, { status: await berth.helper.install(box) });
    left.set({ ...left.get(), [key]: NONE });
  } catch (err) {
    put(key, { ...views.get()[key], fault: faultOf(err) });
    throw err;
  }
}

// turnOff stops and removes the helper; with purge, what it kept too. It
// resolves with the services the box says still point at the helper:
// nothing restarts them, so the caller says which.
async function turnOff(berth: BerthPluginContext, box: string, purge = false): Promise<HelperService[]> {
  const key = keyOf(berth, box);
  // A Shipyard from before remove() answered resolves with nothing.
  const was = (await berth.helper.remove(box, { purge })) as HelperStatus | undefined;
  const attached = was?.attached ?? NONE;
  // A helper that was already off answers with none: the services it left
  // before still point at it (removing its data after turning it off).
  if (attached.length) left.set({ ...left.get(), [key]: attached });
  await readHelper(berth, box);
  return attached;
}

const settling = (v?: HelperView) => v?.status?.state === "installing" || v?.status?.state === "starting";

// useHelperState is a plugin's helper on a box, read again while active:
// every second while it installs or starts, otherwise every fifteen. Its
// refresh reads now, for when a request to the helper said it had gone.
export function useHelperState(berth: BerthPluginContext, box: string, active: boolean): HelperView & { refresh(): void } {
  const view = useSyncExternalStore(views.subscribe, views.get)[keyOf(berth, box)];
  const busy = settling(view);
  useEffect(() => {
    if (!active) return;
    void readHelper(berth, box);
    const t = setInterval(() => void readHelper(berth, box), busy ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [berth, box, active, busy]);
  const refresh = useCallback(() => void readHelper(berth, box), [berth, box]);
  return { ...view, refresh };
}

// sentence makes what a program said read as one: a capital, and a full stop.
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

// serviceNames names worktrees' services in a sentence: "web in
// acme/fix-orders" (the project alone for its main checkout), "a, b and c".
function serviceNames(list: HelperService[]): string {
  const names = list.map((s) => `${s.service} in ${!s.worktree || s.worktree === s.location ? s.location : `${s.location}/${s.worktree}`}`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Why a box can't run the helper, and whether updating the box would help.
// The laptop answers "unsupported" for two things: the box's berthd can't
// run helpers at all (it never said its platform), or it can and the plugin
// has no build for that platform, which no update of the box changes.
function cantRun(s: HelperStatus, box: string, copy: HelperCopy): { why: string; update: boolean } {
  if (s.platform) return { why: `${copy.program} has no build for ${s.platform} yet, so it can't be installed on ${box}.`, update: false };
  return { why: sentence(s.error ?? `${box}'s berthd is from before plugins could install a program on a box`), update: true };
}

const said = (err: unknown) => String((err as Error)?.message ?? err);

function Notice({ icon, title, body, actions, testId }: { icon: ReactNode; title: string; body?: ReactNode; actions?: ReactNode; testId: string }) {
  return (
    <div className="flex h-full min-h-60 flex-1 items-center justify-center p-6" data-testid={`${testId}-notice`}>
      <Empty>
        <EmptyHeader>
          {icon}
          <EmptyTitle>{title}</EmptyTitle>
          {body && <EmptyDescription className="max-w-md text-pretty">{body}</EmptyDescription>}
        </EmptyHeader>
        {actions && <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
      </Empty>
    </div>
  );
}

const mark = "mx-auto mb-2 size-5 text-muted-foreground";

// TurnOnDialog asks before a program is put on a box, saying which.
function TurnOnDialog({ berth, copy, box, update, onClose }: { berth: BerthPluginContext; copy: HelperCopy; box?: string; update?: boolean; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [last, setLast] = useState(box);
  if (box && box !== last) setLast(box);
  // The box stays in the words while the dialog closes.
  const name = box ?? last ?? "";
  const go = async () => {
    if (!box) return;
    setBusy(true);
    setError(undefined);
    try {
      await turnOn(berth, box);
      onClose();
    } catch (err) {
      setError(said(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      open={!!box}
      onOpenChange={(open: boolean) => {
        if (!open) {
          setError(undefined);
          onClose();
        }
      }}
    >
      <AlertDialogPopup className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{update ? `Update ${copy.name} on ${name}?` : `Turn on ${copy.name} on ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            This {update ? "replaces" : "installs"} <code>{copy.program}</code>, a program this plugin carries, on {name} and keeps it running there. {copy.does(name)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="mx-6 whitespace-pre-wrap rounded-md bg-destructive/8 p-2 font-mono text-destructive-foreground text-mono">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button loading={busy} onClick={() => void go()}>
            {update ? "Update" : "Install and turn on"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export interface HelperBoxProps {
  // The plugin's own context: the helper is its own, and so are the
  // notifications.
  berth: BerthPluginContext;
  box: string;
  copy: HelperCopy;
  // "row" (the default) is the box as a line of a list of boxes, an <li>:
  // its state, its buttons, and children under a running helper (what it
  // holds). "panel" is a worktree panel's whole body on a box where the
  // helper isn't running: why, and the same Turn on.
  variant?: "row" | "panel";
  // A row only: whether the box can be reached, and whether the row is on
  // screen (nothing is read while it is not).
  online?: boolean;
  active?: boolean;
  // A panel only: opens the plugin's own screen ("About Leadline").
  onAbout?(): void;
  // The prefix of its data-testid attributes: "leadline" gives
  // leadline-box, leadline-restart and leadline-notice.
  testId?: string;
  children?: ReactNode;
}

export function HelperBox({ variant = "row", ...props }: HelperBoxProps) {
  return variant === "panel" ? <HelperPanel {...props} /> : <HelperRow {...props} />;
}

// HelperPanel says why a box has nothing to show, and what to do about it.
function HelperPanel({ berth, box, copy, onAbout, testId = "helper" }: HelperBoxProps) {
  const view = useHelperState(berth, box, false);
  const [asking, setAsking] = useState(false);
  const about = onAbout && (
    <Button size="sm" variant="ghost" onClick={onAbout}>
      About {copy.name}
    </Button>
  );
  const s = view.status;
  if (!s && !view.fault) {
    return (
      <div className="space-y-3 p-5" aria-busy="true">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (view.old) return <Notice testId={testId} icon={<CircleAlert className={mark} />} title={`Shipyard on this computer is older than ${copy.name} needs`} body="Its agent can't install a plugin's program on a box yet. Update Shipyard, then reload plugins in Settings → Plugins." />;
  if (!s) {
    return (
      <Notice
        testId={testId}
        icon={<TriangleAlert className={mark} />}
        title={`Couldn't ask ${box} about ${copy.name}`}
        body={view.fault?.message}
        actions={
          <Button size="sm" variant="outline" onClick={view.refresh}>
            Try again
          </Button>
        }
      />
    );
  }
  switch (s.state) {
    case "running":
      return null;
    case "unsupported": {
      const { why, update } = cantRun(s, box, copy);
      return (
        <Notice
          testId={testId}
          icon={<ServerOff className={mark} />}
          title={`${box} can't run ${copy.name} yet`}
          body={update ? `${why} Update the box in Settings → Boxes, then turn ${copy.name} on.` : why}
          actions={
            <>
              {update && (
                <Button size="sm" variant="outline" onClick={() => berth.openSettings("boxes")}>
                  Open Settings → Boxes
                </Button>
              )}
              {about}
            </>
          }
        />
      );
    }
    case "installing":
    case "starting":
      return (
        <Notice
          testId={testId}
          icon={<Spinner className={mark} />}
          title={s.state === "installing" ? `Installing ${copy.program} on ${box}…` : `Starting ${copy.program} on ${box}…`}
          body="This takes a moment the first time: the program is downloaded, checked against its checksum and handed to the box."
        />
      );
    case "failed":
      return (
        <Notice
          testId={testId}
          icon={<TriangleAlert className={mark} />}
          title={`${copy.program} couldn't start on ${box}`}
          body={<span className="whitespace-pre-wrap font-mono text-mono">{s.error ?? "The box didn't say why."}</span>}
          actions={
            <>
              <Button size="sm" onClick={() => void turnOn(berth, box).catch((err) => berth.notify(`Couldn't turn ${copy.name} on on ${box}`, said(err)))}>
                Try again
              </Button>
              {about}
            </>
          }
        />
      );
    default:
      return (
        <>
          <Notice
            testId={testId}
            icon={
              <Suspense fallback={null}>
                <NamedIcon name={copy.icon ?? "Plug"} className={mark} />
              </Suspense>
            }
            title={`${copy.name} is off on ${box}`}
            body={copy.about(box)}
            actions={
              <>
                <Button size="sm" onClick={() => setAsking(true)}>
                  Turn on…
                </Button>
                {about}
              </>
            }
          />
          <TurnOnDialog berth={berth} copy={copy} box={asking ? box : undefined} onClose={() => setAsking(false)} />
        </>
      );
  }
}

const STATE: Record<string, { label: string; variant: "success" | "outline" | "warning" | "info" | "error" }> = {
  running: { label: "Running", variant: "success" },
  off: { label: "Off", variant: "outline" },
  none: { label: "Can't run it", variant: "warning" },
  installing: { label: "Installing…", variant: "info" },
  starting: { label: "Starting…", variant: "info" },
  failed: { label: "Failed", variant: "error" },
  unsupported: { label: "Can't run it", variant: "warning" },
};

// HelperRow is one box of a plugin's list of boxes: what it has of the
// helper, and the switch.
function HelperRow({ berth, box, copy, online = true, active = true, testId = "helper", children }: HelperBoxProps) {
  const view = useHelperState(berth, box, active && online);
  const [asking, setAsking] = useState<"on" | "update">();
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = view.status;
  const state = s?.state;
  const running = state === "running";
  const badge = !online ? ({ label: "Offline", variant: "outline" } as const) : state ? STATE[state] : undefined;
  const still = useSyncExternalStore(left.subscribe, left.get)[keyOf(berth, box)] ?? NONE;
  // The services that still point at a helper that has gone, in a sentence.
  const restart = still.length > 0 && copy.left?.(serviceNames(still), still.length);
  const points = (list: HelperService[]) => (list.length && copy.left ? `Restart ${serviceNames(list)}: ${list.length === 1 ? "it still points" : "they still point"} at ${copy.name}.` : undefined);

  const off = async () => {
    setBusy(true);
    try {
      const body = points(await turnOff(berth, box));
      if (body) berth.notify(`${copy.name} is off on ${box}`, body);
    } catch (err) {
      berth.notify(`Couldn't turn ${copy.name} off on ${box}`, said(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3" data-testid={`${testId}-box`} data-box={box} data-state={online ? (state ?? "reading") : "offline"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-row">{box}</span>
        {badge ? (
          <Badge variant={badge.variant} size="sm" className="gap-1">
            {(state === "installing" || state === "starting") && <Spinner className="size-3" />}
            {badge.label}
          </Badge>
        ) : view.old || view.fault ? (
          <Badge variant="warning" size="sm">
            Unknown
          </Badge>
        ) : (
          <Skeleton className="h-4 w-14" />
        )}
        {s?.version && state !== "none" && (
          <span className="font-mono text-muted-foreground text-mono">
            {copy.program} {s.version}
            {s.platform && ` · ${s.platform}`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {online && running && s?.update && (
            <Button size="xs" variant="outline" onClick={() => setAsking("update")}>
              Update to {s.latest}…
            </Button>
          )}
          {online && state === "off" && (
            <Button size="xs" onClick={() => setAsking("on")}>
              Turn on…
            </Button>
          )}
          {online && state === "failed" && (
            <Button size="xs" onClick={() => setAsking("on")}>
              Try again…
            </Button>
          )}
          {online && (running || state === "failed") && (
            <Button size="xs" variant="outline" loading={busy} onClick={() => void off()}>
              Turn off
            </Button>
          )}
          {online && (running || state === "off" || state === "failed") && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(true)}>
              Remove data…
            </Button>
          )}
        </span>
      </div>
      <div className="mt-1 pl-7 text-muted-foreground text-meta">
        {!online ? (
          "Its helper can't be reached until the box is back."
        ) : view.old ? (
          `Shipyard on this computer is older than ${copy.name} needs: its agent can't install a plugin's program on a box yet. Update Shipyard.`
        ) : !s ? (
          view.fault ? (
            <span className="text-destructive-foreground">
              {view.fault.message}{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={view.refresh}>
                Try again
              </button>
            </span>
          ) : null
        ) : state === "unsupported" ? (
          cantRun(s, box, copy).update ? (
            <>
              {cantRun(s, box, copy).why} Update the box in{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => berth.openSettings("boxes")}>
                Settings → Boxes
              </button>
              .
            </>
          ) : (
            cantRun(s, box, copy).why
          )
        ) : state === "failed" ? (
          <span className="whitespace-pre-wrap text-destructive-foreground">{s.error ?? "The box didn't say why."}</span>
        ) : state === "installing" ? (
          "Downloading the program, checking it against its checksum and handing it to the box."
        ) : state === "starting" ? (
          "The box has it and is starting it."
        ) : state === "off" ? (
          <>
            {copy.off(box)}
            {restart && (
              <span className="mt-1 block text-warning-foreground" data-testid={`${testId}-restart`}>
                {restart}
              </span>
            )}
          </>
        ) : state === "none" ? (
          `This copy of the plugin names no program to install. Install ${copy.name} again from Settings → Plugins.`
        ) : null}
      </div>
      {online && running && children}
      <TurnOnDialog berth={berth} copy={copy} box={asking ? box : undefined} update={asking === "update"} onClose={() => setAsking(undefined)} />
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.remove.title(box)}</AlertDialogTitle>
            <AlertDialogDescription>
              This stops <code>{copy.program}</code> on {box}, removes it, and {copy.remove.body(box)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const body = points(await turnOff(berth, box, true));
                  setRemoving(false);
                  berth.notify(copy.remove.done(box), body);
                } catch (err) {
                  berth.notify(`Couldn't remove ${copy.name}'s data on ${box}`, said(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove data
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}
