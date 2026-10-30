# Usage: Claude Code's plan limits

The Usage plugin (`plugins/usage`, off until turned on in Settings → Plugins) shows each agent's 5-hour and weekly plan windows: how much is used, as of when, and when each resets. Codex's come from its transcripts. Claude Code's come from `~/.berth/limits/<account>.json`, which the box writes from every structured turn (each turn's `rate_limit_event`, `internal/box/claudelimits.go`), and which a status line can also write for agents on Claude Code's own screen (the plugin's README).

## Sub-features

- `limits-structured`: a turn of a structured Claude Code agent writes its account's file: `used_percentage` is the event's utilization × 100, `resets_at` in seconds. A newer reading replaces an older one, a window the turn leaves out keeps the file's, and a log read back after berthd restarts writes nothing. All of that is unit-tested in `internal/box/claudedriver_test.go` (`TestAStructuredSessionRecordsItsAccountsPlanLimits`, `TestPlanLimitsKeepTheLatestReading`).
- `limits-account`: the file is named as the plugin names the account: `default` for `~/.claude`, the folder's name for `~/.berth/accounts/claude/<name>`, and no file for any other folder (`TestAClaudeAccountIsNamedAsTheUsagePluginNamesIt`).
- `limits-screen`: the Usage tab's Claude Code panel shows the file's windows as meters ("5-hour limit", "Weekly limit"), the same numbers Claude Code's own `/usage` shows. Home's **Agent usage** widget shows them too.

## How to get to it (user POV)

- Settings → Plugins → turn on **Usage & accounts**; then **Usage** (sidebar, under More) or ⌘K **Show agent usage**. **Switch agent account** opens its Accounts tab, where an account's **…** menu sets which login new sessions use.

## Driving it with drive.mjs

- `../scripts/scenarios/usage-limits-live.mjs`, on a real box: it needs a signed-in Claude account and costs one short Haiku turn. The dev box gets a HOME of its own (so it never writes the real `~/.berth/limits`) with the account linked in as `acme-max`:

  ```sh
  export VERIFY_BOX_DIR=/tmp/vb-limits VERIFY_BOX_HOME=/tmp/vb-limits/home VERIFY_CLAUDE_ACCOUNT=/path/to/signed-in/claude-config-dir VERIFY_DRIVER=claude
  .claude/skills/verify-berthd/scripts/dev-box.sh up && eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"
  node .claude/skills/verify-berthd/scripts/drive.mjs usage-limits-live --port $PORT --agent http://127.0.0.1:9378
  ```

  It turns the plugin on, picks acme-max for the box in the Accounts tab, starts session `limits` (structured, Haiku, "Reply with just: ok"), waits for `acme-max.json`, reads `/usage` with `../scripts/claude-usage.sh` and checks that the file, `/usage` and the screen's meters agree. It removes the session after; `dev-box.sh down` removes the rest.
- `../scripts/claude-usage.sh DIR` prints what `/usage` says for the account in `DIR` (`five_hour=45 seven_day=23`). It starts Claude Code's own screen in a tmux server of its own and trusts an empty `/tmp/claude-usage-w` the first time.

## Gotchas

- An agent still running at `dev-box.sh down` writes its folders again as it exits, after the box's folder is removed: under `VERIFY_BOX_HOME`, `acme-max` comes back as a folder signed in nowhere ("Not logged in"). The scenario removes its session even when it fails, and `up` refuses such a leftover; remove `VERIFY_BOX_DIR` a few seconds after `down`.
- Run with every `BERTH_*` unset (a /ship worker's `BERTH_DRIVER=structured` leaks into the dev box's agents).
- The linked account is a real one: the Usage screen lists its real sessions and projects. Shoot only the limits rows (`shot(name, locator)`), never the whole screen, and keep `failed.png` out of a PR.
- `/usage` and the file are two readings a few seconds apart: on an account other agents are using at the same time, they can differ by a point. Run it on an account nothing else is using.
- The plugin reads limits only for known accounts (`default` and the folders under `~/.berth/accounts/claude`); a file for any other name is ignored.
