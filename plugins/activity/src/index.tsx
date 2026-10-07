import { definePlugin, useStorage, type BerthEvent, type ScreenProps } from "@berth/plugin";
import { Badge, BoxFilter, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Icon, Input, PickOne, ViewHeader, cn } from "@berth/plugin/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

// Activity: everything that happened on every box, as sentences, newest
// first, with a line marking where you left off. It keeps the last 300
// events on this computer, so a restart doesn't wipe "while you were away".

const KEEP = 300;

// Events worth a line. Anything else is noise here (the Automations page
// shows every raw event).
const INTERESTING = /^(agent\.|worktree\.(created|removed|setup\.(finished|failed))|session\.(started|stopped)|task\.created|flow\.finished|service\.(started|stopped|failed)|box\.(connected|disconnected)|notify|share\.started)/;

let log: BerthEvent[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useLog = () => useSyncExternalStore(subscribe, () => log);

export default definePlugin((berth) => {
  log = berth.storage.get<BerthEvent[]>("events", []);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  berth.on("*", (e) => {
    if (!INTERESTING.test(e.type)) return;
    log = [e, ...log].slice(0, KEEP);
    for (const l of listeners) l();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => berth.storage.set("events", log), 1000);
  });
  berth.addScreen({ id: "activity", title: "Activity", Component: ActivityScreen });
  berth.addSidebarItem({ id: "activity", title: "Activity", icon: "History", screen: "activity" });
  berth.addCommand({ id: "activity", title: "Show activity", group: "Activity", run: () => berth.openScreen("activity") });
  return () => clearTimeout(saveTimer);
});

type Kind = "all" | "agents" | "worktrees" | "flows" | "boxes";

const kindOf = (t: string): Exclude<Kind, "all"> =>
  t.startsWith("agent.") || t.startsWith("session.") || t === "task.created" ? "agents" : t.startsWith("flow.") || t === "notify" ? "flows" : t.startsWith("box.") ? "boxes" : "worktrees";

function str(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Names maps "box:path" to "location/worktree", so an agent's event (which
// only knows its folder) reads as the worktree it is in.
type Names = Map<string, string>;

function where(e: BerthEvent, names?: Names): string {
  const d = e.data ?? {};
  const known = e.box && names?.get(`${e.box}:${str(d.path)}`);
  if (known) return known;
  const loc = str(d.location);
  if (loc.includes("/")) return loc;
  const name = str(d.name);
  if (loc && name && e.type.startsWith("worktree.")) return `${loc}/${name}`;
  if (loc) return loc;
  const path = str(d.path);
  return path ? path.split("/").filter(Boolean).slice(-1)[0] : "";
}

const AGENTS: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", cursor: "Cursor", grok: "Grok" };
const agentName = (a: string) => AGENTS[a] ?? (a || "An agent");

interface Line {
  icon: string;
  tone: string;
  text: React.ReactNode;
}

function describe(e: BerthEvent, names: Names): Line {
  const d = e.data ?? {};
  const w = <b className="font-medium text-foreground">{where(e, names) || "a worktree"}</b>;
  // Agent hooks name the agent in data; events relayed from them may only
  // carry it as their origin.
  const agent = agentName(str(d.agent) || (e.origin && AGENTS[e.origin] ? e.origin : ""));
  switch (e.type) {
    case "agent.waiting":
      return { icon: "Hand", tone: "text-warning", text: <>{agent} needs you in {w}{d.reason ? ` (${str(d.reason)})` : ""}</> };
    case "agent.finished":
      return { icon: "CircleCheck", tone: "text-success", text: <>{agent} finished its turn in {w}</> };
    case "agent.started":
      return { icon: "LoaderCircle", tone: "text-info", text: <>{agent} started working in {w}</> };
    case "agent.ready":
      return { icon: "Circle", tone: "text-muted-foreground", text: <>{agent} is ready in {w}</> };
    case "task.created":
      return { icon: "Sparkles", tone: "text-info", text: <>New worktree {w}{d.agent ? <> with {agentName(str(d.agent))}</> : null}{d.from_session ? <> handed off from {str(d.from_session)}</> : null}</> };
    case "worktree.created":
      return { icon: "GitBranchPlus", tone: "text-muted-foreground", text: <>Worktree {w} created{d.branch ? <> on {str(d.branch)}</> : null}</> };
    case "worktree.removed":
      return { icon: "Trash2", tone: "text-muted-foreground", text: <>Worktree {w} removed</> };
    case "worktree.setup.finished":
      return { icon: "Wrench", tone: "text-success", text: <>Setup finished in {w}</> };
    case "worktree.setup.failed":
      return { icon: "Wrench", tone: "text-destructive", text: <>Setup failed in {w}{e.error ? `: ${e.error}` : ""}</> };
    case "session.started":
      return { icon: "SquareTerminal", tone: "text-muted-foreground", text: <>Session {str(d.name)} started in {w}</> };
    case "session.stopped":
      return { icon: "SquareX", tone: "text-muted-foreground", text: <>Session {str(d.name)} stopped</> };
    case "flow.finished":
      return { icon: "Workflow", tone: d.status === "failed" ? "text-destructive" : "text-success", text: <>Flow {str(d.flow)} {d.status === "failed" ? "failed" : "ran"}{where(e, names) ? <> for {w}</> : null}</> };
    case "notify":
      return { icon: "Bell", tone: "text-info", text: <>{str(d.title)}{d.body ? <span className="text-muted-foreground"> — {str(d.body)}</span> : null}</> };
    case "service.started":
      return { icon: "Play", tone: "text-success", text: <>{str(d.service)} started in {w}{d.port ? ` on :${str(d.port)}` : ""}</> };
    case "service.stopped":
      return { icon: "Square", tone: "text-muted-foreground", text: <>{str(d.service)} stopped in {w}</> };
    case "service.failed":
      return { icon: "CircleAlert", tone: "text-destructive", text: <>{str(d.service)} failed to start in {w}</> };
    case "box.connected":
      return { icon: "Plug", tone: "text-success", text: <>Connected to {e.box}</> };
    case "box.disconnected":
      return { icon: "Unplug", tone: "text-warning", text: <>Lost {e.box}</> };
    case "share.started":
      return { icon: "Globe", tone: "text-warning", text: <>Port {str(d.port)} shared publicly at {str(d.url)}</> };
  }
  return { icon: "Dot", tone: "text-muted-foreground", text: e.type };
}

function clock(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function ActivityScreen({ berth }: ScreenProps) {
  const all = useLog();
  const [kind, setKind] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  // Boxes turned off; every box is on until one is, as across the app.
  const [hiddenBoxes, setHiddenBoxes] = useStorage<string[]>("hiddenBoxes", []);
  // Where you left off: the newest event when you last looked.
  const [lastSeen, setLastSeen] = useStorage<string>("lastSeen", "");
  const [mark] = useState(lastSeen);
  useEffect(() => () => setLastSeen(new Date().toISOString()), [setLastSeen]);

  const boxes = useMemo(() => [...new Set(all.map((e) => e.box).filter(Boolean) as string[])].sort(), [all]);
  // A stored filter that hides every box there is now shows them all.
  const hidden = useMemo(() => new Set(boxes.every((b) => hiddenBoxes.includes(b)) ? [] : hiddenBoxes), [boxes, hiddenBoxes]);
  const [names, setNames] = useState<Names>(new Map());
  const boxKey = boxes.join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(
      boxes.map((b) =>
        berth.api.locations(b).then(
          (locs) => locs.flatMap((l) => (l.worktrees ?? []).map((w) => [`${b}:${w.path}`, w.main ? l.name : `${l.name}/${w.name}`] as const)),
          () => [],
        ),
      ),
    ).then((pairs) => live && setNames(new Map(pairs.flat())));
    return () => {
      live = false;
    };
    // boxes is derived from boxKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, berth]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((e) => (kind === "all" || kindOf(e.type) === kind) && (!e.box || !hidden.has(e.box)) && (!q || `${e.type} ${where(e, names)} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(q)));
  }, [all, kind, hidden, query, names]);
  const unseen = mark ? shown.filter((e) => e.time > mark).length : 0;

  return (
    <div>
      <ViewHeader
        title="Activity"
        description={<>What agents, worktrees and flows did on every box{unseen > 0 ? <>, with <b className="font-medium text-foreground">{unseen} new</b> since you last looked</> : null}.</>}
        actions={<Input className="w-52" size="sm" placeholder="Search…" value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <PickOne
          label="Kind of event"
          value={kind}
          onChange={(v: string) => setKind(v as Kind)}
          options={[
            { value: "all", label: "All" },
            { value: "agents", label: "Agents" },
            { value: "worktrees", label: "Worktrees" },
            { value: "flows", label: "Flows" },
            { value: "boxes", label: "Boxes" },
          ]}
        />
        <BoxFilter className="ml-auto" boxes={boxes} hidden={hiddenBoxes} onChange={setHiddenBoxes} />
      </div>

      {shown.length === 0 ? (
        <Empty className="rounded-xl border py-16">
          <EmptyHeader>
            <Icon name="History" className="mx-auto mb-2 size-5 text-muted-foreground" />
            <EmptyTitle>{all.length ? "Nothing matches" : "Nothing has happened yet"}</EmptyTitle>
            <EmptyDescription>{all.length ? "Try another filter." : "Agents finishing, worktrees appearing and flows running will show up here as they happen."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="overflow-hidden rounded-xl border">
          {shown.map((e, i) => {
            const line = describe(e, names);
            const divider = mark && i > 0 && shown[i - 1].time > mark && e.time <= mark;
            const session = str(e.data?.session ?? (e.type.startsWith("session.") ? e.data?.name : ""));
            return (
              <li key={`${e.time}-${i}`}>
                {divider && (
                  <div className="flex items-center gap-2 bg-muted/60 px-4 py-1 text-muted-foreground text-xs">
                    <span className="h-px flex-1 bg-border" /> Since you were last here <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div className={cn("group flex min-h-row items-center gap-3 border-b px-4 py-1 text-sm last:border-b-0", i === 0 && "border-t-0")}>
                  <Icon name={line.icon} className={cn("size-4 shrink-0", line.tone)} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{line.text}</span>
                  {e.box && (
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {e.box}
                    </Badge>
                  )}
                  {/* A slot every row has, so the box badges line up whether
                      or not the row can be opened. */}
                  <span className="flex w-14 shrink-0 justify-end">
                    {session && e.box && e.type !== "session.stopped" && (
                      <Button size="xs" variant="ghost" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" onClick={() => berth.openTerminal(e.box!, session)}>
                        Open
                      </Button>
                    )}
                  </span>
                  <time className="w-24 shrink-0 text-right text-muted-foreground text-xs tabular-nums" dateTime={e.time}>
                    {clock(e.time)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
