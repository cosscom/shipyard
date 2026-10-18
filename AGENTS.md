# Working on Shipyard

Shipyard (formerly Berth) runs coding agents on your own machines. This repo has:

- `cmd/berthd`, `internal/box`: the box daemon. It runs agents, terminals and services in its own tmux server.
- `cmd/berth`, `internal/agent`: the laptop CLI and agent (UI API on 1378, proxy on 1377, phone on 1379).
- `app/`: the Tauri 2 + React desktop app (coss-ui, 23 themes). `app/e2e` holds the Playwright suite on mock fixtures.
- `docs/`: the docs as MDX, built by `docs-site/` (Fumadocs). `site/` is the landing page and `install.sh`.

**Names:** "Shipyard" is the brand in everything people read. `berth`, `berthd`, `~/.berth`, `BERTH_*`, `berth://`, `dev.berth.app`, `berth.prefs` and the `berth-*` skill ids are identifiers. Don't rename them; a later change will, with migrations.

## Checks

Run these before you call something done:

```sh
go vet ./... && go test -race ./...          # -race: CI runs it, and it has caught real races
(cd app/src-tauri && cargo check)
cd app && CI=true pnpm install --frozen-lockfile
pnpm typecheck:plugins && pnpm check:titles && pnpm check:type && pnpm check:csp && pnpm check:themes && pnpm test && pnpm build
npx tsc -p e2e
(cd docs-site && pnpm build)                 # when docs/ changed
```

Browser tests: run the specs you touched, not the whole suite (`E2E_PORT=14xx npx playwright test e2e/x.spec.ts`). CI runs the rest.

## Rules that cost a CI run each

- **Ports:** 1420 is the dev app and 1377–1379 the laptop agent: never use or kill them. Vite and Playwright use `E2E_PORT` in 1421–1439, and you check the port is free first.
- **Hands off:** never touch `~/.berth`, `~/Library/Application Support/berth` or the `dev.berth.berthd` launchd job. Kill only PIDs you started; no `pkill node`/`vite`/`next-server`.
- **No symlinked `node_modules`** (pnpm breaks without a TTY). Install per worktree.
- **New unit test files** go in `app/src/lib/` as `*.test.ts`; `pnpm test` finds them there (`src/lib/**/*.test.ts`). Don't list them in `package.json`.
- **No `title=` attributes** in the app (`check:titles`); use `<Tip>`.
- **Text sizes come from the type scale** (`text-body`, `text-desc`, `text-meta`, `text-tag`, … in `index.css`), never `text-sm` or `text-[11px]` (`check:type`). coss ui's own parts in `components/ui` keep theirs.
- **MDX:** a bare `<word>` in prose is parsed as a tag and breaks the docs build. Wrap it in backticks.
- **Changelog:** every user-visible change gets a bullet under `## Unreleased` in `docs/changelog.mdx`, in plain words.
- **Fixtures are synthetic** ("acme"). Nothing company-specific (no Cal.com repos, keys or names) goes in this public repo.
- **No secrets** in output, logs, URLs or commits. Tokens go through env vars, never query strings.

## Changes

- **Work on a branch and open a PR** against `main` on `cosscom/shipyard`. CI runs on pull requests. Browser tests report there but don't block yet; Go, shell, the app's checks and build, and the docs build do.
- **Commit messages** are lowercase conventional (`feat(app): …`, `fix(box): …`, `test: …`). The subject says what the user gets, in prose.
- **Releases** are in `.claude/skills/release`. Merging several branches is in `.claude/skills/integrate-branches`. Writing browser tests that don't flake is in `.claude/skills/e2e-tests`.
