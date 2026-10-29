import { ChevronDownIcon, ChevronRightIcon, EyeIcon, UsersIcon } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { Avatar } from "@/components/conversation/agent-message";
import { showInChat } from "@/components/conversation/artifacts";
import { HelperSheetHost, openHelper, peekHelper } from "@/components/conversation/subagent-view";
import { Tip } from "@/components/tip";
import { type MessageItem, senderColor, type Teammate } from "@/lib/agent-messages";
import { keyOf, useConversations } from "@/lib/conversation-store";
import { useHasHistory } from "@/lib/history";
import { PaneContext } from "@/lib/pane-context";
import type { CrewMember } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// CrewCard lists the helpers working beside one agent: the subagents it
// started, and Shipyard's own (an attempt, a reviewer, a loop). It belongs to
// the conversation, so it docks above the reply box beside the task list
// (TodoCard), in each chat pane for its own agent. Folded it is one line:
// how many, and how many are still working; open, every helper with what
// it is doing and for how long. A helper that reported back has a Report
// badge, which brings its report into view in the chat.
//
// Teammates (Claude Code's agent teams) are listed too once they have
// written to the agent: their latest message, and whether a question of
// theirs waits for an answer (needs you).
//
// Open while helpers work; once every one is back it folds itself after a
// moment (AUTO_FOLD_MS), unless you opened or folded it since. Each chat
// remembers its own fold while the app runs, as the task list does.

export const AUTO_FOLD_MS = 4000;

const KIND: Record<CrewMember["kind"], string> = { subagent: "Subagent", attempt: "Attempt", reviewer: "Reviewer", loop: "Loop" };

// The fold each chat was left in, and whether you chose it (a fold you
// chose is kept when new helpers start; one the card made is undone).
const folds = new Map<string, { open: boolean; yours: boolean; at: number }>();

const elapsed = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// With history on the box, a subagent opens to its own conversation: a
// click as a tab beside this chat's (or the tab it has), ⌘-click beside the
// chat in a split, ⌥-click (or its eye) a peek in the sheet.
export function CrewCard({ crew, teammates = [], chat }: { crew: CrewMember[]; teammates?: Teammate[]; chat: { box: string; session: string } }) {
  const key = keyOf(chat.box, chat.session);
  // What each helper reported back, latest last.
  const items = useConversations((st) => st.items[key]);
  const reports = useMemo(() => {
    const by = new Map<string, MessageItem>();
    for (const it of items ?? []) if (it.kind === "agent-message" && it.msg.from.helper && it.msg.intent === "report") by.set(it.msg.from.helper, it);
    return by;
  }, [items]);
  const asking = teammates.filter((t) => t.open).length;
  const pane = useContext(PaneContext);
  const from = pane && { wsKey: pane.wsKey, tab: pane.tab, pane: pane.pane };
  const busy = crew.filter((c) => c.state !== "finished").length;
  const working = busy > 0;
  const [open, setOpenState] = useState(() => folds.get(key)?.open ?? working);
  const [now, setNow] = useState(Date.now());
  const history = useHasHistory(chat.box);
  const setOpen = (o: boolean, yours: boolean) => {
    folds.set(key, { open: o, yours, at: Date.now() });
    setOpenState(o);
  };

  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [working]);

  // Helpers sent out open it again (unless you folded it); all back folds
  // it after a moment (unless you touched it since they came back).
  const was = useRef(working);
  useEffect(() => {
    const before = was.current;
    was.current = working;
    if (working === before) return;
    const f = folds.get(key);
    if (working) {
      if (!f?.yours || f.open) setOpen(true, false);
      return;
    }
    const back = Date.now();
    const t = window.setTimeout(() => {
      const g = folds.get(key);
      if (!(g?.yours && g.at >= back)) setOpen(false, false);
    }, AUTO_FOLD_MS);
    return () => window.clearTimeout(t);
  }, [working, key]);

  const first = crew.find((c) => c.state !== "finished");
  return (
    <section role="group" aria-label="Crew" data-crew data-open={open ? "" : undefined} className="mb-2 overflow-hidden rounded-lg border bg-card shadow-xs/5 vibrancy:bg-foreground/4 vibrancy:shadow-none">
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <button
          type="button"
          data-crew-toggle
          aria-expanded={open}
          onClick={() => setOpen(!open, true)}
          className="-my-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UsersIcon className={cn("size-3.5 shrink-0", working ? "text-muted-foreground" : "text-success")} aria-hidden />
          <span className="shrink-0 font-medium text-desc">Crew</span>
          <span className="shrink-0 text-muted-foreground/60 text-meta" aria-hidden>
            ·
          </span>
          <span className="shrink-0 text-muted-foreground text-meta tabular-nums">{crew.length + teammates.length}</span>
          <span className="shrink-0 text-muted-foreground/60 text-meta" aria-hidden>
            ·
          </span>
          <span className={cn("shrink-0 text-meta", working ? "text-info-foreground" : crew.length ? "text-success-foreground" : "text-muted-foreground")} data-crew-status>
            {working ? `${busy} working` : crew.length ? "All back" : `${teammates.length} teammate${teammates.length === 1 ? "" : "s"}`}
          </span>
          {asking > 0 && (
            <>
              <span className="shrink-0 text-muted-foreground/60 text-meta" aria-hidden>
                ·
              </span>
              <span data-crew-needs className="shrink-0 text-warning-foreground text-meta">
                {asking} needs you
              </span>
            </>
          )}
          {!open && first && (
            <>
              <span className="shrink-0 text-muted-foreground/60 text-meta" aria-hidden>
                ·
              </span>
              <span className="cv-shimmer min-w-0 truncate text-muted-foreground text-meta">{first.doing}</span>
            </>
          )}
          <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
      </div>
      <div className="cv-fold" data-closed={open ? undefined : ""}>
        <div>
          {/* About four rows, then it scrolls. */}
          <ul className="max-h-[8.25rem] overflow-y-auto border-t p-1" data-crew-list>
            {crew.map((c, i) => {
              const report = reports.get(c.id);
              const row = (
                <>
                  <StateGlyph state={c.state} />
                  <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium">{c.name.replace(/^Explore:\s*/, "")}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-meta">{c.doing}</span>
                  <span className="shrink-0 text-muted-foreground text-meta @max-[560px]:hidden">{KIND[c.kind]}</span>
                  {report && <span className="w-[3.75rem] shrink-0" aria-hidden />}
                  {/* Wide enough for "12m 00s" on one line. */}
                  <span className="w-[3.75rem] shrink-0 whitespace-nowrap text-right font-mono text-muted-foreground text-mono tabular-nums">{elapsed((c.state === "finished" ? (c.until ?? now) : now) - c.since)}</span>
                </>
              );
              return (
                <li key={c.id} className="group/row relative">
                  {history && c.kind === "subagent" ? (
                    <>
                      <Tip label="Open in a tab · ⌘-click beside the chat · ⌥-click to peek" side="top" align="start" wrapClassName="block w-full">
                      <button
                        type="button"
                        data-helper={c.id}
                        onClick={(e) => openHelper(chat.box, chat.session, c.id, { from, title: c.name, event: e })}
                        aria-label={`${c.name}: open its conversation in a tab`}
                        className="flex h-7 w-full items-center gap-2.5 rounded-md pr-1 pl-2 text-left text-desc outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row}
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-100" />
                      </button>
                      </Tip>
                      {report && (
                        <Tip label="Show its report in the chat">
                          <button
                            type="button"
                            data-crew-report={c.id}
                            onClick={() => showInChat(key, report.id)}
                            className="absolute top-1 right-[6.125rem] inline-flex h-5 w-[3.5rem] items-center justify-center gap-1 rounded-md border bg-background text-tag text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className={cn(`am-c-${senderColor(report.msg.from, i)}`, "size-1.5 rounded-full bg-(--am)")} aria-hidden />
                            {report.msg.status === "failed" ? "Failed" : "Report"}
                          </button>
                        </Tip>
                      )}
                      <Tip label="Peek (⌥-click)">
                        <button
                          type="button"
                          data-helper-peek
                          aria-label={`Peek at ${c.name}`}
                          onClick={() => peekHelper(chat.box, chat.session, c.id, from)}
                          className="absolute top-0.5 right-0.5 inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
                        >
                          <EyeIcon className="size-3.5" />
                        </button>
                      </Tip>
                    </>
                  ) : (
                    <div className="flex h-7 items-center gap-2.5 rounded-md pr-[1.375rem] pl-2 text-desc">{row}</div>
                  )}
                </li>
              );
            })}
            {teammates.map((t) => (
              <li key={`team-${t.id}`} className="group/row relative">
                <Tip label={t.open ? `${t.name} asked a question: show it in the chat` : `Show ${t.name}'s latest message in the chat`} side="top" align="start" wrapClassName="block w-full">
                  <button
                    type="button"
                    data-teammate={t.id}
                    onClick={() => showInChat(key, t.lastId)}
                    className="flex h-7 w-full items-center gap-2.5 rounded-md pr-[1.375rem] pl-2 text-left text-desc outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Avatar from={{ id: t.id, name: t.name, kind: "teammate", color: t.color }} color={senderColor({ id: t.id, name: t.name, kind: "teammate", color: t.color })} className="size-5 rounded" />
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium">{t.name}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground text-meta">{t.last}</span>
                    {t.open ? (
                      <span data-teammate-needs className="inline-flex shrink-0 items-center gap-1 text-warning-foreground text-meta">
                        <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                        Needs you
                      </span>
                    ) : (
                      <span className="shrink-0 text-muted-foreground text-meta @max-[560px]:hidden">Teammate</span>
                    )}
                    <span className="w-[3.75rem] shrink-0 whitespace-nowrap text-right text-muted-foreground text-meta tabular-nums">
                      {t.count} msg{t.count === 1 ? "" : "s"}
                    </span>
                  </button>
                </Tip>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {history && <HelperSheetHost />}
    </section>
  );
}
