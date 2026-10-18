import "./art.css";

import { ArrowUpRightIcon, PanelRightIcon } from "lucide-react";
import { Suspense, useContext, useEffect, useState } from "react";

import { ArtView } from "@/components/art/art-view";
import { kindOf, kindWord } from "@/components/art/kinds";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { ago } from "@/lib/format";
import { type Art, atMs, latest, useArt, useArtBody, useArtifact } from "@/lib/art/model";
import { openArtifact } from "@/lib/art/open";
import { PaneContext } from "@/lib/pane-context";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// The chat's side of an artifact: a card where the agent made it, with a
// live thumbnail, the headline its data gives, what it is, its version and
// age. A click opens it in a tab; ⌘-click (or Open beside) beside the chat.

export const when = (iso: string) => ago(iso);

export function ArtGlyph({ art, body, className }: { art: Art; body?: string; className?: string }) {
  const Icon = kindOf(art.kind).icon(body);
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

// usePulse is true for a few seconds after a new version arrived.
export function usePulse(id: string): boolean {
  const at = useArt((s) => s.pulse[id]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.max(0, at + 6000 - Date.now()));
    return () => window.clearTimeout(t);
  }, [at]);
  return !!at && Date.now() - at < 6000;
}

// Press is a click target that holds a thumbnail: a div acting as a button.
export function Press({ onPress, className, children, label }: { onPress(e: React.MouseEvent | React.KeyboardEvent): void; className?: string; children: React.ReactNode; label: string }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={cn("cursor-pointer", className)}
      onClick={onPress}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPress(e);
        }
      }}
    >
      {children}
    </div>
  );
}

// GistLine is the headline a card, tile or tab leads with.
export function GistLine({ art, className }: { art: Art; className?: string }) {
  const { body } = useArtBody(art);
  const g = body === undefined ? undefined : kindOf(art.kind).gist?.(art, body);
  if (!g) return body === undefined ? <span className={cn("block h-4 w-40 animate-pulse rounded bg-muted/60", className)} /> : null;
  return (
    <span data-art-gist className={cn("block truncate tabular-nums", g.tone === "good" ? "text-success-foreground" : g.tone === "bad" ? "text-destructive-foreground" : "text-foreground/85", className)}>
      {g.text}
    </span>
  );
}

// KindChips is the row a kind puts under the headline (a visual diff's
// "/search at 375 scrolls sideways"), if it has one.
export function KindChips({ art, className }: { art: Art; className?: string }) {
  const { body } = useArtBody(art);
  const Chips = kindOf(art.kind).Chips;
  if (!Chips || body === undefined) return null;
  return (
    <div className={className} data-art-chips>
      <Suspense fallback={null}>
        <Chips art={art} body={body} />
      </Suspense>
    </div>
  );
}

export function KindWord({ art }: { art: Art }) {
  const { body } = useArtBody(art);
  return <>{kindWord(art, body)}</>;
}

export function Version({ art, pulse }: { art: Art; pulse: boolean }) {
  return (
    <span data-art-version className={cn("inline-flex shrink-0 items-center gap-1 rounded-[0.3125rem] border px-1.5 font-medium text-tag tabular-nums leading-[1.0625rem]", pulse ? "border-info/40 bg-info/10 text-info-foreground" : "border-border bg-muted/60 text-muted-foreground")}>
      {pulse && <span className="art-dot size-1.5 rounded-full bg-info" aria-hidden />}v{latest(art).n}
    </span>
  );
}

const helperName = (h: string) => h.replace(/^Explore:\s*/, "");

export function LocalArtifactCard({ it }: { it: Extract<TranscriptItem, { kind: "artifact" }> }) {
  const pane = useContext(PaneContext);
  const art = useArtifact(it.local, pane?.worktree);
  const loaded = useArt((s) => !pane?.worktree || pane.worktree in s.byWt);
  if (!art)
    return loaded ? (
      <div className="cv-in w-[min(100%,40rem)] self-start rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-meta">“{it.text}” is no longer on the box</div>
    ) : (
      <div className="cv-in h-[6.5rem] w-[min(100%,40rem)] animate-pulse self-start rounded-lg border bg-card" />
    );
  if (it.updated) return <UpdateLine art={art} it={it} />;
  return <Card art={art} />;
}

function useOpen(art: Art) {
  const pane = useContext(PaneContext);
  const from = pane ? { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane } : undefined;
  return (e?: React.MouseEvent | React.KeyboardEvent, split?: boolean) => openArtifact(art, { split: split ?? (!!e && (e.metaKey || e.ctrlKey)), from });
}

function Card({ art }: { art: Art }) {
  const pulse = usePulse(art.id);
  const v = latest(art);
  const open = useOpen(art);
  const note = art.by.helper ? `by ${helperName(art.by.helper)}` : v.note;
  return (
    <div data-art-card={art.id} data-testid="art-card" className={cn("cv-in @container flex w-[min(100%,40rem)] min-w-0 self-start overflow-hidden rounded-lg border bg-card text-desc shadow-xs/5 transition-colors", pulse && "art-pulse border-info/50")}>
      <Press onPress={(e) => open(e)} label={`Open ${art.title}`} className="group relative hidden w-[13.5rem] shrink-0 overflow-hidden border-r bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @[420px]:block">
        <ArtView art={art} size="thumb" height={84} />
        <span className="absolute inset-0 bg-foreground/0 transition-colors group-hover:bg-foreground/4" />
      </Press>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-2 pr-1.5 pl-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <ArtGlyph art={art} className="text-muted-foreground" />
          <span className="min-w-0 truncate font-medium" data-art-title>
            {art.title}
          </span>
          <span className="ml-auto" />
          <span className="flex shrink-0 items-center">
            <Tip label="Open beside the chat · ⌘-click">
              <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${art.title} beside the chat`} onClick={(e) => open(e, true)}>
                <PanelRightIcon />
              </Button>
            </Tip>
            <Tip label="Open in a tab · ⌘-click opens it beside">
              <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={(e) => open(e)}>
                Open
                <ArrowUpRightIcon />
              </Button>
            </Tip>
          </span>
        </div>
        <GistLine art={art} className="font-medium" />
        <KindChips art={art} />
        <div className="flex min-w-0 items-center gap-x-1.5 text-muted-foreground text-meta">
          <span className="shrink-0">
            <KindWord art={art} />
          </span>
          <span aria-hidden>·</span>
          <Version art={art} pulse={pulse} />
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{pulse ? "updated just now" : v.n > 1 ? `updated ${when(v.at)}` : when(v.at)}</span>
          {note && <span aria-hidden>·</span>}
          {note && <span className="min-w-0 truncate">{note}</span>}
        </div>
        {art.problem && <span className="truncate text-warning-foreground text-meta">Its latest rewrite wasn't taken: {art.problem}</span>}
      </div>
    </div>
  );
}

// A version made where the agent said so (add --note): one quiet line.
function UpdateLine({ art, it }: { art: Art; it: Extract<TranscriptItem, { kind: "artifact" }> }) {
  const open = useOpen(art);
  const n = it.version ?? latest(art).n;
  const note = art.versions.find((x) => x.n === n)?.note;
  return (
    <div data-art-card={art.id} data-testid="art-update" className="cv-in @container flex w-[min(100%,40rem)] min-w-0 items-center gap-2 self-start rounded-lg border border-info/30 bg-info/5 py-1 pr-1 pl-2.5 text-desc">
      <ArtGlyph art={art} className="text-info-foreground" />
      <span className="shrink-0 text-muted-foreground">Updated</span>
      <span className="min-w-0 truncate font-medium">{art.title}</span>
      <span className="shrink-0 text-muted-foreground text-meta tabular-nums">to v{n}</span>
      {note && <span className="hidden min-w-0 truncate text-muted-foreground text-meta @[520px]:inline">· {note}</span>}
      <span className="ml-auto" />
      <Tip label="Open · ⌘-click beside the chat">
        <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={(e) => open(e)}>
          Open
          <ArrowUpRightIcon />
        </Button>
      </Tip>
    </div>
  );
}

export const artTime = (a: Art) => atMs(latest(a));
