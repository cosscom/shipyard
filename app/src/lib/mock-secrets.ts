import { ApiError, type BerthEvent, type SecretExpiry, type SecretMeta, type SecretRequest, type SecretSettings, type SecretStore, type Session } from "@/lib/api";

// Secrets in demo mode (?mock=1): what boxes keep (Settings › Secrets) and,
// with ?secrets, two agents waiting on secrets they asked for (berthd
// secret request): devl's search-perf Claude wants a staging token in the
// box's encrypted file, gpu's ci-flake Claude a production one in GCP
// Secret Manager, with a service account granted read access.
//
// A save is answered as a box would, with a reference; the value is never
// kept. window.__secretSaves records that a save happened (box, request,
// expiry), for tests, and never the value or its length. A value with
// "denied" in it is refused as GCP would refuse a missing permission, so
// the card's error shows.

type Ctx = { sessions: Record<string, Session[]>; emit: (e: Omit<BerthEvent, "time">) => void; delay: <T>(v: T) => Promise<T> };

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

const LOCAL: SecretStore = { id: "local", label: "Encrypted file", caps: { expiry: true, labels: false, grant: false } };
const GCP: SecretStore = { id: "gcp", label: "GCP Secret Manager", caps: { expiry: true, labels: true, grant: true } };

const stores: Record<string, SecretStore[]> = { devl: [LOCAL, GCP], gpu: [LOCAL, GCP] };

const settings: Record<string, SecretSettings> = {
  devl: { store: "local" },
  gpu: { store: "gcp", gcp_project: "acme-staging", locations: { evals: { store: "local" } } },
};

const saved: Record<string, SecretMeta[]> = {
  devl: [
    { name: "ACME_STRIPE_TEST", ref: "box://ACME_STRIPE_TEST", store: "local", store_label: "Encrypted file", environment: "staging", created: minutes(-3 * 24 * 60), expires: minutes(4 * 24 * 60), session: "checkout-fix-claude", location: "shop", reason: "Replay the webhook fixtures against Stripe's test mode" },
  ],
  gpu: [
    { name: "ACME_PROD_DB", ref: "gcp://projects/acme-prod/secrets/ACME_PROD_DB", store: "gcp", store_label: "GCP Secret Manager", where: "acme-prod", environment: "production", created: minutes(-12 * 24 * 60), session: "ci-flake-claude", location: "shop", reason: "Read the ledger's row counts in production" },
    { name: "ACME_LEDGER_KEY", ref: "gcp://projects/acme-staging/secrets/ACME_LEDGER_KEY", store: "gcp", store_label: "GCP Secret Manager", where: "acme-staging", environment: "staging", created: minutes(-26 * 60), expires: minutes(22 * 60), session: "judge-v2-claude", location: "evals", reason: "Score the judge against the staging ledger" },
  ],
};

// A project the box can't list: Settings says so instead of hiding it.
const listErrors: Record<string, { store: string; where?: string; error: string }[]> = {
  gpu: [{ store: "gcp", where: "acme-legacy", error: "missing permission secretmanager.secrets.list on project acme-legacy" }],
};

// seedSecretRequests puts the two pending requests on their sessions
// (?secrets).
export function seedSecretRequests(sessions: Record<string, Session[]>) {
  const put = (box: string, name: string, r: Omit<SecretRequest, "session" | "created" | "expires" | "status">) => {
    const s = sessions[box]?.find((x) => x.name === name);
    if (!s) return;
    Object.assign(s, {
      agent_state: "waiting",
      soft_wait: true,
      state_since: minutes(-1),
      ask: { tool: "SecretRequest", message: `Asks for the secret ${r.name}` },
      secret_request: { ...r, session: name, created: minutes(-1), expires: minutes(59), status: "pending" },
    });
  };
  put("devl", "search-perf-claude", {
    id: "sr-acme-token",
    name: "ACME_TOKEN",
    reason: "To call the acme staging API from the search benchmark.\nRead-only is enough.",
    location: "shop",
    store: "local",
    store_label: "Encrypted file",
    environment: "staging",
    ttl: "24h",
  });
  put("gpu", "ci-flake-claude", {
    id: "sr-acme-ledger",
    name: "ACME_LEDGER_PROD",
    reason: "Backfill the new ledger from this year's production invoices",
    location: "shop",
    store: "gcp",
    store_label: "GCP Secret Manager",
    where: "acme-prod",
    environment: "production",
    grant: "ledger-backfill@acme-prod.iam.gserviceaccount.com",
    ttl: "1h",
    replace: true,
    replaced_at: minutes(-9 * 24 * 60),
  });
}

// window.__secrets.announce() plays each pending request's
// secret.requested, as a box sends it when the agent asks, for the
// notification it routes.
export function wireSecretsMock(sessions: Record<string, Session[]>, emit: Ctx["emit"]) {
  (window as unknown as { __secrets: unknown }).__secrets = {
    announce: () => {
      for (const [box, list] of Object.entries(sessions)) for (const { r } of pending(list)) emit({ type: "secret.requested", box, data: { id: r.id, session: r.session, name: r.name, location: r.location, reason: r.reason } });
    },
  };
}

const pending = (sessions: Session[] | undefined) =>
  (sessions ?? []).flatMap((s) => {
    const r = (s as Session & { secret_request?: SecretRequest }).secret_request;
    return r ? [{ s, r }] : [];
  });

// endRequest takes a request off its session, which goes back to work.
function endRequest(ctx: Ctx, box: string, s: Session, r: SecretRequest, status: "saved" | "declined") {
  delete (s as Session & { secret_request?: SecretRequest }).secret_request;
  Object.assign(s, { agent_state: "running", soft_wait: undefined, ask: undefined, state_since: new Date().toISOString() });
  ctx.emit({ type: "secret.request.ended", box, data: { id: r.id, session: s.name, name: r.name, status } });
}

export function secretsCall(box: string, method: string, path: string, body: unknown, ctx: Ctx): Promise<unknown> | undefined {
  if (path !== "secrets" && !path.startsWith("secrets/") && !path.startsWith("secrets?")) return undefined;
  if (path === "secrets/test") return undefined;
  const { delay } = ctx;
  if (method === "GET" && path === "secrets/requests") return delay(pending(ctx.sessions[box]).map((p) => p.r));
  const act = method === "POST" ? /^secrets\/requests\/([^/]+)\/(save|decline)$/.exec(path) : null;
  if (act) {
    const hit = pending(ctx.sessions[box]).find((p) => p.r.id === decodeURIComponent(act[1]));
    if (!hit) return Promise.reject(new ApiError("no pending secret request with that id; it may have timed out", 404, "not_found"));
    const { s, r } = hit;
    if (act[2] === "decline") {
      endRequest(ctx, box, s, r, "declined");
      return delay({ ok: true });
    }
    const req = (body ?? {}) as { value?: string; expires?: SecretExpiry };
    if (!req.value) return Promise.reject(new ApiError("a secret needs a value", 400));
    if (req.value.includes("denied")) return new Promise((_, reject) => setTimeout(() => reject(new ApiError(`missing permission secretmanager.secrets.create on project ${r.where ?? "acme-staging"}`, 403)), 300));
    const expires = r.environment === "production" ? "" : (req.expires ?? "");
    const w = window as unknown as { __secretSaves?: { box: string; id: string; expires: string }[] };
    (w.__secretSaves ??= []).push({ box, id: r.id, expires });
    const ref = r.store === "gcp" ? `gcp://projects/${r.where}/secrets/${r.name}` : `box://${r.name}`;
    const hours = { "": 0, "1h": 1, "24h": 24, "7d": 168 }[expires];
    const list = (saved[box] ??= []).filter((m) => m.name !== r.name || m.store !== r.store);
    list.unshift({ name: r.name, ref, store: r.store, store_label: r.store_label, where: r.where, environment: r.environment, created: new Date().toISOString(), expires: hours ? minutes(hours * 60) : undefined, session: s.name, location: r.location, reason: r.reason });
    saved[box] = list;
    // As a box answers: after a moment, the request ends and the agent goes on.
    return new Promise((resolve) =>
      setTimeout(() => {
        endRequest(ctx, box, s, r, "saved");
        ctx.emit({ type: "secret.saved", box, data: { name: r.name, store: r.store } });
        resolve({ ref });
      }, 300),
    );
  }
  if (method === "GET" && path === "secrets") return delay({ secrets: saved[box] ?? [], stores: stores[box] ?? [LOCAL], settings: settings[box] ?? { store: "local" }, errors: listErrors[box] });
  if (method === "POST" && path === "secrets/delete") {
    const { ref, confirm } = (body ?? {}) as { ref?: string; confirm?: string };
    const m = (saved[box] ?? []).find((x) => x.ref === ref);
    if (!m) return Promise.reject(new ApiError("no secret with that reference", 404, "not_found"));
    if (m.environment === "production" && confirm !== m.name) return Promise.reject(new ApiError(`type ${m.name} to delete a production secret`, 400));
    saved[box] = (saved[box] ?? []).filter((x) => x !== m);
    ctx.emit({ type: "secret.deleted", box, data: { name: m.name, store: m.store } });
    return delay({ ok: true });
  }
  if (method === "GET" && path === "secrets/settings") return delay(settings[box] ?? { store: "local" });
  if (method === "PUT" && path === "secrets/settings") {
    const next = body as SecretSettings;
    if (!(stores[box] ?? [LOCAL]).some((s) => s.id === next.store)) return Promise.reject(new ApiError(`no store "${next.store}" on ${box}`, 400));
    settings[box] = next;
    return delay(next);
  }
  return undefined;
}
