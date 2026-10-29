# Shipyard for iPhone

Which agents need you across your boxes, and answering them, from your phone.
It talks to each box over your tailnet, on the box's phone API, and gets
notifications through Shipyard's push relay. The guide for people is
[docs/guides/phone.mdx](../docs/guides/phone.mdx).

## Running it

You need an iPhone with Tailscale, signed in to your boxes' tailnet, and an
[Expo](https://expo.dev) account. No Mac is needed: EAS builds in the cloud.

```sh
CI=true pnpm install --frozen-lockfile
npx eas-cli@latest build --profile development --platform ios   # once, and after adding a native module
pnpm start                                                      # then open the build on the phone
```

The phone reaches Metro over the tailnet: start it with
`REACT_NATIVE_PACKAGER_HOSTNAME=<this machine's tailnet address>`.

On a box, turn phone access on in Shipyard → Settings → Phone and scan the
code from the app. **Try the demo** shows made-up boxes without one.

## What's where

| | |
| --- | --- |
| `src/app/` | The screens (expo-router): Needs you, Runs, Boxes, a session, a run, Pair |
| `src/lib/api.ts` | The box's phone API |
| `src/lib/events.ts` | Following a box's events as they happen |
| `src/lib/store.ts` | Boxes, their sessions and runs, conversations |
| `src/lib/push.ts` | Notifications: the relay's key, registering with boxes |
| `src/lib/mock.ts` | The demo |
| `../packages/core` | What the desktop app and this one share |

## Builds

`eas.json` has three profiles: `development` (a development client, APNs
sandbox), `preview` (TestFlight) and `production` (the App Store, APNs
production). The push relay must hold the same team's APNs key
(`push/README.md`), with `APNS_TOPIC=dev.berth.phone`.

## Checks

```sh
pnpm typecheck && pnpm test && pnpm export
```

`pnpm export` bundles the iOS app with Metro (no Xcode), which is how CI
checks that imports from `packages/core` resolve.
