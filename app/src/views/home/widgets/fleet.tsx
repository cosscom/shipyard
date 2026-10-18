import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";

import { StateGlyph, StatusDot, useBoxState } from "@/components/agent-glyph";
import type { BoxStatus } from "@/lib/api";
import { hostSuffix, portUrl } from "@/lib/browser-url";
import { bytes } from "@/lib/format";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openBrowser, selectWorktree } from "@/lib/workspaces";
import { openAddBox } from "@/views/onboarding/add-box-dialog";

import { useAgentRows } from "./agents";
import { fitRows, useHomeWidget } from "./env";
import { Bar, More, shortAgo, WidgetEmpty, WidgetRow, WidgetSkeleton } from "./parts";
import { placeLabel } from "@/lib/worktree-names";

// Boxes and what runs on them: both from what the app already polls (each
// box's stats every 30s, its services), so they cost nothing extra.

export function BoxesWidget() {
  const { height, span } = useHomeWidget();
  const list = useStore((s) => s.status?.boxes ?? (NONE as BoxStatus[]));
  const loaded = useStore((s) => !!s.status);
  if (!loaded) return <WidgetSkeleton rows={3} />;
  if (!list.length) return <WidgetEmpty scene="arriving" title="No boxes yet" hint="A box is a computer your agents work on: this Mac, a server, a VM." action="Add a box" onAction={openAddBox} />;
  // Online first, then by name; offline boxes take one line.
  const sorted = [...list].sort((a, b) => Number(b.state === "online") - Number(a.state === "online") || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, Math.max(1, fitRows(height, 44)));
  return (
    <div className={cn("grid content-start gap-y-0.5", span.c >= 2 && "grid-cols-2 gap-x-2 @max-[420px]:grid-cols-1")}>
      {shown.map((b) => (
        <BoxRow key={b.name} b={b} />
      ))}
      <More n={sorted.length - shown.length} label={sorted.length - shown.length === 1 ? "box" : "boxes"} onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })} />
    </div>
  );
}

function BoxRow({ b }: { b: BoxStatus }) {
  const state = useBoxState(b.name);
  const st = useStore((s) => s.boxes[b.name]?.stats);
  const agents = useAgentRows();
  const working = agents.filter((a) => a.box === b.name && a.state === "running").length;
  const waiting = agents.filter((a) => a.box === b.name && a.state === "waiting").length;
  const online = b.state === "online";
  const cpu = st?.load?.length ? st.load[0] / Math.max(1, st.cpus) : 0;
  const mem = st ? st.memory.used / Math.max(1, st.memory.total) : 0;
  const disk = st?.disks[0] ? st.disks[0].used / Math.max(1, st.disks[0].total) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-body">
        <StatusDot state={state} />
        <span className="truncate text-row">{b.name}</span>
        <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
          {online ? (st ? `${st.cpus} CPU · ${bytes(st.memory.total)}` : "") : `offline${b.since ? ` · ${shortAgo(b.since)}` : ""}`}
        </span>
        {waiting > 0 && <StateGlyph state="waiting" className="size-3" />}
        {working > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground tabular-nums">
            <StateGlyph state="running" className="size-3" />
            {working}
          </span>
        )}
      </span>
      {online && st ? (
        <span className="grid grid-cols-3 gap-2 pl-3.5" role="group" aria-label={`${b.name}: CPU ${Math.round(cpu * 100)}%, memory ${Math.round(mem * 100)}%, disk ${Math.round(disk * 100)}%`}>
          {(
            [
              ["CPU", cpu],
              ["Mem", mem],
              ["Disk", disk],
            ] as const
          ).map(([l, v]) => (
            <span key={l} className="flex min-w-0 flex-col gap-0.5" aria-hidden>
              <span className="flex justify-between gap-1 text-tag text-muted-foreground">
                <span>{l}</span>
                <span className="tabular-nums">{Math.round(Math.min(1, v) * 100)}%</span>
              </span>
              <Bar value={v} tone={v > 0.9 ? "destructive" : v > 0.8 ? "warning" : "muted"} />
            </span>
          ))}
        </span>
      ) : online ? (
        <span className="h-[22px] pl-3.5 text-meta text-muted-foreground">Reading stats…</span>
      ) : (
        <span className="truncate pl-3.5 text-meta text-muted-foreground">{b.error ? "Can't reach it" : "Not connected"}</span>
      )}
    </div>
  );
}

// Dev servers and databases listening in worktrees, the noise left out.
const NOISE = /chrome|chromium|agent-browser|headless/i;

function serviceName(process?: string) {
  const p = process ?? "";
  if (/next/.test(p)) return "next dev";
  if (/storybook/.test(p)) return "storybook";
  if (/prisma/.test(p)) return "prisma studio";
  if (/vite/.test(p)) return "vite";
  if (/postgres/.test(p)) return "postgres";
  if (/redis/.test(p)) return "redis";
  return p.split(/[\s/]/).filter(Boolean).pop() ?? "";
}

export function ServicesWidget() {
  const { height, span } = useHomeWidget();
  const boxes = useStore((s) => s.boxes);
  const urlPort = useStore((s) => s.status?.proxy.url_port);
  const loaded = useStore((s) => !!s.status && Object.values(s.boxes).some((b) => b.services));
  const list = useMemo(
    () =>
      Object.entries(boxes)
        .flatMap(([box, d]) => (d.services ?? []).filter((s) => !NOISE.test(s.process ?? "")).map((s) => ({ box, ...s, name: serviceName(s.process) })))
        .sort((a, b) => a.box.localeCompare(b.box) || a.port - b.port),
    [boxes],
  );
  if (!loaded && !list.length) return <WidgetSkeleton rows={3} />;
  if (!list.length) return <WidgetEmpty scene="dock" title="Nothing is listening" hint="Dev servers your agents start in worktrees show here, a click from a tab." />;
  const shown = list.slice(0, list.length * 36 > height ? fitRows(height, 36) : list.length);
  return (
    <div className="flex flex-col">
      {shown.map((s) => (
        <WidgetRow
          key={`${s.box}:${s.port}`}
          label={`Open ${placeLabel(s, boxes)} on port ${s.port}`}
          onClick={() => {
            const ref = { box: s.box, location: s.location, worktree: s.worktree, path: s.path, main: s.main };
            selectWorktree(ref);
            openBrowser(portUrl(s.port, { ref, services: boxes[s.box]?.services ?? [], urlPort }) ?? `http://${s.port}.${s.box}.localhost${hostSuffix(urlPort)}/`);
          }}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
          <span className="w-11 shrink-0 font-mono text-meta tabular-nums">:{s.port}</span>
          <span className="min-w-0 flex-1 truncate">{placeLabel(s, boxes)}</span>
          {span.c > 1 && <span className="shrink-0 truncate text-meta text-muted-foreground @max-[260px]:hidden">{s.name}</span>}
          <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
        </WidgetRow>
      ))}
      <More n={list.length - shown.length} label="listening" />
    </div>
  );
}
