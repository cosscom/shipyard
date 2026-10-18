import { ShieldIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/tip";
import { ErrorText } from "@/components/error-note";

// The resource guard is a box's own: when its memory stays high, it stops
// dev servers in worktrees where no agent is working, then pauses worktrees
// whose agents are all idle or finished. See internal/box/guard.go.

export interface GuardConfig {
  enabled: boolean;
  memory_percent?: number;
  sustain?: string;
  stop_services?: boolean;
  pause_agents?: boolean;
  // A memory ceiling for each session's processes, in GB (Settings ›
  // Boxes, "Browsers and sessions"); kept here, applied by systemd.
  session_memory_gb?: number;
}

export interface GuardAction {
  at: string;
  action: "stop_services" | "pause_worktree";
  location: string;
  worktree: string;
  services?: string[];
  sessions?: string[];
  memory_percent: number;
  reason: string;
}

export interface GuardStatus {
  config: GuardConfig;
  memory: { total: number; used: number };
  memory_percent: number;
  over_since?: string;
  actions: GuardAction[];
  // Sessions run in systemd scopes here, so session_memory_gb applies.
  session_scopes?: boolean;
}

const SUSTAIN = [
  { value: "30s", label: "for 30 seconds" },
  { value: "1m", label: "for a minute" },
  { value: "2m", label: "for 2 minutes" },
  { value: "5m", label: "for 5 minutes" },
];

export function GuardDialog({ box, open, onOpenChange }: { box: string; open: boolean; onOpenChange(open: boolean): void }) {
  const [status, setStatus] = useState<GuardStatus>();
  const [draft, setDraft] = useState<GuardConfig>({ enabled: false });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const client = useStore.getState().client;
    if (!client) return;
    setError(undefined);
    client
      .box<GuardStatus>(box, "GET", "guard")
      .then((s) => {
        setStatus(s);
        setDraft(s.config);
      })
      .catch((err) => setError(plainError(err)));
  }, [box, open]);

  const save = async () => {
    const client = useStore.getState().client;
    if (!client) return;
    setSaving(true);
    try {
      const s = await client.box<GuardStatus>(box, "PUT", "guard", { config: draft });
      setStatus(s);
      toastManager.add({ title: draft.enabled ? `The guard watches ${box}` : `The guard is off on ${box}`, type: "success" });
      onOpenChange(false);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setSaving(false);
    }
  };

  const threshold = draft.memory_percent ?? 90;
  const used = status?.memory_percent ?? 0;
  const stopServices = draft.stop_services ?? true;
  const pauseAgents = draft.pause_agents ?? true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldIcon className="size-4" />
            Resource guard on {box}
          </DialogTitle>
          <DialogDescription>Keeps {box} usable when it runs short of memory, without touching agents that are working or waiting for you.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 px-5 pb-5">
          {status && status.memory.total > 0 && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
              <div className="flex items-baseline justify-between text-meta">
                <span className="text-muted-foreground">Memory now</span>
                <span className="font-mono tabular-nums">{used.toFixed(0)}%</span>
              </div>
              <Tip label={`The line is the threshold, ${threshold}%`}>
                <div role="img" aria-label={`${used.toFixed(0)}% in use; threshold ${threshold}%`} className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", used >= threshold ? "bg-warning" : "bg-foreground/50")} style={{ width: `${Math.min(used, 100)}%` }} />
                  <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${threshold}%` }} />
                </div>
              </Tip>
            </div>
          )}
          {status && status.memory.total === 0 && <p className="text-muted-foreground text-meta">This box doesn't report its memory, so the guard can't watch it.</p>}

          <label className="flex items-center gap-2.5 text-body">
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
            Watch {box}'s memory
          </label>

          <fieldset disabled={!draft.enabled} className={cn("flex flex-col gap-3", !draft.enabled && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2 text-body">
              <span>When memory stays above</span>
              <Input
                type="number"
                min={50}
                max={99}
                value={threshold}
                onChange={(e) => setDraft({ ...draft, memory_percent: Number(e.target.value) || undefined })}
                className="w-16 text-right tabular-nums"
                aria-label="Memory threshold percent"
              />
              <span>%</span>
              <div className="w-40">
                <SimpleSelect aria-label="For how long" value={draft.sustain ?? "1m"} onChange={(sustain) => setDraft({ ...draft, sustain })} options={SUSTAIN} size="sm" />
              </div>
            </div>
            <ol className="flex flex-col gap-2 text-body">
              <li className="flex items-start gap-2.5">
                <Switch checked={stopServices} onCheckedChange={(v) => setDraft({ ...draft, stop_services: v })} />
                <span>
                  First, stop dev servers in worktrees where no agent is working
                  <span className="block text-muted-foreground text-meta">Idle longest first, one worktree at a time. This frees memory straight away.</span>
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Switch checked={pauseAgents} onCheckedChange={(v) => setDraft({ ...draft, pause_agents: v })} />
                <span>
                  Then, pause worktrees whose agents are all idle or finished
                  <span className="block text-muted-foreground text-meta">Paused agents use no CPU and the box can swap them out. Resume them from the Worktrees view.</span>
                </span>
              </li>
            </ol>
          </fieldset>

          {status && status.actions.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-muted-foreground text-label">Recently</h4>
              <ul className="flex flex-col gap-1 text-meta">
                {status.actions
                  .slice()
                  .reverse()
                  .slice(0, 5)
                  .map((a) => (
                    <li key={a.at + a.worktree} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span>
                        {a.action === "stop_services" ? `Stopped ${a.services?.join(", ")} in ${a.location}/${a.worktree}` : `Paused ${a.location}/${a.worktree}`} at {a.memory_percent.toFixed(0)}%
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {error && <ErrorText className="text-destructive-foreground text-meta" text={error} />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!status}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
