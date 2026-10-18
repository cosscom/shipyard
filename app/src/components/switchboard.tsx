import { ArrowRightIcon, EllipsisIcon, GitBranchIcon, Layers3Icon, PencilIcon, PlusIcon, SearchIcon, StarIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { AgentIcon, StateGlyph, stateText } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { CommandDialog, CommandDialogPopup, CommandFooter, CommandPanel } from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAllSessions } from "@/hooks/use-agent-counts";
import { resumeConversation } from "@/lib/actions";
import { boxApi, type Conversation } from "@/lib/api";
import { agentOf, sessionName, type SessionState, worktreeOf } from "@/lib/derive";
import { modKey } from "@/lib/platform";
import { useProjects } from "@/lib/project-groups";
import { useStore } from "@/lib/store";
import { setSwitchboardOpen, switchboardActions, useSwitchboard, useSwitchboardOpen } from "@/lib/switchboard";
import { boardLists, cycle, shortAgo, stepId } from "@/lib/switchboard-list";
import { cn } from "@/lib/utils";
import { openSession, refOf, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";

interface BoardItem {
  id: string;
  title: string;
  place: string;
  area: string;
  at: number;
  agent?: string;
  state?: SessionState;
  kind: "conversation" | "worktree";
  open(): void;
}

const date = (s: string | undefined) => (s ? Date.parse(s) || 0 : 0);

// The Switchboard gathers work from every box. A live or ended session is
// shown once; a structured conversation without its old session still has a
// row that can resume it. Recently visited worktrees fill in work without
// an agent. Areas are the existing project sections, with personal overrides.
//
// It reads like the palette (⌘K): type to filter, ↑↓ and ↵, with Focus
// (starred work, with its pickup note) above Recent. A row's controls show
// only on the highlighted row; the rest are in its menu (right-click, ⋯, or
// ⇧F10), and every one has a key.
export function Switchboard() {
  const open = useSwitchboardOpen((s) => s.open);
  const choices = useSwitchboard();
  const allSessions = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const client = useStore((s) => s.client);
  const spaces = useWorkspaces((s) => s.spaces);
  const { projects, sections } = useProjects();
  const [conversations, setConversations] = useState<Record<string, Conversation[]>>({});
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All");
  // The highlighted row, by id, so it stays on the same work as rows move.
  const [active, setActive] = useState<string>();
  const [editing, setEditing] = useState<string>();
  // A new area being named: from the strip, or for a row (moved into it).
  const [adding, setAdding] = useState<{ assign?: string }>();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // A menu item that moves the keyboard elsewhere (a note, a new area)
  // keeps the closing menu from sending it back to the search.
  const keep = useRef(false);
  const listId = useId();
  const conversationBoxes = (status?.boxes ?? []).filter((b) => b.state === "online" && boxes[b.name]?.info?.capabilities?.includes("conversations")).map((b) => b.name).join("|");

  useEffect(() => {
    if (!open || !client) return;
    let live = true;
    for (const box of conversationBoxes.split("|").filter(Boolean)) {
      void boxApi.conversations(client, box, undefined, 200).then((list) => {
        if (live) setConversations((old) => ({ ...old, [box]: list }));
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [open, client, conversationBoxes]);

  useEffect(() => {
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) {
      if (conv.session) switchboardActions.migrate(`session:${box}:${conv.session}`, `conversation:${box}:${conv.id}`);
    }
  }, [conversations]);

  const items = useMemo(() => {
    const out: BoardItem[] = [];
    const conversationBySession = new Map<string, Conversation>();
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) if (conv.session) conversationBySession.set(`${box}:${conv.session}`, conv);
    const projectByLocation = new Map<string, { name: string; area?: string }>();
    for (const p of projects) for (const m of p.members) projectByLocation.set(`${m.box.name}/${m.loc.name}`, { name: p.name, area: p.section });
    const areaOf = (id: string, project?: string) => choices.assigned[id] ?? project ?? "Unsorted";
    const sessionIds = new Set<string>();
    for (const { box, session, state } of allSessions) {
      const agent = agentOf(session);
      if (!agent || session.service) continue;
      const conversation = conversationBySession.get(`${box}:${session.name}`);
      const id = conversation ? `conversation:${box}:${conversation.id}` : `session:${box}:${session.name}`;
      sessionIds.add(`${box}:${session.name}`);
      const found = worktreeOf(boxes[box]?.locations, session);
      const project = found && projectByLocation.get(`${box}/${found.location.name}`);
      out.push({
        id,
        title: sessionName(session, { sessions: boxes[box]?.sessions }),
        place: found ? `${project?.name ?? found.location.name} / ${worktreeLabel(found.worktree)}` : `${box} / Home`,
        area: areaOf(id, project?.area),
        at: date(session.state_since) || date(session.created),
        agent,
        state,
        kind: "conversation",
        open: () => openSession(box, session),
      });
    }
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) {
      if (conv.session && sessionIds.has(`${box}:${conv.session}`)) continue;
      const found = boxes[box]?.locations?.flatMap((l) => (l.worktrees ?? []).map((w) => ({ location: l, worktree: w }))).find((x) => x.worktree.path === conv.dir);
      if (!found) continue;
      const id = `conversation:${box}:${conv.id}`;
      const project = projectByLocation.get(`${box}/${found.location.name}`);
      out.push({
        id,
        title: conv.title || "Untitled conversation",
        place: `${project?.name ?? found.location.name} / ${worktreeLabel(found.worktree)}`,
        area: areaOf(id, project?.area),
        at: date(conv.updated) || date(conv.created),
        agent: conv.agent,
        state: "exited",
        kind: "conversation",
        open: () => {
          selectWorktree(refOf(box, found.location, found.worktree));
          void resumeConversation(box, conv, wsKey(box, conv.dir));
        },
      });
    }
    for (const [key, ws] of Object.entries(spaces)) {
      if (!ws.visitedAt || !ws.ref.location) continue;
      const loc = boxes[ws.ref.box]?.locations?.find((l) => l.name === ws.ref.location);
      const wt = loc?.worktrees?.find((w) => w.path === ws.ref.path);
      if (!loc || !wt) continue;
      const id = `worktree:${key}`;
      if (!choices.focus.includes(id) && allSessions.some((entry) => entry.box === ws.ref.box && entry.session.dir === wt.path && !!agentOf(entry.session))) continue;
      const project = projectByLocation.get(`${ws.ref.box}/${loc.name}`);
      out.push({
        id,
        title: worktreeLabel(wt),
        place: `${project?.name ?? loc.name} / ${ws.ref.box}`,
        area: areaOf(id, project?.area),
        at: ws.visitedAt,
        kind: "worktree",
        open: () => selectWorktree(refOf(ws.ref.box, loc, wt)),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [allSessions, boxes, conversations, spaces, projects, choices.assigned, choices.focus]);

  const areas = useMemo(() => ["All", ...new Set([...sections, ...choices.areas, ...items.map((i) => i.area)].filter((x) => !["all", "unsorted"].includes(x.toLowerCase()))), "Unsorted"], [sections, choices.areas, items]);
  const { focused, recent } = useMemo(() => boardLists(items, choices.focus, area, query), [items, choices.focus, area, query]);
  const rows = useMemo(() => [...focused, ...recent], [focused, recent]);
  const current = rows.find((item) => item.id === active) ?? rows[0];
  const now = Date.now();

  // The highlight stays in sight as the keys move it.
  useEffect(() => {
    if (!current) return;
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);

  const enter = (item: BoardItem) => {
    setSwitchboardOpen(false);
    item.open();
  };
  const close = () => {
    setSwitchboardOpen(false);
    setQuery("");
    setArea("All");
    setActive(undefined);
    setEditing(undefined);
    setAdding(undefined);
  };
  // Before the field that had the keyboard goes away, so the dialog never
  // sends it to itself instead.
  const backToSearch = () => {
    search.current?.focus();
    requestAnimationFrame(() => search.current?.focus());
  };
  const editNote = (item: BoardItem) => {
    setActive(item.id);
    setEditing(item.id);
  };
  const pickArea = (name: string) => {
    setArea(name);
    setActive(undefined);
  };
  // The row's menu, from the keyboard: as a right-click on the row.
  const openMenu = (item: BoardItem, at?: DOMRect) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(item.id)}"]`);
    if (!row) return;
    const r = at ?? row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at ? r.left : r.right - 120, clientY: at ? r.bottom : r.top + r.height / 2, button: 2 }));
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(stepId(rows.map((r) => r.id), current?.id, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) enter(current);
    } else if (e.key === "Tab") {
      e.preventDefault();
      pickArea(cycle(areas, area, e.shiftKey ? -1 : 1));
    } else if (modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (current) switchboardActions.toggleFocus(current.id);
    } else if (modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      if (current) editNote(current);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      if (current) openMenu(current);
    }
  };

  const starred = current ? choices.focus.includes(current.id) : false;
  const empty = !rows.length;
  const row = (item: BoardItem, focus: boolean) => (
    <Row
      key={item.id}
      listId={listId}
      item={item}
      focus={focus}
      note={choices.notes[item.id]}
      showArea={focus && area === "All"}
      areas={areas}
      now={now}
      highlighted={item.id === current?.id}
      editing={editing === item.id}
      onHighlight={() => setActive(item.id)}
      onOpen={() => enter(item)}
      onEditNote={() => editNote(item)}
      onNewArea={() => setAdding({ assign: item.id })}
      onMenu={(r) => openMenu(item, r)}
      onDoneEditing={() => {
        setEditing(undefined);
        backToSearch();
      }}
      keep={keep}
      search={search}
    />
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={(value, details) => {
        if (value) return setSwitchboardOpen(true);
        // Esc leaves a note or a new area first, then the Switchboard.
        if (details.reason === "escape-key" && (editing || adding)) {
          details.cancel();
          setEditing(undefined);
          setAdding(undefined);
          backToSearch();
          return;
        }
        close();
      }}
    >
      <CommandDialogPopup aria-label="Switchboard" initialFocus={search} className="max-h-[min(34rem,calc(100vh-6rem))] max-w-2xl">
        {/* Positioned, like the palette's input, so the shell's tint
            (the popup's ::before) is under it, not over it. */}
        <div className="relative flex h-12 items-center gap-2 px-[calc(--spacing(5.5)-1px)] pt-1.5 pb-0.5 sm:h-11">
          <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground opacity-80" />
          <input
            ref={search}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current ? rowId(listId, current.id) : undefined}
            aria-label="Search work"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(undefined);
            }}
            onKeyDown={onSearchKey}
            placeholder="Find a conversation or worktree…"
            className="h-full min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/72"
          />
        </div>
        <AreaStrip
          areas={areas}
          area={area}
          adding={adding}
          onPick={pickArea}
          onAdd={() => setAdding({})}
          onAdded={(name) => {
            switchboardActions.addArea(name);
            const clean = name.trim();
            if (clean && adding?.assign) switchboardActions.assign(adding.assign, clean);
            setAdding(undefined);
            backToSearch();
          }}
          onCancel={() => {
            setAdding(undefined);
            backToSearch();
          }}
        />
        <CommandPanel className="flex min-h-0 flex-1 flex-col">
          <ScrollArea scrollFade overscrollContain className="min-h-0 flex-1">
            <div ref={list} id={listId} role="listbox" aria-label="Work" className="p-2">
              {empty ? (
                <Empty query={query} area={area} />
              ) : (
                <>
                  {focused.length > 0 && <Section label="Focus">{focused.map((item) => row(item, true))}</Section>}
                  {recent.length > 0 && <Section label="Recent">{recent.map((item) => row(item, false))}</Section>}
                </>
              )}
            </div>
          </ScrollArea>
        </CommandPanel>
        <CommandFooter className="relative text-tag text-muted-foreground">
          {editing ? (
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> to save the note
            </span>
          ) : (
            <span className="flex items-center gap-3">
              {current && (
                <>
                  <Hint keys={["↑", "↓"]}>move</Hint>
                  <Hint keys={["↵"]}>open</Hint>
                  <Hint keys={["⌘S"]}>{starred ? "unstar" : "star"}</Hint>
                  <Hint keys={["⇧F10"]}>more</Hint>
                </>
              )}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> {editing ? "to cancel" : "to close"}
          </span>
        </CommandFooter>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

const rowId = (listId: string, id: string) => `${listId}-${id.replace(/[^\w-]/g, "_")}`;

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
      {children}
    </span>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="[&+&]:mt-2">
      <div id={id} role="presentation" className="px-2 py-1.5 text-muted-foreground text-label">
        {label}
      </div>
      {children}
    </div>
  );
}

function Empty({ query, area }: { query: string; area: string }) {
  const [title, detail] = query.trim()
    ? [`Nothing matches “${query.trim()}”`, area === "All" ? undefined : `in ${area}`]
    : area === "All"
      ? ["No recent work yet", "Conversations and worktrees you open show here."]
      : [`Nothing in ${area} yet`, "Move work here from a row’s menu."];
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <Layers3Icon aria-hidden className="mb-2 size-5 text-muted-foreground/60" />
      <p className="text-body">{title}</p>
      {detail && <p className="text-muted-foreground text-meta">{detail}</p>}
    </div>
  );
}

function AreaStrip({ areas, area, adding, onPick, onAdd, onAdded, onCancel }: { areas: string[]; area: string; adding?: { assign?: string }; onPick(name: string): void; onAdd(): void; onAdded(name: string): void; onCancel(): void }) {
  return (
    <div className="relative flex items-center gap-0.5 px-3.5 pt-1 pb-2.5">
      <div role="tablist" aria-label="Areas" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {areas.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={area === a}
            onClick={() => onPick(a)}
            className={cn("h-6 shrink-0 rounded-md px-2 text-meta transition-colors", area === a ? "bg-foreground/8 font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground")}
          >
            {a}
          </button>
        ))}
      </div>
      {adding ? (
        <NewArea onAdded={onAdded} onCancel={onCancel} />
      ) : (
        <Tip label="New area">
          <button type="button" aria-label="New area" onClick={onAdd} className="ms-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <PlusIcon className="size-3.5" />
          </button>
        </Tip>
      )}
      {/* The strip's own key, where it applies, rather than in the footer. */}
      <span aria-hidden className="ms-auto flex shrink-0 items-center gap-1 ps-2 text-tag text-muted-foreground">
        <Kbd>⇥</Kbd> next area
      </span>
    </div>
  );
}

// NewArea names a new area in place of the strip's +. ↵ or leaving the
// field adds it; Esc doesn't.
function NewArea({ onAdded, onCancel }: { onAdded(name: string): void; onCancel(): void }) {
  const [name, setName] = useState("");
  const done = useRef(false);
  const finish = (add: boolean) => {
    if (done.current) return;
    done.current = true;
    if (add && name.trim()) onAdded(name);
    else onCancel();
  };
  return (
    <form
      className="ms-1 flex shrink-0 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        finish(true);
      }}
    >
      <input
        autoFocus
        aria-label="Area name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") done.current = true;
        }}
        onBlur={() => finish(true)}
        placeholder="New area"
        className="h-6 w-28 rounded-md border bg-background px-2 text-meta outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24"
      />
    </form>
  );
}

interface RowProps {
  listId: string;
  item: BoardItem;
  focus: boolean;
  note?: string;
  showArea: boolean;
  areas: string[];
  now: number;
  highlighted: boolean;
  editing: boolean;
  onHighlight(): void;
  onOpen(): void;
  onEditNote(): void;
  onNewArea(): void;
  onMenu(at: DOMRect): void;
  onDoneEditing(): void;
  keep: React.RefObject<boolean>;
  search: React.RefObject<HTMLInputElement | null>;
}

// Lead is a row's state, as the sidebar leads with it: a spinner while
// working, amber when it needs you, a check when done, a ring when idle, a
// dot once ended. A worktree without an agent leads with its branch.
function Lead({ item }: { item: BoardItem }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {item.kind === "worktree" || !item.state ? <GitBranchIcon aria-hidden className="size-3.5 text-muted-foreground" /> : <StateGlyph state={item.state} />}
    </span>
  );
}

function Row({ listId, item, focus, note, showArea, areas, now, highlighted, editing, onHighlight, onOpen, onEditNote, onNewArea, onMenu, onDoneEditing, keep, search }: RowProps) {
  const starred = focus;
  const waiting = item.state === "waiting";
  // Focus rows, and any row with a pickup note, have a second line.
  const twoLine = focus || !!note;
  const time = shortAgo(item.at, now);
  const moveTo = [...new Set([...areas.filter((a) => a !== "All"), item.area])];
  return (
    <ContextMenu
      onOpenChange={(o) => {
        if (o) return onHighlight();
        // Closed: the keyboard goes back to the search, unless what was
        // chosen took it (a note, a new area).
        if (keep.current) keep.current = false;
        else window.setTimeout(() => search.current?.focus(), 0);
      }}
    >
      <ContextMenuTrigger
        render={<div />}
        data-row={item.id}
        data-highlighted={highlighted || undefined}
        onPointerMove={() => !highlighted && onHighlight()}
        className="group/row scroll-my-2 rounded-lg data-highlighted:bg-accent data-popup-open:bg-accent dark:data-highlighted:bg-foreground/9 dark:data-popup-open:bg-foreground/9"
      >
        <div className="relative">
          <div
            id={rowId(listId, item.id)}
            role="option"
            aria-selected={highlighted}
            aria-label={`${item.title}, ${item.place}${item.state ? `, ${stateText(item.state)}` : ""}`}
            onClick={onOpen}
            className="flex min-h-8 cursor-default select-none items-center gap-2.5 px-2 py-1.5 text-body"
          >
            <Lead item={item} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate">{item.title}</span>
                {waiting && <span className="shrink-0 text-warning-foreground text-label dark:text-warning">Needs you</span>}
              </div>
              {twoLine && (
                <div className="mt-0.5 truncate text-muted-foreground text-meta">
                  {note ? (
                    <>
                      <span className="text-foreground/72">{note}</span>
                      <span className="text-muted-foreground/72"> · {item.place}</span>
                    </>
                  ) : (
                    item.place
                  )}
                </div>
              )}
            </div>
            <div className="flex min-w-21 shrink-0 items-center justify-end gap-2 text-muted-foreground text-meta transition-opacity duration-100 group-hover/row:opacity-0 group-data-popup-open/row:opacity-0">
              {!twoLine && <span className="max-w-52 truncate">{item.place}</span>}
              {focus && showArea && item.area !== "Unsorted" && <span className="rounded-sm bg-muted px-1.5 py-px text-tag group-data-highlighted/row:bg-background/60">{item.area}</span>}
              {item.agent && <AgentIcon agent={item.agent} muted className="size-3" />}
              <span className="w-7 text-right tabular-nums">{time}</span>
            </div>
          </div>
          {/* The row's buttons fade in over its trailing end on hover, in
              place of its details, so the row never moves; the keys (⌘S,
              ⌘E, ⇧F10) reach the same from the keyboard. */}
          {!editing && (
            <div className="pointer-events-none absolute inset-y-0 end-0 flex items-center gap-0.5 pe-1.5 opacity-0 transition-opacity duration-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-data-popup-open/row:pointer-events-auto group-data-popup-open/row:opacity-100">
              <RowButton label={starred ? `Remove ${item.title} from Focus` : `Add ${item.title} to Focus`} tip={starred ? "Unstar (⌘S)" : "Star (⌘S)"} pressed={starred} onClick={() => switchboardActions.toggleFocus(item.id)}>
                <StarIcon className={cn("size-3.5", starred && "fill-current")} />
              </RowButton>
              <RowButton label={`${note ? "Edit" : "Add"} pickup note for ${item.title}`} tip={`${note ? "Edit" : "Add"} pickup note (⌘E)`} onClick={onEditNote}>
                <PencilIcon className="size-3.5" />
              </RowButton>
              <RowButton label={`More for ${item.title}`} tip="More (⇧F10)" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}>
                <EllipsisIcon className="size-3.5" />
              </RowButton>
            </div>
          )}
        </div>
        {editing && <NoteEditor item={item} note={note} onDone={onDoneEditing} />}
      </ContextMenuTrigger>
      <ContextMenuPopup
        className="w-60"
        finalFocus={false}
      >
        <ContextMenuItem onClick={onOpen}>
          <ArrowRightIcon />
          Open
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => switchboardActions.toggleFocus(item.id)}>
          <StarIcon />
          {starred ? "Remove from Focus" : "Add to Focus"}
          <ContextMenuShortcut>⌘S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            keep.current = true;
            onEditNote();
          }}
        >
          <PencilIcon />
          {note ? "Edit pickup note" : "Add pickup note"}
          <ContextMenuShortcut>⌘E</ContextMenuShortcut>
        </ContextMenuItem>
        {note && (
          <ContextMenuItem onClick={() => switchboardActions.note(item.id, "")}>
            <XIcon />
            Clear pickup note
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Layers3Icon />
            Move to area
          </ContextMenuSubTrigger>
          <ContextMenuSubPopup className="w-44">
            <ContextMenuRadioGroup value={item.area} onValueChange={(v: string) => switchboardActions.assign(item.id, v)}>
              {moveTo.map((a) => (
                <ContextMenuRadioItem key={a} value={a} closeOnClick>
                  {a}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                keep.current = true;
                onNewArea();
              }}
            >
              <PlusIcon />
              New area…
            </ContextMenuItem>
          </ContextMenuSubPopup>
        </ContextMenuSub>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function RowButton({ label, tip, pressed, onClick, children }: { label: string; tip: string; pressed?: boolean; onClick(e: React.MouseEvent<HTMLButtonElement>): void; children: ReactNode }) {
  return (
    <Tip label={tip}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn("flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground", pressed && "text-foreground")}
      >
        {children}
      </button>
    </Tip>
  );
}

function NoteEditor({ item, note, onDone }: { item: BoardItem; note?: string; onDone(): void }) {
  const [draft, setDraft] = useState(note ?? "");
  const done = useRef(false);
  const save = () => {
    if (done.current) return;
    done.current = true;
    switchboardActions.note(item.id, draft);
    onDone();
  };
  return (
    <form
      className="flex items-center gap-2 ps-8.5 pe-2 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        autoFocus
        aria-label={`Pickup note for ${item.title}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") done.current = true;
        }}
        onBlur={save}
        placeholder="Where did you leave off?"
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-meta outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24"
      />
    </form>
  );
}
