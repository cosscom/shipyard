import { AppWindowIcon, BotIcon, ChevronDownIcon, EyeIcon, RefreshCwIcon } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { StateGlyph } from "@/components/agent-glyph";
import { ConversationView, type EditActions } from "@/components/conversation/conversation-view";
import { Markdown } from "@/components/conversation/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { boxApi } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { type Helper, historyApi } from "@/lib/history";
import { useStore } from "@/lib/store";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { openHelperPane } from "@/lib/workspaces";

// A helper's own conversation (a subagent Claude Code started), opened from
// the crew or from "Sent out 2 helpers" in the chat: read-only, drawn as the
// chat is (its replies in Markdown, its steps folded, each call opening to
// what it ran and printed). A click opens it as a tab of its own beside the
// chat (helper-pane.tsx), ⌘-click beside the chat in a split, and ⌥-click
// peeks at it in a sheet over the chat, where its siblings are a click away
// at the top and Open in tab keeps it. It reads while open, and holds
// nothing after.

// Where a helper was opened from: the chat's pane, so its tab opens beside
// that chat.
export interface From {
  wsKey: string;
  tab: string;
  pane: string;
}

interface OpenHelper {
  box: string;
  session: string;
  // The helper's id, or the id of the call that started it.
  ref: string;
  from?: From;
}

// The sheet is drawn by one host (the first mounted), wherever the helper
// was opened from.
const useHelperSheet = create<{ open?: OpenHelper; hosts: string[] }>()(() => ({ hosts: [] }));

// peekHelper shows a helper's conversation in the sheet beside the chat.
export function peekHelper(box: string, session: string, ref: string, from?: From) {
  useHelperSheet.setState({ open: { box, session, ref, from } });
}

// openHelper opens a helper as a click asks: ⌥ peeks in the sheet, ⌘ (Ctrl
// elsewhere) opens it beside the chat in a split, and a plain click as a
// tab beside the chat's, or the tab it already has.
export function openHelper(box: string, session: string, ref: string, opts: { from?: From; title?: string; event?: { metaKey: boolean; ctrlKey: boolean; altKey: boolean } } = {}) {
  const e = opts.event;
  if (e?.altKey) return peekHelper(box, session, ref, opts.from);
  openHelperPane({ box, session, ref, title: opts.title }, e && (e.metaKey || e.ctrlKey) ? "split" : "tab", opts.from);
}

// What each open helper is and how it is doing, by box/session/id, for its
// tab in the strip: written by its pane as it reads.
export const helperKey = (box: string, session: string, id: string) => `${box}/${session}/${id}`;
export const useHelperInfo = create<Record<string, { name: string; state: Helper["state"] }>>()(() => ({}));

// matchHelper finds a helper by its id, the call that started it, or its
// name.
export function matchHelper(helpers: Helper[] | undefined, ref: string): Helper | undefined {
  const name = ref.replace(/^Explore:\s*/, "");
  return helpers?.find((x) => x.id === ref || x.tool === ref) ?? helpers?.find((x) => x.name === ref || x.name === name);
}

// useHelpers reads a session's helpers: again every few seconds while any
// works, and with retry while the one wanted isn't among them yet (a
// record written a moment later, or a box coming back).
export function useHelpers(box: string, session: string, opts: { enabled?: boolean; retry?: boolean } = {}) {
  const client = useStore((s) => s.client);
  const [helpers, setHelpers] = useState<Helper[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const busy = !!helpers?.some((h) => h.state === "running");
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!client || !enabled) return;
    let alive = true;
    const read = () =>
      historyApi.helpers(client, box, session).then(
        (hs) => alive && (setHelpers(hs), setError(undefined)),
        (err) => alive && setError(errorMessage(err)),
      );
    void read();
    const every = busy ? 3000 : opts.retry ? 5000 : 0;
    const t = every ? window.setInterval(read, every) : 0;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [client, box, session, busy, enabled, opts.retry, attempt]);
  return { helpers, error, retry: () => setAttempt((n) => n + 1) };
}

export const HelperSheetHost = memo(function HelperSheetHost() {
  const id = useId();
  const leader = useHelperSheet((s) => s.hosts[0] === id);
  const open = useHelperSheet((s) => s.open);
  useEffect(() => {
    useHelperSheet.setState((s) => ({ hosts: [...s.hosts, id] }));
    return () => useHelperSheet.setState((s) => ({ hosts: s.hosts.filter((h) => h !== id) }));
  }, [id]);
  if (!leader || !open) return null;
  return <HelperSheet key={`${open.box}/${open.session}`} {...open} onClose={() => useHelperSheet.setState({ open: undefined })} />;
});

const elapsed = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function HelperSheet({ box, session, ref: first, from, onClose }: OpenHelper & { onClose(): void }) {
  const parent = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session)?.title);
  const { helpers, error: listError } = useHelpers(box, session);
  const [sel, setSel] = useState(first);
  useEffect(() => setSel(first), [first]);

  const h = matchHelper(helpers, sel);
  const siblings = helpers?.filter((x) => (x.depth ?? 1) <= 1 || x.id === h?.id) ?? [];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (h?.state !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [h?.state]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetPopup side="right" className="w-[min(760px,calc(100vw-48px))] max-w-none" aria-label={h ? `${h.name}: the helper's conversation` : "A helper's conversation"}>
        <div className="flex flex-col gap-3 border-b px-6 pt-5 pb-4">
          <div className="flex items-center gap-2 pr-10 text-muted-foreground text-xs">
            <BotIcon className="size-3.5" aria-hidden />
            <span className="min-w-0 truncate">{parent ? `A helper in “${parent}”` : "A helper"}</span>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1">
              <EyeIcon className="size-3" aria-hidden />
              Read-only
            </span>
          </div>
          <div className="flex items-center gap-3 pr-10">
            <SheetTitle className="min-w-0 flex-1 truncate text-lg">{h?.name ?? (helpers ? "Helper not found" : "Opening the helper…")}</SheetTitle>
            {h && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  onClose();
                  openHelperPane({ box, session, ref: h.id, title: h.name }, "tab", from);
                }}
              >
                <AppWindowIcon />
                Open in tab
              </Button>
            )}
          </div>
          {h && (
            <SheetDescription render={<div />} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5">
                <StateGlyph state={h.state === "running" ? "running" : "finished"} />
                {h.state === "running" ? `Working · ${elapsed(now - h.started)}` : `Finished · took ${elapsed(h.updated - h.started)}`}
              </span>
              {h.type && <Badge variant="outline">{h.type}</Badge>}
              {h.background && <Badge variant="secondary">In the background</Badge>}
            </SheetDescription>
          )}
          {siblings.length > 1 && (
            <div role="tablist" aria-label="Helpers" className="-mx-1 flex gap-1 overflow-x-auto pb-0.5">
              {siblings.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={x.id === h?.id}
                  onClick={() => setSel(x.id)}
                  className={cn(
                    "flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    x.id === h?.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <StateGlyph state={x.state === "running" ? "running" : "finished"} className="size-3" />
                  <span className="truncate">{x.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {!helpers && !listError && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            <Spinner className="mr-2 size-4" />
            Reading the helpers…
          </div>
        )}
        {listError && !helpers && <p className="m-6 text-destructive-foreground text-sm">Couldn't list the helpers: {listError}</p>}
        {helpers && !h && <p className="m-6 text-muted-foreground text-sm">This helper's conversation isn't on {box} (it may be from before the agent was resumed, or another session's).</p>}
        {h && <HelperChat key={h.id} box={box} session={session} h={h} />}
      </SheetPopup>
    </Sheet>
  );
}

// HelperChat is a helper's conversation, read while it works. In a tab
// (wide) it keeps to the chat's column; in the sheet it fills it.
export function HelperChat({ box, session, h, wide }: { box: string; session: string; h: Helper; wide?: boolean }) {
  const client = useStore((s) => s.client);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const next = useRef(0);
  const running = h.state === "running";

  useEffect(() => {
    if (!client) return;
    let alive = true;
    let busy = false;
    const read = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const r = await historyApi.helperTranscript(client, box, session, h.id, next.current);
        if (!alive) return;
        setItems((list) => {
          const out = [...list];
          const at = new Map(out.map((it, i) => [it.id, i]));
          for (const it of r.items ?? []) {
            const i = at.get(it.id);
            if (i === undefined) out.push(it);
            else out[i] = it;
          }
          return out.slice(-1000);
        });
        next.current = r.next ?? next.current;
        setState("ready");
      } catch (err) {
        if (!alive) return;
        setError(errorMessage(err));
        setState((s) => (s === "ready" ? s : "error"));
      } finally {
        busy = false;
      }
    };
    void read();
    const t = running ? window.setInterval(() => void read(), 2000) : 0;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [client, box, session, h.id, running, attempt]);

  const edits = useMemo<EditActions | undefined>(
    () =>
      client
        ? {
            load: (file) => boxApi.diff(client, box, session, file),
            tool: (id) => historyApi.helperTool(client, box, session, h.id, id),
            comments: () => undefined,
            review: () => useStore.getState().setView({ kind: "review" }),
          }
        : undefined,
    [client, box, session, h.id],
  );

  // The first prompt is what the agent asked it: shown above, not as a
  // bubble the person sent.
  const prompt = items[0]?.kind === "user" ? items[0].text : h.prompt;
  const rest = items[0]?.kind === "user" ? items.slice(1) : items;
  const shown = running ? [...rest, { kind: "thinking" as const, id: "live:helper", since: h.updated }] : rest;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
      <div className={cn(wide && "mx-auto w-full max-w-(--berth-chat-w)")}>
      {prompt && <AskedBy text={prompt} />}
      {state === "loading" && (
        <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
          <Spinner className="mr-2 size-4" />
          Reading its conversation…
        </div>
      )}
      {state === "error" && (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p className="text-destructive-foreground">Couldn't read its conversation: {error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCwIcon />
            Retry
          </Button>
        </div>
      )}
      {state === "ready" && !shown.length && <p className="text-muted-foreground text-sm">It hasn't done anything yet.</p>}
      {state === "ready" && shown.length > 0 && <ConversationView items={shown} onAnswer={() => {}} edits={edits} who="The helper" className="max-w-none" />}
      </div>
    </div>
  );
}

// AskedBy is the helper's task, as the agent wrote it: folded to a few
// lines when long.
function AskedBy({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 6;
  return (
    <div className="mb-5 rounded-lg border bg-muted/40 px-4 py-3">
      <div className="mb-1.5 font-medium text-muted-foreground text-xs">Asked by the agent</div>
      <div className={cn("relative text-[0.8438rem]", long && !open && "max-h-32 overflow-hidden")}>
        <Markdown text={text} copy={false} />
        {long && !open && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted/90 to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
