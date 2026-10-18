import { useEffect, useRef, useState } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { DitherBand } from "@/components/art/dither-band";
import { HARBOUR, HARBOUR_MUTE, useHarbourLight } from "@/components/art/harbour-art";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";

import { type AgentRow, useAgentRows } from "./agents";
import { useHomeWidget } from "./env";

import "./harbour.css";

// The living harbour: the harbour painting with a boat for each agent at
// work, out on the water; agents that need you wait by the lighthouse, whose
// lamp is lit and sweeping while they do; finished ones are tied up along
// the shore. A boat opens its agent. All motion is CSS, a pixel or two, and
// stops under reduced motion.

// Where the painting's lighthouse lamp and horizon sit, as fractions of the
// picture (all four lights share one composition).
const PIC = { w: 1672, h: 941, lampX: 0.092, lampY: 0.455, horizon: 0.575, shore: 0.19 };

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

interface Props {
  className?: string;
  // Where the picture sits when cropped (DitherBand's position).
  position?: number;
  fade?: number;
  // How far down the band the boats may sail, as a fraction of the water.
  depth?: number;
  labels?: "always" | "hover" | "none";
  // Rounded corners and no dissolve, for a widget.
  framed?: boolean;
  // A sentence over the sky ("3 out, 2 waiting at the lighthouse").
  caption?: boolean;
  style?: React.CSSProperties;
}

export function LivingHarbour({ className, position = 0.42, fade = 0.45, depth = 0.55, labels = "hover", framed, caption, style }: Props) {
  const light = useHarbourLight();
  const rows = useAgentRows();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const scale = Math.max(w / PIC.w, h / PIC.h);
  const dw = PIC.w * scale;
  const dh = PIC.h * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) * position;
  const lamp = { x: ox + PIC.lampX * dw, y: oy + PIC.lampY * dh };
  const horizon = oy + PIC.horizon * dh;
  const water = Math.max(20, h * (1 - fade * 0.6) - horizon);

  const working = rows.filter((r) => r.state === "running");
  const waiting = rows.filter((r) => r.state === "waiting");
  const done = rows.filter((r) => r.state === "finished").slice(0, 4);
  const night = light === "night";

  const boats: { r: AgentRow; x: number; y: number; s: number; kind: "out" | "wait" | "moored" }[] = [];
  working.forEach((r, i) => {
    const j = hash(r.key);
    const d = 0.22 + ((i * 0.37 + j * 0.5) % 1) * depth;
    const big = Math.min(1.4, Math.max(0.8, w / 1000));
    // Out past the lighthouse's queue (and its labels), spread to the right.
    const left = Math.max(w * 0.34, lamp.x + (labels === "always" && waiting.length ? 250 : 120));
    const span = Math.max(80, w * 0.84 - left);
    boats.push({ r, x: left + (i / Math.max(1, working.length)) * span + (j - 0.5) * 0.04 * w, y: horizon + d * water, s: (22 + d * 22) * big, kind: "out" });
  });
  // Waiting boats line up off the lighthouse, one under the other.
  const gap = Math.max(20, Math.min(30, (water * 0.6) / Math.max(1, waiting.length)));
  waiting.forEach((r, i) => boats.push({ r, x: Math.max(24, lamp.x + 26 + i * 22), y: horizon + 0.12 * water + i * gap, s: Math.min(28, 20 + w / 120), kind: "wait" }));
  done.forEach((r, i) => boats.push({ r, x: ox + (0.035 + i * 0.04) * dw, y: horizon + 0.035 * water + (i % 2) * 3, s: 13, kind: "moored" }));

  return (
    <div ref={ref} className={cn("relative overflow-hidden", framed && "rounded-lg", className)} style={style} data-light={light}>
      <DitherBand src={HARBOUR[light]} position={position} fade={fade} mute={HARBOUR_MUTE[light]} className="absolute inset-0" />
      {w > 0 && (
        <>
          {waiting.length > 0 && lamp.x > -10 && (
            <div aria-hidden className="pointer-events-none absolute" style={{ left: lamp.x, top: lamp.y }}>
              <span className="bh-beam" data-night={night || undefined} />
              <span className="bh-lamp" />
            </div>
          )}
          {boats.map((b) => (
            <Boat key={b.r.key} {...b} night={night} labels={labels} />
          ))}
        </>
      )}
      {caption && (
        <p className="pointer-events-none absolute top-3 left-4 rounded-md bg-background/70 px-2 py-1 text-meta backdrop-blur-sm">
          {!working.length && !waiting.length ? "All calm · no boats out" : `${working.length} out working${waiting.length ? ` · ${waiting.length} waiting at the lighthouse` : ""}`}
        </p>
      )}
    </div>
  );
}

function Boat({ r, x, y, s, kind, night, labels }: { r: AgentRow; x: number; y: number; s: number; kind: "out" | "wait" | "moored"; night: boolean; labels: Props["labels"] }) {
  const hull = night ? "#0c1226" : "#22304d";
  const sail = night ? "#dfe5f5" : "#fffdf6";
  const delay = `${-hash(r.key) * 4}s`;
  const label = labels === "always" ? kind !== "moored" : false;
  return (
    <button
      type="button"
      onClick={() => void focusSession(r.box, r.session.name)}
      aria-label={`${r.title}: ${kind === "wait" ? "needs you" : kind === "out" ? "working" : "finished"}`}
      className="group/boat absolute flex items-end gap-1 outline-none"
      style={{ left: x, top: y, transform: `translate(-${s / 2}px, -88%)` }}
    >
      <span className={cn("bh-bob block", kind === "moored" && "opacity-80")} style={{ animationDelay: delay }}>
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          {kind === "moored" ? (
            <>
              <line x1="12" y1="7" x2="12" y2="17" stroke={hull} strokeWidth="1.2" />
              <path d="M12 9 L12 16 L9 16 Z" fill={sail} opacity="0.85" />
            </>
          ) : (
            <>
              <line x1="12" y1="2.5" x2="12" y2="17" stroke={hull} strokeWidth="1.1" />
              <path d="M11.4 3 L11.4 16 L3.5 16 Z" fill={sail} stroke={hull} strokeWidth="0.5" strokeLinejoin="round" />
              <path d="M12.6 6 L12.6 16 L18.6 16 Z" fill={sail} stroke={hull} strokeWidth="0.5" strokeLinejoin="round" opacity="0.92" />
            </>
          )}
          <path d="M3 17 L21 17 L18 20.5 L6 20.5 Z" fill={hull} />
          {kind === "wait" && <circle cx="12" cy="2.6" r="1.9" className="fill-warning" />}
        </svg>
        {kind === "out" && <span className="bh-wake" style={{ width: s * 1.2 }} />}
      </span>
      {kind !== "moored" && (
        <span
          className={cn(
            "mb-0.5 flex max-w-48 items-center gap-1 whitespace-nowrap rounded-md bg-background/85 px-1.5 py-0.5 text-tag text-foreground shadow-xs backdrop-blur-sm transition-opacity",
            label ? "opacity-100" : "opacity-0 group-hover/boat:opacity-100 group-focus-visible/boat:opacity-100",
          )}
        >
          <StateGlyph state={r.state} className="size-3" />
          <span className="truncate">{r.title}</span>
        </span>
      )}
    </button>
  );
}

// The Harbour widget: the living harbour, framed, with its caption. Its
// motion stops while it is off screen.
export function HarbourWidget() {
  const { span, visible } = useHomeWidget();
  return <LivingHarbour framed className={cn("size-full", !visible && "bh-still")} position={span.r > 1 ? 0.46 : 0.5} fade={0} depth={0.7} labels="hover" caption />;
}
