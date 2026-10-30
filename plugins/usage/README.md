# Usage & accounts

A built-in plugin, **off by default**. Turn it on in Settings → Plugins. It adds a **Usage** screen to the sidebar and two commands, "Show agent usage" and "Switch agent account".

## Usage

The screen shows how many tokens Claude Code and Codex used on your boxes. Pick today, 7 days or 30 days, and see the tokens:

- by agent;
- by model;
- by project or worktree;
- by session.

Each session has **Open** if it is still running in Shipyard, or **Resume** (`claude --resume <id>`, `codex resume <id>`) in its worktree.

**All boxes** is the default; the box picker remembers your last choice.

- Every online box is read at once, and each shows its own state: transcripts read, still reading, or the error. A slow or failing box doesn't hold up the rest. Offline boxes are listed as "not counted (offline)".
- Agent cards add the boxes up and show each box's share. The daily chart stacks by agent or by box. The model and project tables have a Box column, and sessions from every box are merged newest first, each with its box.
- A login used on several boxes counts once: plans and Codex limits are matched by the email the agent recorded, keeping the newest limits.
- Each box keeps its own days, in its own time zone.

The numbers come from the files each agent writes on the box. Nothing is estimated or made up.

| Agent | Read from | What's in it |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` and each account's `<dir>/projects` | `message.usage` on each assistant message, deduplicated by message and request id. It also holds Claude Code's own per-session `totalCostUSD`. |
| Codex | `~/.codex/sessions/**/*.jsonl` and each account's `<dir>/sessions` | `token_count` events (cumulative totals per session) and the `rate_limits` Codex last saw. |
| Claude Code limits | `~/.berth/limits/<account>.json`, written by the box (and by your status line, if you add the lines below) | The account's 5-hour and weekly windows as of the last turn a Claude Code agent took. |

- **Input** excludes cached input. Cache reads and writes are shown separately; Codex's `input_tokens` includes its cached tokens, so the plugin subtracts them.
- **Cost** is shown only for Claude Code, and only as Claude Code's own estimate at API list prices. On a subscription (Claude Max or Pro) the screen says the plan covers the use. Codex gets no dollar figure: it records none, and the plugin keeps no price table.
- **Plan limits** show the 5-hour and weekly windows, "as of" the last turn the agent took. A window that has reset since says so instead of showing an old percentage. Codex writes them into its transcripts. Claude Code writes them nowhere, so the box records them (below).

### Claude Code's plan limits

Each turn of a structured Claude Code agent (one Shipyard starts and follows, with `claude -p`) tells the box how much of the account's windows is used, in a `rate_limit_event` (Pro and Max plans). berthd saves the latest reading to `~/.berth/limits/<account>.json`, one file per account: `{"account", "dir", "at", "limits": {"five_hour": {"used_percentage", "resets_at"}, "seven_day": {…}}}`. It keeps the newest reading: one older than the file's `at` changes nothing, and a window a turn leaves out keeps what the file had. Readings in a log read back after berthd restarts are old and aren't saved. A `claude -p` you run yourself, outside Shipyard, isn't followed, so it records nothing.

An agent in Claude Code's own terminal screen sends no such event. Claude Code gives its [status line](https://code.claude.com/docs/en/statusline) the same `rate_limits` instead, so if you use that screen, have your status line script save them to the same file:

```sh
in=$(cat)   # the JSON Claude Code passes your status line
limits=$(printf '%s' "$in" | jq -c '.rate_limits // empty')
if [ -n "$limits" ]; then
  dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}; dir=${dir%/}
  case $dir in
    "$HOME/.claude") account=default ;;
    "$HOME"/.berth/accounts/claude/*) account=$(basename "$dir") ;;
    *) account= ;;
  esac
  if [ -n "$account" ]; then
    mkdir -p ~/.berth/limits
    tmp=~/.berth/limits/"$account".$$.tmp   # one per run: sessions on one account can overlap
    jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson limits "$limits" '{at: $at, limits: $limits}' > "$tmp" \
      && mv "$tmp" ~/.berth/limits/"$account".json
  fi
fi
# …then print your status line from "$in" as before.
```

The account is `default` for `~/.claude` and the folder's name for `~/.berth/accounts/claude/<name>`. A file for any other name is ignored. The screen shows the limits as of `at`, labelled with its age, as long as `at` falls in the period it shows (today, 7 or 30 days), as Codex's do: an account no agent has used in that period shows none. Any other keys in the file are ignored.

### How it runs on the box

[`box/usage.py`](box/usage.py) runs through `exec` with `python3`; the box needs nothing installed.

- It reads files newest first.
- It stops after 45 seconds (`BERTH_USAGE_BUDGET`) and reports what is still pending. The screen asks again until it's done.
- It caches each file's summary by size and mtime in `~/.cache/berth-usage/files.json`.
- Its answer stays under exec's 64 KB output cap.

## Accounts

A box can have several logins per agent. Each login lives in its own folder:

| Agent | Default | More accounts | Picked with |
| --- | --- | --- | --- |
| Claude Code | `~/.claude` (profile in `~/.claude.json`) | `~/.berth/accounts/claude/<name>` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex` | `~/.berth/accounts/codex/<name>` | `CODEX_HOME` |

**Add account…** creates the folder (mode 0700) and opens a terminal in the current worktree. It runs the agent's own sign-in with that folder:

- `CLAUDE_CONFIG_DIR=<dir> claude`;
- `CODEX_HOME=<dir> codex login --device-auth`.

You finish signing in yourself; the plugin never reads or stores credentials. It shows only the email, plan and sign-in method the agent recorded.

**Use for new sessions** sets the variable in one of two places:

- **Everywhere on a box:** in the box's `~/.berth/env.json` (`GET`/`PUT /v1/env`). Every worktree gets it, under the project's own env.
- **One project:** in that project's box-local config (`PUT /v1/locations/{name}/config`, `local.env`). It wins over the box.

Choosing the default account removes the variable. Running sessions keep the account they started with. The screen shows which account each running session uses, read from its tmux environment.

**Add account…** also installs Shipyard's hooks and skills in the new folder, when the box has them for that agent: without them, the box could only guess from the screen when a session on that account is working, done or needs you. berthd installs them in every account folder it knows (the default, every folder under `~/.berth/accounts`, and the folders `env.json` and the projects pick), and in the folder a new session's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` names, before its agent starts. Codex reads skills from `~/.agents/skills` on every account. `berthd integrations` lists them per account; see [Agent integrations](../../docs/guides/agent-integrations.mdx#every-account).

`CODEX_HOME` is Codex's documented home folder. `CLAUDE_CONFIG_DIR` is the variable Claude Code reads for its config folder. On a Linux box each folder keeps its own login. On a Mac box, Claude Code keeps its credentials in the keychain; check that a second account really signs in on its own before relying on it.

## Developing

`pnpm -C app build:plugins` bundles it into `app/public/builtin-plugins/usage/`, with `usage.py` inlined as text. In `?mock=1`, `app/src/lib/mock-usage.ts` answers the script and `/v1/env` with made-up numbers. There are screenshots in `design/plugins/usage-*.png`.
