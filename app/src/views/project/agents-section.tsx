import { PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";

import { Tip } from "@/components/tip";
import { AgentIcon } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentPreset } from "@/lib/api";
import type { RepoConfig } from "@/lib/flows";
import { Section, SourceBadge } from "@/views/project/parts";

// AgentsSection is how agents start in this repo: the built-ins, replaced
// or added to by id, e.g. claude with --model opus.
export function AgentsSection({ repo, draft, setDraft, box }: { repo: RepoConfig | null; draft: RepoConfig; setDraft(c: RepoConfig): void; box: string }) {
  const committed = repo?.agents ?? [];
  const own = draft.agents ?? [];
  const ids = [...new Set([...committed.map((a) => a.id), ...own.map((a) => a.id)])];
  const setOwn = (agents: AgentPreset[]) => setDraft({ ...draft, agents });
  const update = (i: number, patch: Partial<AgentPreset>) => setOwn(own.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <Section
      id="agents"
      title="Agents"
      description="How agents start in this repo. A preset with a built-in's id (claude, codex, opencode, gemini, cursor, grok) replaces it here."
      actions={
        <Button size="xs" variant="ghost" onClick={() => setOwn([...own, { id: ids.includes("claude") ? `agent-${own.length + 1}` : "claude", name: "", command: "" }])}>
          <PlusIcon />
          Add preset
        </Button>
      }
    >
      {ids.length === 0 ? (
        <p className="px-4 py-3 text-muted-foreground text-sm">Using the built-ins. Add a preset to change how one starts, like Claude with a model or flags.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {ids.map((id, row) => {
            const c = committed.find((a) => a.id === id);
            const i = own.findIndex((a) => a.id === id);
            const mine = i >= 0 ? own[i] : undefined;
            const a = mine ?? c!;
            const source = mine ? (c ? "override" : "box") : "repo";
            return (
              <div key={row} className="grid grid-cols-[1.25rem_8rem_minmax(0,10rem)_minmax(0,1fr)_auto_3.5rem] items-center gap-3 px-4 py-2">
                <AgentIcon agent={a.id} />
                {mine && !c ? <Input value={mine.id} onChange={(e) => update(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} size="sm" className="font-mono text-xs" aria-label="Preset id" /> : <code className="truncate font-mono text-xs">{id}</code>}
                {mine ? <Input value={mine.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Name" size="sm" /> : <span className="truncate text-sm">{a.name}</span>}
                {mine ? (
                  <Input value={mine.command} onChange={(e) => update(i, { command: e.target.value })} placeholder="claude --model opus" size="sm" className="font-mono text-xs" spellCheck={false} />
                ) : (
                  <code className="truncate px-2.5 font-mono text-muted-foreground text-xs">{a.command}</code>
                )}
                <SourceBadge source={source} box={box} field="agents" entry={id} />
                <span className="flex justify-end">
                  {!mine && (
                    <Tip label={`Override on ${box}`}>
                      <Button size="icon-xs" variant="ghost" aria-label={`Override ${id} on ${box}`} onClick={() => setOwn([...own, { ...c! }])}>
                        <PlusIcon />
                      </Button>
                    </Tip>
                  )}
                  {mine && (
                    <Tip label={c ? "Use the repo's" : "Remove"}>
                      <Button size="icon-xs" variant="ghost" aria-label={c ? `Use the repo's ${id}` : `Remove ${id}`} onClick={() => setOwn(own.filter((_, j) => j !== i))}>
                        {c ? <Undo2Icon /> : <Trash2Icon />}
                      </Button>
                    </Tip>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
