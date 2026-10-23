# Plugins

Plugins add screens, sidebar items, Home widgets, worktree panels and sections, commands, status bar items and themes (`@berth/plugin`, `packages/plugin-sdk`; docs in `docs/reference/plugin-sdk.mdx`). Built-in ones ship in `app/public/builtin-plugins/` (built from `plugins/` by `pnpm build:plugins`); a person's own live in `~/.berth/plugins` and load once allowed.

## Sub-features

- `plugin-load`: built-ins load on start; each one's status is in Settings → Plugins.
- `plugin-sidebar`: `addSidebarItem` puts a place under More; `useCount` gives it a count (see [sidebar-nav.md](sidebar-nav.md) `nav-counts`).
- `plugin-widget`: `addHomeWidget` adds to Home's picker (see [home-widgets.md](home-widgets.md)).
- `plugin-attach`: `berth.api.attach` uploads a file the way the composer does, into a running session's worktree or a worktree an agent is about to start in (`.berth/attachments`, which git ignores); a pasted `image.png` goes as `pasted-HHMMSS.png`, the box puts a timestamp before every name, and a file over 20 MB is refused before it is sent. `pasted: true` shrinks a big screenshot to WebP first. A path from `berth.api.localPaths(text)` goes up through the laptop agent, except to a box paired at 127.0.0.1, where it resolves as it is. Needs a real box: `../scripts/scenarios/plugin-attach-live.mjs` on `../scripts/dev-box.sh`, run twice: as `up` starts it, and with `VERIFY_BOX_ADDR=$(tailscale ip -4):7544` so the box counts as another computer (`node drive.mjs plugin-attach-live --port $PORT --agent http://127.0.0.1:9378`). The routes, the refusal, paths and `localPaths` are unit-tested in `app/src/lib/attachments.test.ts`.
- `plugin-errors`: a plugin that throws while loading shows as failed in Settings → Plugins; one that throws while rendering shows a note in its own place; a sidebar count that throws shows no count, and one that throws while its plugin turns off (an effect's cleanup) leaves the other counts and the app's dialogs working (`app/e2e/plugin-nav-badges.spec.ts`). The rest of the app carries on.

## How to get to it (user POV)

- Settings → Plugins lists them, with what each adds.
- Their places are under More in the sidebar; their widgets are in Home's **Add widget** picker.

## Driving it with drive.mjs

- A scenario's `plugins` array is loaded as extra built-ins: `{ id, name, source }`, where `source` is an ES module whose default export gets the plugin context (`berth`). Bare imports of `react` and `@berth/plugin` work as in a real plugin (the app rewrites them to its shims). See `../scripts/scenarios/plugin-nav-badges.mjs`.
- This is the way to prove a plugin-facing API: write the smallest plugin that uses it, and drive what it adds.

## Gotchas

- A built-in plugin is skipped when the person turned it off (`disabledPlugins` in prefs); a test plugin from a scenario is on.
- `@berth/plugin` is types only outside the app: a plugin's hooks (`useStorage`, `useWidgetData`) need the plugin's context, which the app provides around everything it renders for a plugin.
