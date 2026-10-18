import { ArchiveIcon, CodeXmlIcon, GlobeIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { HeaderBand, useHeaderPicture } from "@/components/art/header-band";
import { TaskComposer } from "@/components/conversation/task-composer";
import { Scene } from "@/components/art/scenes";
import { usePrefs } from "@/lib/prefs";
import { openEditor } from "@/components/editors/open";
import { archiveWorktree } from "@/components/sidebar/actions";
import { toastManager } from "@/components/ui/toast";
import { WorktreeSections } from "@/components/workspace/worktree-sections";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { agentPresets, openBrowserAt, startAgent, startSession, usePendingStops } from "@/lib/actions";
import { agentLabel, agentOf, type SessionState, sessionName, sessionState } from "@/lib/derive";
import { ago } from "@/lib/format";
import { useRemoval } from "@/lib/removing";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { openSession, type WorktreeRef } from "@/lib/workspaces";
import { sessionWord } from "@/lib/state-model";
import { useTitleAt } from "@/lib/worktree-names";

// The model's words (lib/state-model.ts); a shell is just "open".
const stateWords = (s: SessionState) => (s === "idle" ? "open" : sessionWord(s, true));

// middle shortens a long name in the middle, keeping both ends readable:
// "me/eng-1234-…-checkout".
function middle(s: string, max = 32): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - (max - 1 - half))}`;
}

interface Row {
  key: string;
  icon: React.ReactNode;
  label: string;
  keys?: string;
  run(): void;
}

// Launcher fills a worktree's workspace while it has no tabs: the composer,
// to start an agent on a task here, then a compact command panel, like an
// empty state in Raycast or Linear: one list of what to start here, each
// with its shortcut, then the agents closed as tabs that are still running,
// to pick up again. Arrow keys move, Enter runs. Labs adds the header
// picture (the harbour unless chosen otherwise).
export function Launcher({ worktree: ref }: { worktree: WorktreeRef }) {
  useStore((s) => s.boxes[ref.box]?.info);
  const loc = useStore((s) => s.boxes[ref.box]?.locations?.find((l) => l.name === ref.location));
  const branch = loc?.worktrees?.find((w) => w.path === ref.path)?.branch;
  const sessions = useStore((s) => s.boxes[ref.box]?.sessions ?? NONE);
  const stats = useStore((s) => s.boxes[ref.box]?.stats);
  const leaving = useRemoval(ref.box, ref.path);
  const stopping = usePendingStops((s) => s.sessions);
  const [all, setAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const name = useTitleAt(ref.box, ref.path) ?? (ref.main ? ref.location : ref.worktree);
  const labs = usePrefs((p) => p.labs);
  // Labs puts the header picture (Settings › Appearance) across the top.
  const picture = useHeaderPicture();
  const band = labs ? picture : undefined;

  const rows: Row[] = [
    ...agentPresets(ref.box, ref.location).map((p) => ({
      key: `agent:${p.id}`,
      icon: <AgentIcon agent={p.id} className="size-4" />,
      label: `New ${p.name}`,
      run: () => void startAgent(p, { kind: "tab" }, p.name),
    })),
    { key: "shell", icon: <SquareTerminalIcon />, label: "New shell", keys: "⌘T", run: () => void startSession("") },
    { key: "browser", icon: <GlobeIcon />, label: "New browser tab", keys: "⌘⇧B", run: () => openBrowserAt("") },
    { key: "editor", icon: <CodeXmlIcon />, label: "Open in editor", keys: "⌘⇧O", run: () => void openEditor({ box: ref.box, path: ref.path }) },
    // Done with it: archive keeps the branch; the sidebar's ⋯ has Remove.
    ...(loc && !ref.main
      ? [{ key: "archive", icon: <ArchiveIcon />, label: "Archive this worktree…", run: () => {
          const wt = loc.worktrees?.find((w) => w.path === ref.path);
          if (wt) archiveWorktree(ref.box, loc, wt);
        } }]
      : []),
  ];

  // The launcher shows while the worktree has no tabs, so every agent still
  // running here is one to pick up (but not one closed a moment ago, which
  // is about to stop).
  const closed = sessions
    .filter((s) => s.dir === ref.path && !s.exited && !stopping.includes(s.name) && agentOf(s))
    .sort((a, b) => (b.state_since ?? b.created).localeCompare(a.state_since ?? a.created));
  const shown = all ? closed : closed.slice(0, 5);

  // Take the keyboard on arrival, unless a dialog or a field has it. The
  // sidebar row that opened the worktree gives it up.
  useEffect(() => {
    if (document.querySelector("textarea[aria-label]")) return;
    const t = window.setTimeout(() => {
      const a = document.activeElement as HTMLElement | null;
      const typing = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]") || typing) return;
      list.current?.querySelector<HTMLElement>("[data-row]")?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, [ref.path]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      {band && <HeaderBand picture={band} position={0.45} fade={0.5} className="absolute inset-x-0 top-0 h-[clamp(160px,30vh,280px)]" />}
      <div className={cn("relative flex min-h-full items-start justify-center px-6 pb-10", band ? "pt-[clamp(120px,24vh,230px)]" : "pt-[18vh]")}>
        <div ref={list} onKeyDown={onKeyDown} className="w-full max-w-[560px]">
          {/* A boat tied up and ready: the same drawing language as a pane
              whose session ended. Fixed size, so nothing below moves. */}
          {!labs && (
            <div aria-hidden className="mb-3 px-1">
              <Scene name="moored" width={144} />
            </div>
          )}
          <header className={cn("mb-4 px-2", band && "[text-shadow:0_0_6px_var(--background),0_0_14px_var(--background)]")}>
            <h1 className="truncate text-title" title={name}>
              {name}
            </h1>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
              {branch && (
                <Tip label={middle(branch) !== branch ? branch : undefined}>
                  <span className="shrink-0 rounded bg-accent px-1.5 py-px font-mono text-tag">{middle(branch)}</span>
                </Tip>
              )}
              <span className="shrink-0 rounded bg-accent px-1.5 py-px font-mono text-tag">{ref.box}</span>
              <Tip
                className="max-w-md"
                label={
                  <span className="flex flex-col gap-0.5">
                    <span className="break-all font-mono">{ref.path}</span>
                    <span className="text-muted-foreground">Click to copy</span>
                  </span>
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(ref.path);
                    toastManager.add({ title: "Copied the path", description: ref.path, type: "success" });
                  }}
                  // Truncated from the left, so the end of the path stays visible.
                  className="min-w-0 truncate text-left font-mono text-meta hover:text-foreground [direction:rtl]"
                >
                  <bdi>{ref.path}</bdi>
                </button>
              </Tip>
            </div>
          </header>

          {/* On its way out (archive or remove): nothing new starts here. */}
          {leaving ? (
            <div role="status" aria-busy="true" className="flex items-start gap-3 rounded-lg border bg-muted/40 px-3.5 py-3 text-body">
              <Spinner className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{leaving.kind === "archive" ? "Archiving" : "Removing"} {name}…</span>
                <span className="text-muted-foreground">
                  {leaving.script
                    ? `The repo's archive script is running on ${ref.box}. This worktree closes when it finishes, or comes back if it fails.`
                    : `Waiting for ${ref.box}.`}
                </span>
              </div>
            </div>
          ) : (
            <>
            {/* The one way to start work, here: an agent on a task in this
                worktree, or several attempts from its branch. */}
            <div className="mb-5">
              <TaskComposer fixed={{ box: ref.box, location: ref.location, at: ref.main ? ref.location : `${ref.location}/${ref.worktree}`, name, branch }} autoFocus placeholder={`What should an agent do in ${name}?`} />
            </div>
            <div className="flex flex-col">
              {rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  data-row
                  onClick={r.run}
                  className="flex h-9 items-center gap-3 rounded-md px-2 text-left text-body outline-none hover:bg-accent focus-visible:bg-accent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{r.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.keys && <Kbd>{r.keys}</Kbd>}
                </button>
              ))}
            </div>
            </>
          )}

          {/* What runs here, each with its URL, then plugins' sections. */}
          <WorktreeSections worktree={ref} className="mt-6" />

          {closed.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-1 px-2 text-label text-muted-foreground">Pick up where you left off</h2>
              {shown.map((s) => {
                const state = sessionState(s, stats);
                return (
                  <div
                    key={s.name}
                    data-row
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && openSession(ref.box, s)}
                    className="flex h-10 items-center gap-3 rounded-md px-2 text-body outline-none hover:bg-accent focus-visible:bg-accent"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <AgentIcon agent={agentOf(s)} className="size-4" />
                    </span>
                    <Tip label={<span className="font-mono">{s.name}</span>}>
                      <span className="min-w-0 max-w-[60%] shrink truncate">{sessionName(s, { sessions })}</span>
                    </Tip>
                    {s.title && <span className="shrink-0 text-meta text-muted-foreground">{agentLabel(agentOf(s)!)}</span>}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-meta text-muted-foreground">
                      <StateGlyph state={state} className="size-3" />
                      <span className="truncate">
                        {stateWords(state)} {ago(s.state_since ?? s.created)}
                      </span>
                    </span>
                    <Button size="xs" variant="outline" onClick={() => openSession(ref.box, s)}>
                      Resume
                    </Button>
                  </div>
                );
              })}
              {closed.length > 5 && (
                <button type="button" onClick={() => setAll(!all)} className={cn("mt-1 px-2 text-muted-foreground text-meta hover:text-foreground")}>
                  {all ? "Show fewer" : `Show all ${closed.length}`}
                </button>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
