import "./art.css";

import { BotIcon, ChevronDownIcon, CodeIcon, EyeIcon, HistoryIcon, LayoutGridIcon, LockIcon, SearchXIcon, TriangleAlertIcon } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useMemo, useState } from "react";

import { ArtGlyph, GistLine, KindWord, usePulse, when } from "@/components/art/art-card";
import { ArtView } from "@/components/art/art-view";
import { kindOf } from "@/components/art/kinds";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { type Art, type ArtVersion, latest, sizeLabel, useArt, useArtBody, useArtifact } from "@/lib/art/model";
import { openBoard } from "@/lib/art/open";
import { PaneContext } from "@/lib/pane-context";
import { cn } from "@/lib/utils";

const Board = lazy(() => import("@/components/art/board"));
const SourceView = lazy(() => import("@/components/art/views/source-view"));

// ArtifactPane is an artifact as a tab, a pane of a split, or a side of
// Compare: who made it and from what, its headline, a Live pill that pulses
// when a version lands, its versions, its source, and the artifact itself
// at full size. Without an id it is the worktree's board.

export function ArtifactPane({ id, focus }: { id?: string; focus?: string }) {
  const pane = useContext(PaneContext);
  const wt = pane?.worktree;
  const art = useArtifact(id, wt);
  const loaded = useArt((s) => !!wt && wt in s.byWt);
  if (!id)
    return (
      <Suspense fallback={<div className="flex-1" />}>
        <Board wt={wt} focus={focus} />
      </Suspense>
    );
  if (!art)
    return loaded ? (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="artifact-pane">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>This artifact is gone</EmptyTitle>
            <EmptyDescription>Its worktree was archived, or it was removed with berthd artifact rm.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    ) : (
      <div className="flex-1 animate-pulse bg-muted/20" data-testid="artifact-pane" />
    );
  return <Shown art={art} />;
}

function madeBy(a: Art): string {
  const agent = a.by.agent === "codex" ? "Codex" : a.by.agent === "claude" || !a.by.agent ? "Claude" : a.by.agent;
  if (a.by.helper) return `${a.by.helper.replace(/^Explore:\s*/, "")}, a helper of ${agent}`;
  return a.by.session ? `${agent} (${a.by.session})` : agent;
}

function Shown({ art }: { art: Art }) {
  const pane = useContext(PaneContext);
  const pulse = usePulse(art.id);
  const [n, setN] = useState<number | null>(null);
  const [source, setSource] = useState(false);
  const cur = latest(art);
  const v = useMemo(() => art.versions.find((x) => x.n === n) ?? cur, [art.versions, n, cur]);
  const old = v.n !== cur.n;
  const kind = kindOf(art.kind);
  const { body } = useArtBody(art, v.n);
  useEffect(() => useArt.getState().seen(art.id), [art.id, cur.n]);
  const sandboxed = kind.drawn === "sandbox";
  const fill = art.kind !== "notes";
  // A compact kind's header, in a pane under 40rem (the pane is the
  // container): these classes apply there only (KindSpec.compact).
  const narrow = (cls: string) => (kind.compact ? cls : "");
  const pick = (n: number) => setN(n === cur.n ? null : n);

  return (
    <div data-testid="artifact-pane" data-art-id={art.id} className={cn("flex min-h-0 flex-1 flex-col bg-background", kind.compact && "@container/art")}>
      <header className={cn("shrink-0 border-b px-5 pt-3 pb-2.5", narrow("@max-[40rem]/art:px-3 @max-[40rem]/art:py-1.5"))} data-art-header>
        <div className={cn("mx-auto flex w-full flex-col gap-1.5", kind.wide ? "max-w-[88rem]" : "max-w-[72rem]")}>
          <div className={cn("flex min-w-0 items-center gap-1.5 text-muted-foreground text-meta", narrow("@max-[40rem]/art:sr-only"))}>
            <BotIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">Made by {madeBy(art)}</span>
            {art.file && (
              <>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate font-mono">{art.file}</span>
              </>
            )}
            <Tip label={sandboxed ? "Runs on its own origin in a sandbox: no network, no access to Shipyard" : "Drawn by Shipyard from its data: no code of the agent's runs"}>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1">
                <LockIcon className="size-3" aria-hidden />
                {sandboxed ? "Sandboxed page" : (kind.drawnLabel ?? "Drawn by Shipyard")}
              </span>
            </Tip>
          </div>
          <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1", narrow("@max-[40rem]/art:flex-nowrap @max-[40rem]/art:gap-x-1.5"))}>
            <ArtGlyph art={art} body={body} className="size-4 shrink-0 text-muted-foreground" />
            <h2 className={cn("min-w-0 truncate text-heading", narrow("@max-[40rem]/art:text-row @max-[40rem]/art:font-semibold"))}>{art.title}</h2>
            <span className={cn("shrink-0 text-muted-foreground text-meta", narrow("@max-[40rem]/art:hidden"))}>
              <KindWord art={art} />
            </span>
            <span data-testid="art-live" data-pulse={pulse || undefined} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-tag tabular-nums", pulse ? "art-pulse border-info/40 bg-info/10 text-info-foreground" : "text-muted-foreground", narrow("@max-[40rem]/art:hidden"))}>
              <span className={cn("size-1.5 rounded-full", pulse ? "art-dot bg-info" : art.watched ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
              {pulse ? `Updated just now · v${cur.n}` : `${art.watched ? "Live" : "Latest"} · v${cur.n} · ${when(cur.at)}`}
            </span>
            {kind.compact && <VersionMenu art={art} cur={cur} v={v} pulse={pulse} onPick={pick} className="hidden @max-[40rem]/art:inline-flex" />}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Tip label={source ? "Show the artifact" : "Show its source"}>
                <Button size="xs" variant={source ? "secondary" : "ghost"} className="text-muted-foreground" onClick={() => setSource((s) => !s)} aria-pressed={source} data-testid="art-source-toggle">
                  {source ? <EyeIcon /> : <CodeIcon />}
                  <span className={narrow("@max-[40rem]/art:sr-only")}>{source ? "Artifact" : "Source"}</span>
                </Button>
              </Tip>
              <Tip label="All of this worktree's artifacts">
                <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => pane && openBoard(pane.worktree, { focus: art.id })} data-testid="art-board-link">
                  <LayoutGridIcon />
                  <span className={narrow("@max-[40rem]/art:sr-only")}>Board</span>
                </Button>
              </Tip>
            </span>
          </div>
          <GistLine art={art} className={cn("text-desc", narrow("@max-[40rem]/art:sr-only"))} />
          {art.problem && (
            <div className="flex items-center gap-1.5 text-warning-foreground text-meta">
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">The latest rewrite of {art.file ?? "its file"} wasn't taken: {art.problem}</span>
            </div>
          )}
          {art.versions.length > 1 && (
            <div className={cn("flex flex-wrap items-center gap-1 pt-0.5", narrow("@max-[40rem]/art:hidden"))} role="radiogroup" aria-label="Versions" data-testid="art-versions">
              <HistoryIcon className="me-0.5 size-3.5 text-muted-foreground" aria-hidden />
              {[...art.versions].reverse().map((x) => (
                <button
                  key={x.n}
                  type="button"
                  role="radio"
                  aria-checked={x.n === v.n}
                  onClick={() => pick(x.n)}
                  className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-meta", x.n === v.n ? "border-ring bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}
                >
                  <span className="font-medium tabular-nums">v{x.n}</span>
                  <span className="tabular-nums">{x.n === cur.n ? "latest" : when(x.at)}</span>
                  {x.note && <span className="min-w-0 max-w-[14rem] truncate">· {x.note}</span>}
                  <span className="text-muted-foreground tabular-nums">· {sizeLabel(x.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      {old && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-warning/8 px-5 py-1.5 text-meta" data-testid="art-old">
          <HistoryIcon className="size-3.5 text-warning-foreground" aria-hidden />
          <span>
            Showing v{v.n} from {when(v.at)}. The latest is v{cur.n}.
          </span>
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => setN(null)}>
            Back to latest
          </Button>
        </div>
      )}
      {/* Focusable, so the keyboard can scroll it when nothing in it takes
          focus (a long source, notes). */}
      <div tabIndex={0} aria-label={art.title} role="region" className={cn("min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", fill || source ? "flex flex-col p-4" : "px-5 py-5")}>
        <div className={cn("mx-auto w-full", kind.wide ? "max-w-[88rem]" : "max-w-[72rem]", (fill || source) && "flex min-h-0 flex-1 flex-col")}>
          {source ? (
            body === undefined ? null : (
              <Suspense fallback={null}>
                <div data-testid="art-source">
                  <SourceView art={art} version={v} body={body} size="full" />
                </div>
              </Suspense>
            )
          ) : (
            <ArtView art={art} version={v} size="full" className={cn(fill && "flex min-h-0 flex-1 flex-col *:flex-1")} />
          )}
        </div>
      </div>
    </div>
  );
}

// VersionMenu is a compact header's Live pill and versions strip in one:
// the version shown, which opens the list of them.
function VersionMenu({ art, cur, v, pulse, onPick, className }: { art: Art; cur: ArtVersion; v: ArtVersion; pulse: boolean; onPick(n: number): void; className?: string }) {
  const state = pulse ? "Updated just now" : art.watched ? "Live" : "Latest";
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Version: v${v.n}${v.n === cur.n ? `, the latest (${state.toLowerCase()})` : `, the latest is v${cur.n}`}. ${art.versions.length} ${art.versions.length === 1 ? "version" : "versions"}`}
        data-testid="art-version-menu"
        data-pulse={pulse || undefined}
        className={cn("shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-tag tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", pulse ? "art-pulse border-info/40 bg-info/10 text-info-foreground" : "text-muted-foreground hover:bg-accent/60", className)}
      >
        <span className={cn("size-1.5 rounded-full", pulse ? "art-dot bg-info" : art.watched ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
        v{v.n}
        <ChevronDownIcon className="size-3" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>
            {state} · v{cur.n} · {when(cur.at)}
          </MenuGroupLabel>
          <MenuRadioGroup value={String(v.n)} onValueChange={(x) => onPick(Number(x))}>
            {[...art.versions].reverse().map((x) => (
              <MenuRadioItem key={x.n} value={String(x.n)}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-medium tabular-nums">v{x.n}</span>
                  <span className="text-muted-foreground tabular-nums">{x.n === cur.n ? "latest" : when(x.at)}</span>
                  {x.note && <span className="min-w-0 max-w-[14rem] truncate text-muted-foreground">· {x.note}</span>}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
