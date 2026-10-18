import { useEffect, useRef, useState } from "react";

// Thumb draws its children at a fixed width and scales them into the
// space it has: a chart, a table or a diagram as a small picture of
// itself. Not interactive.
export function Thumb({ h, width = 720, children }: { h: number; width?: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Drawn at least at width, wider when there is room: never scaled up.
  const W = Math.max(width, w);
  const k = (w || 240) / W;
  return (
    // inert as well as hidden: a thumbnail's links and buttons are a picture
    // of the artifact, not controls inside the card that opens it.
    <div ref={ref} className="pointer-events-none relative w-full overflow-hidden" style={{ height: h }} aria-hidden inert>
      {w > 0 && (
        <div className="absolute top-0 left-0 origin-top-left" style={{ width: W, height: h / k, transform: `scale(${k})` }}>
          {children}
        </div>
      )}
    </div>
  );
}
