import type { SecretExpiry, SecretMeta, SecretRequest, Session } from "@/lib/api";
import { ago } from "./format.ts";

// A secret an agent asked the person for (berthd secret request), as its
// card draws it: in the chat, on the board's card, wherever a question
// shows. Pure, so the card and its tests share it.
//
// The value itself is never here. It lives only in the card's password
// field (components/conversation/secret-request-card.tsx), is read from it
// once on Save and goes to the box in that one request (boxApi.saveSecret);
// the field is then cleared and goes. Nothing below takes, keeps or returns
// it: not this state, a store, the transcript, an event, a log or the
// offline prompt queue. A failed save leaves it in the field, with no retry
// queued.

// The line every card says, because it is true: a secret the agent can use
// is one a careless command can print.
export const HONEST_LINE = "The agent can use this in commands. A command that prints it puts it in the chat.";

// The ask a session shows while it waits on a request (Session.ask.tool):
// its card answers it, never Allow or Deny.
export const SECRET_TOOL = "SecretRequest";

export const EXPIRY_OPTIONS: { value: SecretExpiry; label: string }[] = [
  { value: "", label: "No expiry" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

// secretRequestOf is the request a session waits on, while one is pending.
export function secretRequestOf(s: Session | undefined): SecretRequest | undefined {
  const r = (s as (Session & { secret_request?: SecretRequest }) | undefined)?.secret_request;
  return r && r.status === "pending" && !s?.exited ? r : undefined;
}

// pendingSecrets are a box's sessions' pending requests, oldest first.
export function pendingSecrets(sessions: Session[] | undefined): SecretRequest[] {
  return (sessions ?? [])
    .map(secretRequestOf)
    .filter((r): r is SecretRequest => !!r)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export const isProduction = (r: { environment?: string }): boolean => r.environment === "production";

// environmentLabel is an environment as the card and Settings write it.
export const environmentLabel = (r: { environment?: string }): string => (isProduction(r) ? "Production" : r.environment === "staging" ? "Staging" : (r.environment ?? ""));

// expiryOptions are the card's choices, or none: production is always no
// expiry, so it has no picker.
export const expiryOptions = (r: SecretRequest): typeof EXPIRY_OPTIONS | undefined => (isProduction(r) ? undefined : EXPIRY_OPTIONS);

// initialExpiry is the choice the card starts on: what the agent suggests
// when it is one of the choices, else no expiry.
export function initialExpiry(r: SecretRequest): SecretExpiry {
  if (isProduction(r)) return "";
  return EXPIRY_OPTIONS.some((o) => o.value === r.ttl) ? (r.ttl as SecretExpiry) : "";
}

// sentExpiry is what goes to the box: production ignores any choice.
export const sentExpiry = (r: SecretRequest, chosen: SecretExpiry): SecretExpiry => (isProduction(r) ? "" : chosen);

// storeLine says where the value goes: "GCP Secret Manager · acme-staging".
export const storeLine = (r: { store_label: string; store: string; where?: string }): string => [r.store_label || r.store, r.where].filter(Boolean).join(" · ");

export const grantLine = (r: SecretRequest): string | undefined => (r.grant ? `Grants ${r.grant} read access to this one secret` : undefined);

export const cardTitle = (r: SecretRequest): string => (r.replace ? `Replace ${r.name}` : r.name);

// replacedLine says when the secret it replaces was saved, when it says.
export function replacedLine(r: SecretRequest): string | undefined {
  if (!r.replace) return undefined;
  return r.replaced_at ? `Replaces the one saved ${ago(r.replaced_at)}` : "Replaces the one saved before";
}

// askLine is the request in the few words a notification or a card's
// summary has: "ACME_TOKEN — to call the staging API".
export const askLine = (r: { name: string; reason?: string }): string => (r.reason ? `${r.name} — ${r.reason}` : r.name);

// ---- The card's state ----------------------------------------------------
//
// idle → saving → saved, or → error (the value stays in the field) → saving
// again; idle → declining → declined, or → error. Saved and declined are
// the end: the box drops the request and the card goes with it.

export type CardState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "declining" }
  | { phase: "error"; during: "save" | "decline"; message: string }
  | { phase: "saved"; ref: string }
  | { phase: "declined" };

export type CardEvent = { type: "save" } | { type: "decline" } | { type: "saved"; ref: string } | { type: "declined" } | { type: "failed"; message: string };

export const IDLE: CardState = { phase: "idle" };

export function cardReducer(s: CardState, e: CardEvent): CardState {
  if (s.phase === "saved" || s.phase === "declined") return s;
  switch (e.type) {
    case "save":
      return busy(s) ? s : { phase: "saving" };
    case "decline":
      return busy(s) ? s : { phase: "declining" };
    case "saved":
      return s.phase === "saving" ? { phase: "saved", ref: e.ref } : s;
    case "declined":
      return s.phase === "declining" ? { phase: "declined" } : s;
    case "failed":
      return s.phase === "saving" || s.phase === "declining" ? { phase: "error", during: s.phase === "saving" ? "save" : "decline", message: e.message } : s;
  }
}

export const busy = (s: CardState): boolean => s.phase === "saving" || s.phase === "declining";
export const done = (s: CardState): boolean => s.phase === "saved" || s.phase === "declined";

// canSave says Save may be pressed: something typed (its length only, as
// the card knows no more), nothing in flight, not over.
export const canSave = (s: CardState, typed: number): boolean => typed > 0 && !busy(s) && !done(s);
export const canDecline = (s: CardState): boolean => !busy(s) && !done(s);

// errorLine is a failed save in words, saying where the value is: still in
// the field, and nowhere else.
export function errorLine(s: CardState, box: string): string | undefined {
  if (s.phase !== "error") return undefined;
  const why = (s.message || `${box} didn't answer`).replace(/\.\s*$/, "");
  return s.during === "save" ? `Couldn't save it: ${why}. The value is still in the field, and nowhere else.` : `Couldn't decline it: ${why}.`;
}

// ---- Settings › Secrets ----------------------------------------------------

// needsTypedName says deleting a saved secret asks for its name typed:
// production secrets do.
export const needsTypedName = (s: SecretMeta): boolean => isProduction(s);

// deleteConfirm is what to send as confirm, or undefined when Delete
// should stay disabled. A staging secret needs none ("").
export function deleteConfirm(s: SecretMeta, typed: string): string | undefined {
  if (!needsTypedName(s)) return "";
  return typed.trim() === s.name ? s.name : undefined;
}

// expiresLine says when a saved secret goes: "never", or in words.
export function expiresLine(expires: string | undefined, now = Date.now()): string {
  if (!expires) return "Never";
  const ms = Date.parse(expires) - now;
  if (!Number.isFinite(ms)) return expires;
  if (ms <= 0) return "Expired";
  const h = ms / 3_600_000;
  if (h < 1) return `In ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `In ${Math.round(h)}h`;
  return `In ${Math.round(h / 24)}d`;
}
