import { useRef } from "react";

import { COMPARE_BAR, CompareBar, useSideStates } from "@/components/workspace/compare-view";
import { useTiny } from "@/components/workspace/worktree-tone";
import { ErrorBoundary } from "@/components/error-boundary";
import { Pane } from "@/components/workspace/pane";
import { PaneGuard } from "@/components/workspace/pane-guard";
import { closeCompare } from "@/lib/compare-actions";
import { DragGhost, DropOverlay } from "@/components/workspace/tab-drag";
import { shownSides, sides } from "@/lib/compare";
import { type Divider, layout, mixed } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { resizeSplit, useWorkspaces } from "@/lib/workspaces";

const pct = (n: number) => `${n * 100}%`;

// PaneLayer draws every pane of every workspace opened since launch, in one
// flat list positioned from each tab's split tree. Keeping them in one list,
// keyed by pane id, is what lets a terminal survive its tab being split,
// hidden, moved to another tab, or its worktree switched away from: React
// never remounts it. They are sorted by id, so a pane moving between tabs
// never moves in the DOM either (a moved frame would reload).
export function PaneLayer({ showing }: { showing: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const current = useWorkspaces((s) => s.current);
  const mounted = useWorkspaces((s) => s.mounted);
  const spaces = useWorkspaces((s) => s.spaces);
  // Compare tabs' sides, and whether each can show (compare-view.tsx).
  const compared = mounted.flatMap((k) => spaces[k]?.tabs.flatMap((t) => (t.compare ? [t.compare.a, t.compare.b] : [])) ?? []);
  const states = useSideStates(compared);
  const stateOf = (k: string) => states[compared.indexOf(k)] ?? "ok";
  // In a tiny window a Compare tab's sides stack, each the tab's full width.
  const tiny = useTiny();

  const items = mounted.flatMap((key) => {
    const ws = spaces[key];
    if (!ws) return [];
    return ws.tabs.flatMap((tab) => {
      const visible = showing && key === current && tab.id === ws.active;
      // A Compare tab: its bar, then its two panes below it, one filling
      // the tab when the other side can't show; its other lanes' panes
      // stay mounted, hidden.
      const pair = sides(tab);
      if (tab.compare && pair) {
        const c = tab.compare;
        const ratio = tab.root.kind === "split" ? tab.root.ratio : 0.5;
        const show = shownSides([stateOf(c.a), stateOf(c.b)]);
        const whole = { x: 0, y: 0, w: 1, h: 1 };
        const halves = tiny ? [{ ...whole, h: 0.5 }, { ...whole, y: 0.5, h: 0.5 }] : [{ ...whole, w: ratio }, { ...whole, x: ratio, w: 1 - ratio }];
        const rects = show[0] && show[1] ? halves : show[0] ? [whole, undefined] : [undefined, whole];
        return [
          ...(visible
            ? [
                <ErrorBoundary key={`bar:${tab.id}`} compact scope="the Compare bar" className="absolute inset-x-0 top-0 z-10 h-bar border-b bg-sidebar vibrancy:bg-transparent" rescues={() => [{ label: "Close tab", run: () => closeCompare(key, tab.id) }]}>
                  <CompareBar wsKey={key} tab={tab} />
                </ErrorBoundary>,
              ]
            : []),
          ...pair.map((leaf, i) => {
            const r = rects[i];
            const on = visible && !!r;
            return (
              <div
                key={leaf.id}
                data-testid="pane"
                data-pane-kind={leaf.content.kind}
                data-compare-side={i}
                data-pane-focused={on && tab.focus === leaf.id ? "" : undefined}
                className={cn("absolute overflow-hidden", r && r.x > 0 && "border-l", r && r.y > 0 && "border-t", "vibrancy:border-foreground/8")}
                style={{ left: pct(r?.x ?? 0), width: pct(r?.w ?? 1), top: `calc(${COMPARE_BAR}px + (100% - ${COMPARE_BAR}px) * ${r?.y ?? 0})`, height: `calc((100% - ${COMPARE_BAR}px) * ${r?.h ?? 1})`, display: on ? "block" : "none" }}
              >
                <PaneGuard wsKey={key} tab={tab.id} pane={leaf.id}>
                  <Pane wsKey={key} tab={tab.id} pane={leaf} visible={on} focused={tab.focus === leaf.id} split={false} mixed compare={{ tab: tab.id, pane: leaf.id, side: i as 0 | 1, sync: c.sync }} />
                </PaneGuard>
              </div>
            );
          }),
          ...(c.parked ?? []).map((leaf) => (
            <div key={leaf.id} className="absolute inset-0 overflow-hidden" style={{ display: "none" }}>
              <PaneGuard wsKey={key} tab={tab.id} pane={leaf.id}>
                <Pane wsKey={key} tab={tab.id} pane={leaf} visible={false} focused={false} split={false} mixed />
              </PaneGuard>
            </div>
          )),
        ];
      }
      const { leaves, dividers } = layout(tab.root);
      const split = leaves.length > 1;
      const several = mixed(tab.root, key);
      return [
        ...leaves.map(({ leaf, rect }) => (
          <div
            key={leaf.id}
            data-testid="pane"
            data-pane-kind={leaf.content.kind}
            // Where the keyboard goes home to when what had it closes (lib/focus-home.ts).
            data-pane-focused={visible && tab.focus === leaf.id ? "" : undefined}
            className={cn("absolute overflow-hidden", rect.x > 0 && "border-l", rect.y > 0 && "border-t", "vibrancy:border-foreground/8")}
            style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h), display: visible ? "block" : "none" }}
          >
            <PaneGuard wsKey={key} tab={tab.id} pane={leaf.id}>
              <Pane wsKey={key} tab={tab.id} pane={leaf} visible={visible} focused={tab.focus === leaf.id} split={split} mixed={several} />
            </PaneGuard>
          </div>
        )),
        ...(visible ? dividers.map((d) => <DividerHandle key={d.id} d={d} area={area} onRatio={(r) => resizeSplit(key, tab.id, d.id, r)} />) : []),
      ];
    });
  });

  return (
    <div ref={area} data-pane-area className="absolute inset-0" style={{ visibility: showing ? "visible" : "hidden" }}>
      {items.sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1))}
      {showing && <DropOverlay />}
      <DragGhost />
    </div>
  );
}

// DividerHandle is the invisible, wider grab area over a split's line.
function DividerHandle({ d, area, onRatio }: { d: Divider; area: React.RefObject<HTMLDivElement | null>; onRatio(r: number): void }) {
  const row = d.dir === "row";
  const style = row
    ? { left: `calc(${pct(d.at)} - 3px)`, top: pct(d.area.y), width: 6, height: pct(d.area.h) }
    : { top: `calc(${pct(d.at)} - 3px)`, left: pct(d.area.x), height: 6, width: pct(d.area.w) };

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      className={cn("absolute z-10 transition-colors hover:bg-ring/40", row ? "cursor-col-resize" : "cursor-row-resize")}
      style={style}
      onPointerDown={(e) => {
        const box = area.current?.getBoundingClientRect();
        if (!box) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        // Iframes would swallow the pointer while dragging over them.
        document.body.classList.add("[&_iframe]:pointer-events-none");
        const move = (ev: PointerEvent) => {
          const r = row ? ((ev.clientX - box.left) / box.width - d.area.x) / d.area.w : ((ev.clientY - box.top) / box.height - d.area.y) / d.area.h;
          onRatio(r);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          document.body.classList.remove("[&_iframe]:pointer-events-none");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}
