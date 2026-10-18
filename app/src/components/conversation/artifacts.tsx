import { AppWindowIcon, ExternalLinkIcon, LinkIcon, LocateFixedIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import type { ChatListApi } from "@/components/conversation/chat-list";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { toastManager } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { ago } from "@/lib/format";
import { openUrl } from "@/lib/open-url";
import type { Artifact, TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// Artifacts are the pages an agent published on claude.ai with Claude
// Code's Artifact tool. Each publish is a card where it happened in the
// chat; the chip by the reply box lists every page, newest first, to open,
// copy, or find again in the chat. The box reads them from the agent's
// transcript (internal/transcript/artifacts.go).

const NO_ARTIFACTS: Artifact[] = [];

export function useArtifacts(box: string, session: string): Artifact[] {
  return useConversations((s) => s.artifacts[keyOf(box, session)]) ?? NO_ARTIFACTS;
}

const host = (url?: string) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};

const when = (at: number) => ago(new Date(at).toISOString());

// The newest publish each chat has shown, so one that arrives while the
// chat is open is marked new until the list is opened.
const seenUpTo = new Map<string, number>();

// ArtifactsChip sits at the right of the chips under the reply box: "3
// artifacts", opening the list. Nothing shows until there is one.
export function ArtifactsChip({ box, session, who, className }: { box: string; session: string; who: string; className?: string }) {
  const list = useArtifacts(box, session);
  const key = keyOf(box, session);
  const [open, setOpen] = useState(false);
  const newest = list.length ? Math.max(...list.map((a) => a.at)) : 0;
  if (newest && !seenUpTo.has(key)) seenUpTo.set(key, newest);
  const fresh = newest > (seenUpTo.get(key) ?? 0);
  useEffect(() => {
    if (open && newest) seenUpTo.set(key, newest);
  }, [open, newest, key]);
  const rows = useMemo(() => [...list].sort((a, b) => b.at - a.at), [list]);
  if (!list.length) return null;
  const n = list.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" data-testid="artifacts-chip" className={cn(className, fresh && "text-foreground/85")} aria-label={`${n} ${n === 1 ? "artifact" : "artifacts"} ${who} published${fresh ? ", one new" : ""}`} />}>
        <span className="relative flex">
          <AppWindowIcon className="size-3.5" />
          {fresh && <span aria-hidden className="-top-0.5 -right-0.5 absolute size-1.5 rounded-full bg-info ring-2 ring-background" />}
        </span>
        <span className="tabular-nums">{n} published</span>
      </PopoverTrigger>
      <PopoverPopup data-testid="artifacts-popover" side="top" align="end" className="w-[min(24rem,calc(100vw-2rem))] [--viewport-inline-padding:--spacing(1.5)] *:data-[slot=popover-viewport]:py-1.5">
        <div className="flex items-baseline justify-between gap-2 px-2 pt-1 pb-1.5">
          <span className="font-medium text-desc">Artifacts</span>
          <span className="text-muted-foreground text-meta">Published by {who} on claude.ai</span>
        </div>
        <ul className="flex max-h-[min(26rem,calc(var(--available-height)-4rem))] flex-col gap-px overflow-y-auto">
          {rows.map((a) => (
            <ArtifactRow key={a.url} a={a} chat={key} onDone={() => setOpen(false)} />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

function ArtifactRow({ a, chat, onDone }: { a: Artifact; chat: string; onDone(): void }) {
  const open = () => {
    onDone();
    void openUrl(a.url);
  };
  return (
    <li className="group/row relative flex min-w-0 items-center rounded-md has-[button[data-main]:hover]:bg-accent has-[button[data-main]:focus-visible]:bg-accent">
      <Tip label={a.url} side="left" delay={700}>
        <button type="button" data-main onClick={open} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none">
          <ArtifactGlyph />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-desc">{a.title}</span>
            <span className="block truncate text-muted-foreground text-meta">{a.description || host(a.url)}</span>
          </span>
          <span className="shrink-0 self-start pt-0.5 text-meta text-muted-foreground tabular-nums transition-opacity group-hover/row:opacity-0 group-has-focus-visible/row:opacity-0">
            {a.updated ? `Updated ${when(a.at)}` : when(a.at)}
          </span>
        </button>
      </Tip>
      {/* What else to do with it, over its time while the row is pointed at. */}
      <span className="pointer-events-none absolute right-1.5 flex items-center gap-0.5 rounded-md bg-accent pl-1 opacity-0 shadow-[-10px_0_8px_-2px_var(--accent)] transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-focus-visible/row:pointer-events-auto group-has-focus-visible/row:opacity-100">
        <Tip label="Show in chat">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Show ${a.title} in the chat`}
            onClick={() => {
              onDone();
              jumpTo(chat, a.tool);
            }}
          >
            <LocateFixedIcon />
          </Button>
        </Tip>
        <Tip label="Copy link">
          <Button size="icon-xs" variant="ghost" aria-label={`Copy the link to ${a.title}`} onClick={() => void copyText(a.url, "Link copied")}>
            <LinkIcon />
          </Button>
        </Tip>
        <Tip label="Open in your browser">
          <Button size="icon-xs" variant="ghost" aria-label={`Open ${a.title}`} onClick={open}>
            <ExternalLinkIcon />
          </Button>
        </Tip>
      </span>
    </li>
  );
}

function ArtifactGlyph({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs/5", className)}>
      <AppWindowIcon className="size-3.5" />
    </span>
  );
}

// ArtifactCard is a publish where it happened in the chat: the page's
// title, and Open once it has a link.
// An artifact kept on the box (components/art), loaded the first time a
// chat shows one.
const LocalArtifactCard = lazy(() => import("@/components/art/art-card").then((m) => ({ default: m.LocalArtifactCard })));

export function ArtifactCard({ it }: { it: Extract<TranscriptItem, { kind: "artifact" }> }) {
  // One kept on the box (berthd artifact add), not a page on claude.ai.
  if (it.local)
    return (
      <Suspense fallback={<div className="cv-in h-[6.5rem] w-[min(100%,40rem)] animate-pulse self-start rounded-lg border bg-card" />}>
        <LocalArtifactCard it={it} />
      </Suspense>
    );
  const publishing = !it.done && !it.url;
  const status = it.error ? "Didn't publish" : publishing ? "Publishing" : it.updated ? "Updated" : "Published";
  const sub = it.error ? undefined : it.description;
  return (
    <div className={cn("cv-in flex w-[min(100%,40rem)] min-w-0 items-center gap-2 self-start rounded-lg border bg-card py-1 pl-2.5 text-desc shadow-xs/5", it.url ? "pr-1" : "pr-3")}>
      <AppWindowIcon className={cn("size-3.5 shrink-0", it.error ? "text-destructive-foreground" : "text-muted-foreground")} />
      <span className={cn("shrink-0", publishing ? "cv-shimmer" : it.error ? "text-destructive-foreground" : "text-muted-foreground")}>{status}</span>
      <span className="min-w-0 shrink truncate font-medium">{it.text}</span>
      {sub && <span className="hidden min-w-0 max-w-[22rem] flex-1 truncate text-muted-foreground @[640px]:block">· {sub}</span>}
      {it.url && (
        <Tip label={host(it.url) ? `Open on ${host(it.url)}` : "Open in your browser"}>
          <Button size="xs" variant="ghost" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground" onClick={() => void openUrl(it.url!)}>
            Open
            <ExternalLinkIcon />
          </Button>
        </Tip>
      )}
    </div>
  );
}

// --- Show in chat ---

// A request to bring a publish's card (by its call) or any item (by its
// id: a helper's report, from the crew) into view, in the chat it belongs
// to.
const useJump = create<{ to?: { chat: string; tool?: string; item?: string; n: number } }>(() => ({}));
let jumps = 0;
const jumpTo = (chat: string, tool: string) => useJump.setState({ to: { chat, tool, n: ++jumps } });
export const showInChat = (chat: string, item: string) => useJump.setState({ to: { chat, item, n: ++jumps } });

type Row = { kind: "item"; it: TranscriptItem } | { kind: "fold" | "pings" };

// ArtifactJumper brings a card the list asked for into view and marks it
// for a moment. A card further back than the chat holds loads the older
// turns, a page at a time, until it is found or the chat begins.
export function ArtifactJumper({ api, chat, rows, older, onLoadOlder }: { api: ChatListApi; chat: string; rows: Row[]; older?: { loading: boolean; more: boolean }; onLoadOlder?(): void }) {
  const to = useJump((s) => (s.to?.chat === chat ? s.to : undefined));
  const handled = useRef(0);
  useEffect(() => {
    if (!to || handled.current === to.n) return;
    const i = rows.findIndex((r) => r.kind === "item" && (to.item ? r.it.id === to.item : r.it.kind === "artifact" && r.it.tool === to.tool));
    if (i < 0) {
      if (older?.loading) return;
      if (older?.more && onLoadOlder) return void onLoadOlder();
      handled.current = to.n;
      if (to.item) toastManager.add({ type: "info", title: "That message isn't in this chat any more" });
      else toastManager.add({ type: "info", title: "That publish isn't in this chat any more", description: "Its page is still on claude.ai: open it from the list." });
      return;
    }
    handled.current = to.n;
    api.scrollToRow(i);
    const id = (rows[i] as { it: TranscriptItem }).it.id;
    // Once it is drawn where it was scrolled to.
    window.setTimeout(() => {
      const el = api.scroller?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"] > *`);
      if (!el) return;
      el.classList.remove("cv-flash");
      void el.offsetWidth;
      el.classList.add("cv-flash");
    }, 380);
  }, [to, rows, older?.loading, older?.more, onLoadOlder, api]);
  return null;
}
