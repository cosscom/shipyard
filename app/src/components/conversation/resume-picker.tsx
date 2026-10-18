import { HistoryIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandFooter, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { boxApi, type PastSession } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { ago, errorMessage } from "@/lib/format";
import { scheduleRefresh, useStore } from "@/lib/store";

// A structured chat's agent has no screen for its own /resume picker, so
// the chat draws one: the agent's past conversations in this folder (those
// had in its terminal too, for Claude Code), newest first. Picking one
// carries it on in this pane; the conversation it leaves stays in the
// worktree's "Resume a conversation".

interface Item {
  value: string;
  past: PastSession;
  label: string;
}

export function ResumePicker({ box, session, who, query: initial, onClose }: { box: string; session: string; who: string; query: string; onClose(): void }) {
  const client = useStore((s) => s.client);
  const [list, setList] = useState<{ agent: string; items: Item[]; note?: string }>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    boxApi.pastSessions(client, box, session).then(
      (r) => {
        if (!alive) return;
        const items = r.sessions.map((p) => ({ value: p.id, past: p, label: p.title || `Untitled ${p.id.slice(0, 8)}` }));
        setList({ agent: r.agent, items, note: r.note });
      },
      (err) => alive && setError(plainError(err)),
    );
    return () => {
      alive = false;
    };
  }, [client, box, session]);

  const pick = async (p: PastSession) => {
    onClose();
    if (!client || p.current) return;
    try {
      await boxApi.resumeSession(client, box, session, p.id);
      scheduleRefresh(box, ["sessions"]);
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't resume it", description: errorMessage(err) });
    }
  };

  const items = list?.items ?? [];
  const groups = [{ value: "past", items }];
  const empty = error ?? list?.note ?? (list ? `${who} has no past conversations in this folder.` : undefined);
  return (
    <CommandDialog open onOpenChange={(o) => !o && onClose()}>
      <CommandDialogPopup aria-label={`Resume one of ${who}'s conversations`}>
        <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => `${(i as Item).label} ${(i as Item).past.id}`}>
          <CommandInput placeholder={`Resume one of ${who}'s conversations…`} />
          <CommandPanel>
            {!list && !error ? (
              <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-body">
                <Spinner className="size-3.5" /> Reading {who}'s conversations…
              </div>
            ) : (
              <CommandEmpty>{items.length ? "No conversation matches." : empty}</CommandEmpty>
            )}
            <CommandList>
              {(group: (typeof groups)[number]) => (
                <CommandGroup key={group.value} items={group.items}>
                  {group.items.length > 0 && <CommandGroupLabel>In this folder, newest first</CommandGroupLabel>}
                  <CommandCollection>
                    {(item: Item) => (
                      <CommandItem key={item.value} value={item} disabled={!!item.past.session} className="gap-2" onClick={() => void pick(item.past)}>
                        <AgentIcon agent={list?.agent} className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{item.label}</span>
                        {item.past.current && <span className="shrink-0 rounded bg-accent px-1 py-px text-tag text-muted-foreground">this chat</span>}
                        <span className="ml-auto min-w-0 shrink-0 truncate text-muted-foreground text-meta tabular-nums">{item.past.session ? `running in ${item.past.session}` : item.past.updated ? ago(item.past.updated) : ""}</span>
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="text-tag text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> carry it on here
            </span>
            <span className="flex items-center gap-1">
              <HistoryIcon className="size-3" /> This chat's conversation stays resumable <Kbd>esc</Kbd>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
