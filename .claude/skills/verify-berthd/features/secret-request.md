# An agent asks for a secret

An agent that needs an API key or a token asks the person for it with `berthd secret request NAME --reason "…"`. The box holds the request on the agent's session (`Session.secret_request`, with `agent_state: "waiting"`, `soft_wait: true` and `ask.tool: "SecretRequest"`) until it is saved, declined or an hour passes. The app draws a **secret card** wherever the agent's question would show (`components/conversation/secret-request-card.tsx`, its state in `lib/secret-request.ts`):

- **In its chat**, at the foot of the conversation (`conversation-pane.tsx`, the chat's tail), never as Allow / Deny. The reply box says "Give NAME in the card above, never here".
- **On the Agent Dashboard**, in its card in place of its last lines (`views/dashboard/agent-card.tsx`, `compact`).
- **As a notification**: `secret.requested` routes "AGENT asks for a secret", "NAME — reason", in An agent needs you (`lib/events.ts`); `secret.request.ended` settles it (`lib/notifications.ts`). The agent's own `agent.waiting` for it is not a second one. Home's Needs you row and the rail's card say "Asks for the secret NAME".

The card shows the name (Replace NAME, with when the old one was saved, when `replace`), the reason verbatim, who asks, where it goes (`store_label · where`), the environment, any grant ("Grants … read access to this one secret"), a masked field with a reveal toggle (Show the value / Hide the value), an expiry picker (No expiry, 1 hour, 24 hours, 7 days; the agent's `ttl` preselected), and "The agent can use this in commands. A command that prints it puts it in the chat." **Production** shows the environment, project and grant in the warning colour (`text-warning-foreground`) and has no expiry picker: it never expires.

**Save securely** reads the field once and sends it in one request, `POST secrets/requests/{id}/save` with `{ value, expires }`; the box answers with a reference (`box://NAME`, `gcp://projects/P/secrets/NAME`). The field is uncontrolled, so the value is in no React state, prop or attribute while typed, and after the save it is cleared and the card goes. A save the box refuses (or a box away) shows its words on the card, and the value stays in the field only: nothing queues or retries it. **Decline** posts `secrets/requests/{id}/decline`. Both buttons are disabled while either is in flight.

## Sub-features

- `secret-card-chat`: the card in the chat, with every field above, and no Allow / Deny.
- `secret-card-board`: the card on the Agent Dashboard's card, shorter (Never / 1h / 24h / 7d).
- `secret-reveal`: the toggle flips the field between `password` and `text`.
- `secret-save`: one POST, then the value is in no DOM node, field, transcript item or storage, and the card goes.
- `secret-production`: warning colour on environment, project and grant; no expiry picker; Replace with when.
- `secret-refused`: the box's words on the card ("Couldn't save it: … The value is still in the field, and nowhere else."), the value in the field, no second POST.
- `secret-decline`: one POST to decline, the card goes, the field with it.
- `secret-notification`: the needs-you notification, settled when the request ends.

## How to get to it (user POV)

- An agent runs `berthd secret request ACME_TOKEN --reason "…"`. Its chat, its card on ⌘J's board and a notification show the request.

## Driving it with drive.mjs

- On the mock: `scenarios/secret-request.mjs` opens `?mock=1&secrets=1&sidebar=list&view=conversation`. With `?secrets` (`lib/mock-secrets.ts`), devl's search-perf Claude ("Speed up product search") asks for `ACME_TOKEN` (staging, Encrypted file, `ttl: "24h"`, a two-line reason), and gpu's ci-flake Claude ("Move acme billing to the new ledger") asks to replace `ACME_LEDGER_PROD` (production, GCP Secret Manager · acme-prod, a grant, saved 9 days ago). `window.__secrets.announce()` plays their `secret.requested`.
- Second views: `window.__berthCalls` (every box call the app made, by method and path, as the mock counts them) for the one POST, and `window.__secretSaves` (box, request, expiry; never the value) for what reached the box. A value with `denied` in it is refused as GCP refuses a missing permission.
- It asserts the board's two cards, the chat card's every field, that the typed value is in no attribute, the reveal toggle, the notification, the save's one POST with `7d`, that afterwards the value is in no `outerHTML`, field value, chat item or storage, the production card's warning classes and no picker, the refusal keeping the value in the field with no second POST, and Decline. Screenshots: `1-board-cards`, `2-chat-card`, `3-revealed`, `3b-notification`, `4-saved`, `5-production-card`, `6-save-refused`, `7-declined`.
- `app/e2e/a11y-scenes.ts` has `chat-secret-request` (axe over the production card); `app/src/lib/secret-request.test.ts` covers the card's state, the expiry rules and production's.

## Gotchas

- `document.documentElement.outerHTML` doesn't hold a field's live value; the scenario reads every `input` and `textarea`'s `.value` too.
- The mock answers a save after 300 ms and ends the request just before, so the card can go before Save's own answer lands.
- A real box is the only proof that the laptop agent and the box keep no copy of the value (no log, no event); the mock can't show it.
