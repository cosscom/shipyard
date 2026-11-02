---
name: berth-hooks
description: Automate berth with hooks — run a command when something happens (an agent finishes or needs the user, a worktree is created or removed, a session starts) or gate an action with a before: hook that can refuse it. Covers where hooks live (a repository's .berth/config.json, a box, the laptop), the event catalog, the variables hooks get, and how to test them. Use when the user asks to automate a workflow, react to agents or worktrees, block something, or set up per-worktree databases and ports.
---

# berth hooks

A hook runs a shell command when an event happens. A hook whose `on` starts
with `before:` runs first and can refuse the action by exiting non-zero; what
it prints becomes the error everyone sees.

```json
{ "hooks": [
  { "on": "agent.waiting", "run": "notify-send \"$BERTH_PATH needs you\"" },
  { "on": "worktree.*", "run": "echo \"$BERTH_EVENT $BERTH_NAME\" >> ~/worktrees.log" },
  { "on": "before:worktree.create", "run": "case \"$BERTH_BRANCH\" in main|master) echo 'not on main'; exit 1;; esac" }
] }
```

`on` is an event type, a prefix like `worktree.*`, or `*`. Optional:
`timeout` (`30s`, `5m`; default 1m, 30s for gates) and `tool` (a hook with
`"tool": "slack"` skips events whose origin is `slack`, which stops loops).

## Where a hook lives decides where it runs

| Scope | File | Runs | Good for |
| --- | --- | --- | --- |
| A repository | `hooks` in `.berth/config.json` (or the box's config for the location) | on the box, only for that repo's events, **in the worktree** with its environment | per-worktree databases, seeding, codegen |
| A box | `~/.berth/hooks.json` on the box | on the box, for every event there | box-wide policy, logging |
| The laptop | `~/.berth/hooks.json` on the laptop | on the laptop, for events from every box | notifications, opening things locally |

Repository hooks get the worktree's variables (`$BERTH_WORKTREE_PATH`,
`$BERTH_WORKTREE_SLUG`, `$BERTH_PORT`, …) plus the repository's `env`. Prefer
`setup` / `archive` in `.berth/config.json` for one-time worktree setup and
teardown; use hooks for reactions to other events.

## What a hook gets

- The event as JSON on stdin: `{"type","time","box","origin","data":{…}}`.
- `BERTH_EVENT`, `BERTH_EVENT_BOX`, `BERTH_EVENT_ORIGIN`, and each data field
  upper-cased: `BERTH_PATH`, `BERTH_NAME`, `BERTH_LOCATION`, `BERTH_BRANCH`, …

## Events

`worktree.created`, `worktree.removed`, `worktree.setup.{started,finished,failed}`,
`worktree.archive.{started,finished,failed}`, `task.created`,
`session.started`, `session.stopped`, `session.sent`,
`agent.ready` (idle at its prompt), `agent.started`, `agent.waiting` (needs a
human; `$BERTH_SUB_STATE` names its Needs you column when known), `agent.substate`
(a question form was placed in a column, after its `agent.waiting`; no new wait),
`agent.finished`, `substates.changed`, `service.started`, `service.stopped`,
`exec.finished`, `preview.open`, `location.added`, `location.removed`, `config.changed`,
`share.started`, `share.stopped`, and on the laptop `box.connected`,
`box.disconnected`, `forward.*`.

Gates: `before:worktree.create`, `before:worktree.remove`,
`before:task.create`, `before:session.start`, `before:session.stop`,
`before:session.send`, `before:exec`, `before:location.add`,
`before:config.change`, `before:skills.install`, `before:skills.uninstall`.

## Test before you rely on it

```sh
berthd events                                   # watch events arrive (Ctrl-C to stop)
berthd emit agent.finished path="$PWD"          # fire one to try a hook
```

## Safety

- Ask before adding or changing hooks: they run automatically, as the user.
- Keep commands short, idempotent and quick; put long work in a script.
- Never put secrets in a committed `.berth/config.json`; use the box's own
  config for the location, or read them from the environment at run time.
- A gate that fails closed blocks the user; print a clear reason.
