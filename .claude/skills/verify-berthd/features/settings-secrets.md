# Settings › Secrets

The secrets agents asked for and the person saved, per online box, and where each box saves them (`views/settings/secrets-section.tsx`, `GET secrets`, `POST secrets/delete`, `PUT secrets/settings`). Never a value: the box never sends one back, and the page has no field or Show for one.

- **The list**: each secret's name, its environment (Production in the warning colour), where it is (`store_label · where`), when it expires ("never" for production), when it was saved, and who asked (the session's work, as the box still has it) and why. A store the box couldn't list (`errors`, a GCP project it has no access to) says so in red.
- **Delete**: asks first. A production secret wants its name typed exactly before Delete enables, and sends it as `confirm`; a staging one needs only the confirm. The list reads again on `secret.saved` and `secret.deleted`, from anywhere.
- **Where it saves them**: the box's default store (from `stores`) and, for GCP, its project; and per project (each of the box's locations) its own store and project, or "Box default". One Save per box sends `PUT secrets/settings`.
- Find a setting answers to "api token", "keys", "credentials", "secret manager"; ⌘K has it too.

## Sub-features

- `secrets-list`: names and facts only, per box, with the box's listing errors.
- `secrets-delete-production`: Delete disabled until the name is typed exactly; then one `POST secrets/delete`.
- `secrets-delete-staging`: Delete after a confirm.
- `secrets-where`: the default store and a project's own, saved.

## How to get to it (user POV)

- Settings (the gear at the sidebar's foot) › Agents › Secrets, or ⌘K "Secrets".

## Driving it with drive.mjs

- On the mock: `scenarios/settings-secrets.mjs` opens `?mock=1` (no `?secrets` needed). devl keeps `ACME_STRIPE_TEST` (staging, Encrypted file, expires in 4 days); gpu keeps `ACME_PROD_DB` (production, acme-prod) and `ACME_LEDGER_KEY` (staging, acme-staging), saves to GCP · acme-staging by default and evals to its encrypted file, and can't list acme-legacy (`lib/mock-secrets.ts`).
- It asserts each row's facts and who asked, the listing error, no password field or Show, gpu's store choices, shop given GCP · acme-shop and saved (`PUT gpu/secrets/settings` once, in `window.__berthCalls`), the production delete locked on `ACME_PROD` and `acme_prod_db` and open on `ACME_PROD_DB` (one `POST gpu/secrets/delete`), the staging delete, and Find a setting. Screenshots: `1-secrets-list`, `2-where-saved`, `3-production-delete-locked`, `4-production-delete-typed`, `5-after-deletes`.
- `app/e2e/a11y-scenes.ts` has `settings-secrets`; `app/e2e/look.spec.ts`'s "every Settings section opens" opens it.

## Gotchas

- A box without the secrets API answers `GET secrets` with an error; the box's group shows it with `BoxError` (an older berthd gets Update).
