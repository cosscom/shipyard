import {
  cloneElement,
  createContext,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { focusFromKeyboard, Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { platformKeys } from "@/lib/platform";
import { cn } from "@/lib/utils";

// Tip gives an element a tooltip: the app's own, not the browser's title,
// so it appears on hover and on keyboard focus alike. The element is the
// trigger itself, so it keeps its own props and ref. No label, no tooltip.
//
// A disabled button gets no pointer events, so its tooltip, often the
// reason it is disabled, would never show. While the child is disabled it
// sits in a span that is the trigger instead; `wrapClassName` sizes that
// span (w-full for a full-width button).
//
// `delay` overrides the app's 300ms for rows people sweep the pointer over,
// like the sidebar's, where a tooltip at every row would be noise.
//
// Inside a tip layer (useTipLayer: the sidebar's rows, the rail's agents) a
// Tip is only a mark on its element, and the layer's one tooltip opens over
// whichever is hovered or focused: hundreds of rows, one tooltip.
export function Tip({
  label,
  side,
  align,
  delay,
  className,
  wrapClassName,
  children,
}: {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delay?: number;
  className?: string;
  wrapClassName?: string;
  children: ReactElement;
}) {
  const layer = useContext(TipLayerContext);
  if (label == null || label === false || label === "") return children;
  // "Search (⌘K)" is "Search (Ctrl+K)" on Linux.
  if (typeof label === "string") label = platformKeys(label);
  const disabled = !!(children.props as { disabled?: unknown }).disabled;
  const trigger = disabled ? (
    <span data-slot="tip-disabled" className={cn("inline-flex", wrapClassName)}>
      {children}
    </span>
  ) : (
    children
  );
  if (layer) return <LayerTip layer={layer} spec={{ label, side, align, delay, className }} trigger={trigger} />;
  // A new trigger element when disabled flips: hover only finds the first
  // one (Back's arrow, disabled until there is somewhere to go).
  return (
    <Tooltip key={disabled ? "disabled" : "enabled"}>
      <TooltipTrigger delay={delay} render={trigger} />
      <TooltipPopup side={side} align={align} className={className}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

// ---- The tip layer ------------------------------------------------------------

interface TipSpec {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delay?: number;
  className?: string;
}

interface TipLayer {
  tips: Map<string, { current: TipSpec }>;
  // The tip open now, told when its label changes or it goes.
  openId?: string;
  refresh(): void;
  close(): void;
}

const TipLayerContext = createContext<TipLayer | null>(null);

// LayerTip marks its element with an id the layer looks its label up by.
function LayerTip({ layer, spec, trigger }: { layer: TipLayer; spec: TipSpec; trigger: ReactElement }) {
  const id = useId();
  const ref = useRef(spec);
  ref.current = spec;
  useLayoutEffect(() => {
    layer.tips.set(id, ref);
    return () => {
      layer.tips.delete(id);
      if (layer.openId === id) layer.close();
    };
  }, [layer, id]);
  // An open tip shows its label as it changes.
  useLayoutEffect(() => {
    if (layer.openId === id) layer.refresh();
  });
  return cloneElement(trigger, { "data-tip": id } as Record<string, unknown>);
}

const DELAY = 300;
// Moving from one tip to the next within this, the next opens at once.
const WARM = 400;

const tipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-tip]") : null);

// useTipLayer makes a tip layer: `provider` wraps the part of the tree
// whose Tips it shows, `props` go on the element that holds them (React's
// events, so they arrive from portals too), and `tooltip` is the one
// tooltip, rendered anywhere inside.
export function useTipLayer() {
  const [cur, setCur] = useState<{ id: string; el: HTMLElement }>();
  const [open, setOpen] = useState(false);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const timer = useRef<number>(undefined);
  const pending = useRef<HTMLElement>(undefined);
  const pressed = useRef<HTMLElement>(undefined);
  const closedAt = useRef(0);
  const openRef = useRef(false);

  const layer = useMemo<TipLayer>(() => ({ tips: new Map(), refresh, close: () => {} }), []);
  const cancel = () => {
    window.clearTimeout(timer.current);
    pending.current = undefined;
  };
  const hide = () => {
    cancel();
    if (!openRef.current) return;
    openRef.current = false;
    layer.openId = undefined;
    closedAt.current = performance.now();
    setOpen(false);
  };
  const show = (el: HTMLElement) => {
    cancel();
    const id = el.dataset.tip;
    if (!id || !layer.tips.has(id) || !el.isConnected) return;
    openRef.current = true;
    layer.openId = id;
    setCur({ id, el });
    setOpen(true);
  };
  layer.close = hide;

  const props = {
    onPointerOver(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      const el = tipOf(e.target);
      if (!el || el === pending.current || el === pressed.current || (openRef.current && layer.openId === el.dataset.tip)) return;
      const spec = layer.tips.get(el.dataset.tip ?? "");
      if (!spec) return;
      cancel();
      if (openRef.current || performance.now() - closedAt.current < WARM) return show(el);
      pending.current = el;
      timer.current = window.setTimeout(() => show(el), spec.current.delay ?? DELAY);
    },
    onPointerOut(e: PointerEvent) {
      const el = tipOf(e.target);
      if (!el) return;
      const to = e.relatedTarget;
      if (to instanceof Node && el.contains(to)) return;
      if (pressed.current === el) pressed.current = undefined;
      if (pending.current === el) cancel();
      if (openRef.current && layer.openId === el.dataset.tip) hide();
    },
    // Focus opens one only when the keyboard moved it, as Tooltip does.
    onFocus(e: FocusEvent) {
      const el = tipOf(e.target);
      if (el && focusFromKeyboard()) show(el);
    },
    onBlur(e: FocusEvent) {
      const el = tipOf(e.target);
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
      if (openRef.current && layer.openId === el.dataset.tip) hide();
    },
    // A press closes it, until the pointer leaves and comes back.
    onPointerDown(e: PointerEvent) {
      const el = tipOf(e.target);
      if (el) pressed.current = el;
      hide();
    },
    onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") hide();
    },
  };

  const spec = cur ? layer.tips.get(cur.id)?.current : undefined;
  const tooltip = (
    <Tooltip open={open && !!spec} onOpenChange={(o) => !o && hide()}>
      <TooltipPopup anchor={cur?.el} side={spec?.side} align={spec?.align} className={spec?.className}>
        {spec?.label}
      </TooltipPopup>
    </Tooltip>
  );
  const provider = (children: ReactNode) => <TipLayerContext.Provider value={layer}>{children}</TipLayerContext.Provider>;
  return { props, tooltip, provider };
}
