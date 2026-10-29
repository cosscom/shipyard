import { CheckIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LockIcon, XIcon } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { PickOne } from "@/components/pick-one";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { boxApi, type SecretExpiry, type SecretRequest } from "@/lib/api";
import { sessionName } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import {
  canDecline,
  canSave,
  cardReducer,
  cardTitle,
  errorLine,
  expiryOptions,
  grantLine,
  HONEST_LINE,
  IDLE,
  initialExpiry,
  isProduction,
  replacedLine,
  sentExpiry,
} from "@/lib/secret-request";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// SecretRequestCard is an agent asking the person for a secret (berthd
// secret request NAME --reason …): what, why, for whom and where it goes,
// a masked field for the value, and Save securely or Decline. It shows
// wherever the agent's question would: its chat, its card on the board.
//
// The value is the field's alone. The field is uncontrolled, so the value
// is in no React state, prop or attribute: Save reads it once, sends it to
// the box in one request (boxApi.saveSecret) and clears the field, which
// goes with the card. A failed save leaves it in the field, to try again or
// leave; nothing queues it. See lib/secret-request.ts.
//
// compact draws it inside the board's card: no outline of its own there.
export function SecretRequestCard({ box, request, compact }: { box: string; request: SecretRequest; compact?: boolean }) {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.boxes[box]?.sessions);
  const asker = sessions?.find((s) => s.name === request.session);
  const who = asker ? sessionName(asker, { sessions, agent: true }) : request.session;
  const [state, dispatch] = useReducer(cardReducer, IDLE);
  const field = useRef<HTMLInputElement>(null);
  // How much is typed, for Save: its length, never the value.
  const [typed, setTyped] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [expiry, setExpiry] = useState<SecretExpiry>(() => initialExpiry(request));
  const prod = isProduction(request);
  const options = expiryOptions(request);
  const grant = grantLine(request);
  const replaced = replacedLine(request);
  const warn = prod && "text-warning-foreground";
  const inFlight = state.phase === "saving" || state.phase === "declining";
  // A refusal shows above the buttons: both brought into view, as the
  // chat doesn't move for it.
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.phase === "error") said.current?.scrollIntoView({ block: "nearest" });
  }, [state]);

  const save = async () => {
    const el = field.current;
    if (!client || !el || !canSave(state, el.value.length)) return;
    dispatch({ type: "save" });
    try {
      const { ref } = await boxApi.saveSecret(client, box, request.id, el.value, sentExpiry(request, expiry));
      el.value = "";
      setTyped(0);
      setRevealed(false);
      dispatch({ type: "saved", ref });
    } catch (err) {
      dispatch({ type: "failed", message: plainError(err, { box }) });
    }
  };
  const decline = async () => {
    if (!client || !canDecline(state)) return;
    dispatch({ type: "decline" });
    try {
      await boxApi.declineSecret(client, box, request.id);
      if (field.current) field.current.value = "";
      setTyped(0);
      dispatch({ type: "declined" });
    } catch (err) {
      dispatch({ type: "failed", message: plainError(err, { box }) });
    }
  };

  // Over: the box drops the request, and this line goes with it a moment
  // later. Never the field again.
  if (state.phase === "saved" || state.phase === "declined") {
    const saved = state.phase === "saved";
    return (
      <div data-testid="secret-card" data-state={state.phase} className={cn("cv-in flex min-w-0 items-center gap-2 text-muted-foreground", compact ? "mt-2 text-meta" : "text-desc")}>
        {saved ? <CheckIcon className="size-3.5 shrink-0 text-success" /> : <XIcon className="size-3.5 shrink-0" />}
        <span className="shrink-0">{saved ? "Saved" : "Declined"}</span>
        <span className="truncate font-mono text-foreground/80 text-mono">{request.name}</span>
        {saved && <span className="min-w-0 truncate">· {who} gets {state.ref}</span>}
      </div>
    );
  }

  const error = errorLine(state, box);
  const body = (
    <>
      <div className={cn("flex flex-col", compact ? "gap-2" : "gap-3 p-4")}>
        <div className="flex min-w-0 items-start gap-2">
          <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className={cn("font-medium", compact ? "text-desc" : "text-body")}>
              <span className="sr-only">Secret request: </span>
              <span data-testid="secret-name" className="break-all font-mono">
                {cardTitle(request)}
              </span>
            </div>
            {/* On the board, the card around it names who asks. */}
            {(!compact || replaced) && (
              <div className="text-muted-foreground text-meta">
                {!compact && (
                  <>
                    Asked by <span data-testid="secret-session">{who}</span>
                  </>
                )}
                {replaced && (
                  <span data-testid="secret-replaced">
                    {compact ? "" : " · "}
                    {replaced}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {/* The agent's words as it wrote them. */}
        <p data-testid="secret-reason" data-selectable className={cn("whitespace-pre-wrap break-words", compact ? "text-meta" : "text-body")}>
          {request.reason}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta">
          <dt className="text-muted-foreground">Saved in</dt>
          <dd data-testid="secret-store" className="min-w-0 break-words">
            {request.store_label || request.store}
            {request.where && (
              <>
                {" · "}
                <span data-testid="secret-where" className={cn(warn)}>
                  {request.where}
                </span>
              </>
            )}
          </dd>
          {request.environment && (
            <>
              <dt className="text-muted-foreground">Environment</dt>
              <dd data-testid="secret-environment" className={cn("min-w-0", warn, prod && "font-medium")}>
                {prod ? "Production" : request.environment === "staging" ? "Staging" : request.environment}
              </dd>
            </>
          )}
          {grant && (
            <>
              <dt className="text-muted-foreground">Access</dt>
              <dd data-testid="secret-grant" className={cn("min-w-0 break-words", warn)}>
                {grant}
              </dd>
            </>
          )}
        </dl>
        <div className="flex min-w-0 items-center gap-1">
          <Input
            nativeInput
            ref={field}
            type={revealed ? "text" : "password"}
            size="sm"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-testid="secret-input"
            aria-label={`Value for ${request.name}`}
            aria-describedby={error ? `secret-error-${request.id}` : undefined}
            placeholder="Paste the value"
            disabled={inFlight}
            onInput={(e) => setTyped(e.currentTarget.value.length)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              }
            }}
            className="min-w-0 flex-1 font-mono text-mono [&_input::placeholder]:font-sans"
          />
          <Tip label={revealed ? "Hide the value" : "Show the value"}>
            <Button size="icon-sm" variant="ghost" data-testid="secret-reveal" aria-label={revealed ? "Hide the value" : "Show the value"} aria-pressed={revealed} onClick={() => setRevealed((r) => !r)}>
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </Tip>
        </div>
        {options ? (
          <div data-testid="secret-expiry" className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-meta">Expires</span>
            {/* The board's card is narrow: the same four, in short. */}
            <PickOne<SecretExpiry> label={`When ${request.name} expires`} value={expiry} options={compact ? options.map((o) => ({ value: o.value, label: o.value || "Never" })) : options} onChange={setExpiry} />
          </div>
        ) : (
          <p className="text-muted-foreground text-meta">Production secrets never expire. Delete it in Settings › Secrets.</p>
        )}
        <p className="text-muted-foreground text-meta">{HONEST_LINE}</p>
        {error && (
          <p id={`secret-error-${request.id}`} role="alert" data-testid="secret-error" className="text-destructive-foreground text-desc">
            {error}
          </p>
        )}
      </div>
      <div ref={said} className={cn("flex flex-wrap items-center gap-2", compact ? "mt-2" : "border-t px-4 py-3")}>
        <Button size={compact ? "xs" : "sm"} data-testid="secret-save" loading={state.phase === "saving"} disabled={!canSave(state, typed)} onClick={() => void save()}>
          <LockIcon />
          Save securely
        </Button>
        <Button size={compact ? "xs" : "sm"} variant="outline" data-testid="secret-decline" loading={state.phase === "declining"} disabled={!canDecline(state)} onClick={() => void decline()}>
          Decline
        </Button>
        {!compact && <span className="ml-auto text-muted-foreground text-meta">The agent waits for you</span>}
      </div>
    </>
  );

  if (compact) {
    // Inside the board's card, whose click opens the agent: here, clicks
    // and keys are the request's.
    return (
      <div data-testid="secret-card" data-secret-id={request.id} data-environment={request.environment} className="mt-2 cursor-auto rounded-md bg-muted/50 px-2.5 py-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {body}
      </div>
    );
  }
  return (
    <Card data-testid="secret-card" data-secret-id={request.id} data-environment={request.environment} className="cv-in w-full border-warning/60">
      {body}
    </Card>
  );
}
