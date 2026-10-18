import { BookMarkedIcon, ChevronsUpDownIcon, CloudOffIcon, FolderPlusIcon, PinIcon, UsersIcon } from "lucide-react";
import { useEffect } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import type { SessionEntry } from "@/hooks/use-agent-counts";
import type { AgentPreset } from "@/lib/api";
import type { AgentPick } from "@/lib/composer";
import { sessionAgent, sessionName, sessionPlace } from "@/lib/derive";
import { promptsFor, usePrompts } from "@/lib/prompts";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// The composer's pickers: where (project, box, worktree or main checkout),
// which agents (with their models and efforts, and how many of each), the
// running agents a prompt goes to, and saved prompts to start from.

// What the agents picker holds: per agent, its models (each one attempt; ""
// the default) and one effort.
export type Chosen = Record<string, { models: string[]; effort: string }>;

export const expand = (sel: Chosen, copies: number): AgentPick[] =>
  Object.entries(sel).flatMap(([agent, c]) => c.models.flatMap((model) => Array.from({ length: copies }, () => ({ agent, model, effort: c.effort }))));

// toChosen groups picks back into the picker's shape.
export function toChosen(picks: { agent: string; model?: string; effort?: string }[]): Chosen {
  const out: Chosen = {};
  for (const p of picks) {
    const c = (out[p.agent] ??= { models: [], effort: p.effort ?? "" });
    if (!c.models.includes(p.model ?? "")) c.models.push(p.model ?? "");
  }
  return out;
}

// nice shows a CLI's name for a model or an effort as people say it:
// "opus" → "Opus", "xhigh" → "Extra high"; ids like gpt-5-codex stay.
export const nice = (m: string) => (m === "xhigh" ? "Extra high" : /^[a-z]+$/.test(m) ? m[0].toUpperCase() + m.slice(1) : m);

// pickLabel is the trigger's text: "Claude Code · Opus · High",
// "Claude Code (Opus vs Sonnet)", "Claude Code + Codex", "Codex ×3".
export function pickLabel(sel: Chosen, copies: number, presets: AgentPreset[]): string {
  const name = (id: string) => presets.find((p) => p.id === id)?.name ?? id;
  const entries = Object.entries(sel);
  if (!entries.length) return "No agent";
  let s: string;
  if (entries.length === 1 && entries[0][1].models.length === 1) {
    const [id, c] = entries[0];
    s = [name(id), c.models[0] && nice(c.models[0]), c.effort && nice(c.effort)].filter(Boolean).join(" · ");
  } else {
    const parts = entries.map(([id, c]) => {
      const named = c.models.filter(Boolean).map(nice);
      if (!named.length) return name(id);
      return `${name(id)} (${c.models.map((m) => (m ? nice(m) : "Default")).join(" vs ")})`;
    });
    s = parts.length > 2 ? `${parts[0]} + ${parts.length - 1} more` : parts.join(" + ");
  }
  return copies > 1 ? `${s} ×${copies}` : s;
}

const Tick = ({ on }: { on: boolean }) => (
  <span className={cn("flex w-3 shrink-0 items-center justify-center", !on && "invisible")} aria-hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-3">
      <path d="M5.25 12.7 10.2 18.63 18.75 5.37" />
    </svg>
  </span>
);

// AgentsPicker chooses the agents to start: one is a task; several, or one
// model against another, or ×2 of the same, are attempts. single keeps it
// to one (a hand-off, a review); allowNone offers the worktree alone.
export function AgentsPicker({
  presets,
  sel,
  copies,
  none,
  single,
  allowNone,
  onChange,
  onCopies,
  onNone,
}: {
  presets: AgentPreset[];
  sel: Chosen;
  copies: number;
  none?: boolean;
  single?: boolean;
  allowNone?: boolean;
  onChange(c: Chosen): void;
  onCopies(n: number): void;
  onNone?(on: boolean): void;
}) {
  const label = none ? "No agent" : pickLabel(sel, copies, presets);
  const ids = none ? [] : Object.keys(sel);
  // Unticking the last pick leaves it: there is always one agent, unless
  // "No agent" is ticked instead.
  const set = (id: string, next: { models: string[]; effort: string } | undefined) => {
    onNone?.(false);
    if (single) {
      if (next?.models.length) onChange({ [id]: { models: next.models.slice(-1), effort: next.effort } });
      return;
    }
    const out: Chosen = { ...sel };
    if (next?.models.length) out[id] = next;
    else delete out[id];
    if (Object.keys(out).length) onChange(out);
  };
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="ghost" aria-label={`Agents: ${label}`} className="min-w-0 max-w-60 shrink" />}>
        {ids.length > 0 && (
          <span className="flex shrink-0 gap-0.5">
            {ids.map((id) => (
              <AgentIcon key={id} agent={id} />
            ))}
          </span>
        )}
        <span className="truncate">{label}</span>
        <ChevronsUpDownIcon className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>{single ? "Agent" : "Agents"}</MenuGroupLabel>
          {presets.length === 0 && <p className="px-2 py-1.5 text-muted-foreground text-meta">No agent CLI on this box. Settings → Agents shows how to add one.</p>}
          {presets.map((p) => {
            const c = none ? undefined : sel[p.id];
            const models = p.model_flag ? (p.models ?? []) : [];
            const efforts = p.effort_flag ? (p.efforts ?? []) : [];
            if (!models.length && !efforts.length) {
              return (
                <MenuCheckboxItem key={p.id} checked={!!c} onCheckedChange={(on) => set(p.id, on ? { models: [""], effort: "" } : undefined)}>
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={p.id} />
                    {p.name}
                  </span>
                </MenuCheckboxItem>
              );
            }
            const cur = c ?? { models: [], effort: "" };
            const toggle = (m: string, on: boolean) => set(p.id, { ...cur, models: on ? [...cur.models.filter((x) => x !== m), m] : cur.models.filter((x) => x !== m) });
            return (
              <MenuSub key={p.id}>
                <MenuSubTrigger className="gap-2 ps-2">
                  <Tick on={!!c} />
                  <AgentIcon agent={p.id} />
                  <span className="flex-1">{p.name}</span>
                  {c && <span className="text-muted-foreground text-meta">{[...c.models.map((m) => (m ? nice(m) : "Default")), c.effort && nice(c.effort)].filter(Boolean).join(", ")}</span>}
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-44">
                  <MenuGroup>
                    <MenuGroupLabel>Model</MenuGroupLabel>
                    {["", ...models].map((m) => (
                      <MenuCheckboxItem key={m || "default"} checked={cur.models.includes(m)} onCheckedChange={(on) => toggle(m, on)}>
                        {m ? nice(m) : "Default"}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                  {efforts.length > 0 && (
                    <>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuGroupLabel>Effort</MenuGroupLabel>
                        <MenuRadioGroup value={cur.effort} onValueChange={(v) => set(p.id, { models: cur.models.length ? cur.models : [""], effort: String(v) })}>
                          {["", ...efforts].map((e) => (
                            <MenuRadioItem key={e || "default"} value={e}>
                              {e ? nice(e) : "Default"}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuGroup>
                    </>
                  )}
                </MenuSubPopup>
              </MenuSub>
            );
          })}
          {allowNone && (
            <MenuCheckboxItem checked={!!none} onCheckedChange={(on) => onNone?.(on)}>
              <span className="flex flex-col">
                No agent
                <span className="text-muted-foreground text-meta">Just the worktree</span>
              </span>
            </MenuCheckboxItem>
          )}
        </MenuGroup>
        {!single && !none && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Attempts of each</MenuGroupLabel>
              <MenuRadioGroup value={copies} onValueChange={(v) => onCopies(Number(v))}>
                {[1, 2, 3].map((n) => (
                  <MenuRadioItem key={n} value={n}>
                    {n === 1 ? "One" : `×${n}`}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

export interface PickOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

// Pick is one of the footer's quiet pickers: Project, Box, Where.
export function Pick({
  label,
  icon,
  value,
  options,
  onPick,
  empty,
  footer,
  className,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: PickOption[];
  onPick(v: string): void;
  empty?: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  const shown = options.find((o) => o.value === value)?.label ?? empty ?? "";
  // One choice and nothing else to do: a label, not a menu.
  const fixed = options.length <= 1 && !footer;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="ghost" aria-label={`${label}: ${shown}`} disabled={fixed && !options.length} className={cn("min-w-0 max-w-44 shrink-0 text-muted-foreground hover:text-foreground", fixed && "pointer-events-none", className)} />}
      >
        {icon}
        <span className="truncate">{shown}</span>
        {!fixed && <ChevronsUpDownIcon className="opacity-60" />}
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
            {options.map((o) => (
              <MenuRadioItem key={o.value} value={o.value} disabled={o.disabled} closeOnClick>
                <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                  <span className="truncate">{o.label}</span>
                  {o.detail && <span className="shrink-0 text-muted-foreground text-meta">{o.detail}</span>}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {footer}
      </MenuPopup>
    </Menu>
  );
}

export function AddProjectItem({ box }: { box?: string }) {
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={() => useStore.getState().openAddProject(box || undefined)}>
        <FolderPlusIcon />
        Add a project…
      </MenuItem>
    </>
  );
}

export function DefaultBoxItem({ box, onSet }: { box: string; onSet(): void }) {
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={onSet}>
        <PinIcon />
        Make {box} this project's default box
      </MenuItem>
    </>
  );
}

const keyOf = (e: { box: string; session: string }) => `${e.box}/${e.session}`;
export const entryKey = (e: SessionEntry) => keyOf({ box: e.box, session: e.session.name });

// TargetsPicker chooses the running agents a prompt goes to, by box, each
// named by its work. Agents on boxes that are away, as last seen, get the
// prompt once their box is back.
export function TargetsPicker({
  shown,
  away,
  selected,
  onlyFree,
  onOnlyFree,
  onToggle,
  onAll,
}: {
  shown: SessionEntry[];
  away: Set<string>;
  selected: Set<string>;
  onlyFree: boolean;
  onOnlyFree(on: boolean): void;
  onToggle(key: string, on: boolean): void;
  onAll(on: boolean): void;
}) {
  const boxes = useStore((s) => s.boxes);
  const chosen = shown.filter((e) => selected.has(entryKey(e)));
  const byBox = [...new Set(shown.map((e) => e.box))].map((box) => [box, shown.filter((e) => e.box === box)] as const);
  const label = chosen.length === 0 ? "Pick agents" : chosen.length === 1 ? sessionName(chosen[0].session, { sessions: boxes[chosen[0].box]?.sessions }) : `${chosen.length} agents`;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="ghost" aria-label={`Send to: ${label}`} className={cn("min-w-0 max-w-80 shrink", !chosen.length && "text-muted-foreground")} />}>
        {chosen.length === 1 ? <AgentIcon agent={chosen[0].session.agent} /> : <UsersIcon />}
        <span className="truncate">{label}</span>
        <ChevronsUpDownIcon className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-96 min-w-80">
        <MenuCheckboxItem checked={onlyFree} onCheckedChange={onOnlyFree}>
          Only agents that are ready or done
        </MenuCheckboxItem>
        {shown.length > 0 && (
          <MenuItem closeOnClick={false} onClick={() => onAll(chosen.length !== shown.length)}>
            <span className="ps-5">{chosen.length === shown.length ? "Pick none" : `Pick all ${shown.length}`}</span>
          </MenuItem>
        )}
        {byBox.length === 0 && <p className="px-2 py-3 text-center text-muted-foreground text-meta">{onlyFree ? "Every agent is busy. Untick the filter to queue behind them." : "No agents are running."}</p>}
        {byBox.map(([box, entries]) => (
          <MenuGroup key={box}>
            <MenuSeparator />
            <MenuGroupLabel className="flex items-center gap-1.5">
              {away.has(box) && <CloudOffIcon className="size-3" />}
              {box}
              {away.has(box) && <span className="font-normal">· offline, as last seen</span>}
            </MenuGroupLabel>
            {entries.map((e) => {
              const k = entryKey(e);
              const d = boxes[e.box];
              return (
                <MenuCheckboxItem key={k} checked={selected.has(k)} closeOnClick={false} onCheckedChange={(on) => onToggle(k, on)}>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <AgentIcon agent={e.session.agent} className="size-3.5" />
                    <span className="min-w-0 truncate">{sessionName(e.session, { sessions: d?.sessions })}</span>
                    <span className="min-w-0 shrink truncate text-muted-foreground text-meta">{[sessionAgent(e.session), sessionPlace(e.session, d?.locations)].filter(Boolean).join(" · ")}</span>
                    <StateGlyph state={e.state} className="ml-auto size-3" />
                  </span>
                </MenuCheckboxItem>
              );
            })}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

// SavedPrompts starts the text from a saved prompt: its body, variables
// and all, which fill in for each agent when it is sent.
export function SavedPrompts({ onPick }: { onPick(id: string, body: string): void }) {
  const prompts = usePrompts((s) => s.prompts);
  useEffect(() => {
    void usePrompts.getState().load();
  }, []);
  const list = promptsFor(prompts).slice(0, 12);
  return (
    <Menu>
      <Tip label="Start from a saved prompt">
        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Saved prompts" className="text-muted-foreground hover:text-foreground" />}>
          <BookMarkedIcon />
        </MenuTrigger>
      </Tip>
      <MenuPopup align="end" className="max-h-80 w-72">
        <MenuGroup>
          <MenuGroupLabel>Saved prompts</MenuGroupLabel>
          {list.length === 0 && <p className="px-2 py-2 text-muted-foreground text-meta">None yet. Save prompts you use often from ⌘K → Send a saved prompt.</p>}
          {list.map((p) => (
            <MenuItem key={p.id} onClick={() => onPick(p.id, p.body)}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{p.title}</span>
                <span className="truncate text-muted-foreground text-meta">{p.body.split("\n")[0]}</span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
