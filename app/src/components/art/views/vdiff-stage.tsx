import { ArrowDownIcon, ChevronsLeftRightIcon, MoveHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import type { Art } from "@/lib/art/model";
import { overflow, type VdRegion, type VdShot, type VisualDiff } from "@/lib/art/vdiff";
import { useVdImage } from "@/lib/art/vdiff-img";
import { cn } from "@/lib/utils";

// The stage: one page at one size, before and after, drawn at the size it
// was shot (or smaller, to fit), with what changed on top. Every overlay is
// placed in the shot's own pixels as percentages, so it scales with it.
// The marks sit on screenshots, which are the app's own colours, not
// Shipyard's: they keep one blue, one red and one amber in either theme.

export type StageMode = "slider" | "side" | "flicker" | "onion";

export interface Overlays {
  heat: boolean;
  glow: number; // 0-1
  regions: boolean;
  focus?: number; // a region's index, drawn louder
}

export const REGION = "#2563eb";
const PAPER = "#f4f4f5";

type A = Pick<Art, "box" | "id" | "location" | "worktree">;

export function Stage({ art, v, shot, mode, o, wipe, setWipe, onion = 0.5, className }: { art: A; v: VisualDiff; shot: VdShot; mode: StageMode; o: Overlays; wipe: number; setWipe(n: number): void; onion?: number; className?: string }) {
  const W = shot.size;
  const before = shot.before?.img ? shot.before : undefined;
  const after = shot.after?.img ? shot.after : undefined;
  const H = Math.max(before?.h ?? 0, after?.h ?? 0, shot.viewport[1]);
  const flick = useFlicker(mode === "flicker");
  const base = v.base.kind === "baseline" ? `${v.base.label} baseline` : v.base.label;
  const dim = o.heat && shot.heat ? o.glow : 0;

  if (mode === "side")
    return (
      <div className={cn("grid w-full grid-cols-2 gap-3", className)} style={{ maxWidth: W * 2 + 12 }} data-vd-stage="side">
        {[
          { side: "Before", label: base, img: before, isAfter: false },
          { side: "After", label: v.head.label, img: after, isAfter: true },
        ].map((c) => (
          <div key={c.side} className="min-w-0">
            <SideLabel side={c.side} label={c.label} />
            <Canvas W={W} H={H}>
              {c.img ? <Layer art={art} name={c.img.img} h={c.img.h!} H={H} /> : <Missing what={c.isAfter ? `Not on ${v.head.label}` : `Not on ${base}`} />}
              {c.isAfter ? <Marks art={art} shot={shot} o={o} W={W} H={H} /> : o.regions && <MaskMarks shot={shot} W={W} H={H} />}
            </Canvas>
          </div>
        ))}
      </div>
    );

  return (
    <div className={cn("w-full", className)} style={{ maxWidth: W }} data-vd-stage={mode}>
      <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2 whitespace-nowrap text-meta">
        {mode === "slider" && (
          <>
            <Pill tone="before">← Before · {base}</Pill>
            {W >= 640 && <span className="hidden truncate text-muted-foreground @[640px]:inline">drag, or ←/→ on the handle</span>}
            <Pill tone="after">After · {v.head.label} →</Pill>
          </>
        )}
        {mode === "flicker" && (
          <Pill tone={flick ? "after" : "before"} live>
            {flick ? `After · ${v.head.label}` : `Before · ${base}`}
          </Pill>
        )}
        {mode === "onion" && <Pill tone="after">After at {Math.round(onion * 100)}% over before</Pill>}
      </div>
      <Canvas W={W} H={H} wipe={mode === "slider" ? setWipe : undefined}>
        {mode === "slider" && (
          <>
            {after ? <Layer art={art} name={after.img} h={after.h!} H={H} dim={dim} /> : <Missing what={`Not on ${v.head.label}`} />}
            <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }} data-vd-before>
              <div className="absolute inset-0" style={{ background: PAPER }} />
              {before ? <Layer art={art} name={before.img} h={before.h!} H={H} dim={dim} /> : <Missing what={`Not on ${base}`} />}
            </div>
          </>
        )}
        {mode === "flicker" && (flick ? after && <Layer art={art} name={after.img} h={after.h!} H={H} dim={dim} /> : before && <Layer art={art} name={before.img} h={before.h!} H={H} dim={dim} />)}
        {mode === "onion" && (
          <>
            {before && <Layer art={art} name={before.img} h={before.h!} H={H} dim={dim} />}
            {after && (
              <div className="absolute inset-0" style={{ opacity: onion }}>
                <Layer art={art} name={after.img} h={after.h!} H={H} dim={dim} />
              </div>
            )}
          </>
        )}
        <Marks art={art} shot={shot} o={o} W={W} H={H} />
        {mode === "slider" && <Handle wipe={wipe} setWipe={setWipe} />}
      </Canvas>
    </div>
  );
}

function useFlicker(on: boolean): boolean {
  const [b, setB] = useState(false);
  useEffect(() => {
    if (!on) return;
    // With reduced motion it doesn't flash: it changes once a second and a
    // half, slowly enough to read.
    const slow = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = window.setInterval(() => setB((x) => !x), slow ? 1500 : 650);
    return () => window.clearInterval(t);
  }, [on]);
  return b;
}

// Canvas is the shot's coordinate space: W by H pixels, scaled to fit.
function Canvas({ W, H, wipe, children }: { W: number; H: number; wipe?: (n: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    wipe?.(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={ref}
      data-vd-canvas
      className={cn("relative w-full overflow-hidden rounded-md shadow-[0_0_0_1px_var(--border)]", wipe && "cursor-ew-resize touch-none select-none")}
      style={{ aspectRatio: `${W} / ${H}`, background: PAPER }}
      onPointerDown={
        wipe &&
        ((e) => {
          drag.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          at(e);
        })
      }
      onPointerMove={wipe && ((e) => drag.current && at(e))}
      onPointerUp={wipe && (() => (drag.current = false))}
    >
      {children}
    </div>
  );
}

function Layer({ art, name, h, H, dim = 0 }: { art: A; name?: string; h: number; H: number; dim?: number }) {
  const src = useVdImage(art, name);
  if (!src) return <div className="absolute top-0 left-0 w-full animate-pulse bg-black/5" style={{ height: `${(h / H) * 100}%` }} />;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      data-vd-img={name}
      className="absolute top-0 left-0 w-full select-none"
      style={{ height: `${(h / H) * 100}%`, filter: dim ? `grayscale(${0.6 + dim * 0.4}) contrast(${1 - dim * 0.35}) brightness(${1 + dim * 0.12})` : undefined, opacity: dim ? 1 - dim * 0.35 : 1 }}
    />
  );
}

export function Missing({ what }: { what: string }) {
  return <div className="absolute inset-0 flex items-start justify-center bg-[repeating-linear-gradient(135deg,#e4e4e7_0_10px,#f4f4f5_10px_20px)] pt-[12%] text-[#52525b] text-row">{what}</div>;
}

function Handle({ wipe, setWipe }: { wipe: number; setWipe(n: number): void }) {
  return (
    <div className="pointer-events-none absolute inset-y-0 z-20" style={{ left: `${wipe}%` }}>
      <div className="absolute inset-y-0 -left-px w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_0_12px_rgba(0,0,0,0.25)]" />
      <div className="sticky top-[40%] -ml-[17px] flex h-[34px] w-[34px] items-center justify-center rounded-full border border-black/15 bg-white text-[#18181b] shadow-lg">
        <button
          type="button"
          aria-label="Before and after: drag, or use the arrow keys"
          role="slider"
          aria-valuenow={Math.round(wipe)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-vd-handle
          className="pointer-events-auto flex size-full items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWipe(Math.max(0, wipe - 5));
            if (e.key === "ArrowRight") setWipe(Math.min(100, wipe + 5));
            if (e.key === "Home") setWipe(0);
            if (e.key === "End") setWipe(100);
          }}
        >
          <ChevronsLeftRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

const box = (r: { x: number; y: number; w: number; h: number }, W: number, H: number): React.CSSProperties => ({ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%` });

// Marks: the heatmap (a soft glow under the exact pixels), the regions,
// masked content, what only moved, and a page wider than the screen.
function Marks({ art, shot, o, W, H }: { art: A; shot: VdShot; o: Overlays; W: number; H: number }) {
  const heat = useVdImage(art, o.heat ? shot.heat : undefined);
  const heatH = shot.after?.h ?? H;
  const over = overflow(shot);
  return (
    <>
      {o.heat && heat && (
        <div data-vd-heat className="pointer-events-none absolute inset-0">
          <img src={heat} alt="" className="absolute top-0 left-0 w-full" style={{ height: `${(heatH / H) * 100}%`, filter: "blur(6px) saturate(1.8) brightness(1.15)", opacity: Math.min(1, o.glow * 1.1) }} />
          <img src={heat} alt="" className="absolute top-0 left-0 w-full" style={{ height: `${(heatH / H) * 100}%`, opacity: 0.25 + o.glow * 0.75 }} />
        </div>
      )}
      {o.regions && <MaskMarks shot={shot} W={W} H={H} />}
      {o.regions && shot.shift && (
        <div className="pointer-events-none absolute right-0 z-10 flex items-start justify-end" style={{ top: `${(shot.shift.y / H) * 100}%`, height: `${(shot.shift.h / H) * 100}%`, width: "30%" }}>
          <div className="h-full w-1 rounded-l bg-[#0ea5e9]/70" />
          <span className="absolute top-1 right-2 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#0369a1] px-2 py-0.5 font-medium text-tag text-white shadow">
            <ArrowDownIcon className="size-3" />
            only moved {shot.shift.dy > 0 ? "+" : ""}
            {shot.shift.dy}px
          </span>
        </div>
      )}
      {o.regions && (shot.regions ?? []).map((r, i) => <RegionBox key={`${r.x}-${r.y}-${i}`} r={r} n={i + 1} W={W} H={H} loud={o.focus === i} />)}
      {over ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1.5 bg-[repeating-linear-gradient(180deg,#e11d48_0_8px,transparent_8px_14px)]" data-vd-overflow>
          <span className="sticky top-[30%] -ml-[188px] inline-flex w-[180px] items-center gap-1 rounded-md bg-[#be123c] px-2 py-1 font-medium text-tag text-white shadow-lg">
            <MoveHorizontalIcon className="size-3.5 shrink-0" />
            Scrolls sideways: {over}px wider than the screen
          </span>
        </div>
      ) : null}
    </>
  );
}

function MaskMarks({ shot, W, H }: { shot: VdShot; W: number; H: number }) {
  return (
    <>
      {(shot.masks ?? []).map(([x, y, w, h], i) => (
        <Tip key={`m${i}`} label="Masked: dynamic content, left out of the diff">
          <div role="img" aria-label="Masked: dynamic content, left out of the diff" data-vd-mask className="pointer-events-auto absolute rounded-[2px] border border-[#71717a]/60 border-dashed bg-[repeating-linear-gradient(135deg,rgba(113,113,122,0.35)_0_4px,transparent_4px_8px)]" style={box({ x, y, w, h }, W, H)} />
        </Tip>
      ))}
    </>
  );
}

function RegionBox({ r, n, W, H, loud }: { r: VdRegion; n: number; W: number; H: number; loud?: boolean }) {
  return (
    <div data-vd-region={n} data-loud={loud || undefined} className={cn("pointer-events-none absolute z-10 rounded-[3px]", loud && "vd-loud")} style={{ ...box({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }, W, H), boxShadow: `0 0 0 ${loud ? 3 : 2}px ${REGION}, 0 0 0 ${loud ? 5 : 3}px rgba(255,255,255,0.7)` }}>
      <span className="absolute -top-[9px] -left-[9px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-semibold text-tag text-white tabular-nums shadow" style={{ background: REGION }}>
        {n}
      </span>
    </div>
  );
}

function Pill({ tone, live, children }: { tone: "before" | "after"; live?: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-label" aria-live={live ? "polite" : undefined}>
      <span className={cn("size-2 rounded-full", tone === "before" ? "bg-muted-foreground" : "bg-[#2563eb]")} />
      {children}
    </span>
  );
}

function SideLabel({ side, label }: { side: string; label: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-meta">
      <span className={cn("size-2 rounded-full", side === "Before" ? "bg-muted-foreground" : "bg-[#2563eb]")} />
      <span className="font-medium">{side}</span>
      <span className="truncate text-muted-foreground">{label}</span>
    </div>
  );
}

// Crop is part of a shot, scaled to fill w by h: a page's top for a grid
// cell or a thumbnail, with the heat over it when asked.
export function Crop({ art, shot, r, side, w, h, heat = 0, outline, className }: { art: A; shot: VdShot; r: { x: number; y: number; w: number; h: number }; side: "before" | "after"; w: number; h: number; heat?: number; outline?: VdRegion; className?: string }) {
  const im = side === "before" ? shot.before : shot.after;
  const src = useVdImage(art, im?.img);
  const heatSrc = useVdImage(art, heat > 0 && side === "after" ? shot.heat : undefined);
  const W = shot.size;
  const k = Math.min(w / r.w, h / r.h, 3);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const left = w / 2 - cx * k;
  const top = h / 2 - cy * k;
  return (
    <div className={cn("relative overflow-hidden", className)} style={{ width: w, height: h, background: PAPER }}>
      {im?.img ? (
        src ? (
          <img src={src} alt="" draggable={false} className="absolute max-w-none select-none" style={{ left, top, width: W * k, filter: heat ? `grayscale(${heat * 0.7}) contrast(${1 - heat * 0.2})` : undefined, opacity: heat ? 1 - heat * 0.15 : 1 }} />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-black/5" />
        )
      ) : (
        <Missing what={side === "before" ? "Not there before" : "Gone"} />
      )}
      {heatSrc && (
        <>
          <img src={heatSrc} alt="" className="absolute max-w-none" style={{ left, top, width: W * k, filter: "blur(5px) saturate(1.8)", opacity: heat }} />
          <img src={heatSrc} alt="" className="absolute max-w-none" style={{ left, top, width: W * k, opacity: 0.4 + heat * 0.6 }} />
        </>
      )}
      {outline && <div className="absolute rounded-[3px]" style={{ left: left + (outline.x - 3) * k, top: top + (outline.y - 3) * k, width: (outline.w + 6) * k, height: (outline.h + 6) * k, boxShadow: `0 0 0 2px ${REGION}` }} />}
    </div>
  );
}

