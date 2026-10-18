---
name: verify-berthd
description: Prove a change to the Shipyard app works the way a person sees it - build the app, serve it on its mock fixtures, drive a scenario in a real Chromium (optionally with a test plugin loaded beside the built-in ones), and keep screenshots, an ARIA snapshot and the console as evidence. Use before calling an app change done, to show a reviewer what changed, or when a plugin-facing API needs a plugin to exercise it.
---

# Verify the Shipyard app

The app (`app/`) is what people touch. Its production build runs in a browser on the mock fixtures (`?mock=1`, `src/lib/mock*.ts`, synthetic "acme" data), with no laptop agent and no box. That is the surface this skill drives. The Go daemons (`berthd`, `berth`) are verified by `go test -race ./...`; a box-side change also needs a run on a real box, which this skill doesn't cover.

The e2e suite (`app/e2e`, see `.claude/skills/e2e-tests`) asserts. This skill **shows**: it drives the same build through a scenario and keeps the evidence for a PR or a person.

## Launch

```sh
cd app && CI=true pnpm install --frozen-lockfile   # once per worktree; never symlink node_modules
pnpm build                                          # dist/, and the built-in plugins in public/
PORT=1433                                           # free, in 1421-1439 (1420 and 1377-1379 are taken)
ss -ltn | grep -q ":$PORT " && echo "port $PORT is taken"
pnpm exec vite preview --host 0.0.0.0 --port $PORT --strictPort > /tmp/verify-berthd-preview.log 2>&1 &
echo $! > /tmp/verify-berthd-preview.pid
until curl -sf "http://localhost:$PORT/" >/dev/null; do sleep 0.5; done   # ready
```

`--host 0.0.0.0` so a person can open it from another machine too (`http://<box>:$PORT/?mock=1`). Rebuild after every change: preview serves `dist/` as it was built.

## Doctor

```sh
.claude/skills/verify-berthd/scripts/doctor.sh $PORT
```

Read only. It checks the port answers with the app, that the PID in `/tmp/verify-berthd-preview.pid` is the one listening (so you never drive someone else's server), and that `dist/` is newer than every file under `app/src` and `packages/plugin-sdk/src` (a stale build proves nothing). Run it first, and whenever something looks off.

## Drive

```sh
node .claude/skills/verify-berthd/scripts/drive.mjs <scenario> --port $PORT [--out DIR]
```

`<scenario>` is a file in `scripts/scenarios/` (by name, without `.mjs`) or a path. The driver:

- opens `http://localhost:$PORT/?mock=1` at 1440×900 in dark mode, and waits until the sidebar's `nav-home` is there;
- refuses every request to the laptop agent's ports (1377-1379), as the e2e fixtures do;
- serves the scenario's `plugins` as extra built-in plugins (it appends them to `builtin-plugins/index.json` and answers `builtin-plugins/<id>/index.js` with their source), so a plugin API is exercised by a real plugin loaded the way the app loads its own;
- calls the scenario's `run({ page, shot, step })`, where `shot(name)` saves `<name>.png` and `<name>.aria.txt` (an ARIA snapshot of the body), and `step(text)` logs what is being done;
- fails (exit 1) on a page error, or a console error the scenario doesn't list in `allowErrors` (regexes), and on any assertion the scenario throws.

A scenario is a module:

```js
export const plugins = [{ id: "counts", name: "Counts", source: `export default function (berth) { … }` }];
export const allowErrors = [/count boom/];
export async function run({ page, shot, step, expect }) { … }
```

`expect` is Playwright's, so assertions wait as they do in the e2e suite. Use stable hooks: `data-testid` (`nav-<id>`, `nav-more`, `nav-badge`, `home-grid`, the list at the top of `app/e2e/fixtures.ts`), roles and accessible names. Never coordinates.

Which scenario proves which feature is in [features/README.md](features/README.md).

## Evidence

`--out` defaults to `/tmp/verify-berthd/<scenario>-<timestamp>/`. It holds the scenario's screenshots and ARIA snapshots, `console.txt` (every console message and page error, in order) and `result.json` (`ok`, the steps, the errors that failed it). The driver prints the folder at the end. Attach the screenshots to the PR's Evidence and quote the steps.

Proof standards:

- Drive the path a person takes (click the row, open the menu), not the store or an internal setter.
- Capture the state after the action, and the action's effect on a second view where there is one (a count on the row and on More's row; a setting and the screen it changes).
- The mock is the fixture boundary the app already has. Anything it can't show (a real box, the Mac app's window, the updater) needs a person or a real box, so say so in the PR rather than claiming it.

## Cleanup

```sh
kill "$(cat /tmp/verify-berthd-preview.pid)" && rm /tmp/verify-berthd-preview.pid
```

Kill only the PID you started; never `pkill node` or `vite`. The evidence folder stays.
