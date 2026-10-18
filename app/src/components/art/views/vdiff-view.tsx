import { AlertTriangleIcon, ArrowLeftIcon, ArrowRightIcon, CheckCircle2Icon, CheckIcon, Columns2Icon, FlameIcon, InfoIcon, LayersIcon, LayoutGridIcon, MoonIcon, PlusCircleIcon, RepeatIcon, SplitIcon, SquareDashedIcon, StampIcon, SunIcon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ViewProps } from "@/components/art/kinds";
import { Crop, type Overlays, REGION, Stage, type StageMode } from "@/components/art/views/vdiff-stage";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { type Art, type ArtVersion, latest } from "@/lib/art/model";
import { acceptBaseline, useAccepted } from "@/lib/art/vdiff-accept";
import { allClear, baseName, type Change, changes, firstPage, flags, frame, overflow, parseVdiff, pct, type Scheme, schemeOf, schemes, sizeName, sortedPages, thumbShot, type VdPage, type VdShot, type VisualDiff, worstShot } from "@/lib/art/vdiff";
import { cn } from "@/lib/utils";

// A visual diff, drawn by Shipyard from the box's berth.visualdiff/v1
// manifest. Full size it is the slider-first view: one page large, a
// before/after wipe, sizes as tabs with each one's change, the heatmap and
// numbered regions on top; "All shots" puts every page × size in a grid in
// its place, and "Changes ‹ n of N ›" (n / p) walks every change across
// pages and sizes. Nothing changed: a calm all clear. Small (a card, a
// board tile) it is a mini wipe of its biggest change, or the all clear.

export default function VisualDiffKindView({ art, version, body, size, height }: ViewProps) {
  const v = useMemo(() => parseVdiff(body), [body]);
  if (!v)
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed p-3 text-muted-foreground text-meta" style={{ height: height ?? 120 }}>
        This visual diff's manifest doesn't parse.
      </div>
    );
  if (size === "thumb") return <VdiffThumb art={art} v={v} height={height ?? 120} />;
  return <VisualDiffView art={art} version={version} v={v} />;
}

// ---------------------------------------------------------------- the tab

function VisualDiffView({ art, version, v }: { art: Art; version: ArtVersion; v: VisualDiff }) {
  return (
    <div data-vd-view data-vd-clear={allClear(v) || undefined} className="@container flex min-w-0 flex-col">
      <Summary art={art} version={version} v={v} />
      {allClear(v) ? <AllClear art={art} v={v} /> : <SliderFirst art={art} v={v} />}
    </div>
  );
}

// Summary: what was compared with what, how long it took, what needs a
// look, and Accept as baseline.
function Summary({ art, version, v }: { art: Art; version: ArtVersion; v: VisualDiff }) {
  const n = v.settings.sizes.length;
  const sch = schemes(v);
  // Under 480px (beside the chat) it is one line, what needs a look and
  // Accept, so the stage starts near the top; the counts and timing stay
  // for screen readers.
  return (
    <div className="flex min-w-0 flex-col gap-1.5 @max-[480px]:flex-row @max-[480px]:flex-wrap @max-[480px]:items-center" data-vd-summary>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-meta @max-[480px]:order-2 @max-[480px]:ml-auto">
        <span className="hidden min-w-0 truncate font-mono @[560px]:inline" data-vd-compare>
          {v.base.kind === "baseline" ? `${v.base.label} baseline` : v.base.label}
          {v.base.commit ? `@${v.base.commit}` : ""} → {v.head.label}
          {v.head.commit ? `@${v.head.commit}` : ""}
          {v.head.dirty ? ` +${v.head.dirty} uncommitted` : ""}
        </span>
        <span aria-hidden className="hidden @[560px]:inline">
          ·
        </span>
        <span className="shrink-0 tabular-nums @max-[480px]:sr-only">
          {v.pages.length} {v.pages.length === 1 ? "page" : "pages"} × {n} {n === 1 ? "size" : "sizes"}
          {sch.length > 1 ? " × light and dark" : sch[0] === "dark" ? " (dark)" : ""} in {(v.timing.total_ms / 1000).toFixed(1)}s
        </span>
        <span className="ml-auto" />
        <AcceptButton art={art} version={version} v={v} />
      </div>
      {v.notice && (
        <div className="flex items-start gap-1.5 text-warning-foreground text-meta @max-[480px]:order-3 @max-[480px]:w-full" data-vd-notice>
          <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{v.notice}</span>
        </div>
      )}
      <VdiffChips v={v} className="@max-[480px]:order-1" />
    </div>
  );
}

// VdiffChips says what needs a look: a page that now scrolls sideways, one
// that fails, a new or gone page; then how many pages are unchanged.
export function VdiffChips({ v, className, max }: { v: VisualDiff; className?: string; max?: number }) {
  const f = flags(v);
  const chip = "inline-flex shrink-0 items-center gap-1 rounded-[0.3125rem] border px-1.5 text-tag leading-[1.125rem]";
  if (allClear(v))
    return (
      <div className={cn("flex min-w-0 flex-wrap gap-1", className)} data-vd-chips>
        <span className={cn(chip, "border-success/30 bg-success/8 text-success-foreground")}>
          <CheckCircle2Icon className="size-3" aria-hidden />
          {v.pages.length} pages × {v.settings.sizes.length} sizes match {baseName(v)}
        </span>
      </div>
    );
  const items: React.ReactNode[] = [
    ...f.sideways.map((o) => (
      <span key={`o${o.path}${o.size}`} data-vd-chip="sideways" className={cn(chip, "border-destructive/30 bg-destructive/8 text-destructive-foreground")}>
        <AlertTriangleIcon className="size-3" aria-hidden />
        {o.path} at {o.size} scrolls sideways
      </span>
    )),
    ...f.fails.map((p) => (
      <span key={`e${p}`} data-vd-chip="fails" className={cn(chip, "border-destructive/30 bg-destructive/8 text-destructive-foreground")}>
        <XCircleIcon className="size-3" aria-hidden />
        {p} fails
      </span>
    )),
    ...f.fresh.map((p) => (
      <span key={`n${p}`} data-vd-chip="new" className={cn(chip, "border-info/30 bg-info/8 text-info-foreground")}>
        <PlusCircleIcon className="size-3" aria-hidden />
        {p} new
      </span>
    )),
    ...f.gone.map((p) => (
      <span key={`g${p}`} data-vd-chip="gone" className={cn(chip, "border-warning/30 bg-warning/8 text-warning-foreground")}>
        <AlertTriangleIcon className="size-3" aria-hidden />
        {p} gone
      </span>
    )),
  ];
  const shown = max ? items.slice(0, max) : items;
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1", className)} data-vd-chips>
      {shown}
      {items.length > shown.length && <span className={cn(chip, "text-muted-foreground")}>+{items.length - shown.length} more</span>}
      {f.same > 0 && (
        <span data-vd-chip="unchanged" className={cn(chip, "text-muted-foreground")}>
          <CheckCircle2Icon className="size-3 text-success-foreground" aria-hidden />
          {f.same} unchanged
        </span>
      )}
    </div>
  );
}

// AcceptButton keeps this version's after-shots as the worktree's accepted
// baseline, after asking once. The box remembers which version it was.
function AcceptButton({ art, version, v }: { art: Art; version: ArtVersion; v: VisualDiff }) {
  const accepted = useAccepted(art);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const isLatest = version.n === latest(art).n;
  const done = accepted?.from === art.id && accepted.from_version === version.n;
  const shots = v.pages.reduce((n, p) => n + p.shots.filter((s) => s.after?.img).length, 0);
  if (v.base.label === "accepted" && allClear(v)) return null;
  if (done)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success-foreground" data-vd-accepted>
        <CheckIcon className="size-3.5" aria-hidden />
        Accepted as baseline
      </span>
    );
  return (
    <span className="relative inline-flex shrink-0 items-center gap-1.5">
      {ask ? (
        <span className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-info/30 bg-info/6 py-0.5 pr-0.5 pl-2 text-foreground" data-vd-accept-ask>
          <span className="max-w-[26rem] text-meta">
            Keep these {shots} after-shots as {art.worktree}'s accepted look? <span className="text-muted-foreground">Main isn't changed.</span>
          </span>
          <Button
            size="xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(undefined);
              try {
                await acceptBaseline(art);
                setAsk(false);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Accept v{version.n}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setAsk(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Tip label={isLatest ? "Later compares with --base accepted measure against these shots" : "Only the latest version can be accepted"}>
          <Button size="xs" variant="outline" disabled={!isLatest} onClick={() => setAsk(true)} data-vd-accept>
            <StampIcon />
            Accept<span className="@max-[480px]:sr-only"> as baseline</span>
          </Button>
        </Tip>
      )}
      {err && <span className="text-destructive-foreground text-meta">{err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- slider first

function useOverlays() {
  const [heat, setHeat] = useState(true);
  const [glow, setGlow] = useState(0.6);
  const [regions, setRegions] = useState(true);
  return { heat, setHeat, glow, setGlow, regions, setRegions };
}

function SliderFirst({ art, v }: { art: Art; v: VisualDiff }) {
  const pages = useMemo(() => sortedPages(v), [v]);
  const items = useMemo(() => changes(v), [v]);
  const sch = schemes(v);
  const start = firstPage(pages);
  const [scheme, setScheme] = useState<Scheme>(() => schemeOf(worstShot(start)));
  const [path, setPath] = useState(start.path);
  const page = pages.find((p) => p.path === path) ?? pages[0];
  const [size, setSize] = useState(() => worstShot(start, scheme).size);
  const shot = page.shots.find((s) => s.size === size && schemeOf(s) === scheme) ?? worstShot(page, scheme);
  const [all, setAll] = useState(false);
  const [step, setStep] = useState<number | undefined>();
  const root = useRef<HTMLDivElement>(null);
  // A new version: start again on its biggest change.
  useEffect(() => {
    const p = firstPage(pages);
    setPath(p.path);
    setScheme(schemeOf(worstShot(p)));
    setSize(worstShot(p).size);
    setStep(undefined);
  }, [pages]);
  const go = useCallback(
    (k: number) => {
      const it = items[Math.max(0, Math.min(items.length - 1, k))];
      if (!it) return;
      setStep(items.indexOf(it));
      setAll(false);
      setPath(it.page.path);
      setSize(it.shot.size);
      setScheme(schemeOf(it.shot));
    },
    [items],
  );
  // n / p (and ] / [) step through the changes, when nothing else is
  // typing and this view is the one on screen.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,textarea,select,[contenteditable],[role=slider],.xterm")) return;
      const el = root.current;
      if (!el || !el.offsetParent) return;
      // The keyboard is in this artifact, or nowhere in particular: on
      // <body>, or home on a region round it (lib/focus-home.ts puts it on
      // <main> when what had it went away, as the chat's Open does).
      const active = document.activeElement;
      const art = el.closest("[data-testid=artifact-pane]");
      if (active && active !== document.body && !art?.contains(active) && !(art && active.contains(art))) return;
      if (e.key === "n" || e.key === "]") {
        e.preventDefault();
        go((step ?? -1) + 1);
      } else if (e.key === "p" || e.key === "[") {
        e.preventDefault();
        go((step ?? 1) - 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, step]);
  const cur = step !== undefined ? items[step] : undefined;
  const focus = cur && cur.page.path === page.path && cur.shot === shot && cur.kind === "region" ? cur.n - 1 : undefined;

  const stepper = (
    <div className="inline-flex shrink-0 items-center gap-1 text-meta" data-vd-stepper role="group" aria-label="Changes">
      <span className="hidden text-muted-foreground @[720px]:inline">Changes</span>
      <Tip label="Previous change · p">
        <Button size="icon-xs" variant="outline" aria-label="Previous change" onClick={() => go((step ?? 1) - 1)} disabled={!items.length || step === 0}>
          <ArrowLeftIcon />
        </Button>
      </Tip>
      <span className="min-w-[2.25rem] text-center tabular-nums @[480px]:min-w-[2.75rem] @[560px]:min-w-[3.5rem]" data-vd-step>
        {step !== undefined ? `${step + 1} of ${items.length}` : `${items.length}`}
      </span>
      <Tip label="Next change · n">
        <Button size="icon-xs" variant="outline" aria-label="Next change" onClick={() => go((step ?? -1) + 1)} disabled={!items.length || step === items.length - 1}>
          <ArrowRightIcon />
        </Button>
      </Tip>
    </div>
  );
  const allBtn = (
    <Tip label={all ? "Back to one page" : "Every page and size at once"}>
      <button type="button" aria-pressed={all} onClick={() => setAll((x) => !x)} data-vd-all className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-meta", all ? "border-ring bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
        <LayoutGridIcon className="size-3.5" aria-hidden />
        <span className="hidden @[480px]:inline">All {v.summary.shots} shots</span>
        <span className="@[480px]:hidden">All</span>
      </button>
    </Tip>
  );
  const schemeSeg =
    sch.length > 1 ? (
      <Seg<Scheme>
        label="Colour scheme"
        value={scheme}
        onChange={(s) => {
          setScheme(s);
          setStep(undefined);
        }}
        items={[
          { v: "light", label: "Light", icon: SunIcon },
          { v: "dark", label: "Dark", icon: MoonIcon },
        ]}
      />
    ) : null;

  return (
    <div ref={root} className="flex min-w-0 flex-col" data-vd-slider-first>
      {all ? (
        <>
          <div className="sticky -top-4 z-40 -mx-4 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 pt-4 pb-2.5 backdrop-blur">
            {allBtn}
            <span className="hidden text-muted-foreground text-meta @[560px]:inline">most changed first · click a shot to compare it</span>
            <span className="ml-auto" />
            {schemeSeg}
            {stepper}
          </div>
          <ShotGrid
            art={art}
            v={v}
            pages={pages}
            scheme={scheme}
            onPick={(p, sz) => {
              setAll(false);
              setPath(p);
              setSize(sz);
              setStep(undefined);
            }}
          />
        </>
      ) : (
        <Detail
          art={art}
          v={v}
          pages={pages}
          page={page}
          shot={shot}
          scheme={scheme}
          setPage={(p) => {
            setPath(p);
            setStep(undefined);
          }}
          setSize={(sz) => {
            setSize(sz);
            setStep(undefined);
          }}
          lead={allBtn}
          extra={stepper}
          schemeSeg={schemeSeg}
          focus={focus}
          caption={cur ? <ChangeCaption it={cur} total={items.length} /> : undefined}
        />
      )}
    </div>
  );
}

function ChangeCaption({ it }: { it: Change; total: number }) {
  const over = overflow(it.shot);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta" data-vd-caption>
      <span className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-semibold text-tag text-white", it.kind === "region" ? "" : it.kind === "error" ? "bg-destructive" : "bg-info")} style={it.kind === "region" ? { background: REGION } : undefined}>
        {it.kind === "region" ? it.n : "!"}
      </span>
      <span className="font-medium font-mono">{it.page.path}</span>
      <span className="text-muted-foreground">
        {sizeName(it.shot.size)} {it.shot.size}
        {schemeOf(it.shot) === "dark" ? " · dark" : ""}
      </span>
      {it.kind === "region" ? (
        <>
          <span className="text-muted-foreground tabular-nums">
            · region {it.n} of {it.shot.regions_total ?? it.shot.regions?.length}, {it.region!.w}×{it.region!.h}
          </span>
          {it.region!.el && <span className="min-w-0 truncate font-mono text-muted-foreground">· {it.region!.el}</span>}
          {over ? <span className="font-medium text-destructive-foreground">· scrolls sideways (+{over}px)</span> : null}
        </>
      ) : (
        <span className={it.kind === "error" ? "font-medium text-destructive-foreground" : "text-info-foreground"}>· {it.shot.why}</span>
      )}
    </div>
  );
}

// Detail is one page large: pages, sizes, how to compare, and the stage.
function Detail({ art, v, pages, page, shot, scheme, setPage, setSize, lead, extra, schemeSeg, focus: focusIn, caption }: { art: Art; v: VisualDiff; pages: VdPage[]; page: VdPage; shot: VdShot; scheme: Scheme; setPage(p: string): void; setSize(s: number): void; lead?: React.ReactNode; extra?: React.ReactNode; schemeSeg?: React.ReactNode; focus?: number; caption?: React.ReactNode }) {
  const [mode, setMode] = useState<StageMode>("slider");
  const [wipe, setWipe] = useState(50);
  const [onion, setOnion] = useState(0.5);
  const ov = useOverlays();
  const [focusOwn, setFocus] = useState<number | undefined>();
  const focus = focusIn ?? focusOwn;
  const o: Overlays = { heat: ov.heat && shot.verdict === "changed", glow: ov.glow, regions: ov.regions, focus };
  const stageRef = useRef<HTMLDivElement>(null);
  const show = (i: number) => {
    setFocus(i);
    stageRef.current?.querySelector(`[data-vd-region="${i + 1}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  useEffect(() => setFocus(undefined), [page.path, shot]);
  // A change chosen with n / p scrolls into view.
  useEffect(() => {
    if (focusIn === undefined) return;
    const t = window.setTimeout(() => stageRef.current?.querySelector(`[data-vd-region="${focusIn + 1}"]`)?.scrollIntoView({ block: "center" }), 120);
    return () => window.clearTimeout(t);
  }, [focusIn, page.path, shot]);
  const shots = page.shots.filter((s) => schemeOf(s) === scheme);
  return (
    <div data-vd-detail data-vd-page={page.path} data-vd-size={shot.size} className="flex min-w-0 flex-col">
      <div className="sticky -top-4 z-40 -mx-4 flex flex-col gap-2 border-b bg-background/95 px-4 pt-4 pb-2.5 backdrop-blur" data-vd-toolbar>
        <div className="flex min-w-0 items-center gap-2">
          {lead}
          <div className="min-w-0 flex-1">
            <PageChips pages={pages} cur={page.path} scheme={scheme} onPick={setPage} />
          </div>
          {extra && <div className="hidden shrink-0 @[760px]:block">{extra}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 @[560px]:gap-x-2.5 @[560px]:gap-y-2">
          <SizeTabs shots={shots} cur={shot.size} onPick={setSize} />
          {schemeSeg}
          <span className="ml-auto hidden @[560px]:block" />
          <Seg<StageMode>
            label="How to compare"
            value={mode}
            onChange={setMode}
            items={[
              { v: "slider", label: "Slider", icon: SplitIcon },
              { v: "side", label: "Side by side", icon: Columns2Icon },
              { v: "flicker", label: "Flicker", icon: RepeatIcon },
              { v: "onion", label: "Onion skin", icon: LayersIcon },
            ]}
          />
          <OverlayControls ov={ov} shot={shot} />
          {mode === "onion" && <Range label="After" value={onion} onChange={setOnion} />}
          {extra && <div className="@[760px]:hidden">{extra}</div>}
        </div>
        {caption}
      </div>
      <div className="h-3" />
      <Banner v={v} page={page} shot={shot} />
      <div className="flex gap-4">
        <div ref={stageRef} className="flex min-w-0 flex-1 justify-center">
          <Stage art={art} v={v} shot={shot} mode={mode} o={o} wipe={wipe} setWipe={setWipe} onion={onion} />
        </div>
        {ov.regions && (shot.regions?.length ?? 0) > 0 && <RegionList shot={shot} focus={focus} onPick={show} />}
      </div>
      <Settings v={v} shot={shot} />
    </div>
  );
}

function PageChips({ pages, cur, scheme, onPick }: { pages: VdPage[]; cur: string; scheme: Scheme; onPick(p: string): void }) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:thin]" role="tablist" aria-label="Pages, most changed first">
      {pages.map((p) => {
        const top = worstShot(p, scheme);
        return (
          <button key={p.path} type="button" role="tab" aria-selected={p.path === cur} data-vd-page-chip={p.path} onClick={() => onPick(p.path)} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-meta", p.path === cur ? "border-ring bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
            <span className="font-medium font-mono text-foreground/90">{p.path}</span>
            <VerdictTag shot={top} all={p.shots.filter((s) => schemeOf(s) === scheme)} />
          </button>
        );
      })}
    </div>
  );
}

// VerdictTag sums a page (or one shot) up in a few characters.
function VerdictTag({ shot, all }: { shot: VdShot; all?: VdShot[] }) {
  const shots = all ?? [shot];
  if (shot.verdict === "error") return <span className="font-medium text-destructive-foreground">{shot.after?.status && shot.after.status >= 400 ? shot.after.status : "Error"}</span>;
  if (shot.verdict === "new") return <span className="font-medium text-info-foreground">New</span>;
  if (shot.verdict === "removed") return <span className="font-medium text-warning-foreground">Gone</span>;
  if (shots.every((s) => s.verdict === "unchanged"))
    return (
      <span className="inline-flex items-center gap-0.5 text-success-foreground">
        <CheckCircle2Icon className="size-3" aria-hidden />
        Same
      </span>
    );
  const side = shots.some((s) => overflow(s));
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums", side ? "text-destructive-foreground" : "text-warning-foreground")}>
      {side && <AlertTriangleIcon className="size-3" aria-label="scrolls sideways" />}
      {pct(shot.changed_pct)}
    </span>
  );
}

function SizeTabs({ shots, cur, onPick }: { shots: VdShot[]; cur: number; onPick(n: number): void }) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5" role="tablist" aria-label="Sizes">
      {shots.map((s) => (
        <button key={s.size} type="button" role="tab" aria-selected={s.size === cur} data-vd-size-tab={s.size} onClick={() => onPick(s.size)} className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-meta", s.size === cur ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
          <span className="font-medium">
            <span className="hidden @[620px]:inline">{sizeName(s.size)} </span>
            <span className="tabular-nums">{s.size}</span>
          </span>
          <VerdictTag shot={s} />
        </button>
      ))}
    </div>
  );
}

function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange(v: T): void; items: { v: T; label: string; icon: React.ComponentType<{ className?: string }> }[]; label: string }) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <Tip key={it.v} label={it.label}>
          <button type="button" role="radio" aria-checked={value === it.v} aria-label={it.label} data-vd-mode={it.v} onClick={() => onChange(it.v)} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-meta @[480px]:px-2", value === it.v ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
            <it.icon className="size-3.5" />
            <span className="hidden @[900px]:inline">{it.label}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}

function OverlayControls({ ov, shot }: { ov: ReturnType<typeof useOverlays>; shot: VdShot }) {
  const n = shot.regions_total ?? shot.regions?.length ?? 0;
  return (
    <div className="inline-flex items-center gap-1">
      <Tip label="Changed pixels, glowing by how much they changed">
        <button type="button" aria-pressed={ov.heat} aria-label="Heatmap" data-vd-heat-toggle onClick={() => ov.setHeat((h) => !h)} disabled={!shot.heat} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-meta disabled:opacity-50 @[480px]:px-2", ov.heat && shot.heat ? "border-[#f97316]/50 bg-[#f97316]/10 text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
          <FlameIcon className={cn("size-3.5", ov.heat && shot.heat && "text-[#f97316]")} aria-hidden />
          <span className="hidden @[560px]:inline">Heatmap</span>
        </button>
      </Tip>
      {ov.heat && shot.heat && (
        <span className="hidden @[620px]:inline-flex">
          <Range label="Glow" value={ov.glow} onChange={ov.setGlow} />
        </span>
      )}
      <Tip label="Numbered boxes around each change">
        <button type="button" aria-pressed={ov.regions} aria-label={n ? `Regions, ${n}` : "Regions"} data-vd-regions-toggle onClick={() => ov.setRegions((r) => !r)} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-meta @[480px]:px-2", ov.regions ? "border-[#2563eb]/40 bg-[#2563eb]/8 text-foreground" : "text-muted-foreground hover:bg-accent/60")}>
          <SquareDashedIcon className={cn("size-3.5", ov.regions && "text-[#3b82f6]")} aria-hidden />
          <span className="hidden @[560px]:inline">Regions</span>
          {n ? <span className="text-muted-foreground tabular-nums">{n}</span> : null}
        </button>
      </Tip>
    </div>
  );
}

function Range({ label, value, onChange }: { label: string; value: number; onChange(n: number): void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-muted-foreground text-meta">
      <span className="hidden @[720px]:inline">{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} className="vd-range h-1 w-20 cursor-pointer" aria-label={label} />
    </label>
  );
}

function Banner({ v, page, shot }: { v: VisualDiff; page: VdPage; shot: VdShot }) {
  const over = overflow(shot);
  const base = baseName(v);
  const line = (tone: "bad" | "warn" | "info" | "good", icon: React.ReactNode, text: React.ReactNode) => (
    <div data-vd-banner={tone} className={cn("mb-3 flex shrink-0 items-start gap-2 rounded-lg border px-3 py-1.5 text-desc @[560px]:py-2", tone === "bad" ? "border-destructive/30 bg-destructive/6" : tone === "warn" ? "border-warning/30 bg-warning/8" : tone === "good" ? "border-success/30 bg-success/6" : "border-info/30 bg-info/6")}>
      {icon}
      <div className="min-w-0">{text}</div>
    </div>
  );
  if (shot.verdict === "error")
    return line(
      "bad",
      <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" aria-hidden />,
      <>
        <span className="font-medium">
          {page.path} fails on {shot.why?.startsWith("before") ? base : v.head.label}
        </span>{" "}
        <span className="text-muted-foreground">· {shot.why}</span>
        {shot.after?.errors?.[0] && <div className="mt-0.5 truncate font-mono text-muted-foreground text-mono">{shot.after.errors[0]}</div>}
      </>,
    );
  if (shot.verdict === "new")
    return line(
      "info",
      <PlusCircleIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" aria-hidden />,
      <>
        <span className="font-medium">A new page.</span>{" "}
        <span className="text-muted-foreground">
          {page.path} {shot.why === "not in the baseline" ? `isn't in ${base}` : `is a 404 on ${base}`}; this is how it looks on {v.head.label}.
        </span>
      </>,
    );
  if (shot.verdict === "removed")
    return line(
      "warn",
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />,
      <>
        <span className="font-medium">This page is gone.</span> <span className="text-muted-foreground">{page.path} is a 404 on {v.head.label}.</span>
      </>,
    );
  if (shot.verdict === "unchanged")
    return line(
      "good",
      <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden />,
      <>
        <span className="font-medium">No visual change</span>{" "}
        <span className="text-muted-foreground">
          at {sizeName(shot.size)} {shot.size}
          {shot.masks?.length ? ` · ${shot.masks.length} dynamic ${shot.masks.length === 1 ? "area" : "areas"} masked` : ""}.
        </span>
      </>,
    );
  if (over)
    return line(
      "bad",
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" aria-hidden />,
      <>
        <span className="font-medium">Now scrolls sideways at {shot.size}</span>
        <span className="text-muted-foreground">
          : {over}px wider than the screen<span className="hidden @[560px]:inline">, and it wasn't on {base}. Usually a row that doesn't wrap or a fixed width</span>.
        </span>
      </>,
    );
  return null;
}

function RegionList({ shot, focus, onPick }: { shot: VdShot; focus?: number; onPick(i: number): void }) {
  const total = shot.regions_total ?? shot.regions!.length;
  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-1 @[1000px]:flex" aria-label="Regions" data-vd-region-list>
      <div className="sticky top-[8.5rem] flex flex-col gap-0.5">
        <div className="px-1 pb-1 text-muted-foreground text-label">
          {total} {total === 1 ? "region" : "regions"} · {shot.changed_px.toLocaleString("en-US")} px
        </div>
        {shot.regions!.map((r, i) => (
          <button key={`${r.x}-${r.y}-${i}`} type="button" onClick={() => onPick(i)} className={cn("flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-meta hover:bg-accent/60", focus === i && "bg-accent")}>
            <span className="flex w-full items-center gap-2">
              <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-semibold text-tag text-white" style={{ background: REGION }}>
                {i + 1}
              </span>
              <span className="tabular-nums">
                {r.w}×{r.h}
              </span>
              <span className="ml-auto text-muted-foreground tabular-nums">{r.px >= 1000 ? `${(r.px / 1000).toFixed(1)}k px` : `${r.px} px`}</span>
            </span>
            {r.el && <span className="truncate ps-[26px] font-mono text-tag text-muted-foreground">{r.el}</span>}
          </button>
        ))}
        {total > shot.regions!.length && <div className="px-1.5 text-muted-foreground text-meta">+{total - shot.regions!.length} smaller</div>}
      </div>
    </aside>
  );
}

function Settings({ v, shot }: { v: VisualDiff; shot: VdShot }) {
  const ms = Math.max(shot.before?.ms ?? 0, shot.after?.ms ?? 0);
  return (
    <div className="mt-3 flex shrink-0 flex-wrap gap-x-2 gap-y-0.5 border-t pt-2 text-muted-foreground text-meta">
      <span>
        {shot.viewport[0]}×{shot.viewport[1]} at {v.settings.scale}x{schemeOf(shot) === "dark" ? ", dark" : ""}
      </span>
      <span aria-hidden>·</span>
      <span>reduced motion, animations settled, caret hidden, UTC</span>
      {v.settings.mask?.length ? (
        <>
          <span aria-hidden>·</span>
          <span>
            masked <span className="font-mono">{v.settings.mask.join(", ")}</span>
          </span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span>threshold {v.settings.threshold}</span>
      {ms ? (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            shot in {(ms / 1000).toFixed(1)}s, diffed in {shot.diff_ms} ms
          </span>
        </>
      ) : null}
      {v.settings.chromium && <span className="ml-auto hidden font-mono @[720px]:inline">{v.settings.chromium}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- all shots

function ShotGrid({ art, v, pages, scheme, onPick }: { art: Art; v: VisualDiff; pages: VdPage[]; scheme: Scheme; onPick(path: string, size: number): void }) {
  const sizes = v.settings.sizes;
  return (
    <div data-vd-grid className="grid gap-x-3 gap-y-4 pt-3" style={{ gridTemplateColumns: `minmax(5.5rem,8rem) repeat(${sizes.length}, minmax(0,1fr))` }}>
      <span />
      {sizes.map((s) => (
        <span key={s} className="text-muted-foreground text-label">
          <span className="hidden @[620px]:inline">{sizeName(s)} </span>
          <span className="tabular-nums">{s}</span>
        </span>
      ))}
      {pages.map((p) => {
        const same = p.shots.every((s) => s.verdict === "unchanged");
        return (
          <div key={p.path} className="contents">
            <div className="flex min-w-0 flex-col gap-0.5 pt-1">
              <span className="truncate font-medium font-mono text-mono">{p.path}</span>
              <span className="truncate text-muted-foreground text-meta">{p.title}</span>
            </div>
            {sizes.map((size) => {
              const s = p.shots.find((x) => x.size === size && schemeOf(x) === scheme);
              return s ? <Cell key={size} art={art} path={p.path} s={s} dim={same} onPick={() => onPick(p.path, size)} /> : <span key={size} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

function useWidth(min = 80, initial = 220) {
  const ref = useRef<HTMLButtonElement & HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(min, el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w] as const;
}

function Cell({ art, path, s, dim, onPick }: { art: Art; path: string; s: VdShot; dim: boolean; onPick(): void }) {
  const [ref, w] = useWidth();
  const h = Math.round(w * 0.62);
  const r = s.regions?.[0];
  // Every cell at the same scale: the page's full width, from the top, or
  // from just above its biggest change when that is further down.
  const fh = s.size / (w / h);
  const pageH = Math.max(s.after?.h ?? 0, s.before?.h ?? 0, s.viewport[1]);
  const view = { x: 0, y: r && r.y > fh * 0.8 ? Math.min(Math.max(0, pageH - fh), r.y - fh * 0.2) : 0, w: s.size, h: fh };
  const over = overflow(s);
  return (
    <button ref={ref} type="button" onClick={onPick} data-vd-cell={`${path}@${s.size}`} aria-label={`${path} at ${s.size}: ${s.verdict === "changed" ? pct(s.changed_pct) : s.verdict}`} className={cn("group relative min-w-0 overflow-hidden rounded-lg border bg-card text-left outline-none transition-colors hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring", (over || s.verdict === "error") && "border-destructive/50")}>
      <div className={cn(dim && "opacity-60 grayscale-[0.6]")}>
        <Crop art={art} shot={s} r={view} side={s.verdict === "removed" ? "before" : "after"} w={w} h={h} heat={s.verdict === "changed" ? 0.6 : 0} outline={r} />
      </div>
      {s.verdict === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/85 p-2 text-center">
          <XCircleIcon className="size-5 text-destructive-foreground" aria-hidden />
          <span className="text-label">{s.why}</span>
        </div>
      )}
      <div className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1 rounded-md bg-background/92 px-1.5 py-0.5 text-tag shadow-xs backdrop-blur">
          <VerdictTag shot={s} />
          {s.verdict === "changed" && (
            <span className="text-muted-foreground tabular-nums">
              · {s.regions_total ?? s.regions?.length} {(s.regions_total ?? 0) === 1 ? "region" : "regions"}
            </span>
          )}
        </span>
        {over ? <span className="rounded-md bg-[#be123c] px-1.5 py-0.5 font-medium text-tag text-white shadow-xs">↔ +{over}px</span> : null}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------- all clear

function AllClear({ art, v }: { art: Art; v: VisualDiff }) {
  const sch = schemes(v);
  return (
    <div className="flex flex-col items-center gap-5 py-6" data-vd-all-clear>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="vd-clear flex size-12 items-center justify-center rounded-full bg-success/12 text-success-foreground">
          <CheckCircle2Icon className="size-6" aria-hidden />
        </span>
        <h3 className="text-heading">No visual changes</h3>
        <p className="max-w-md text-balance text-muted-foreground text-body">
          All {v.summary.shots} shots of {v.pages.length} {v.pages.length === 1 ? "page" : "pages"} match {baseName(v)} pixel for pixel{v.settings.mask?.length ? ", with dynamic content masked" : ""}.
        </p>
      </div>
      <div className="grid w-full max-w-[60rem] grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2.5">
        {v.pages.map((p) => (
          <ClearTile key={p.path} art={art} p={p} />
        ))}
      </div>
      <div className="flex flex-wrap justify-center gap-x-2 text-muted-foreground text-meta">
        <span>sizes {v.settings.sizes.join(", ")}</span>
        {sch.length > 1 && (
          <>
            <span aria-hidden>·</span>
            <span>light and dark</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>threshold {v.settings.threshold}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {(v.timing.total_ms / 1000).toFixed(1)}s for {v.summary.shots} shots
        </span>
        {v.base.taken && (
          <>
            <span aria-hidden>·</span>
            <span>baseline from {new Date(v.base.taken).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </>
        )}
      </div>
    </div>
  );
}

function ClearTile({ art, p }: { art: Art; p: VdPage }) {
  const [ref, w] = useWidth(60, 160);
  const s = [...p.shots].sort((x, y) => y.size - x.size)[0];
  const h = 104;
  return (
    <div ref={ref} className="overflow-hidden rounded-lg border bg-card">
      <Crop art={art} shot={s} r={{ x: 0, y: 0, w: s.size, h: s.size * (h / w) }} side="after" w={w} h={h} />
      <div className="flex items-center gap-1 px-2 py-1.5 text-meta">
        <span className="truncate font-medium font-mono">{p.path}</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-success-foreground tabular-nums">
          <CheckCircle2Icon className="size-3" aria-hidden />
          {p.shots.length}/{p.shots.length}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- thumbnails

// VdiffThumb is a visual diff small: its biggest change, before against
// after split down the middle, the heat glowing on the after half; or, all
// clear, a row of unchanged pages.
function VdiffThumb({ art, v, height }: { art: Art; v: VisualDiff; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(240);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(60, el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.max(60, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (allClear(v)) {
    const ps = v.pages.slice(0, Math.max(1, Math.min(4, Math.floor(w / 70))));
    const cw = (w - (ps.length - 1) * 4) / ps.length;
    return (
      <div ref={ref} className="relative flex gap-1" style={{ height }} data-vd-thumb="clear">
        {ps.map((p) => {
          const s = [...p.shots].sort((x, y) => y.size - x.size)[0];
          return <Crop key={p.path} art={art} shot={s} r={{ x: 0, y: 0, w: s.size, h: s.size * (height / cw) }} side="after" w={cw} h={height} className="rounded-sm" />;
        })}
        <span className="absolute right-1 bottom-1 inline-flex items-center gap-0.5 rounded-full bg-[#15803d] px-1.5 py-0.5 font-medium text-tag text-white shadow">
          <CheckCircle2Icon className="size-3" aria-hidden /> All clear
        </span>
      </div>
    );
  }
  const it = thumbShot(v);
  if (!it) {
    // Only errors and new pages: the first page that has an image.
    const p = v.pages.find((x) => x.shots.some((s) => s.after?.img));
    const s = p?.shots.find((x) => x.after?.img);
    return (
      <div ref={ref} className="relative overflow-hidden rounded-sm" style={{ height }} data-vd-thumb="other">
        {s && <Crop art={art} shot={s} r={{ x: 0, y: 0, w: s.size, h: s.size / (w / height) }} side="after" w={w} h={height} />}
      </div>
    );
  }
  const aspect = w / height;
  const shot = it.shot;
  const fh = shot.size / aspect;
  // The first screen, or the first change when it sits further down.
  const reg = [...(shot.regions ?? [])].sort((a, b) => a.y - b.y)[0];
  const r = reg && reg.y > fh * 0.7 ? frame({ x: 0, y: reg.y, w: shot.size, h: reg.h }, shot.size, Math.max(shot.after?.h ?? 0, shot.before?.h ?? 0), aspect) : { x: 0, y: 0, w: shot.size, h: fh };
  return (
    <div ref={ref} className="relative overflow-hidden rounded-sm" style={{ height }} data-vd-thumb="wipe">
      <Crop art={art} shot={shot} r={r} side="after" w={w} h={height} heat={0.8} />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: w / 2 }}>
        <Crop art={art} shot={shot} r={r} side="before" w={w} h={height} />
      </div>
      <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.2)]" style={{ left: w / 2 - 1 }} />
      <span className="absolute bottom-1 left-1 rounded bg-[#18181b]/75 px-1 font-medium text-tag text-white">before</span>
      <span className="absolute right-1 bottom-1 rounded bg-[#1d4ed8]/90 px-1 font-medium text-tag text-white">
        after · {it.page.path} {shot.size}
      </span>
    </div>
  );
}

