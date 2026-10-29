import { useBoxes, type BerthPluginContext, type WorktreePanelProps } from "@berth/plugin";
import { Badge, Button, HelperBox, Icon, Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger, PickOne, Tip, useHelperState } from "@berth/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Connection, database, type Fault, faultOf, isOldBox, isOldHelper, lostHelper, NO_CAPABILITIES, type Schema } from "./api";
import { skewOf, untilHere, WRITES_FOR_MS } from "./clock.ts";
import { Browser } from "./browser";
import { type At, ConnectDialog, ForgetDialog } from "./connect";
import { Console } from "./console";
import type { Ctx } from "./context";
import { cannotLook, fromFile, lookAgain, type Looked, type Origin, originOf, said } from "./dotenv.ts";
import { engineOf } from "./engines/index.ts";
import { useNow, useRead, useVisible } from "./live";
import { Lock, UnlockDialog, type Writes } from "./lock";
import { sourceOf } from "./source.ts";
import { COPY, FaultText, HELPER, Line, Notice, Waiting } from "./ui";

// The Database panel: a worktree's own development database. It reads the
// helper's state on the worktree's box, says so when there is nothing to
// show (the box is offline, the helper is off, installing or failed), and
// otherwise draws the worktree's connection.

// The states in which a box has no helper at all: it was turned off, or
// can't be there. Any other state that isn't "running" is a helper on its
// way back.
const GONE = new Set(["off", "none", "unsupported"]);

export function DatabasePanel({ berth, box, location, worktree, main }: WorktreePanelProps) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const online = useBoxes().find((b) => b.name === box)?.state === "online";
  const helper = useHelperState(berth, box, visible && online);
  const state = helper.status?.state;
  const running = online && state === "running";
  // What is staged in the grid and typed in the console lives in the
  // connection's own part of the panel. So once that has been shown it is
  // kept, out of sight, while the helper is away for a moment: the box
  // starting it again (it crashed, or the box's berthd or the helper was
  // updated), or the box out of reach. It comes back as it was, with writes
  // locked. Only turning the helper off takes it down.
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (running) setKept(true);
    else if (online && state && GONE.has(state)) setKept(false);
  }, [running, online, state]);
  return (
    <div ref={ref} data-testid="database" data-state={online ? (state ?? "reading") : "offline"} className="@container flex h-full min-h-0 flex-col bg-pane text-sm">
      {(running || kept) && (
        <div className={running ? "contents" : "hidden"}>
          <Connections berth={berth} box={box} source={sourceOf({ location, worktree, main })} worktree={main ? location : worktree} at={{ location, worktree: main ? "" : worktree }} active={visible && running} />
        </div>
      )}
      {!running && kept && (
        <Line tone="note" testId="database-kept">
          {online ? (
            <>
              What you staged and typed in this tab is kept, and is here again once <code>{HELPER}</code> is running on {box}. Writes will be locked.
            </>
          ) : (
            <>What you staged and typed in this tab is kept, and is here again once {box} is back.</>
          )}
        </Line>
      )}
      {!online ? (
        <Notice icon="CloudOff" title={`${box} is offline`} body="Database's helper runs on the box, beside the database it reads, so there is nothing to show until the box is back." />
      ) : (
        !running && <HelperBox variant="panel" berth={berth} box={box} copy={COPY} testId="database" onAbout={() => berth.openScreen("database")} />
      )}
    </div>
  );
}

// How far each box's clock is ahead of this computer's, learned when writes
// were turned on there.
const skews = new Map<string, number>();

interface Scope {
  berth: BerthPluginContext;
  box: string;
  source: string;
  worktree: string;
  active: boolean;
}

// Connections reads the databases the helper knows for the worktree, and
// says why when there is none to show.
//
// The helper is told of a database when Shipyard starts one of the
// worktree's services. When it knows none for this worktree, the box is
// asked to look in the worktree's own .env files and tell the helper what it
// finds there (dotenv.ts): once for each time the panel is opened, which is
// the person asking, and again when they ask to look again.
//
// And when nothing says which database the worktree has, the person can:
// Connect a database… takes its address (connect.tsx).
function Connections({ berth, box, source, worktree, at, active }: Scope & { at: { location: string; worktree: string } }) {
  const api = useMemo(() => database(berth), [berth]);
  const helper = useHelperState(berth, box, false);
  const refresh = helper.refresh;
  const onFault = useCallback(
    (fault: Fault) => {
      if (lostHelper(fault)) refresh();
    },
    [refresh],
  );
  const key = `${box}\n${source}`;
  // What the last look found, kept between launches: which connections the
  // worktree's .env gave.
  const originKey = `env:${box}/${source}`;
  const [origin, setOrigin] = useState(() => berth.storage.get<Origin | null>(originKey, null));
  const [looking, setLooking] = useState(false);
  const [looked, setLooked] = useState<{ key: string; result: Looked }>();
  // The worktree a look was made for since the panel opened, and whether
  // the next read was asked to look again.
  const lookedFor = useRef<string | undefined>(undefined);
  const again = useRef(false);
  const known = useRef(origin);
  known.current = origin;
  // The connections that were made by hand from this computer: their ids,
  // never their address.
  const handKey = `hand:${box}/${source}`;
  const [byHand, setByHand] = useState(() => berth.storage.get<string[]>(handKey, []));
  const hand = useRef(byHand);
  hand.current = byHand;
  const [connecting, setConnecting] = useState(false);
  const read = async () => {
    const asked = again.current;
    again.current = false;
    const list = await api.connections(box, source);
    const first = lookedFor.current !== key;
    if (!(first && list.length === 0) && !(asked && lookAgain(known.current, list, hand.current))) return list;
    lookedFor.current = key;
    let result: Looked = { kind: "old" };
    if (api.canLook) {
      setLooking(true);
      try {
        const look = await api.look(box, at.location, at.worktree);
        result = { kind: "looked", look };
        const found = originOf(look) ?? null;
        berth.storage.set(originKey, found);
        setOrigin(found);
      } catch (err) {
        const fault = faultOf(err);
        onFault(fault);
        result = cannotLook(fault) ? { kind: "old" } : { kind: "failed", message: fault.message };
      } finally {
        setLooking(false);
      }
    }
    setLooked({ key, result });
    return result.kind === "looked" ? api.connections(box, source) : list;
  };
  const conns = useRead(read, key, { active, every: 10_000 });
  const reload = conns.reload;
  const relook = useCallback(() => {
    again.current = true;
    reload();
  }, [reload]);
  useEffect(() => {
    if (conns.fault) onFault(conns.fault);
  }, [conns.fault, onFault]);
  const pickKey = `connection:${box}/${source}`;
  const [picked, setPicked] = useState(() => berth.storage.get<string>(pickKey, ""));
  const pick = (id: string) => {
    setPicked(id);
    berth.storage.set(pickKey, id);
  };
  const where: At = { box, location: at.location, worktree: at.worktree };
  const connect = (
    <ConnectDialog
      open={connecting}
      api={api}
      at={where}
      name={worktree}
      onConnected={(id) => {
        berth.storage.set(handKey, [id]);
        setByHand([id]);
        // The one that was just connected is the one to show.
        pick(id);
        reload();
      }}
      onClose={() => setConnecting(false)}
    />
  );

  if (!conns.data) {
    // The helper is there and won't answer the box: the box's berthd is from
    // before it sent a helper its token.
    if (conns.fault && isOldBox(conns.fault)) {
      return (
        <Notice
          icon="CircleFadingArrowUp"
          title={`${box} needs updating for Database`}
          body={
            <>
              <code>{HELPER}</code> runs on {box} and answers only the box's own daemon, which proves itself with a token. {box}'s <code>berthd</code> is from before it sent one, so every request is turned away. Update the box in Settings → Boxes; nothing needs installing again.
            </>
          }
          actions={
            <>
              <Button size="sm" onClick={() => berth.openSettings("boxes")}>
                Open Settings → Boxes
              </Button>
              <Button size="sm" variant="ghost" onClick={conns.reload}>
                Check again
              </Button>
            </>
          }
        />
      );
    }
    // The helper answers, and has never heard of db/: it is from before this panel.
    if (conns.fault && isOldHelper(conns.fault)) {
      const s = helper.status;
      return (
        <Notice
          icon="CircleFadingArrowUp"
          title={`Database on ${box} needs updating`}
          body={
            s?.update ? (
              <>
                {box} runs <code>{HELPER}</code> {s.version}, from before it could do this. This plugin carries {s.latest}: open Database, and choose <b>Update to {s.latest}…</b> on {box}'s row.
              </>
            ) : (
              <>
                {box} runs a <code>{HELPER}</code> from before it could do this, and this copy of the plugin carries nothing newer. Update the plugin in Settings → Plugins, then choose <b>Update</b> on {box}'s row in Database.
              </>
            )
          }
          actions={
            <>
              <Button size="sm" onClick={() => berth.openScreen("database")}>
                Open Database
              </Button>
              {!s?.update && (
                <Button size="sm" variant="outline" onClick={() => berth.openSettings("plugins")}>
                  Open Settings → Plugins
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => (refresh(), conns.reload())}>
                Check again
              </Button>
            </>
          }
        />
      );
    }
    if (looking && !conns.fault) {
      return (
        <>
          <Line tone="note" testId="database-looking">
            Looking in {worktree}'s <code>.env</code> files on {box} for its database…
          </Line>
          <Waiting />
        </>
      );
    }
    return <Waiting fault={conns.fault} onRetry={conns.reload} title={`Couldn't ask ${box} for ${worktree}'s database`} />;
  }
  if (conns.data.length === 0) {
    const result = looked?.key === key ? looked.result : undefined;
    return (
      <>
        {connect}
        <Notice
          icon="table-2"
          title={`No database for ${worktree} yet`}
          body={
            result?.kind === "looked" || result?.kind === "failed" ? (
              <>
                <span className="block text-foreground" data-testid="database-looked">
                  {result.kind === "looked" ? said(result.look, box).join(" ") : `Couldn't look in ${worktree}'s .env files on ${box}: ${result.message}`}
                </span>
                <span className="mt-2 block">
                  Database shows the Postgres a worktree's <code>DATABASE_URL</code> or <code>POSTGRES_URL</code> points at when it is on {box} itself. It reads that from the worktree's <code>.env</code> files when this tab opens. A service of this worktree that Shipyard starts with one shows here too, once it has started; one that was already running when Database was turned on needs a restart. A database on another host, or one whose address is a secret reference, is not shown. If nothing says which database {worktree} has, connect it yourself with its address.
                </span>
              </>
            ) : (
              <>
                A service of this worktree that Shipyard starts with a <code>DATABASE_URL</code> or <code>POSTGRES_URL</code> pointing at a Postgres on {box} itself shows here once it has started. Database learns of a database when a service starts, so one that was already running when Database was turned on needs a restart. A database on another host, or one whose address is a secret reference, is not shown.
              </>
            )
          }
          actions={
            <>
              <Button size="sm" variant="outline" loading={looking} onClick={relook}>
                Look again
              </Button>
              {/* Not on a box that can't be asked to look: it can't be given an address either. */}
              {api.canLook && result?.kind !== "old" && (
                <Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
                  Connect a database…
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => berth.openScreen("database")}>
                Which databases show
              </Button>
            </>
          }
        />
      </>
    );
  }
  const conn = conns.data.find((c) => c.id === picked) ?? conns.data[0];
  return (
    <>
      {connect}
      <Connected
        key={conn.id}
        scope={{ berth, box, source, worktree, active }}
        api={api}
        at={where}
        conn={conn}
        all={conns.data}
        origin={origin}
        byHand={byHand}
        relook={relook}
        // One connection by hand for a worktree: another would replace it,
        // so it is forgotten first.
        onConnect={api.canLook && conns.data.length > 1 && !conns.data.some((c) => byHand.includes(c.id)) ? () => setConnecting(true) : undefined}
        onForgotten={() => {
          berth.storage.set(handKey, []);
          setByHand([]);
          relook();
        }}
        stale={conns.fault}
        onPick={pick}
        onFault={onFault}
        reread={conns.reload}
      />
    </>
  );
}

function Connected({
  scope,
  api,
  at,
  conn,
  all,
  origin,
  byHand,
  relook,
  onConnect,
  onForgotten,
  stale,
  onPick,
  onFault,
  reread,
}: {
  scope: Scope;
  api: ReturnType<typeof database>;
  at: At;
  conn: Connection;
  all: Connection[];
  // What the worktree's .env files gave, when the last look found any.
  origin: Origin | null;
  // The connections that were made by hand, by id.
  byHand: string[];
  // Reads the worktree's databases again, its .env files too.
  relook(): void;
  // Asks for another database's address; absent when one can't be added.
  onConnect?(): void;
  // The connection that was made by hand was forgotten.
  onForgotten(): void;
  stale?: Fault;
  onPick(id: string): void;
  onFault(fault: Fault): void;
  reread(): void;
}) {
  const { berth, box, source, worktree, active } = scope;
  const file = fromFile(origin, conn);
  const mine = byHand.includes(conn.id);
  const [forgetting, setForgetting] = useState(false);
  const engine = useMemo(() => engineOf(conn.engine), [conn.engine]);
  const caps = conn.capabilities ?? NO_CAPABILITIES;
  const [mode, setMode] = useState<"browse" | "console">("browse");
  const [put, setPut] = useState<{ sql: string; n: number }>();

  // The lock: what the helper last said, or what it just answered to this
  // panel until it is read again. Both are put on this computer's clock
  // (clock.ts): the helper's times are the box's.
  const [answered, setAnswered] = useState<{ until?: number }>();
  useEffect(() => setAnswered(undefined), [conn.writes_until]);
  const read = useMemo(() => (conn.writes_until === undefined ? undefined : untilHere(conn.writes_until, skews.get(box) ?? 0, Date.now())), [conn.writes_until, box]);
  const until = answered ? answered.until : read;
  const now = useNow(until !== undefined);
  const on = caps.writes && until !== undefined && until > now;
  const [asking, setAsking] = useState(false);
  const [locking, setLocking] = useState(false);
  // Writes ran out while the panel was open: said once, until the next unlock.
  const [ranOut, setRanOut] = useState(false);
  const was = useRef(on);
  useEffect(() => {
    if (was.current && !on && until !== undefined && until <= Date.now()) setRanOut(true);
    was.current = on;
  }, [on, until]);

  const unlock = async () => {
    const r = await api.writes(box, conn.id, true);
    // Fifteen minutes from now, whatever the box's clock reads.
    const arrived = Date.now();
    if (r.writes_until !== undefined) skews.set(box, skewOf(r.writes_until, arrived));
    setRanOut(false);
    setAnswered({ until: r.writes_until === undefined ? undefined : arrived + WRITES_FOR_MS });
    reread();
  };
  const lock = async () => {
    setLocking(true);
    try {
      await api.writes(box, conn.id, false);
      setAnswered({});
      reread();
    } catch (err) {
      berth.notify(`Couldn't lock writes to ${conn.database}`, String((err as Error)?.message ?? err));
    } finally {
      setLocking(false);
    }
  };
  const writes: Writes = {
    can: caps.writes,
    on,
    until,
    ask: () => setAsking(true),
    refused: () => {
      setAnswered({});
      reread();
    },
  };

  const schema = useRead<Schema[]>(() => api.schema(box, conn.id), `${box}\n${conn.id}`, { active });
  useEffect(() => {
    if (!schema.fault) return;
    onFault(schema.fault);
    // The connection is gone (its worktree was removed, or its services
    // start without it now): what the worktree has is read again.
    if (schema.fault.code === "not_found") reread();
  }, [schema.fault, onFault, reread]);
  const ctx: Ctx = { berth, api, box, source, worktree, conn, caps, engine, writes, active, onFault };
  const where = `${conn.host}${conn.port ? `:${conn.port}` : ""}`;

  return (
    <>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5" data-testid="database-bar" data-engine={conn.engine}>
        {all.length > 1 ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" className="max-w-64" aria-label={`Database: ${conn.database}, ${engine.name}. Pick another`} data-testid="database-connection" />}>
              <Icon name={engine.icon} className="size-3.5" />
              <span className="truncate">{conn.database}</span>
              <Icon name="ChevronsUpDown" className="size-3 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-64">
              {all.map((c) => (
                <MenuItem key={c.id} onClick={() => onPick(c.id)}>
                  <Icon name={engineOf(c.engine).icon} className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{c.database}</span>
                  <span className="ml-3 shrink-0 text-muted-foreground text-xs">
                    {engineOf(c.engine).name}
                    {byHand.includes(c.id) ? " · added by hand" : c.label && ` · ${c.label}`}
                    {!byHand.includes(c.id) && fromFile(origin, c) && ` in ${fromFile(origin, c)}`}
                  </span>
                </MenuItem>
              ))}
              {onConnect && (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onConnect}>
                    <Icon name="Plus" className="size-3.5 text-muted-foreground" />
                    Connect a database…
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 font-medium" data-testid="database-connection">
            <Icon name={engine.icon} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{conn.database}</span>
          </span>
        )}
        <Tip label={`${engine.name}${where ? ` at ${where}` : ""}${conn.user ? `, as ${conn.user}` : ""}${mine ? ", added by hand" : conn.label ? `, from ${conn.label}` : ""}`}>
          <Badge variant="outline" size="sm" className="hidden shrink-0 font-normal @lg:inline-flex">
            {engine.name}
          </Badge>
        </Tip>
        {mine && (
          // Where Database learned of it: someone pasted its address. Only
          // such a connection can be forgotten: the others would come back.
          <>
            <Tip label={`You connected this one by hand. Its address is kept on ${box} until you forget it, ${worktree} is removed, or Database's data on ${box} is removed.`}>
              <Badge variant="outline" size="sm" className="shrink-0 font-normal text-muted-foreground" data-testid="database-by-hand">
                added by hand
              </Badge>
            </Tip>
            <Button size="xs" variant="ghost" className="shrink-0" aria-label="Forget this connection…" onClick={() => setForgetting(true)}>
              Forget…
            </Button>
          </>
        )}
        {file && !mine && (
          // Where Database learned of it: not a service Shipyard started.
          <Tip label={`${conn.label}, read from ${worktree}'s ${file} on ${box}. Reading the tables again looks in the file again.`}>
            <Badge variant="outline" size="sm" className="shrink-0 font-mono font-normal text-muted-foreground" data-testid="database-from-env" aria-label={`From ${conn.label} in ${worktree}'s ${file}`}>
              {file}
            </Badge>
          </Tip>
        )}
        <PickOne
          label="Browse the tables, or run SQL"
          value={mode}
          onChange={(v) => setMode(v as "browse" | "console")}
          options={[
            { value: "browse", label: "Tables" },
            { value: "console", label: "Console" },
          ]}
        />
        <span className="ml-auto">
          <Lock writes={writes} now={now} busy={locking} onLock={() => void lock()} />
        </span>
      </div>
      {ranOut && !on && (
        <Line tone="note" testId="database-ran-out" actions={<Button size="xs" variant="ghost" onClick={() => setRanOut(false)}>Dismiss</Button>}>
          Writes locked themselves again: the fifteen minutes ran out. What you staged is still staged.
        </Line>
      )}
      {stale && <Line tone="bad">Couldn't ask {box} again: {stale.message}</Line>}
      {!schema.data || !schema.fresh ? (
        schema.fault && schema.fault.code !== "db_unavailable" ? (
          <Waiting fault={schema.fault} onRetry={schema.reload} title={`Couldn't read ${conn.database}'s tables`} />
        ) : schema.fault ? (
          // The helper has the connection, and the database isn't answering it.
          <Notice
            icon="Unplug"
            title={`Couldn't reach ${conn.database}`}
            body={
              <>
                <FaultText fault={schema.fault} />
                <span className="mt-2 block">
                  {engine.name}
                  {where && ` at ${where}`} isn't answering {box}. If its server or container stopped, start it and try again; if the worktree's services moved to another database, restart them and it shows here.
                </span>
              </>
            }
            actions={
              <Button size="sm" variant="outline" onClick={schema.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <Waiting />
        )
      ) : (
        <>
          <div className={mode === "browse" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <Browser
              ctx={ctx}
              schemas={schema.data}
              onReload={() => {
                // The worktree's .env may name another database by now.
                relook();
                schema.reload();
              }}
              toConsole={(sql) => {
                setPut((p) => ({ sql, n: (p?.n ?? 0) + 1 }));
                setMode("console");
              }}
            />
          </div>
          <div className={mode === "console" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <Console ctx={ctx} schemas={schema.data} put={put} />
          </div>
        </>
      )}
      <UnlockDialog open={asking} conn={conn} engine={engine} box={box} worktree={worktree} onUnlock={unlock} onClose={() => setAsking(false)} />
      <ForgetDialog open={forgetting} api={api} at={at} name={worktree} conn={conn} onForgotten={onForgotten} onClose={() => setForgetting(false)} />
    </>
  );
}
