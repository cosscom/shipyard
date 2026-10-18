import { useEffect, useRef } from "react";

import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { guessSessionName, sessionName, sessionPlace, worktreeOf } from "@/lib/derive";
import { type PromptVariable, type SavedPrompt, segments, variableLabel } from "@/lib/prompts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useRegistry } from "@/plugins/registry";
import { describeAgent, startedAt } from "@/views/dashboard/names";

// The prompts plugin's library screen, when that plugin is on.
export const LIBRARY_SCREEN = "prompt-library";

export function openLibrary(): boolean {
  if (!useRegistry.getState().screens.some((c) => c.item.id === LIBRARY_SCREEN)) return false;
  useStore.getState().setView({ kind: "plugin", screen: LIBRARY_SCREEN });
  return true;
}

// What a target session is called, the way the rest of the app names it:
// name is sessionName's "Claude Code 2", short adds the worktree for a chip
// ("order-export · Claude Code 2"), and detail says where and, when
// several agents share the worktree, when this one started.
export function useTargetLabel(box: string, session: string) {
  const d = useStore((s) => s.boxes[box]);
  const s = d?.sessions?.find((x) => x.name === session);
  if (!s) {
    const guess = guessSessionName(session);
    return { session: s, name: guess, title: guess, short: guess, place: "", detail: box };
  }
  const where = worktreeOf(d?.locations, s);
  const name = sessionName(s, { sessions: d?.sessions });
  const place = sessionPlace(s, d?.locations);
  const here = where ? (where.worktree.main ? where.location.name : where.worktree.name) : place;
  const crowded = describeAgent(s, d?.sessions, d?.locations).crowded;
  return {
    session: s,
    name,
    title: name,
    short: `${here} · ${name}`,
    place,
    detail: [place, where?.worktree.branch, crowded ? `started ${startedAt(s.created)}` : undefined, box].filter(Boolean).join(" · "),
  };
}

// PromptPreview is the prompt as it will be typed: what variables filled
// is marked, and what is still missing stands out.
export function PromptPreview({ body, values, className }: { body: string; values: Record<string, string | undefined>; className?: string }) {
  return (
    <div className={cn("whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3 py-2.5 text-desc", className)}>
      {segments(body, values).map((s, i) =>
        s.variable ? (
          <Tip key={i} label={s.missing ? `{{${s.variable}}} has no value yet` : `{{${s.variable}}}`}>
            <span className={cn("rounded-[3px] px-0.5", s.missing ? "bg-warning/12 font-mono text-mono text-warning-foreground" : "bg-primary/10 text-foreground")}>{s.text}</span>
          </Tip>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </div>
  );
}

// VariableFields asks for a prompt's own variables; built-ins fill
// themselves.
export function VariableFields({ vars, values, onChange, autoFocus }: { vars: PromptVariable[]; values: Record<string, string>; onChange(name: string, value: string): void; autoFocus?: boolean }) {
  if (!vars.length) return null;
  return (
    <div className="grid gap-3">
      {vars.map((v, i) => (
        <label key={v.name} className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-baseline gap-2 font-medium text-desc">
            {variableLabel(v)}
            <span className="font-mono font-normal text-tag text-muted-foreground">{`{{${v.name}}}`}</span>
          </span>
          {v.multiline ? (
            <Textarea autoFocus={autoFocus && i === 0} rows={3} value={values[v.name] ?? ""} placeholder={v.default} onChange={(e) => onChange(v.name, e.target.value)} />
          ) : (
            <Input autoFocus={autoFocus && i === 0} value={values[v.name] ?? ""} placeholder={v.default} onChange={(e) => onChange(v.name, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}

// With nothing typed, a variable takes its default.
export const withDefaults = (vars: PromptVariable[], values: Record<string, string>) =>
  Object.fromEntries(vars.map((v) => [v.name, values[v.name]?.trim() ? values[v.name] : (v.default ?? "")]));

// PromptRow is one prompt in a list: its title, tags, and how it starts.
export function PromptRow({ p, active, onPick, onHover }: { p: SavedPrompt; active?: boolean; onPick(): void; onHover?(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left outline-none", active ? "bg-accent" : "hover:bg-accent/50")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-desc">{p.title}</span>
        {p.project && (
          <Badge size="sm" variant="info">
            project
          </Badge>
        )}
        {p.tags.slice(0, 3).map((t) => (
          <Badge key={t} size="sm" variant="secondary">
            {t}
          </Badge>
        ))}
      </span>
      <span className="truncate text-muted-foreground text-meta">{p.body.replace(/\s+/g, " ")}</span>
    </button>
  );
}
