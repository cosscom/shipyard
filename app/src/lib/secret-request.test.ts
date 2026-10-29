// node --experimental-strip-types --test src/lib/secret-request.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SecretMeta, SecretRequest, Session } from "./api.ts";
import {
  askLine,
  canDecline,
  canSave,
  cardReducer,
  type CardState,
  cardTitle,
  deleteConfirm,
  errorLine,
  EXPIRY_OPTIONS,
  expiresLine,
  expiryOptions,
  grantLine,
  HONEST_LINE,
  IDLE,
  initialExpiry,
  pendingSecrets,
  replacedLine,
  secretRequestOf,
  sentExpiry,
  storeLine,
} from "./secret-request.ts";

const staging: SecretRequest = {
  id: "sr-1",
  name: "ACME_TOKEN",
  reason: "To call the acme staging API from the integration tests",
  session: "shop-claude",
  location: "shop",
  store: "local",
  store_label: "Encrypted file",
  environment: "staging",
  ttl: "24h",
  created: "2026-10-29T10:00:00Z",
  expires: "2026-10-29T11:00:00Z",
  status: "pending",
};

const production: SecretRequest = {
  id: "sr-2",
  name: "ACME_PROD_DB",
  reason: "Run the billing migration against production",
  session: "billing-claude",
  store: "gcp",
  store_label: "GCP Secret Manager",
  where: "acme-prod",
  environment: "production",
  grant: "billing@acme-prod.iam.gserviceaccount.com",
  ttl: "1h",
  created: "2026-10-29T09:00:00Z",
  expires: "2026-10-29T10:00:00Z",
  status: "pending",
};

const session = (over: Partial<Session> & { secret_request?: SecretRequest } = {}): Session => ({ name: "shop-claude", dir: "/home/me/shop", created: "2026-10-29T09:00:00Z", attached: 0, exited: false, agent: "claude", ...over }) as Session;

test("a session's pending request is found, and nothing else is", () => {
  assert.equal(secretRequestOf(session({ secret_request: staging })), staging);
  assert.equal(secretRequestOf(session()), undefined);
  assert.equal(secretRequestOf(undefined), undefined);
  // An ended session has nobody left to give it to.
  assert.equal(secretRequestOf(session({ secret_request: staging, exited: true })), undefined);
  assert.equal(secretRequestOf(session({ secret_request: { ...staging, status: "saved" as "pending" } })), undefined);
});

test("a box's pending requests are its sessions', oldest first", () => {
  const list = pendingSecrets([session({ name: "a", secret_request: staging }), session({ name: "b" }), session({ name: "c", secret_request: production })]);
  assert.deepEqual(
    list.map((r) => r.id),
    ["sr-2", "sr-1"],
  );
  assert.deepEqual(pendingSecrets(undefined), []);
});

test("the expiry picker offers four choices, preselecting the agent's suggestion", () => {
  assert.deepEqual(
    EXPIRY_OPTIONS.map((o) => [o.value, o.label]),
    [
      ["", "No expiry"],
      ["1h", "1 hour"],
      ["24h", "24 hours"],
      ["7d", "7 days"],
    ],
  );
  assert.equal(initialExpiry(staging), "24h");
  assert.equal(initialExpiry({ ...staging, ttl: undefined }), "");
  // Something the picker doesn't offer starts on no expiry.
  assert.equal(initialExpiry({ ...staging, ttl: "30d" as "7d" }), "");
});

test("production has no expiry picker and is always sent without one", () => {
  assert.equal(expiryOptions(production), undefined);
  assert.equal(expiryOptions(staging), EXPIRY_OPTIONS);
  assert.equal(initialExpiry(production), "");
  assert.equal(sentExpiry(production, "7d"), "");
  assert.equal(sentExpiry(staging, "7d"), "7d");
});

test("the card says the store, the grant, replace and the honest line in words", () => {
  assert.equal(storeLine(staging), "Encrypted file");
  assert.equal(storeLine(production), "GCP Secret Manager · acme-prod");
  assert.equal(grantLine(production), "Grants billing@acme-prod.iam.gserviceaccount.com read access to this one secret");
  assert.equal(grantLine(staging), undefined);
  assert.equal(cardTitle(staging), "ACME_TOKEN");
  assert.equal(cardTitle({ ...staging, replace: true }), "Replace ACME_TOKEN");
  assert.equal(replacedLine(staging), undefined);
  assert.match(replacedLine({ ...staging, replace: true, replaced_at: new Date(Date.now() - 3 * 86_400_000).toISOString() })!, /^Replaces the one saved 3d ago$/);
  assert.equal(HONEST_LINE, "The agent can use this in commands. A command that prints it puts it in the chat.");
  assert.equal(askLine(staging), "ACME_TOKEN — To call the acme staging API from the integration tests");
});

test("saving: idle, saving, saved; nothing is pressed twice", () => {
  let s: CardState = IDLE;
  assert.equal(canSave(s, 0), false, "nothing typed");
  assert.equal(canSave(s, 12), true);
  s = cardReducer(s, { type: "save" });
  assert.deepEqual(s, { phase: "saving" });
  assert.equal(canSave(s, 12), false, "in flight");
  assert.equal(canDecline(s), false);
  assert.equal(cardReducer(s, { type: "save" }), s);
  assert.equal(cardReducer(s, { type: "decline" }), s);
  s = cardReducer(s, { type: "saved", ref: "box://ACME_TOKEN" });
  assert.deepEqual(s, { phase: "saved", ref: "box://ACME_TOKEN" });
  // Over: nothing moves it again.
  assert.equal(cardReducer(s, { type: "save" }), s);
  assert.equal(cardReducer(s, { type: "failed", message: "late" }), s);
  assert.equal(canSave(s, 12), false);
});

test("a failed save says why and that the value is only in the field, and can be tried again", () => {
  let s = cardReducer(cardReducer(IDLE, { type: "save" }), { type: "failed", message: "missing permission secretmanager.secrets.create on project acme-staging." });
  assert.deepEqual(s, { phase: "error", during: "save", message: "missing permission secretmanager.secrets.create on project acme-staging." });
  assert.equal(errorLine(s, "devl"), "Couldn't save it: missing permission secretmanager.secrets.create on project acme-staging. The value is still in the field, and nowhere else.");
  assert.equal(canSave(s, 12), true);
  // The box away: its words, or ours.
  assert.match(errorLine({ phase: "error", during: "save", message: "" }, "devl")!, /^Couldn't save it: devl didn't answer\./);
  s = cardReducer(s, { type: "save" });
  assert.deepEqual(s, { phase: "saving" });
  assert.equal(errorLine(s, "devl"), undefined);
});

test("declining: idle, declining, declined; a failed decline can be tried again", () => {
  let s = cardReducer(IDLE, { type: "decline" });
  assert.deepEqual(s, { phase: "declining" });
  assert.equal(cardReducer(s, { type: "saved", ref: "x" }), s, "a save's answer doesn't end a decline");
  const failed = cardReducer(s, { type: "failed", message: "gone" });
  assert.deepEqual(failed, { phase: "error", during: "decline", message: "gone" });
  assert.equal(errorLine(failed, "devl"), "Couldn't decline it: gone.");
  assert.equal(canDecline(failed), true);
  s = cardReducer(s, { type: "declined" });
  assert.deepEqual(s, { phase: "declined" });
  assert.equal(canDecline(s), false);
});

test("the state never holds a value: only phases, a reference and a message", () => {
  const states: CardState[] = [IDLE, { phase: "saving" }, cardReducer({ phase: "saving" }, { type: "saved", ref: "gcp://projects/acme-prod/secrets/ACME_PROD_DB" })];
  for (const s of states) assert.ok(Object.keys(s).every((k) => ["phase", "ref", "during", "message"].includes(k)));
});

test("deleting a production secret needs its name typed; staging needs nothing", () => {
  const prod: SecretMeta = { name: "ACME_PROD_DB", ref: "gcp://projects/acme-prod/secrets/ACME_PROD_DB", store: "gcp", store_label: "GCP Secret Manager", where: "acme-prod", environment: "production", created: "2026-10-01T00:00:00Z" };
  const stage: SecretMeta = { name: "ACME_TOKEN", ref: "box://ACME_TOKEN", store: "local", store_label: "Encrypted file", environment: "staging", created: "2026-10-01T00:00:00Z" };
  assert.equal(deleteConfirm(stage, ""), "");
  assert.equal(deleteConfirm(prod, ""), undefined);
  assert.equal(deleteConfirm(prod, "ACME_PROD"), undefined);
  assert.equal(deleteConfirm(prod, "acme_prod_db"), undefined, "the name exactly");
  assert.equal(deleteConfirm(prod, " ACME_PROD_DB "), "ACME_PROD_DB");
});

test("a saved secret's expiry reads in words", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(expiresLine(undefined, now), "Never");
  assert.equal(expiresLine("2026-10-29T10:20:00Z", now), "In 20m");
  assert.equal(expiresLine("2026-10-30T09:00:00Z", now), "In 23h");
  assert.equal(expiresLine("2026-11-05T10:00:00Z", now), "In 7d");
  assert.equal(expiresLine("2026-10-29T09:00:00Z", now), "Expired");
});
