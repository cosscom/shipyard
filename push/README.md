# Shipyard's push relay

Sends a Shipyard phone app the notifications its boxes ask for, at
`push.berthd.app`. Apple delivers a notification only from a server holding
the app's push key, which a box can't have, so boxes ask this relay. How it
fits together is in [the phone guide](../docs/guides/phone.mdx); the box's side is
`internal/box/phonev2.go`.

It keeps nothing. A phone app registers its device token and gets back a
**key**, the token sealed (AES-256-GCM) so only the relay can open it. The
app gives the key to each box it pairs with, and a box sends it with every
notice. A notice is a few short fields (`src/schema.ts`), and the relay makes
the notification from them itself, so a box, or anyone holding a phone's
key, can put nothing else in it.

| Route | |
| --- | --- |
| `POST /v1/register` | `{ platform: "ios", token, env: "production" \| "sandbox", bundle }` → `{ key }` |
| `POST /v1/send` | `Authorization: Bearer <key>`, a notice → `{ sent: true }`; 401 for a key that isn't this relay's, 410 when the phone no longer takes notifications (the box forgets it), 429, 502 for Apple's trouble |
| `GET /v1/health` | `{ ok: true }` |

Logs say what happened and to which key (the first characters of its hash),
never a body, a token or a key.

## Working on it

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` bundles `src/node.ts` with esbuild into Vercel's Build Output
API layout (`.vercel/output`): one Node function that every route goes to.

## Deploying

A Vercel project with this folder as its root directory, and the domain
`push.berthd.app`. Its environment variables, all marked sensitive:

| Variable | |
| --- | --- |
| `APNS_KEY_P8` | The APNs auth key's PEM (`AuthKey_XXXXXXXXXX.p8`), from Apple Developer → Keys. `\n` in it is read as a newline |
| `APNS_KEY_ID` | That key's id |
| `APNS_TEAM_ID` | The Apple Developer team's id |
| `APNS_TOPIC` | The app's bundle id, `dev.berth.phone` |
| `SEAL_KEYS` | `{"<kid>": "<base64 of 32 random bytes>"}`: the keys phone keys are sealed with |
| `SEAL_KID` | Which of them seals new keys |

Make a sealing key with `openssl rand -base64 32`. To replace one, add the
new key to `SEAL_KEYS` beside the old, point `SEAL_KID` at it, and keep the
old one: phones' keys sealed with it still open. Remove it only once every
phone has registered again (the app does whenever its device token changes,
or a box answers 401).

The relay limits each key to 30 notices a minute and 300 a day, and each
address to 20 registrations an hour, in each instance's memory. For a limit
that holds across instances, add Vercel Firewall rate limits on the project:
`/v1/register` at 20 an hour per IP, and `/v1/send` at 120 a minute per IP.
