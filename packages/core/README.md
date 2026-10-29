# @berth/core

Plain TypeScript that the desktop app (`app/`) and the phone app share: a
session's state and its words, reading an agent's screen, transcript items and
how a chat's list changes, questions, pairing links, timeouts and backoff.

The rules, which `pnpm check:core` in `app/` enforces:

- Only relative imports, with their `.ts` extension, and `import type` from
  `../../plugin-sdk/src/types.ts`. No packages: Vite, Metro and
  `node --experimental-strip-types --test` all load these files as they are.
- No DOM, no `window`, no React. Code that needs them stays in the app.

`app/src/lib/<name>.ts` re-exports each file, so the app's imports
(`@/lib/derive`) are unchanged. Tests sit beside the code as `*.test.ts` and run
with the app's `pnpm test`.
