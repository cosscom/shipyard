# Plugins

Each folder here is a Shipyard plugin. The ones whose `berth-plugin.json` says
`"builtin": true` ship inside the app; `hello-ports` is the smallest example
of the SDK and is not built in. The ones that say `"marketplace": true`
(`hello-ports`, and [`leadline`](leadline) and [`database`](database), which
each also carry a program for boxes) are in the listing people browse and install from in Settings →
Plugins: see "How the listing ships" below.

| Plugin | Adds | Why it's built in |
| --- | --- | --- |
| [git-changes](git-changes) | Worktree panel "Changes" | See what an agent changed before you trust it: files, diffs, commit and push. |
| [diff](diff) | Worktree panel "Diff" | The branch's whole diff in one view (split or unified, vs the default branch or uncommitted), drawn with [@pierre/diffs](https://diffs.com). |
| [pull-request](pull-request) | Worktree panel "Pull request" | The branch's PR, its checks, reviews and comments, or open one. |
| [canvas](canvas) | Screen and sidebar item | Live chats, terminals, subagents and previews from multiple worktrees on one canvas. |
| [dev-servers](dev-servers) | Screen, sidebar item, status bar item | Every dev server on every box, one click from a browser tab. |
| [box-monitor](box-monitor) | Screen, sidebar item | Memory, disk and load with an hour of history, and a warning before a box runs out. |
| [activity](activity) | Screen, sidebar item | What happened on every box while you were away. |
| [notes](notes) | Worktree panel "Notes" | A scratchpad per worktree that its agents can read too. |
| [issues](issues) | Screen, sidebar item, commands, Home widget | Open GitHub issues for each project, or your Linear issues, and an agent on any of them (or a batch) in one step. |
| [prompts](prompts) | Screen, sidebar item, command | Saved prompts with `{{variables}}`, sent to one agent from ⌘K or a pane's menu, or to several at once. |

## How built-ins ship

- `pnpm -C app build:plugins` (also run by `pnpm dev` and `pnpm build`)
  bundles each built-in's `src/index.tsx` with esbuild into
  `app/public/builtin-plugins/<id>/index.js`, writes its manifest beside it,
  and lists them all in `app/public/builtin-plugins/index.json`. That folder
  is generated and ignored by git. `--watch` rebuilds on change.
- React, `@berth/plugin` and `@berth/plugin/ui` stay external, exactly as for
  plugins in `~/.berth/plugins`, so built-ins use nothing a user plugin
  can't.
- The app loads built-ins from its own files and user plugins through the
  agent (`app/src/plugins/host.ts`). A user plugin with the same id replaces
  the built-in. Built-ins are on by default; Settings → Plugins turns each
  off (stored in the app's preferences, `disabledPlugins`).
- The app fetches `builtin-plugins/` from its own origin, so the release
  CSP in `app/src-tauri/tauri.conf.json` keeps `'self'` in `connect-src`.
  Tauri applies it only to the bundled app, never to `pnpm tauri dev`;
  `pnpm -C app check:csp` guards it.
- Built-ins are styled with the app's Tailwind classes: `app/src/index.css`
  scans this folder. A plugin in `~/.berth/plugins` should stick to classes
  the app already uses, or inline styles.
- A built-in can keep heavy code out of its main module: each file in its
  `src/lazy/` is bundled, code-split, into `<id>/lazy/` (React and the SDK
  resolve to the app's shims), for the plugin to `import()` by URL when it
  needs it, and a worker to start from. Packages come from `app/`'s
  `node_modules`. Diff loads `@pierre/diffs` this way.
- Type-check them all with `pnpm -C app typecheck:plugins` (uses
  `plugins/tsconfig.json`).

## How the listing ships

- `pnpm -C app build:marketplace` bundles each plugin whose
  `berth-plugin.json` says `"marketplace": true` (its `src/index.tsx`, with
  React and the SDK external, not minified) into
  `site/plugins/<id>/<version>/` beside its manifest, and writes
  `site/plugins/index.json`: every plugin, and each file's path, link, size
  and SHA-256. That folder is committed and deployed with the site, so
  publishing is building and committing it. Raise the plugin's `version`
  when its code changes.
- The laptop agent reads the index (`internal/agent/marketplace.go`),
  checks every file it downloads against it, and installs into
  `~/.berth/plugins/<id>/`. It never turns a plugin on: the consent dialog
  does, as for any plugin there.
- `pnpm -C app check:marketplace` fails when `site/plugins/` is not what
  this folder builds. A plugin is built in or in the listing, not both.
