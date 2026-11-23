# Chat: the account an agent runs on

A box can have several Claude Code and Codex accounts, each a folder of its own (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): the default (`~/.claude`, `~/.codex`, or berthd's own pick) and the ones the Usage plugin makes under `~/.berth/accounts/<agent>/<name>`, picked for new sessions in the box's `env.json` or a project's box-local config. The chat's foot names the one the session's agent runs on, after the model chip: its name (`default`, or the folder's name, or the folder with `~` for one elsewhere), with its folder as the tooltip ("Claude Code account in /home/me/.berth/accounts/claude/work"). It only says; nothing switches from it. It is hidden on a box with one account for the agent (backups like `work.bak-20260101T120000` don't count), and on a box too old to send it.

The box keeps the account variable's value as the session's `@berth_account` tmux option, set when the session starts with one and every time its agent starts again in its pane (`respawnAgent`: a switch between chat and terminal, a resume, carrying on another conversation), since the tmux environment only says how it first started. The value is kept after an `=`, so a variable set empty is told from none. A start again without the variable removes the option. Without the option (nothing picked one, the box stopped picking one, or a session from an older berthd), the list reads its tmux environment instead. It gives no account when it can't tell: a secret reference (`op://…`) as the folder, or tmux failing (`internal/box/accounts.go`, `sessionAccount`; `integrations.AccountName`). The session list carries it as `account: {agent, name, dir, count}`, so the phone's `/phone/v1/sessions` has it too.

## Sub-features

- `two-accounts`: the chip with the account's name and the folder's tooltip, after the model.
- `one-account`: no chip on a box with one account for the agent.
- `follows-respawn`: an agent started again after the box's default changed shows the new account.

## How to get to it (user POV)

- Open a worktree's Claude Code or Codex agent and switch the pane to **Conversation**; the chips are under the reply box.
- On the mock: `devl/checkout-fix` runs on `work` of two accounts; every `gpu` agent is on its box's only account.
- On a real box: add an account with the Usage plugin (**Add account…**), pick it for new sessions, and start an agent.

## Driving it with drive.mjs

- On the mock: `scenarios/chat-account.mjs` opens both, asserts the chip's text, its place after the model chip, its tooltip and that clicking it opens nothing, and that gpu's foot has none. `app/e2e/chat.spec.ts` ("the chat's foot names the account …") asserts the same; `app/src/lib/session-account.test.ts` the rule for when it shows.
- On a real box: `scenarios/chat-account-live.mjs` (`export const live = true`), on a dev box of this checkout started with `VERIFY_DRIVER=claude scripts/dev-box.sh up` (all `BERTH_*` unset). It makes two synthetic account folders under the dev box's own folder, starts a session with the box's `env.json` on each, asserts each chat's foot against the box's `sessions` (second view: `call`), then points `env.json` at a third folder, switches one session to its terminal (the agent starts again in its pane) and asserts the chip follows. The folders are outside `~/.berth/accounts`, so the chip names them by path.
- Box side: `go test ./internal/box -run 'Account'` (`TestTheSessionListSaysWhichAccountEachAgentRunsOn`, `TestASessionFromAnOlderBerthdHasTheAccountItsEnvironmentPicks`) and `go test ./internal/integrations -run 'Account'`.

## Gotchas

- The count is the box's, from its folders (`integrations.Accounts`), not the sessions': a session on a folder the box doesn't list (a path outside home) shows its chip even when the count is 1.
- An agent's account changes only when it starts. A new pick in `env.json` reaches a running session at its next start in the pane, not before; a session whose start doesn't name the variable keeps the one its tmux environment has.
- A dev box keeps the real HOME (Claude Code needs its sign-in), so the count includes that machine's own accounts. Keep screenshots to the synthetic folders.
