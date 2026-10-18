import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, CircleDotIcon, CircleStopIcon, CircleXIcon, MilestoneIcon } from "lucide-react";
import { useContext, useState } from "react";

import { BerthAvatar, CardHead, type Chip } from "@/components/conversation/agent-message";
import { PromptActionsContext } from "@/components/conversation/prompt-actions";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { BerthReport, TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { openSession } from "@/lib/workspaces";

// A report is Shipyard telling this agent that work it started has ended,
// needs a person, or reached a gate: what the box typed into the session as
// a <berth-notification> (internal/box/notify_text.go). It reads as a
// compact card, "checkout-fix finished · +12 −2 · 4m12s", with the other
// agent's last words under it and a way to open that agent, never as the
// tagged text, and never as if the person had typed it.

type Tone = "done" | "needs" | "failed" | "ended";

const WORDS: Record<string, [string, Tone]> = {
  finished: ["finished", "done"],
  succeeded: ["succeeded", "done"],
  failed: ["failed", "failed"],
  exited: ["exited", "ended"],
  lost: ["never started", "failed"],
  waiting: ["needs you", "needs"],
  waiting_gate: ["waits at a gate", "needs"],
  cancelled: ["was cancelled", "ended"],
  interrupted: ["was interrupted", "ended"],
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

// name is what the report is about, as the person knows it: the worktree,
// else the session, else the run.
export function reportName(r: BerthReport): string {
  if (r.kind === "run") return r.title || r.template || r.run || "A run";
  const wt = r.worktree?.split("/").pop();
  return wt || r.session || "An agent";
}

export function reportWord(r: BerthReport): string {
  if (r.kind !== "run" && r.status === "failed") return "ended on an error";
  return WORDS[r.status]?.[0] ?? r.status.replace(/_/g, " ");
}

// The chip each status gets: the same family as an agent's message
// (agent-message), so Shipyard's reports and other agents' read as one kind.
const CHIP: Record<Tone, Chip> = {
  done: { word: "Finished", Icon: CheckIcon, tone: "good" },
  needs: { word: "Needs you", Icon: CircleDotIcon, tone: "ask" },
  failed: { word: "Failed", Icon: CircleXIcon, tone: "bad" },
  ended: { word: "Ended", Icon: CircleStopIcon, tone: "plain" },
};

const Dot = () => (
  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
    ·
  </span>
);

export function ReportCard({ it }: { it: Extract<TranscriptItem, { kind: "report" }> }) {
  const r = it.report;
  const ctx = useContext(PromptActionsContext);
  const box = ctx?.box;
  const session = useStore((s) => (box && r.session ? s.boxes[box]?.sessions?.find((x) => x.name === r.session) : undefined));
  const [open, setOpen] = useState(false);
  const tone = WORDS[r.status]?.[1] ?? "ended";
  const name = reportName(r);
  const word = reportWord(r);
  const detail = (tone === "needs" ? r.needs || r.answer : r.answer || r.needs)?.trim();
  const changed = (r.added ?? 0) + (r.removed ?? 0) > 0;
  const about = r.kind === "run" ? `run ${r.run}` : (r.session ?? name);
  return (
    <div
      data-report={r.status}
      role="group"
      aria-label={`Shipyard: ${name} ${word}`}
      className={cn(
        "cv-in flex w-[min(100%,40rem)] min-w-0 flex-col self-start overflow-hidden rounded-lg border bg-card text-desc shadow-xs/5 @container",
        tone === "needs" && "border-warning/45",
        tone === "failed" && "border-destructive/35",
      )}
    >
      <CardHead
        avatar={<BerthAvatar />}
        name={name}
        kind={r.kind === "run" ? "Run" : "Agent"}
        chip={r.status === "waiting_gate" ? { word: "At a gate", Icon: MilestoneIcon, tone: "ask" } : { ...CHIP[tone], word: r.kind === "run" || tone !== "done" ? cap(word) : CHIP[tone].word }}
        extra={
          changed && (
            <>
              <Dot />
              <span className="shrink-0 text-meta tabular-nums" aria-label={`${r.added ?? 0} lines added, ${r.removed ?? 0} removed`}>
                <span className="text-success-foreground">+{r.added ?? 0}</span> <span className="text-destructive-foreground">−{r.removed ?? 0}</span>
              </span>
            </>
          )
        }
        took={r.duration}
        tip={`Shipyard reported back on ${about}, which this agent started, and sent it to the agent. You didn't type it.`}
        open={
          session &&
          box && (
            <Tip label={`Open ${session.title || session.name}`}>
              <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => openSession(box, session)}>
                Open
                <ArrowUpRightIcon />
              </Button>
            </Tip>
          )
        }
      />
      {detail && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="group flex w-full min-w-0 items-start gap-1.5 border-t px-2.5 py-1.5 text-left text-muted-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span data-selectable className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug", !open && "line-clamp-2")}>
            {detail}
          </span>
          <ChevronDownIcon className={cn("mt-0.5 size-3.5 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-70 group-focus-visible:opacity-70", open && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
