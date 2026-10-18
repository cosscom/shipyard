import { CloudOffIcon, ListStartIcon, RotateCcwIcon, SendIcon, TrashIcon } from "lucide-react";
import { type RefObject, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { agentOf, guessAgent, sessionName } from "@/lib/derive";
import { ago, errorMessage } from "@/lib/format";
import { mockBoxes, mockSetBoxOnline } from "@/lib/mock-queue";
import { type QueueItem, discard, openQueue, preview, retarget, retry, sendNow, targetName, useQueue } from "@/lib/queue";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// QueueIndicator is the status bar's "Queued (n)": prompts the laptop agent
// keeps for boxes that are away. It opens a list to send, retry, move or
// discard them. It only shows while something is queued (always in mock
// mode, for the simulator).
export function QueueIndicator() {
  const items = useQueue((s) => s.items);
  const open = useQueue((s) => s.open);
  const failed = items.filter((i) => i.state === "failed").length;
  // The keyboard starts on the list, not on the first row's Discard: Enter
  // right after opening must never throw a prompt away.
  const list = useRef<HTMLDivElement>(null);
  if (!items.length && !isMock()) return null;
  return (
    <Popover open={open} onOpenChange={(o) => openQueue(o)}>
      <Tip label={failed ? `${failed} queued ${failed === 1 ? "prompt" : "prompts"} could not be sent` : "Prompts waiting for their box to come back"}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn("-mx-1 flex items-center gap-1.5 rounded px-1 hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground", failed > 0 && "text-warning-foreground")}
            />
          }
        >
          {failed > 0 ? <span className="size-1.5 rounded-full bg-warning" /> : <ListStartIcon className="size-3" />}
          Queued ({items.length})
        </PopoverTrigger>
      </Tip>
      <PopoverPopup initialFocus={list} side="top" align="start" sideOffset={6} className="w-[26rem] p-0 [&_[data-slot=popover-viewport]]:p-0">
        <QueuePanel items={items} list={list} />
      </PopoverPopup>
    </Popover>
  );
}

function QueuePanel({ items, list }: { items: QueueItem[]; list: RefObject<HTMLDivElement | null> }) {
  const status = useStore((s) => s.status);
  const state = (box: string) => status?.boxes.find((b) => b.name === box)?.state ?? "unknown";
  const byBox = useMemo(() => [...new Set(items.map((i) => i.box))].map((box) => [box, items.filter((i) => i.box === box)] as const), [items]);
  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col">
      <div className="border-b px-4 pt-3 pb-2.5">
        <div className="text-row">Queued prompts</div>
        <p className="text-muted-foreground text-meta">Kept by Shipyard on this Mac and typed in when their box is back, in order for each agent, after its current turn.</p>
      </div>
      <div ref={list} tabIndex={-1} role="region" aria-label="Queued prompts" className="min-h-0 flex-1 overflow-y-auto outline-none">
        {items.length === 0 && <p className="px-4 py-8 text-center text-muted-foreground text-body">Nothing queued. A prompt for a box that is offline can wait here.</p>}
        {byBox.map(([box, list]) => (
          <div key={box}>
            <div className="sticky top-0 z-1 flex items-center gap-1.5 border-b bg-popover px-4 py-1 font-medium text-tag text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", state(box) === "online" ? "bg-success" : state(box) === "offline" ? "bg-muted-foreground/50" : "bg-warning")} />
              {box}
              <span className="font-normal">· {state(box) === "online" ? "online" : state(box) === "offline" ? "offline" : state(box)}</span>
            </div>
            {list.map((it) => (
              <Row key={it.id} it={it} online={state(box) === "online"} />
            ))}
          </div>
        ))}
      </div>
      {isMock() && <Simulator />}
    </div>
  );
}

const label = (it: QueueItem, online: boolean): { text: string; className: string } => {
  if (it.state === "failed") return { text: "Failed", className: "text-destructive-foreground" };
  if (it.state === "sending") return { text: "Sending…", className: "text-info-foreground" };
  if (it.state === "waiting") return { text: "Waiting for its turn to end", className: "text-info-foreground" };
  if (it.blocked) return { text: "Behind a failed prompt", className: "text-warning-foreground" };
  return online ? { text: "Sending soon", className: "text-muted-foreground" } : { text: "Waiting for the box", className: "text-muted-foreground" };
};

function Row({ it, online }: { it: QueueItem; online: boolean }) {
  const boxData = useStore((s) => s.boxes[it.box]);
  const session = boxData?.sessions?.find((s) => s.name === it.session);
  const [busy, setBusy] = useState<string>();
  const st = label(it, online);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toastManager.add({ title: "Couldn't do that", description: errorMessage(err), type: "error" });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="border-b px-4 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon agent={session ? agentOf(session) : guessAgent(it.session)} />
        <Tip label={`Session ${it.session} on ${it.box}`} align="start">
          <span className="min-w-0 truncate font-medium text-desc">{targetName(it.box, it.session)}</span>
        </Tip>
        <span className="ml-auto shrink-0 text-tag text-muted-foreground tabular-nums">{ago(it.created)}</span>
      </div>
      <p className="mt-1 line-clamp-2 break-words text-meta text-foreground/80" title={it.text}>
        {preview(it.text, 240)}
      </p>
      {/* The agent's errors name the session by id; say it as the row does. */}
      {it.error && <p className="mt-1 text-destructive-foreground text-meta">{it.error.split(it.session).join(targetName(it.box, it.session))}</p>}
      <div className="mt-1.5 flex min-w-0 items-center gap-1">
        <span className={cn("flex min-w-0 items-center gap-1 truncate text-tag", st.className)}>
          {(it.state === "sending" || it.state === "waiting") && <Spinner className="size-3" />}
          {!online && it.state === "queued" && !it.blocked && <CloudOffIcon className="size-3" />}
          {st.text}
        </span>
        <span className="flex-1" />
        {it.state === "failed" && <MoveTo it={it} />}
        {it.state === "failed" && (
          <Tip label="Put it back in line, to send when the agent is free">
            <Button size="xs" variant="ghost" className="h-6 text-tag" loading={busy === "retry"} onClick={() => act("retry", () => retry(it.id))}>
              <RotateCcwIcon />
              Retry
            </Button>
          </Tip>
        )}
        <Tip label={online ? "Type it in now, without waiting for the agent's turn to end" : `${it.box} is offline`}>
          <Button
            size="xs"
            variant="ghost"
            className="h-6 text-tag"
            disabled={!online || it.state === "sending"}
            loading={busy === "send"}
            onClick={() =>
              act("send", async () => {
                const r = await sendNow(it.id);
                if (r.state === "delivered") toastManager.add({ title: `Sent to ${targetName(it.box, it.session)}`, type: "success" });
                else if (r.state === "failed") toastManager.add({ title: "Couldn't send it", description: r.error, type: "error" });
              })
            }
          >
            <SendIcon />
            Send now
          </Button>
        </Tip>
        <Tip label="Discard this prompt">
          <Button size="icon-xs" variant="ghost" aria-label="Discard" disabled={it.state === "sending"} loading={busy === "discard"} onClick={() => act("discard", () => discard(it.id))}>
            <TrashIcon />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

// MoveTo retargets a failed prompt to another agent on an online box.
function MoveTo({ it }: { it: QueueItem }) {
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const options = useMemo(() => {
    const online = new Set(status?.boxes.filter((b) => b.state === "online").map((b) => b.name));
    return Object.entries(boxes)
      .filter(([box]) => online.has(box))
      .flatMap(([box, d]) =>
        (d.sessions ?? [])
          .filter((s) => !s.exited && agentOf(s) && !(box === it.box && s.name === it.session))
          .map((s) => ({ value: `${box}\u0000${s.name}`, label: `${sessionName(s, { sessions: d.sessions, locations: d.locations, place: true })} — ${box}` })),
      );
  }, [boxes, status, it.box, it.session]);
  if (!options.length) return null;
  return (
    <SimpleSelect
      size="sm"
      className="h-6 w-32 min-w-0 text-tag"
      options={options}
      value=""
      placeholder="Move to…"
      onChange={(v) => {
        const [box, session] = v.split("\u0000");
        if (box && session) retarget(it.id, box, session).catch((err) => toastManager.add({ title: "Couldn't move it", description: errorMessage(err), type: "error" }));
      }}
    />
  );
}

// Simulator takes mock boxes offline and back, so the queue can be seen
// filling and draining without a real box.
function Simulator() {
  useStore((s) => s.status);
  const boxes = mockBoxes();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/40 px-4 py-2 text-tag text-muted-foreground">
      <span className="font-medium">Simulate</span>
      {boxes.map((b) => (
        <Button
          key={b.name}
          size="xs"
          variant="outline"
          className="h-6 text-tag"
          onClick={() => {
            mockSetBoxOnline(b.name, !b.online);
          }}
        >
          <span className={cn("size-1.5 rounded-full", b.online ? "bg-success" : "bg-muted-foreground/50")} />
          {b.online ? `Take ${b.name} offline` : `Bring ${b.name} back`}
        </Button>
      ))}
    </div>
  );
}
