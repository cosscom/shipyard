# Working on the phone app

Shipyard for iPhone (Android later, from this code): Expo SDK 58, React Native, expo-router. The repository's own `AGENTS.md` applies too.

- **Expo changes every SDK.** Before writing code against an Expo or React Native API, read the docs for the SDK in `package.json` (`https://docs.expo.dev/versions/v58.0.0/`, and `https://docs.expo.dev/llms.txt`), not memory.
- **Add native modules with `npx expo install <pkg>`**, which picks SDK-matched versions. A module with native code needs a new development build (`eas build --profile development`); Expo Go can't load it, nor receive remote notifications.
- **No `ios/` or `android/`.** They are generated (Continuous Native Generation). Configure native behaviour in `app.config.ts` and config plugins.
- **Routes live in `src/app/`**; everything else in `src/lib` (no React) and `src/components`.
- **Shared code is `packages/core`**, imported as `@berth/core/<file>.ts` (tsconfig paths, Metro's `watchFolders`, Jest's `moduleNameMapper`). Code both apps need goes there, by its rules (`packages/core/README.md`).
- **Boxes are the backend**: each box's phone API on its tailnet address, port 1379 (`docs/reference/phone-api.mdx`, `internal/box/phone.go`, `phonev2.go`). Notifications go through the push relay (`push/`).
- **The demo** (`src/lib/mock.ts`, "Try the demo") is what App Review sees: keep it working, with acme's made-up data.

## Checks

```sh
CI=true pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm export   # export: Metro bundles the iOS app, no Xcode needed
```
