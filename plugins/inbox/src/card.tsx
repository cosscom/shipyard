import type { BerthPluginContext } from "@berth/plugin";
import { Alert, AlertDescription, Badge, Button, Kbd, Skeleton, Textarea, cn } from "@berth/plugin/ui";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Markdown } from "./markdown.tsx";
import { ago, closeKind, answerFor, type Choice, complete, didntLand, type GateLike, GROUPS, isRecommended, type Item, oneLine, type Pick, type Question, shownLabel, snoozeTimes } from "./model.ts";
import { answerForm, decideGate, type Detail, errText, getState, loadDetail, openSession, closeSession, pressKey, reply, resume, snooze, subscribe } from "./store.ts";

// A key is the Inbox's only when you're not typing and no dialog or menu has the
// keyboard, so Wispr Flow and friends can type into the note. Same rule as the
// app's own lib/view-keys.ts, until the SDK exports it.
export function viewKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  return !(t?.closest?.("input, textarea, select, [contenteditable=true], .xterm, [data-terminal]") || document.querySelector("[data-slot=dialog-popup], [data-slot=alert-dialog-popup], [data-slot=sheet-popup], [data-slot=menu-popup], [role=menu]"));
}

// What you wrote stays while you walk around, until the card is answered.
const drafts = new Map<string, { picks: Record<number, string[]>; note: string }>();
const draftOf = (key: string) => drafts.get(key) ?? { picks: {}, note: "" };

const Key = ({ k }: { k: string }) => <Kbd className="ml-1">{k}</Kbd>;

interface CardProps {
  berth: BerthPluginContext;
  item: Item;
  peekOpen: boolean;
  onPeek(): void;
}

export function Card({ berth, item, peekOpen, onPeek }: CardProps) {
  const state = useSyncExternalStore(subscribe, getState);
  const detail: Detail | undefined = state.details[item.key];
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [draft, setDraftState] = useState(() => draftOf(item.key));
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Keys can come faster than a render, so each reads the draft as it is now.
  const latest = useRef(draft);
  latest.current = draft;

  const setDraft = useCallback(
    (d: { picks: Record<number, string[]>; note: string }) => {
      latest.current = d;
      drafts.set(item.key, d);
      setDraftState(d);
    },
    [item.key],
  );

  useEffect(() => {
    setDraftState(draftOf(item.key));
    setError(undefined);
    setSnoozing(false);
    void loadDetail(item);
  }, [item.key]);

  const run = useCallback(async (act: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await act();
      drafts.delete(item.key);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }, [item.key]);

  const form = detail?.form;
  const questions: Question[] = form?.questions ?? [];
  const last = questions.length - 1;
  const picksOf = (i: number): Pick => ({ picks: draft.picks[i] ?? [], note: i === last ? draft.note : "" });
  const formReady = questions.length > 0 && questions.every((_, i) => complete(picksOf(i)));
  // The first question still open takes the number keys.
  const firstOpen = (picks: Record<number, string[]>) => Math.max(0, questions.findIndex((_, i) => !picks[i]?.length));
  const focusQ = firstOpen(draft.picks);

  const toggle = useCallback(
    (i: number, label: string) => {
      const q = questions[i];
      const now = latest.current;
      const was = now.picks[i] ?? [];
      const next = q.multi ? (was.includes(label) ? was.filter((l) => l !== label) : [...was, label]) : was[0] === label ? [] : [label];
      setDraft({ ...now, picks: { ...now.picks, [i]: next } });
    },
    [questions, setDraft],
  );

  const submitForm = useCallback(() => {
    if (!form || !formReady || busy) return;
    void run(() => answerForm(item, form.tool, questions.map((q, i) => answerFor(q, picksOf(i)))));
  }, [form, formReady, busy, item, questions, draft]);

  const choices: Choice[] = (item.kind === "wait" && !form && detail?.choices) || [];
  const onItsScreen = item.kind === "wait" && detail?.screen !== undefined;
  const canReply = !form && !choices.length && !onItsScreen && !!item.session && (item.kind === "wait" || item.kind === "marked");
  const noteText = oneLine(draft.note);

  const send = useCallback(() => {
    if (form) return submitForm();
    if (canReply && noteText && !busy) void run(() => reply(item, noteText));
  }, [form, submitForm, canReply, noteText, busy, item]);

  const closing = closeKind(item.kind);
  const doClose = useCallback(() => {
    if (!closing) return;
    drafts.delete(item.key);
    closeSession(item, draft.note);
  }, [item, closing, draft.note]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (e.target as HTMLElement | null)?.tagName === "TEXTAREA") return (e.target as HTMLElement).blur();
      if (!viewKey(e)) return;
      if (snoozing) {
        const t = snoozeTimes(Date.now())[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          snooze(item, t.until);
        } else if (e.key === "Escape") setSnoozing(false);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        if (form) {
          const at = firstOpen(latest.current.picks);
          const o = questions[at]?.options[n];
          if (o) {
            e.preventDefault();
            toggle(at, o.label);
          }
        } else if (choices[n] && !busy) {
          e.preventDefault();
          void run(() => pressKey(item, choices[n].key));
        }
        return;
      }
      if (e.key === "Enter" && !(e.target as HTMLElement | null)?.closest?.("button, a")) {
        e.preventDefault();
        return send();
      }
      if (e.key === "h") {
        e.preventDefault();
        setSnoozing(true);
      } else if (e.key === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (e.key === "x") {
        e.preventDefault();
        doClose();
      } else if (e.key === "o") {
        e.preventDefault();
        openSession(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snoozing, item, form, questions, focusQ, toggle, choices, busy, send, doClose]);

  const groupTitle = useMemo(() => GROUPS.find((g) => g.id === item.group)?.title, [item.group]);
  const where = [item.location, item.box].filter(Boolean).join(" · ");
  const waited = ago(item.since, state.now);
  const gate = item.kind === "gate" ? (item.source as GateLike).gate : undefined;
  const loading = detail?.loading && !form;

  return (
    <div className="mx-auto flex w-full flex-col gap-4 p-4" style={{ maxWidth: 680 }} data-testid="inbox-card">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{groupTitle}</span>
          {where && <span>· {where}</span>}
          {waited && <span>· waited {waited}</span>}
        </div>
        <h2 className="text-base font-medium" data-testid="inbox-card-title">
          {item.title}
        </h2>
        {(detail?.ended ?? item.why) && (
          <p className="text-sm text-muted-foreground" data-testid="inbox-why">
            {detail?.ended ?? item.why}
          </p>
        )}
      </div>

      {didntLand(item, state.marks, state.now) && (
        <Alert variant="warning" data-testid="inbox-didnt-land">
          <AlertDescription>You answered this a while ago and it's still waiting. Peek at the session to see what happened.</AlertDescription>
        </Alert>
      )}

      {loading && <Skeleton className="h-24 w-full" />}
      {detail?.error && (
        <Alert variant="error">
          <AlertDescription>Couldn't read this session: {detail.error}</AlertDescription>
        </Alert>
      )}

      {detail?.message && !form && (
        <div className="max-h-72 overflow-auto rounded-md border p-3 text-sm" data-testid="inbox-last-message">
          <Markdown text={detail.message} openUrl={(u) => berth.openUrl(u)} />
        </div>
      )}

      {onItsScreen && (
        <div className="flex flex-col gap-2" data-testid="inbox-on-its-screen">
          <p className="text-sm">It's waiting on a screen of its own, which only keys in the session can answer.</p>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{detail?.screen}</pre>
          <div>
            <Button onClick={() => openSession(item)}>Open session</Button>
          </div>
        </div>
      )}

      {questions.map((q, i) => (
        <fieldset key={i} className="flex flex-col gap-2" data-testid="inbox-question">
          <legend className="pb-2 text-sm font-medium">{q.question}</legend>
          {q.options.map((o, n) => {
            const on = (draft.picks[i] ?? []).includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                aria-pressed={on}
                data-testid="inbox-option"
                onClick={() => toggle(i, o.label)}
                className={cn("flex w-full items-start gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent", on && "border-primary bg-accent")}
              >
                {i === focusQ && <Kbd>{n + 1}</Kbd>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{shownLabel(o)}</span>
                    {isRecommended(o) && (
                      <Badge variant="secondary" data-testid="inbox-recommended">
                        Recommended
                      </Badge>
                    )}
                  </span>
                  {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
                </span>
              </button>
            );
          })}
        </fieldset>
      ))}

      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="inbox-choices">
          {choices.map((c, n) => (
            <Button key={c.key} variant={n === 0 ? "default" : "outline"} disabled={busy} onClick={() => void run(() => pressKey(item, c.key))}>
              {c.label}
              <Key k={String(n + 1)} />
            </Button>
          ))}
        </div>
      )}

      {gate && (
        <div className="flex flex-wrap gap-2" data-testid="inbox-gate">
          <Button disabled={busy} onClick={() => void run(() => decideGate(item, true, noteText))}>
            {gate.approve_label ?? "Approve"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(() => decideGate(item, false, noteText))}>
            {gate.reject_label ?? "Reject"}
          </Button>
        </div>
      )}

      {(item.kind === "gone" || item.kind === "exited") && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} data-testid="inbox-resume" onClick={() => void run(() => resume(item))}>
            Resume
          </Button>
        </div>
      )}

      {item.kind === "secret" && (
        <p className="text-sm text-muted-foreground">
          Open the session to fill in the masked card. The value goes to the box's secret store, never through this Inbox.
        </p>
      )}

      {item.kind !== "gone" && item.kind !== "exited" && item.kind !== "secret" && !onItsScreen && (
        <Textarea
          ref={noteRef}
          rows={2}
          value={draft.note}
          data-testid="inbox-note"
          aria-label={form ? "Add a note" : "Reply"}
          placeholder={form ? "Add a note (n)" : canReply ? "Reply to the agent (n)" : "Add a note (n)"}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, note: e.currentTarget.value })}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
      )}

      {error && (
        <Alert variant="error" data-testid="inbox-error">
          <AlertDescription>
            That didn't go through, and your answer is still here. {error}
          </AlertDescription>
        </Alert>
      )}

      {snoozing ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="inbox-snooze">
          {snoozeTimes(Date.now()).map((t, n) => (
            <Button key={t.id} size="sm" variant="outline" onClick={() => snooze(item, t.until)}>
              {t.label}
              <Key k={String(n + 1)} />
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setSnoozing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {(form || canReply) && (
            <Button disabled={busy || (form ? !formReady : !noteText)} data-testid="inbox-send" onClick={send}>
              {form ? "Send answer" : "Send reply"}
              <Key k={form ? "↵" : "⌘↵"} />
            </Button>
          )}
          {closing && (
            <Button variant="ghost" size="sm" data-testid="inbox-close" onClick={doClose}>
              {closing === "close" ? "Close session" : "Dismiss"}
              <Key k="x" />
            </Button>
          )}
          <Button variant="ghost" size="sm" data-testid="inbox-snooze-open" onClick={() => setSnoozing(true)}>
            Snooze
            <Key k="h" />
          </Button>
          {item.session && (
            <>
              <Button variant="ghost" size="sm" aria-pressed={peekOpen} data-testid="inbox-peek-toggle" onClick={onPeek}>
                {peekOpen ? "Hide session" : "Peek"}
                <Key k="p" />
              </Button>
              <Button variant="ghost" size="sm" data-testid="inbox-open" onClick={() => openSession(item)}>
                Open session
                <Key k="o" />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
