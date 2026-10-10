import { definePlugin, useBoxes, useCurrentWorktree, useEvent, type BerthPluginContext, type Location, type ScreenProps, type Service, type WorktreeService } from "@berth/plugin";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Icon,
  Input,
  Skeleton,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  ViewHeader,
  cn,
} from "@berth/plugin/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

// Dev servers: everything listening in a worktree, on every box, next to
// the services each repository declares for its worktrees. Open one in a
// browser tab beside your terminal, copy its private URL, or start and stop
// a repository's services.

export default definePlugin((berth) => {
  berth.addScreen({ id: "servers", title: "Dev servers", Component: ServersScreen });
  berth.addSidebarItem({ id: "servers", title: "Dev servers", icon: "Radio", screen: "servers" });
  berth.addStatusBarItem({ id: "servers", Component: ServersStatus });
  berth.addCommand({ id: "servers", title: "Show dev servers", group: "Dev servers", run: () => berth.openScreen("servers") });
});

interface Listening extends Service {
  box: string;
  url: string;
}

interface Configured extends WorktreeService {
  box: string;
  location: string;
  worktree: string;
}

interface Group {
  key: string;
  box: string;
  location: string;
  worktree: string;
  main?: boolean;
  listening: Listening[];
  configured: Configured[];
}

// useServers polls the listening servers of every online box, and reads the
// repositories' declared services when worktrees or services change. That
// is a request per worktree on every box, so only the screen that lists
// them asks (withConfigured); the status bar's count needs none of it.
function useServers(berth: BerthPluginContext, withConfigured = true) {
  const boxes = useBoxes();
  const online = useMemo(() => boxes.filter((b) => b.state === "online").map((b) => b.name), [boxes]);
  const key = online.join(",");
  const [listening, setListening] = useState<Listening[]>();
  const [configured, setConfigured] = useState<Configured[]>([]);
  const [stamp, setStamp] = useState(0);
  const reload = useCallback(() => setStamp((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const all = await Promise.all(
        online.map((box) =>
          berth.api.services(box).then(
            (s) => s.map((x) => ({ ...x, box, url: berth.api.serviceUrl(box, x.port) })),
            () => [] as Listening[],
          ),
        ),
      );
      if (live) setListening(all.flat());
    };
    void load();
    const t = setInterval(() => !document.hidden && void load(), 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // online is derived from key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stamp, berth]);

  useEffect(() => {
    if (!withConfigured) return;
    let live = true;
    void (async () => {
      const found: Configured[] = [];
      await Promise.all(
        online.map(async (box) => {
          const locs: Location[] = await berth.api.locations(box).catch(() => []);
          await Promise.all(
            locs.flatMap((l) =>
              (l.worktrees ?? []).map(async (w) => {
                const svcs = await berth.api.request<WorktreeService[]>(box, "GET", `locations/${encodeURIComponent(l.name)}/worktrees/${encodeURIComponent(w.name)}/services`).catch(() => []);
                for (const s of svcs ?? []) found.push({ ...s, box, location: l.name, worktree: w.name });
              }),
            ),
          );
        }),
      );
      if (live) setConfigured(found);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stamp, berth, withConfigured]);

  useEvent("service.*", reload);
  useEvent("worktree.created", reload);
  useEvent("worktree.removed", reload);
  return { listening, configured, reload };
}

function ServersStatus({ berth }: ScreenProps) {
  const { listening } = useServers(berth, false);
  if (!listening?.length) return null;
  return (
    <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => berth.openScreen("servers")}>
      <Icon name="Radio" className="size-3" />
      {listening.length} {listening.length === 1 ? "server" : "servers"}
    </button>
  );
}

function ServersScreen({ berth }: ScreenProps) {
  const { listening, configured, reload } = useServers(berth);
  const current = useCurrentWorktree();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    const group = (box: string, location: string, worktree: string, main?: boolean) => {
      const key = `${box}/${location}/${worktree}`;
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, box, location, worktree, main, listening: [], configured: [] }));
      return g;
    };
    for (const l of listening ?? []) group(l.box, l.location, l.worktree, l.main).listening.push(l);
    for (const c of configured) group(c.box, c.location, c.worktree).configured.push(c);
    const q = query.trim().toLowerCase();
    return [...by.values()]
      .filter((g) => !q || `${g.box} ${g.location} ${g.worktree} ${g.listening.map((l) => `${l.port} ${l.process}`).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => b.listening.length - a.listening.length || a.key.localeCompare(b.key));
  }, [listening, configured, query]);

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Dev servers"
        description="Everything listening in a worktree on every box, and the services each repository runs."
        actions={
          <>
            <Input className="w-56" size="sm" placeholder="Filter by worktree, port…" value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
            <Tooltip>
              <TooltipTrigger render={<Button size="icon-sm" variant="ghost" onClick={reload} aria-label="Refresh" />}>
                <Icon name="RefreshCw" className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Refresh</TooltipPopup>
            </Tooltip>
          </>
        }
      />

      {!listening ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <Empty className="py-16">
          <EmptyHeader>
            <Icon name="Radio" className="mx-auto mb-2 size-5 text-muted-foreground" />
            <EmptyTitle>{query ? "Nothing matches" : "Nothing is listening"}</EmptyTitle>
            <EmptyDescription>
              {query ? "Try another worktree or port." : <>Start a dev server in a worktree, or declare one under <code>services</code> in the repository's .berth/config.json, and it shows up here.</>}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((g) => <WorktreeGroup key={g.key} group={g} berth={berth} here={current?.box === g.box && current.location === g.location && current.worktree === g.worktree} onChanged={reload} />)
      )}
    </div>
  );
}

function WorktreeGroup({ group: g, berth, here, onChanged }: { group: Group; berth: BerthPluginContext; here: boolean; onChanged(): void }) {
  const listeningPorts = new Set(g.listening.map((l) => l.port));
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 py-2.5">
        <Icon name="GitBranch" className="size-3.5 text-muted-foreground" />
        <FrameTitle className="truncate">{g.worktree}</FrameTitle>
        <span className="truncate text-muted-foreground text-xs">{g.main ? g.box : `${g.location} · ${g.box}`}</span>
        {g.main && <Badge variant="outline" size="sm">main checkout</Badge>}
        {here && <Badge variant="secondary" size="sm">current worktree</Badge>}
      </FrameHeader>
      <FramePanel className="p-0">
        <ul className="divide-y">
          {g.listening.map((l) => (
            <ServerRow key={`l${l.port}`} item={l} berth={berth} service={g.configured.find((c) => c.state === "running" && c.port === l.port)} onChanged={onChanged} />
          ))}
          {g.configured
            .filter((c) => !(c.state === "running" && c.port && listeningPorts.has(c.port)))
            .map((c) => (
              <ConfiguredRow key={`c${c.name}`} item={c} berth={berth} onChanged={onChanged} />
            ))}
        </ul>
      </FramePanel>
    </Frame>
  );
}

function ServerRow({ item: l, berth, service, onChanged }: { item: Listening; berth: BerthPluginContext; service?: Configured; onChanged(): void }) {
  const [copied, setCopied] = useState(false);
  const worktree = { box: l.box, location: l.location, worktree: l.worktree, path: l.path, main: l.main };
  const openInTab = (split?: "row") => {
    berth.openWorktree(worktree);
    berth.openBrowser(l.url, split ? { split } : undefined);
  };
  const stop = async () => {
    if (!service) return;
    await berth.api
      .request(service.box, "POST", `locations/${encodeURIComponent(service.location)}/worktrees/${encodeURIComponent(service.worktree)}/services/${encodeURIComponent(service.name)}/stop`)
      .catch((err) => berth.notify(`Couldn't stop ${service.name}`, String((err as Error).message ?? err)));
    onChanged();
  };
  return (
    <li className="group flex items-center gap-3 px-4 py-2 text-sm">
      <span className="size-2 shrink-0 rounded-full bg-success" aria-label="listening" />
      <span className="w-14 shrink-0 font-mono tabular-nums">{l.port}</span>
      <span className="min-w-0 flex-1 truncate">
        {service && <span className="mr-2 font-medium">{service.name}</span>}
        <span className="text-muted-foreground">{l.process ?? "listening"}</span>
        <span className="ml-2 font-mono text-muted-foreground/70 text-xs">{l.url.replace(/^https?:\/\//, "")}</span>
      </span>
      {copied && <span className="text-muted-foreground text-xs">Copied</span>}
      <Button size="xs" variant="outline" onClick={() => openInTab()}>
        <Icon name="AppWindow" className="size-3.5" /> Open in tab
      </Button>
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`More for port ${l.port}`} />}>
          <Icon name="Ellipsis" className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem onClick={() => openInTab("row")}>
            <Icon name="PanelRight" /> Open beside the terminal
          </MenuItem>
          <MenuItem onClick={() => berth.openUrl(l.url)}>
            <Icon name="ArrowUpRight" /> Open in your browser
          </MenuItem>
          <MenuItem
            onClick={() =>
              void navigator.clipboard?.writeText(l.url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <Icon name="Copy" /> Copy URL
          </MenuItem>
          {service && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => void stop()}>
                <Icon name="Square" /> Stop {service.name}
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </li>
  );
}

function ConfiguredRow({ item: c, berth, onChanged }: { item: Configured; berth: BerthPluginContext; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const running = c.state === "running";
  const act = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      await berth.api.request(c.box, "POST", `locations/${encodeURIComponent(c.location)}/worktrees/${encodeURIComponent(c.worktree)}/services/${encodeURIComponent(c.name)}/${action}`);
      onChanged();
    } catch (err) {
      berth.notify(`Couldn't ${action} ${c.name}`, String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className={cn("size-2 shrink-0 rounded-full", running ? "bg-warning" : c.state === "failed" ? "bg-destructive" : "bg-muted-foreground/30")} aria-label={c.state} />
      <span className="w-14 shrink-0 font-medium">{c.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={c.run}>
        {c.run}
      </span>
      <span className="text-muted-foreground text-xs">{running ? "running, not listening yet" : c.state}</span>
      {running ? (
        <Button size="xs" variant="outline" loading={busy} onClick={() => void act("stop")}>
          Stop
        </Button>
      ) : (
        <Button size="xs" loading={busy} onClick={() => void act("start")}>
          Start
        </Button>
      )}
    </li>
  );
}
