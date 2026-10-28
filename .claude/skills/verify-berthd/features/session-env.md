# A session's own variables: `--env KEY=VALUE`

A task or session can be started with variables for it alone: `--env KEY=VALUE` (repeatable) on `berthd task new` and `berthd session new` (and `berth` for a box), `env` in the `POST /v1/tasks` and `POST /v1/sessions` bodies, and `env` (an object) on the `berth_task_new` MCP tool. They reach the agent's process in its terminal and through the agent host (a structured agent), and come over the same names from the box's `env.json` and the project's `env`. They last through a switch between the terminal and the chat: `@berth_env` names them on the tmux session, and `respawnAgent` leaves those names out of what it passes again (the worktree's values and the browser timeout's default), so the session's tmux environment supplies them. berthd's own names (`BERTH_SESSION`, `BERTH_PORT`, `BERTH_PORT_<n>`, the worktree's `BERTH_*`, `BERTH_AGENT`, `BERTH_DRIVER`, and `BERTH_HOME`, `BERTH_USER_DIR`, `BERTH_OP`, which the secret wrapper trusts, …) and malformed ones (no `=`, no name, a name twice, a NUL in a value) are refused before anything is made (`internal/box/sessionenv.go`, `boxcmd` `envFlag`, `mcpserver` `envArg`).

## Sub-features

- `task-env`: `task new --env` sets them for the new worktree's agent.
- `session-env`: `session new --env` sets them for a session in an existing worktree, agent or command.
- `mcp-env`: `berth_task_new` with `env: {…}` does the same from an agent.
- `precedence`: session over project over box; names only one level sets come through.
- `refused`: a name berthd sets, or a malformed `--env`, is an error with a message, and no worktree or session is made.

## How to get to it (user POV)

- From a terminal or an agent on a box: `berthd task new acme/fix --agent claude --prompt … --env TICKET=T-7`.
- The app doesn't set them; it shows the agents started with them like any other.

## Driving it

- Go: `internal/box/sessionenv_test.go` (precedence over a real tmux, refusals with nothing made, a structured agent's pane keeping them across a respawn), `internal/boxcmd` `TestEnvFlags…`/`TestAMalformedEnvFlag…`, `internal/mcpserver` `TestATasksAgentGetsTheVariablesItWasGiven`.
- On a real box, with real Claude Code: `scripts/session-env-live.sh [OUT]` on a dev box of this checkout (`VERIFY_BOX_DIR=/tmp/vb-N scripts/dev-box.sh up`, every `BERTH_*` unset when you are an agent). It sets `ACME_*` in the box's env, the project's and each session's, starts Claude four ways (task new, session new, `berth_task_new` through `berthd mcp`, all structured; session new in its terminal) and has each one's Bash tool write `env | grep ^ACME_` to `OUT/<name>.txt`, which it compares; then the two refusals, checking no session or worktree appeared. Evidence: the four files, each session's transcript, the terminal's screen, `refused-*.txt`.
- The chats in the app: then `node scripts/drive.mjs session-env-live --port $PORT --agent http://127.0.0.1:9378` opens `env-mcp`'s and `env-task`'s chats and asserts the Bash tool's output lines on screen (`scenarios/session-env-live.mjs`).

## Gotchas

- The terminal run needs Claude's folder-trust prompt answered: the script presses Down until `❯ … Yes, I trust` (or `Yes, proceed`) shows, then Enter, and runs Claude with `--dangerously-skip-permissions` so its Bash tool doesn't ask.
- The structured runs need the box's agent default on (`PUT agents/defaults {"structured":true,"mode":"bypassPermissions"}`); the script sets it, so `dev-box.sh`'s terminal default no longer holds after it.
- `env-task`'s worktree has two sessions (its chat and `env-term`'s terminal), so the scenario picks the chat's tab if the terminal opens first.
