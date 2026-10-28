---
name: berth
description: Use berth to work across development boxes — list repos (locations) and their worktrees, make a worktree or a task (a worktree with an agent in it), start or read terminal sessions, find which port and URL a worktree's dev server has, and read a repo's .berth/config.json (ports, env, services, hooks). Use when asked to spin up a worktree or agent on a box, check what runs where, find a dev server, or when you see BERTH_* variables in your environment. For driving other agents see berth-orchestrate; for showing a page to the user see berth-preview; for automating with hooks see berth-hooks.
---

# berth

berth connects a laptop to development boxes. Each box runs `berthd`; each
laptop runs `berth`. The commands are the same, with one difference:

- **On a laptop**, name the box first: `berth worktree new devl/shop/fix-login`.
- **On a box**, the box is implied: `berthd worktree new shop/fix-login`.

`command -v berth berthd` tells you which you have. Add `--json` to any
listing and prefer it when you will parse the result. The examples below use
the box form (`berthd …`); on a laptop write `berth … BOX/…` instead.

## Where am I?

When berth started your terminal, the environment says where you are:

| Variable | Meaning |
| --- | --- |
| `BERTH_BOX` | the box's name |
| `BERTH_LOCATION` | the repository (location) name, e.g. `shop` |
| `BERTH_ROOT_PATH` | the repository's main checkout |
| `BERTH_WORKTREE_PATH`, `BERTH_WORKTREE_NAME` | this worktree |
| `BERTH_WORKTREE_SLUG` | `shop_fix_login`: safe for database and container names |
| `BERTH_BRANCH` | the worktree's branch |
| `BERTH_PORT`, `BERTH_PORT_1`, … | ports reserved for this worktree alone |

Use `$BERTH_PORT` for this worktree's dev server instead of a fixed port like
3000: every worktree has its own block, so two worktrees never collide, and
berth's URL for the worktree reaches whatever listens there.

## Find your way around

```sh
berthd locations --json          # repos and their worktrees (each with its first port)
berthd sessions --json           # terminals and agents, with agent and agent_state
berthd services --json           # which worktree each listening port belongs to
berthd ports --json              # everything listening on the box
berthd agents                    # agent CLIs this box can start
```

`agent_state` is `idle` (at its prompt), `running`, `waiting` (needs a human)
or `finished` (done with its turn).

## Make work

```sh
# An agent beside you, in a split pane of the user's window:
berthd session new "$BERTH_LOCATION/$BERTH_WORKTREE_NAME" --agent claude --prompt "Review my diff" --open split
# A new worktree with an agent in it, in a new tab:
berthd task new shop/fix-login --agent claude --prompt "Fix the login redirect loop" --open tab
# A worktree alone, or any command in a terminal:
berthd worktree new shop/fix-login --base main
# A stacked branch, nested under the worktree it builds on:
berthd worktree new shop/fix-login-tests --base fix-login --parent fix-login
berthd session new shop/fix-login -- pnpm dev
# Read a terminal:
berthd session screen shop-fix-login-claude-1a2b --history 200
```

- Start agents with `--agent ID --prompt TEXT` (ids from `berthd agents`),
  never `-- claude "…"`: berth builds and quotes the command for that agent.
- `--open split` (beside the user's focused terminal) or `--open tab` shows
  it in the user's Shipyard app when they are looking at that worktree, and
  offers it otherwise. Use it whenever the user asks for an agent "beside
  me", "in a split" or "in a new tab".
- `--env KEY=VALUE` (repeatable) gives that one agent a variable, over the
  box's and the repository's: `--env TICKET=T-7`. Names berth sets itself
  (`BERTH_SESSION`, `BERTH_PORT`, …) are refused.
- A new agent may stop at a question before it is ready, such as "do you
  trust this folder?". Wait with `berthd session wait NAME --for idle,waiting`:
  `idle` means it is at its prompt; `waiting` means it needs the user, so
  tell them. Never poll the screen for a prompt.
- An agent you start with `task new` reports back to you: when its turn
  ends (or it needs a person) berth types a `<berth-notification>` into your
  session at your next idle. End your turn rather than waiting on it; see
  berth-orchestrate.

A branch that already exists, locally or on origin, is checked out as it is.
Session names are printed when they start and listed by `sessions`. Do not run
`berthd session attach` or `berth attach` yourself: they are interactive and
meant for humans.

## A repository's config

`.berth/config.json` in a repository (and the box's own config for that
location, which wins) says what every worktree gets:

```json
{
  "setup": "pnpm install",
  "archive": "dropdb --if-exists $BERTH_WORKTREE_SLUG",
  "ports": 2,
  "env": { "DATABASE_URL": "postgres://localhost/$BERTH_WORKTREE_SLUG" },
  "services": [{ "name": "web", "run": "pnpm dev --port $BERTH_PORT", "autostart": true }],
  "hooks": [{ "on": "worktree.created", "run": "createdb $BERTH_WORKTREE_SLUG" }],
  "agents": [{ "id": "claude", "name": "Claude Code", "command": "claude --model opus" }]
}
```

```sh
berthd location config shop --json        # the repo's, the box's, and the effective config
berthd service list shop/fix-login        # this worktree's services and their state
berthd service start shop/fix-login web   # also stop, restart
berthd service log shop/fix-login web     # its output, when it will not stay up
```

`setup` runs after a worktree is created and `archive` before it is removed;
services start after setup and stop before archive. Edit the repository's
file only when the user asks you to change how every worktree is set up.

A box runs none of the repository's file (only its `ports`) until a person
trusts it on that box, and again after every change to it: `location config`
then shows `repo_trust.state` as `untrusted` or `changed`. Never trust it
yourself (`--trust`); tell the user what it wants to run and let them decide
in the app or with `berth location config BOX/LOC --trust HASH`.

## Review links for the PRs you open

When a pull request you open from a berth worktree changes something a
reviewer would look at in a browser (pages, components, styles, copy, UI
behaviour), end its description with a **Review in Shipyard** button, so a
teammate opens it on their own box in one click, set up by the team's kit,
at the page it changes. Leave it out of PRs with nothing to see: backend,
API, infrastructure, tests or docs alone. GitHub drops `berth://` links, so the
button goes through berthd.app, which opens the review in Shipyard:

```md
<!-- shipyard-review-button -->
[![Review in Shipyard](https://berthd.app/badges/review.svg)](https://berthd.app/review?repo=OWNER/NAME&pr=N&as=EMAIL&path=/x)
<!-- /shipyard-review-button -->
```

- `repo` and `pr` are the PR's. Open the PR first, then edit its description
  to add the button (`gh pr edit N --body-file …`, keeping what is there).
- `path` is the main page your change affects (`/settings/billing`): a path
  on the app's own address, starting with one `/`. Leave it out when no page
  shows the change.
- `as` is the dev user who sees that page best, one of the project's login
  users: `berthd login users` lists them. Leave it out when the project has
  none or it doesn't matter.
- URL-encode both (`pro%2Bqa@acme.test`, `/billing%3Ftab%3Dplans`), and put
  nothing else in the link: never a secret, a token or a real person's email.
- Keep the two marker comments: berthd uses them to never add a second
  button. When the project has the button turned on, berthd adds one by
  itself; then `berthd review-button --as EMAIL --path /x` sets its user and
  page instead of editing the description.

In a review worktree, `BERTH_REVIEW` is the PR number: it is someone else's
work pinned to the commit they were shown, so don't push to its branch.

## Share publicly — only when a human asks

`berthd share 3000` makes a port reachable **by anyone on the internet**
until `berthd unshare <id>`. Never share on your own initiative, and never
share anything with real data. Confirm with the user first and tell them the
URL and how to stop it.

## When something fails

- `no paired box named X` (laptop): run `berth boxes`; the name may differ.
- `berthd serve is not running` (box): `berthd install` starts it.
- `a "before:…" hook stopped …`: the user's hooks refused the action. The
  message says why; do not try to work around it.
