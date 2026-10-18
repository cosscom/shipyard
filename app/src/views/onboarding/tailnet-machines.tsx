import { CheckIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { Discovery, Machine } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { openUrl } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { GuidedInstall, type TeamAfterInstall, useAgentChoice, useInstallTarget } from "@/views/onboarding/guided-install";
import { InlineAgents, QuickInstall } from "@/views/onboarding/quick-install";
import { useSshPlan } from "@/views/onboarding/ssh-setup";
import { discoverNetwork, type SystemTailnet, sortMachines, type TailnetSource } from "@/views/onboarding/tailnet";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

// TailnetMachines lists the machines on a tailnet this computer reaches,
// each with Set up: Shipyard logs in over SSH once, installs berthd (which
// listens on the machine's tailnet address only) and pairs. With more than
// one tailnet (this Mac's, and ones Shipyard signed in to), tabs switch.
export function TailnetMachines({
  sources,
  system,
  active,
  onActive,
  autoFocus,
  onRunning,
  onPaired,
  onSignIn,
  readyLabel,
  team,
}: {
  sources: TailnetSource[];
  system?: SystemTailnet;
  active: string;
  onActive(key: string): void;
  autoFocus?: boolean;
  onRunning(running: boolean): void;
  onPaired(box: string): void;
  onSignIn(): void;
  readyLabel?: string;
  team?: TeamAfterInstall;
}) {
  const source = sources.find((s) => s.key === active) ?? sources[0];
  const found = useDiscovery(source, system);
  // The machine being set up, by IP; one at a time.
  const [picked, setPicked] = useState<string>();
  const [running, setRunning] = useState(false);
  useEffect(() => setPicked(undefined), [source?.key]);

  return (
    <section aria-labelledby="tailnet-heading">
      <div className="mb-2 flex h-6 min-w-0 items-center gap-2">
        <h2 id="tailnet-heading" className="shrink-0 text-row">
          On your tailnet
        </h2>
        {sources.length === 1 && <span className="min-w-0 truncate text-muted-foreground text-meta">{source.label}</span>}
        <Button size="xs" variant="ghost" data-focus-skip="" className="-me-2 ms-auto shrink-0 text-muted-foreground" disabled={running} onClick={onSignIn}>
          <PlusIcon /> Sign in to another tailnet
        </Button>
      </div>
      {sources.length > 1 && (
        <Tabs value={source.key} onValueChange={(v) => !running && onActive(String(v))} className="mb-2">
          <TabsList size="sm">
            {sources.map((s) => (
              <TabsTab key={s.key} value={s.key} disabled={running && s.key !== source.key}>
                {s.label}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
      )}
      <MachineList
        key={source.key}
        source={source}
        found={found}
        picked={picked}
        running={running}
        autoFocus={autoFocus}
        onPick={setPicked}
        onRunning={(r) => {
          setRunning(r);
          onRunning(r);
        }}
        onPaired={onPaired}
        onSignIn={onSignIn}
        readyLabel={readyLabel}
        team={team}
      />
    </section>
  );
}

type Found = { state: "loading" } | { state: "error"; message: string; retry(): void } | { state: "ok"; discovery: Discovery };

// useDiscovery is the machine list for a source: this Mac's tailnet comes
// with the screen; a Shipyard network's is read when its tab is chosen.
function useDiscovery(source: TailnetSource | undefined, system?: SystemTailnet): Found {
  const client = useStore((s) => s.client);
  const [found, setFound] = useState<Found>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const network = source?.network;
  useEffect(() => {
    if (!client || !network) return;
    let live = true;
    setFound({ state: "loading" });
    discoverNetwork(client, network, nonce > 0).then(
      (d) => live && setFound({ state: "ok", discovery: d }),
      (err) => live && setFound({ state: "error", message: plainError(err), retry: () => setNonce((n) => n + 1) }),
    );
    return () => {
      live = false;
    };
  }, [client, network, nonce]);
  if (!network) return system?.discovery ? { state: "ok", discovery: system.discovery } : { state: "loading" };
  return found;
}

// A list this long gets a filter.
const FILTER_FROM = 7;

function MachineList({
  source,
  found,
  picked,
  running,
  autoFocus,
  onPick,
  onRunning,
  onPaired,
  onSignIn,
  readyLabel,
  team,
}: {
  source: TailnetSource;
  found: Found;
  picked?: string;
  running: boolean;
  autoFocus?: boolean;
  onPick(ip?: string): void;
  onRunning(running: boolean): void;
  onPaired(box: string): void;
  onSignIn(): void;
  readyLabel?: string;
  team?: TeamAfterInstall;
}) {
  const [filter, setFilter] = useState("");
  const all = useMemo(() => (found.state === "ok" ? sortMachines(found.discovery.machines) : []), [found]);
  const q = filter.trim().toLowerCase();
  const machines = q ? all.filter((m) => m.name.toLowerCase().includes(q) || m.os.toLowerCase().includes(q)) : all;
  const machine = all.find((m) => m.ip === picked);
  const firstSettable = machines.find((m) => m.online && !m.box);

  if (found.state === "loading") {
    return (
      <div className="flex h-24 items-center justify-center gap-2 rounded-lg border text-muted-foreground text-body">
        <Spinner className="size-4" /> Listing machines…
      </div>
    );
  }
  if (found.state === "error") {
    const login = /needs a login/i.test(found.message);
    return (
      <div className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-lg border px-3.5 py-3 text-body">
        <span>{login ? `Shipyard is signed out of ${source.label}.` : `Couldn't list the machines on ${source.label}.`}</span>
        {!login && <span className="text-muted-foreground text-meta">{found.message}</span>}
        <Button size="xs" variant="outline" onClick={login ? onSignIn : found.retry}>
          {login ? "Sign in again" : "Try again"}
        </Button>
      </div>
    );
  }
  if (all.length === 0) {
    return (
      <div className="flex min-h-24 items-center rounded-lg border px-3.5 py-3 text-muted-foreground text-body">
        Nothing on {source.label} can be a box yet: berthd runs on Linux and macOS. Add a machine to the tailnet, or run the command below on any box.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {all.length >= FILTER_FROM && (
        <label className="flex h-9 items-center gap-2 border-b px-3 text-muted-foreground">
          <SearchIcon aria-hidden className="size-3.5 shrink-0" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${all.length} machines`}
            aria-label="Filter machines"
            spellCheck={false}
            autoComplete="off"
            data-focus-skip=""
            className="h-full min-w-0 flex-1 bg-transparent text-foreground text-body outline-none placeholder:text-muted-foreground/72"
          />
        </label>
      )}
      {/* At most about five rows tall, whatever the tailnet's size. */}
      <ul aria-label={`Machines on ${source.label}`} className="max-h-[201px] divide-y divide-border/70 overflow-y-auto">
        {machines.map((m) => (
          <MachineRow
            key={m.ip}
            machine={m}
            picked={m.ip === picked}
            locked={running}
            autoFocus={autoFocus && m === firstSettable && !picked}
            onPick={() => onPick(m.ip === picked ? undefined : m.ip)}
          />
        ))}
        {machines.length === 0 && <li className="flex h-10 items-center px-3 text-muted-foreground text-body">No machine matches “{filter.trim()}”.</li>}
      </ul>
      {machine && found.state === "ok" && (
        <MachineSetup
          key={machine.ip}
          machine={machine}
          user={found.discovery.user}
          network={source.network}
          onRunning={onRunning}
          onPaired={onPaired}
          onClose={() => onPick(undefined)}
          readyLabel={readyLabel}
          team={team}
        />
      )}
    </div>
  );
}

function MachineRow({ machine: m, picked, locked, autoFocus, onPick }: { machine: Machine; picked: boolean; locked: boolean; autoFocus?: boolean; onPick(): void }) {
  const kind = m.os === "linux" ? "Linux" : m.os;
  return (
    <li className={cn("flex h-10 items-center gap-2.5 ps-3 pe-2", picked && "bg-accent/50", !m.online && !m.box && "text-muted-foreground")}>
      <Tip label={m.online ? "Online" : "Offline"}>
        <span role="img" aria-label={m.online ? "Online" : "Offline"} className={cn("size-1.5 shrink-0 rounded-full", m.online ? "bg-success" : "bg-muted-foreground/40")} />
      </Tip>
      <span className="min-w-0 truncate text-row">{m.name}</span>
      <span className="hidden shrink-0 text-muted-foreground text-meta sm:inline">
        {kind}
        {m.ssh ? " · Tailscale SSH" : ""}
      </span>
      <span className="ms-auto flex shrink-0 items-center">
        {m.box ? (
          <span className="flex items-center gap-1 pe-1 text-muted-foreground text-meta">
            <CheckIcon className="size-3.5" /> Paired as {m.box}
          </span>
        ) : !m.online ? (
          <span className="pe-1 text-muted-foreground text-meta">Offline</span>
        ) : picked ? (
          <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={locked} onClick={onPick}>
            Cancel
          </Button>
        ) : (
          <Tip label={locked ? "Another machine is being set up" : undefined}>
            <Button size="xs" variant="outline" disabled={locked} autoFocus={autoFocus} onClick={onPick} aria-label={`Set up ${m.name}`}>
              Set up
            </Button>
          </Tip>
        )}
      </span>
    </li>
  );
}

// boxName is a machine's name as a box name, unless a box has it already
// (then the box's own hostname decides, with a number if need be).
function boxName(machine: string, taken: string[]): string {
  const name = machine.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return taken.includes(name) ? "" : name;
}

// MachineSetup sets one machine up: who to log in as, then the install as
// it happens. A Mac is set up with the install command instead.
function MachineSetup({
  machine: m,
  user: suggested,
  network,
  onRunning,
  onPaired,
  onClose: _onClose,
  readyLabel,
  team,
}: {
  machine: Machine;
  user: string;
  network?: string;
  onRunning(running: boolean): void;
  onPaired(box: string): void;
  onClose(): void;
  readyLabel?: string;
  team?: TeamAfterInstall;
}) {
  const [agents, setAgents] = useAgentChoice();
  // A Shipyard network is dialed by address; this Mac's tailnet by name.
  const host = network ? m.ip : m.dns_name || m.ip;
  const plan = useSshPlan(m.os === "linux" ? host : "", network);
  const boxes = useStore((s) => s.status?.boxes);
  const [user, setUser] = useState(suggested);
  const [touched, setTouched] = useState(false);
  const [name, setName] = useState(() => boxName(m.name, boxes?.map((b) => b.name) ?? []));
  // Install and pair opens the quick install's dialog (from Team setup, the
  // guided install, full screen).
  const install = useInstallTarget();
  const running = !!install.target;
  const state = running ? "running" : "ready";
  useEffect(() => onRunning(running), [running, onRunning]);

  // ssh's own answer for the user (~/.ssh/config's User), until one is typed.
  const planned = plan && plan !== "loading" ? plan.user : undefined;
  useEffect(() => {
    if (planned && !touched) setUser(planned);
  }, [planned, touched]);

  if (m.os !== "linux") {
    return (
      <div className="border-t p-3">
        <p className="text-muted-foreground text-meta">
          Shipyard sets up Linux machines over SSH. On a Mac like {m.name}, run the command in step 1 below, then paste what it prints into step 2.
        </p>
      </div>
    );
  }

  const go = () => {
    const u = user.trim();
    if (/[\s@]/.test(u)) return;
    install.open({ host: `${u ? `${u}@` : ""}${host}`, name: name.trim() || undefined, network, knownHostKeys: m.host_keys });
  };
  const userError = /@/.test(user) ? `Only the user: Shipyard connects to ${m.name}.` : /\s/.test(user.trim()) ? "A user name has no spaces." : undefined;

  return (
    <div className="border-t p-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2.5 font-mono text-desc shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32">
          <input
            autoFocus
            value={user}
            disabled={running}
            onChange={(e) => {
              setUser(e.target.value);
              setTouched(true);
            }}
            aria-label={`SSH user on ${m.name}`}
            aria-invalid={userError ? true : undefined}
            placeholder="user"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            style={{ width: `${(user.length || 4) + 0.25}ch` }}
            className="h-full min-w-0 shrink-0 bg-transparent outline-none placeholder:text-muted-foreground/72 disabled:opacity-64"
          />
          <span className="min-w-0 truncate text-muted-foreground">@{host}</span>
        </div>
        <Button type="submit" size="sm" className="shrink-0" disabled={!!userError || running} data-testid="machine-install">
          Install and pair
        </Button>
      </form>
      <div aria-live="polite" className="mt-2 flex min-h-5 min-w-0 items-center gap-1.5 text-muted-foreground text-meta">
        {userError ? (
          <span className="text-destructive-foreground">{userError}</span>
        ) : m.ssh ? (
          <>
            <ShieldCheckIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">Tailscale SSH: no keys needed</span>
          </>
        ) : plan === "loading" ? (
          <>
            <Spinner className="size-3" /> Reading your SSH setup…
          </>
        ) : plan ? (
          <>
            <KeyRoundIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{plan.summary}</span>
          </>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          named
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="after its hostname"
            aria-label="Name in Shipyard"
            spellCheck={false}
            disabled={running}
            className="h-5 w-28 border-input border-b bg-transparent px-0.5 text-foreground outline-none placeholder:text-muted-foreground/72 focus:border-ring"
          />
        </span>
      </div>
      {!team && <InlineAgents value={agents} onChange={setAgents} disabled={running} />}
      {state === "ready" && (
        <p className="mt-1 text-muted-foreground text-meta">
          Shipyard logs in once to install berthd for that user. It listens on {m.name}'s tailnet address only, and Shipyard never needs SSH for it again.
        </p>
      )}
      {team ? (
        <GuidedInstall
          target={install.target}
          readyLabel={readyLabel}
          team={team}
          onClose={install.close}
          onReady={(box) => {
            install.close();
            onPaired(box);
          }}
        />
      ) : (
        <QuickInstall
          target={install.target && { ...install.target, agents }}
          readyLabel={readyLabel}
          onClose={install.close}
          onReady={(box) => {
            install.close();
            onPaired(box);
          }}
        />
      )}
    </div>
  );
}

// UseTailscale is the tailnet path while this Mac can't list one: what
// Tailscale gives you here, and the one thing to do about its state.
export function UseTailscale({ system, onRefresh, onSignIn }: { system?: SystemTailnet; onRefresh(): void; onSignIn(): void }) {
  const state = system?.state ?? "unknown";
  const said =
    state === "missing"
      ? undefined
      : state === "logged-out"
        ? "Tailscale is on this Mac, but signed out. Sign in from its menu bar icon and your machines show up here."
        : state === "stopped"
          ? "Tailscale is on this Mac, but not connected. Connect from its menu bar icon and your machines show up here."
          : state === "running"
            ? `Nothing on ${system?.name || "your tailnet"} can be a box yet: berthd runs on Linux and macOS.`
            : "Shipyard couldn't ask Tailscale on this Mac for its machines.";
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-meta">
        Tailscale puts your machines on one private network. With it on this Mac, they're listed here and Shipyard sets one up in a click: no ports to open, and berthd listens on the tailnet only.
      </p>
      {said && <p className="text-body">{said}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {state === "missing" ? (
          <Button size="sm" variant="outline" onClick={() => void openUrl(TAILSCALE_DOWNLOAD)}>
            <ExternalLinkIcon /> Get Tailscale
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCwIcon /> Check again
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onSignIn}>
          Sign in to a tailnet in Shipyard
        </Button>
      </div>
    </div>
  );
}
