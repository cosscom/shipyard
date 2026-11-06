import { type BerthPluginContext, useStorage } from "@berth/plugin";
import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Kbd, Skeleton, ViewHeader, cn } from "@berth/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Card, viewKey } from "./card.tsx";
import { ago, estimate, holdCurrent, inList, type Item, itemsOf, nextAfter, openItems, snoozedItems, walkOrder } from "./model.ts";
import { Peek } from "./peek.tsx";
import { getState, type InboxState, subscribe, undoClose } from "./store.ts";

export const allItems = (s: InboxState): Item[] => Object.entries(s.reads).flatMap(([box, read]) => itemsOf(box, read));
export const openOf = (s: InboxState): Item[] => openItems(allItems(s), s.marks, s.now);

function Row({ item, active, now, onClick }: { item: Item; active: boolean; now: number; onClick(): void }) {
  return (
    <button type="button" data-testid="inbox-item" aria-current={active || undefined} onClick={onClick} className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", active && "bg-accent")}>
      <span className="truncate text-sm">{item.title}</span>
      <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{[item.location, item.box].filter(Boolean).join(" · ")}</span>
        <span>{ago(item.since, now)}</span>
      </span>
    </button>
  );
}

export function InboxScreen({ berth }: { berth: BerthPluginContext }) {
  const state = useSyncExternalStore(subscribe, getState);
  const open = useMemo(() => openOf(state), [state.reads, state.marks, state.now]);
  const order = useMemo(() => walkOrder(open), [open]);
  const groups = useMemo(() => inList(open), [open]);
  const later = useMemo(() => snoozedItems(allItems(state), state.marks, state.now), [state.reads, state.marks, state.now]);

  const [walking, setWalking] = useStorage<boolean>("walking", false);
  const [peekOpen, setPeekOpen] = useStorage<boolean>("peek", false);
  const [currentKey, setCurrentKey] = useState<string>();
  const previous = useRef<Item[]>([]);

  // The card you're on stays while it's open. When it leaves, the next in order
  // comes up, and a new arrival waits its turn.
  const current = holdCurrent(order, currentKey, previous.current);
  useEffect(() => {
    previous.current = order;
    if (current?.key !== currentKey) setCurrentKey(current?.key);
  }, [order, current?.key]);

  const root = useRef<HTMLDivElement>(null);
  // Focus leaves the nav row you came from, so Enter can't press it again.
  useEffect(() => root.current?.focus(), []);

  const step = useCallback((by: number) => setCurrentKey(nextAfter(order, current?.key, by)?.key), [order, current?.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewKey(e)) return;
      const act = { j: () => step(1), k: () => step(-1), w: () => setWalking(!walking), p: () => current?.session && setPeekOpen(!peekOpen) }[e.key];
      if (act) {
        e.preventDefault();
        act();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, walking, peekOpen, current?.session]);

  const left = estimate(order);
  const at = current ? order.findIndex((i) => i.key === current.key) + 1 : 0;

  return (
    <div ref={root} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none" data-testid="inbox-screen">
      <ViewHeader
        title="Inbox"
        description={state.loaded ? <span data-testid="inbox-left">{left}</span> : undefined}
        actions={
          <div className="flex items-center gap-2">
            {walking && order.length > 0 && (
              <span className="text-xs text-muted-foreground" data-testid="inbox-position">
                {at} of {order.length}
              </span>
            )}
            <Button size="sm" variant={walking ? "default" : "outline"} aria-pressed={walking} data-testid="inbox-walk" onClick={() => setWalking(!walking)}>
              {walking ? "Show list" : "Walk through"}
              <Kbd className="ml-1">w</Kbd>
            </Button>
          </div>
        }
      />

      {!state.loaded && (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {state.loaded && !current && (
        <Empty data-testid="inbox-empty" className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Nothing needs you</EmptyTitle>
            <EmptyDescription>{later.length ? `${later.length} snoozed. They come back when it's time.` : "Agents post here when they need a decision, an action or your review."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {current && (
        <div className="flex min-h-0 flex-1">
          {!walking && (
            <nav className="flex min-h-0 flex-col gap-3 overflow-auto border-r p-2" style={{ width: 300, flexShrink: 0 }} data-testid="inbox-list" aria-label="Inbox items">
              {groups.map((g) =>
                g.items.length === 0 ? null : (
                  <section key={g.group} data-testid={`inbox-group-${g.group}`}>
                    <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
                      {g.title}
                      <Badge variant="secondary">{g.items.length}</Badge>
                    </h3>
                    {g.items.map((it) => (
                      <Row key={it.key} item={it} now={state.now} active={it.key === current.key} onClick={() => setCurrentKey(it.key)} />
                    ))}
                  </section>
                ),
              )}
              {later.length > 0 && <p className="px-2 text-xs text-muted-foreground" data-testid="inbox-snoozed-count">{later.length} snoozed</p>}
            </nav>
          )}
          <main className="min-h-0 min-w-0 flex-1 overflow-auto">
            <Card key={current.key} berth={berth} item={current} peekOpen={peekOpen && !!current.session} onPeek={() => setPeekOpen(!peekOpen)} />
          </main>
          {peekOpen && current.session && <Peek berth={berth} item={current} onClose={() => setPeekOpen(false)} />}
        </div>
      )}

      {state.undo && (
        <div className="flex items-center gap-2 border-t px-4 py-2 text-sm" role="status" data-testid="inbox-undo">
          <span className="min-w-0 flex-1 truncate">Closing "{state.undo.item.title}" in a few seconds.</span>
          <Button size="sm" variant="outline" onClick={undoClose}>
            Undo
          </Button>
        </div>
      )}
    </div>
  );
}
