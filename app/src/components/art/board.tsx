import "./art.css";

import { ArrowUpRightIcon, LayoutGridIcon, PanelRightIcon } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { ArtGlyph, artTime, GistLine, KindChips, KindWord, Press, usePulse, when } from "@/components/art/art-card";
import { ArtView } from "@/components/art/art-view";
import { allKinds } from "@/components/art/kinds";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { type Art, latest, useArt, useWorktreeArt } from "@/lib/art/model";
import { openArtifact } from "@/lib/art/open";
import { PaneContext } from "@/lib/pane-context";
import { cn } from "@/lib/utils";
import { useWorktreeRef } from "@/lib/workspaces";

// The board: a worktree's artifacts at a glance, a grid of live
// thumbnails, the newest change first, filtered by kind. focus leads,
// larger. Opened from the chat's "N artifacts" chip, a tab's Board button,
// or the worktree's toolbar.

export default function Board({ wt, focus }: { wt?: string; focus?: string }) {
  const list = useWorktreeArt(wt);
  const loaded = useArt((s) => !!wt && wt in s.byWt);
  const ref = useWorktreeRef(wt);
  const [filter, setFilter] = useState<string>("all");
  const kinds = allKinds().filter((k) => list.some((a) => a.kind === k.kind));
  const rows = useMemo(() => list.filter((a) => filter === "all" || a.kind === filter).sort((x, y) => artTime(y) - artTime(x)), [list, filter]);
  const lead = focus ? rows.find((a) => a.id === focus) : undefined;
  const rest = rows.filter((a) => a !== lead);
  return (
    <div data-testid="artifact-board" className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <header className="sticky top-0 z-10 shrink-0 border-b bg-background/95 px-5 pt-3 pb-2.5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[80rem] flex-wrap items-center gap-x-3 gap-y-2">
          <LayoutGridIcon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-heading">Artifacts</h2>
          <span className="text-muted-foreground text-meta">
            {ref ? (ref.main ? ref.location : ref.worktree) : ""}
            {list.length ? ` · ${list.length} made by its agents · live` : ""}
          </span>
          {kinds.length > 0 && (
            <div className="ml-auto flex flex-wrap items-center gap-1" role="toolbar" aria-label="Show">
              {[{ kind: "all", plural: "All" }, ...kinds].map((k) => (
                <button key={k.kind} type="button" aria-pressed={filter === k.kind} data-filter={k.kind} onClick={() => setFilter(k.kind)} className={cn("rounded-md border px-2 py-0.5 text-meta", filter === k.kind ? "border-transparent bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
                  {k.plural}
                  {k.kind !== "all" && <span className="ms-1 text-muted-foreground tabular-nums">{list.filter((a) => a.kind === k.kind).length}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      {loaded && !list.length ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutGridIcon />
              </EmptyMedia>
              <EmptyTitle>No artifacts here yet</EmptyTitle>
              <EmptyDescription>When an agent in this worktree makes a chart, a table, a diagram, notes or a small page with berthd artifact add, it shows here, live.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-[80rem] grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 p-5">
          {lead && <Tile art={lead} lead />}
          {rest.map((a) => (
            <Tile key={a.id} art={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ art, lead }: { art: Art; lead?: boolean }) {
  const pulse = usePulse(art.id);
  const pane = useContext(PaneContext);
  const from = pane ? { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane } : undefined;
  const v = latest(art);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lead) ref.current?.scrollIntoView({ block: "nearest" });
  }, [lead]);
  const open = (split: boolean) => openArtifact(art, { split, from });
  return (
    <div ref={ref} data-art-tile={art.id} className={cn("group @container flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card shadow-xs/5 transition-colors hover:border-ring/50", lead && "col-span-full ring-2 ring-ring/40", pulse && "art-pulse border-info/50")}>
      <Press onPress={(e) => open(e.metaKey || e.ctrlKey)} className={cn("relative block overflow-hidden border-b bg-background text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", lead ? "p-4" : "p-2.5")} label={`Open ${art.title}`}>
        <ArtView art={art} size="thumb" height={lead ? 300 : 136} />
      </Press>
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-2">
        <ArtGlyph art={art} className="text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-desc">{art.title}</div>
          <GistLine art={art} className="text-meta" />
          {lead && <KindChips art={art} className="py-0.5" />}
          <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-meta">
            <span className="truncate">
              <KindWord art={art} />
            </span>
            <span aria-hidden>·</span>
            <span className={cn("shrink-0 tabular-nums", pulse && "font-medium text-info-foreground")}>
              {pulse && <span className="art-dot me-1 inline-block size-1.5 rounded-full bg-info align-middle" aria-hidden />}v{v.n} · {pulse ? "just now" : when(v.at)}
            </span>
          </div>
        </div>
        <Tip label="Open beside">
          <Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Open ${art.title} beside`} onClick={() => open(true)}>
            <PanelRightIcon />
          </Button>
        </Tip>
        <Tip label="Open in a tab">
          <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Open ${art.title}`} onClick={() => open(false)}>
            <ArrowUpRightIcon />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
