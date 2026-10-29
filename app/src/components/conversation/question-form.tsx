import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CopyIcon, ListChecksIcon, PencilIcon, RotateCwIcon, SendHorizontalIcon, SquareTerminalIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { createContext, Fragment, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { LinkedText } from "@/components/conversation/linked-text";
import { ErrorText } from "@/components/error-note";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/clipboard";
import { answersText, complete, type Question, type QuestionAnswer, shownAnswer } from "@/lib/questions";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// The questions an agent asks with a form of its own, drawn whole in the
// chat: one step per question (radios for one pick, checkboxes for
// several, and a field for the person's own words), then a review with
// Submit, as Claude Code's own form goes. Submit hands the whole set to
// the box, which fills in the agent's form with keys (lib/questions).
// Answered, it stays in the conversation as what was picked.

export interface QuestionsActions {
  // The call the agent waits on now, when it is a question form.
  live?: string;
  // The chat can fill in the form: Claude Code, on a box that answers.
  canAnswer: boolean;
  // Why it couldn't, when it tried: the form keeps every answer, to try
  // again or copy, and the agent's own screen opens below to finish in.
  stuck?: string;
  submit(tool: string, answers: QuestionAnswer[]): Promise<void>;
}

export const QuestionsContext = createContext<QuestionsActions | undefined>(undefined);

type Item = Extract<TranscriptItem, { kind: "question" }>;

export function QuestionCard({ it, who }: { it: Item; who: string }) {
  const ctx = useContext(QuestionsContext);
  const [sent, setSent] = useState<QuestionAnswer[]>();
  if (it.done) return <Answered it={it} />;
  const live = !!ctx && !!it.tool && ctx.live === it.tool;
  if (sent) return <Sending it={it} answers={sent} who={who} />;
  if (!live) return <Asked it={it} />;
  if (!ctx.canAnswer) return <InTerminal it={it} who={who} />;
  return (
    <Form
      it={it}
      who={who}
      stuck={ctx.stuck}
      onSubmit={async (answers) => {
        await ctx.submit(it.tool ?? "", answers);
        setSent(answers);
      }}
    />
  );
}

const count = (n: number) => (n === 1 ? "a question" : `${n} questions`);

// What was answered, as the agent's record has it.
function Answered({ it }: { it: Item }) {
  const qs = it.questions;
  if (it.error || !it.answers) {
    return (
      <div className="cv-in flex min-w-0 items-center gap-2 text-muted-foreground">
        <XIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Not answered</span>
        <span className="truncate text-foreground/70">{qs.length === 1 ? qs[0].question : qs.map((q) => q.header || q.question).join(" · ")}</span>
      </div>
    );
  }
  return <AnswerList questions={qs} answers={it.answers} />;
}

function AnswerList({ questions, answers, note }: { questions: Question[]; answers: string[]; note?: ReactNode }) {
  if (questions.length === 1) {
    return (
      <div className="cv-in flex min-w-0 items-center gap-2 text-muted-foreground">
        <CheckIcon className="size-3.5 shrink-0 text-success" />
        <span className="truncate">{questions[0].question}</span>
        <span className="shrink-0" aria-hidden>
          →
        </span>
        <span data-selectable className="min-w-0 shrink-0 truncate font-medium text-foreground/85">
          {answers[0] || "—"}
        </span>
        {note}
      </div>
    );
  }
  return (
    <div className="cv-in flex min-w-0 flex-col gap-1.5 text-muted-foreground">
      <div className="flex items-center gap-2">
        <CheckIcon className="size-3.5 shrink-0 text-success" />
        <span>Answered {questions.length} questions</span>
        {note}
      </div>
      <dl className="ml-5.5 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-desc">
        {questions.map((q, i) => (
          <div key={q.question} className="contents">
            <dt className="truncate" title={q.question}>
              {q.header || q.question}
            </dt>
            <dd data-selectable className="min-w-0 break-words font-medium text-foreground/85">
              {answers[i] || "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Sent: the agent's form is filled in; its record says so a moment later.
function Sending({ it, answers, who }: { it: Item; answers: QuestionAnswer[]; who: string }) {
  return (
    <AnswerList
      questions={it.questions}
      answers={it.questions.map((q, i) => shownAnswer(q, answers[i]))}
      note={
        <span className="flex items-center gap-1.5 text-meta">
          <Spinner className="size-3" />
          {who} is reading your answers
        </span>
      }
    />
  );
}

// Asked, and no longer waited on here (it was answered in the terminal,
// or the agent moved on): the questions, quietly.
function Asked({ it }: { it: Item }) {
  return (
    <div className="cv-in flex min-w-0 items-center gap-2 text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
      <span className="shrink-0">Asked {count(it.questions.length)}</span>
      <span className="truncate text-foreground/70">{it.questions.map((q) => q.header || q.question).join(" · ")}</span>
    </div>
  );
}

// The questions, when only the agent's own screen can answer them: its
// terminal opens under the conversation.
function InTerminal({ it, who }: { it: Item; who: string }) {
  return (
    <Card className="cv-in border-warning/60">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2 font-medium">
          <span className="size-2 rounded-full bg-warning" aria-hidden />
          {who} asks you {count(it.questions.length)}
        </div>
        <ol className="flex flex-col gap-2.5">
          {it.questions.map((q, i) => (
            <li key={q.question} className="flex gap-2.5">
              <span className="mt-px font-mono text-muted-foreground text-mono tabular-nums">{i + 1}.</span>
              <div className="min-w-0">
                <p data-selectable className="wrap-anywhere text-body">
                  <LinkedText text={q.question} />
                </p>
                <p className="wrap-anywhere text-muted-foreground text-meta">
                  {q.options.map((o, j) => (
                    <Fragment key={o.label}>
                      {j > 0 && " · "}
                      <LinkedText text={o.label} />
                    </Fragment>
                  ))}
                  {q.multi ? " — pick any" : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-3 text-muted-foreground text-body">
        <SquareTerminalIcon className="size-3.5 shrink-0" />
        <span className="min-w-0">Answer in {who}'s screen below.</span>
      </div>
    </Card>
  );
}

// One question's state in the form: the options ticked (one for a single
// choice), and the person's own words with whether they count.
type Draft = { picks: string[]; other: string; otherOn: boolean };

const toAnswer = (d: Draft): QuestionAnswer => ({ picks: d.picks, other: d.otherOn ? d.other.replace(/\s+/g, " ").trim() : "" });

function Form({ it, who, stuck, onSubmit }: { it: Item; who: string; stuck?: string; onSubmit(answers: QuestionAnswer[]): Promise<void> }) {
  const qs = it.questions;
  const [drafts, setDrafts] = useState<Draft[]>(() => qs.map(() => ({ picks: [], other: "", otherOn: false })));
  // One question with one pick goes as soon as it is picked, as the
  // agent's own form does; anything more ends in a review.
  const reviewed = qs.length > 1 || qs.some((q) => q.multi);
  const steps = qs.length + (reviewed ? 1 : 0);
  const [step, setStep] = useState(0);
  // The keyboard moves with the step: Next turns disabled on a new step and
  // the old step's controls go, so whoever had the keyboard in the form
  // gets the new step's first control, not <body>.
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  const go = (n: number) => {
    follow.current = !!card.current?.contains(document.activeElement);
    setStep(n);
  };
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    body.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"], [role=radio], [role=checkbox], textarea, input:not([type=hidden]):not([aria-hidden=true]), button:not([disabled])')?.focus({ preventScroll: true });
  }, [step]);
  const [busy, setBusy] = useState(false);
  const answers = drafts.map(toAnswer);
  // The box couldn't fill in the agent's form: nothing here is lost.
  const failed = busy ? undefined : stuck;
  const done = qs.map((q, i) => complete(q, answers[i]));
  const review = reviewed && step === qs.length;
  const q = qs[Math.min(step, qs.length - 1)];
  const set = (i: number, f: (d: Draft) => Draft) => setDrafts((ds) => ds.map((d, j) => (j === i ? f(d) : d)));
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(answers);
    } catch {
      // Why is the pane's (stuck), for this wait.
      setBusy(false);
    }
  };
  const next = () => {
    if (!review && !done[step]) return;
    if (step < steps - 1) go(step + 1);
    else void submit();
  };
  const last = step === steps - 1;

  return (
    <Card ref={card} data-testid="question-form" className="cv-in overflow-hidden border-warning/60" aria-busy={busy}>
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-3">
        <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">
          {who} asks you {count(qs.length)}
        </span>
        {qs.length > 1 && (
          <span className="shrink-0 text-muted-foreground text-meta tabular-nums" aria-live="polite">
            {review ? "Review" : `${step + 1} of ${qs.length}`}
          </span>
        )}
      </div>
      {steps > 1 && (
        <nav aria-label="Questions" className="flex gap-1 overflow-x-auto px-4 pb-3">
          {[...qs.map((x, i) => ({ label: x.header || `Question ${i + 1}`, ok: done[i] })), ...(reviewed ? [{ label: "Review", ok: false }] : [])].map((s, i) => {
            // A step opens once every one before it has its answer.
            const reachable = i <= step || done.slice(0, i).every(Boolean);
            return (
              <button
                key={s.label + i}
                type="button"
                disabled={busy || !reachable}
                aria-current={i === step ? "step" : undefined}
                onClick={() => go(i)}
                className={cn(
                  "flex h-6.5 shrink-0 items-center gap-1.5 rounded-md border px-2 text-meta outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
                  i === step ? "border-foreground/25 bg-accent font-medium text-foreground" : "border-transparent text-muted-foreground enabled:hover:bg-accent/60 enabled:hover:text-foreground",
                )}
              >
                {s.ok ? <CheckIcon className="size-3 text-success" /> : i < qs.length ? <span className="font-mono text-tag tabular-nums opacity-70">{i + 1}</span> : <ListChecksIcon className="size-3 opacity-70" />}
                <span className="max-w-32 truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>
      )}
      <div ref={body} className="border-t bg-muted/20 px-4 py-4">
        {review ? (
          <Review questions={qs} answers={answers} onEdit={go} disabled={busy} />
        ) : (
          <Step key={step} q={q} d={drafts[step]} disabled={busy} onChange={(f) => set(step, f)} onEnter={next} />
        )}
      </div>
      {failed && (
        <div className="border-t px-4 py-3">
          <Alert variant="error" data-testid="question-form-failed">
            <TriangleAlertIcon />
            <AlertTitle>Your answers didn't reach {who}</AlertTitle>
            <AlertDescription>
              <ErrorText text={failed} />
              <span className="text-foreground">They're kept here: try again, or copy them and finish in {who}'s screen below.</span>
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void submit()}>
                <RotateCwIcon />
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyText(answersText(qs, answers), "Answers copied")}>
                <CopyIcon />
                Copy answers
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}
      {/* At a phone's width Back, the status (min-w-32) and Submit answers don't fit on one line: the button goes under, on the right. */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {steps > 1 && (
          <Button size="sm" variant="ghost" disabled={busy || step === 0} onClick={() => go(step - 1)}>
            <ArrowLeftIcon />
            Back
          </Button>
        )}
        <span className="min-w-32 flex-1 truncate text-meta text-muted-foreground">{busy ? `Answering in ${who}'s form…` : failed ? "Not sent yet" : review ? "Check your answers, then submit" : `${who} waits for your answer`}</span>
        <Button size="sm" className="ml-auto" disabled={busy || (review ? !done.every(Boolean) : !done[step])} onClick={next}>
          {busy ? <Spinner className="size-3.5" /> : last ? <SendHorizontalIcon /> : null}
          {last ? (reviewed ? "Submit answers" : "Submit") : step === qs.length - 1 ? "Review" : "Next"}
          {!last && <ArrowRightIcon />}
        </Button>
      </div>
    </Card>
  );
}

const OTHER = "\u0000other";

function Step({ q, d, disabled, onChange, onEnter }: { q: Question; d: Draft; disabled: boolean; onChange(f: (d: Draft) => Draft): void; onEnter(): void }) {
  const row = "flex cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:bg-accent/40 has-data-checked:border-primary/45 has-data-checked:bg-primary/[0.04] has-disabled:cursor-default dark:bg-input/16";
  const otherField = (
    <Input
      size="sm"
      value={d.other}
      disabled={disabled}
      placeholder="Something else…"
      aria-label="Your own answer"
      onChange={(e) => {
        const v = e.currentTarget.value.replace(/\n/g, " ");
        onChange((x) => ({ ...x, other: v, otherOn: v.trim() !== "" || x.otherOn, picks: q.multi || !v.trim() ? x.picks : [] }));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
  return (
    // min-w-0: a fieldset is as wide as its widest word, a long address,
    // unless told otherwise, and the card would cut it off.
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
      <legend className="contents">
        <span data-selectable className="wrap-anywhere block text-heading">
          <LinkedText text={q.question} />
        </span>
      </legend>
      <span className="-mt-1.5 text-muted-foreground text-meta">{q.multi ? "Pick any that apply" : "Pick one"}</span>
      {q.multi ? (
        <div className="flex flex-col gap-1.5">
          {q.options.map((o) => (
            <label key={o.label} className={row}>
              <Checkbox
                className="mt-0.5"
                checked={d.picks.includes(o.label)}
                onCheckedChange={(on) => onChange((x) => ({ ...x, picks: on ? [...x.picks, o.label] : x.picks.filter((p) => p !== o.label) }))}
              />
              <OptionText label={o.label} description={o.description} />
            </label>
          ))}
          <label className={cn(row, "items-center py-2")}>
            <Checkbox checked={d.otherOn} onCheckedChange={(on) => onChange((x) => ({ ...x, otherOn: !!on }))} aria-label="Something else" />
            {otherField}
          </label>
        </div>
      ) : (
        <RadioGroup
          className="gap-1.5"
          value={d.otherOn ? OTHER : (d.picks[0] ?? "")}
          onValueChange={(v) => onChange((x) => (v === OTHER ? { ...x, picks: [], otherOn: true } : { ...x, picks: [String(v)], otherOn: false }))}
        >
          {q.options.map((o) => (
            <label key={o.label} className={row}>
              <Radio className="mt-0.5" value={o.label} />
              <OptionText label={o.label} description={o.description} />
            </label>
          ))}
          <label className={cn(row, "items-center py-2")}>
            <Radio value={OTHER} aria-label="Something else" />
            {otherField}
          </label>
        </RadioGroup>
      )}
    </fieldset>
  );
}

function OptionText({ label, description }: { label: string; description?: string }) {
  return (
    <span className="wrap-anywhere flex min-w-0 flex-col gap-0.5">
      <span className="text-row">
        <LinkedText text={label} />
      </span>
      {description && (
        <span className="text-desc text-muted-foreground">
          <LinkedText text={description} />
        </span>
      )}
    </span>
  );
}

function Review({ questions, answers, onEdit, disabled }: { questions: Question[]; answers: QuestionAnswer[]; onEdit(step: number): void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-heading">Review your answers</span>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border bg-background dark:bg-input/16">
        {questions.map((q, i) => (
          <li key={q.question}>
            <button type="button" disabled={disabled} onClick={() => onEdit(i)} className="group flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors focus-visible:bg-accent/60 enabled:hover:bg-accent/40">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* Whole, so an address in it shows; not a link, inside the row's button. */}
                <span className="wrap-anywhere text-muted-foreground text-meta">{q.question}</span>
                <span className="wrap-anywhere text-row">{shownAnswer(q, answers[i]) || "—"}</span>
              </span>
              <PencilIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-label="Change" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
