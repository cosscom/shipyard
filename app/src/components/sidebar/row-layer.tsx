import { type ComponentProps, useLayoutEffect, useRef } from "react";

import { RowMenus } from "@/components/sidebar/actions";
import { useTipLayer } from "@/components/tip";

// RowLayer holds a long list of rows, the sidebar's projects and worktrees
// or the rail's agents: one context menu (RowMenus) and one tooltip (a tip
// layer) for all of them, so a row costs its own few elements and nothing
// more until it is pointed at, focused or right-clicked. It renders a div,
// with the props given, marked while it has rows scrolled out of sight
// above (data-more-above) or below (data-more-below), for its fade (ink.ts).
export function RowLayer({ children, onPointerOver, onPointerOut, onFocus, onBlur, onPointerDown, onKeyDown, ...props }: ComponentProps<"div">) {
  const tips = useTipLayer();
  return tips.provider(
    <RowMenus
      {...props}
      onPointerOver={(e) => {
        onPointerOver?.(e);
        tips.props.onPointerOver(e);
      }}
      onPointerOut={(e) => {
        onPointerOut?.(e);
        tips.props.onPointerOut(e);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        tips.props.onFocus(e);
      }}
      onBlur={(e) => {
        onBlur?.(e);
        tips.props.onBlur(e);
      }}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        tips.props.onPointerDown(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        tips.props.onKeyDown(e);
      }}
    >
      {children}
      {/* After the rows, so it is never their :first-child. */}
      <ScrollEdges />
      {tips.tooltip}
    </RowMenus>,
  );
}

// ScrollEdges marks the list it is in while rows are scrolled out of sight
// above or below it, and how far (--more-above, --more-below, for the
// fade's band), set straight on the element: a scroll draws nothing again.
function ScrollEdges() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const mark = () => {
      // How much there is to scroll each way, up to the fade's 2.75rem.
      const most = 2.75 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      const above = Math.min(Math.max(el.scrollTop, 0), most);
      const below = Math.min(Math.max(el.scrollHeight - el.clientHeight - el.scrollTop, 0), most);
      el.toggleAttribute("data-more-above", above > 1);
      el.toggleAttribute("data-more-below", below > 1);
      el.style.setProperty("--more-above", `${above}px`);
      el.style.setProperty("--more-below", `${below}px`);
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    // Rows coming and going, or the window's height, change it too.
    const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(mark);
    sizes?.observe(el);
    for (const c of el.children) sizes?.observe(c);
    const kids = new MutationObserver(() => {
      for (const c of el.children) sizes?.observe(c);
      mark();
    });
    kids.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", mark);
      sizes?.disconnect();
      kids.disconnect();
    };
  }, []);
  return <span ref={ref} hidden />;
}
