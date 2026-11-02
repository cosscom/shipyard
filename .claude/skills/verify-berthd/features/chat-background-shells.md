# Chat: work left running in the background

Under the reply box, a chip says what the agent left running in the background (shells started with `run_in_background`, monitors): "1 shell running", "2 tasks running". It counts only what still runs. With nothing running it says how many ended in the last five minutes ("2 finished", a grey dot), then goes. Clicking it opens **Left running in the background by Claude**: a row per job with its label and command, a badge and how long it ran, newest first. Opening a row shows its output (the shell's `tasks/<id>.output`), followed while it runs.

The badge is green **Running**, grey **Done · exit 0**, red **Failed · exit N** or **Stopped** (TaskStop, KillShell). Once a job ended, its duration stops growing. (`components/conversation/chat-controls.tsx` `BackgroundChip`, `JobRow`, `State`; `lib/background-work.ts`.)

The box decides when a shell ended (`internal/transcript/signals.go`):

- Claude's notification for it, in any of its shapes: a `queue-operation`, a `queued_command` attachment, a prompt (`<task-notification>…<status>…</status><summary>… (exit code N)</summary>`). A structured (chat) agent's log (berthd agent-host) says it in a `system`/`task_notification` line of its own, read as that notification (`host.go` `unwrapHost`). That log holds lines as Go's JSON writes them, with `<` escaped, so a check for the literal `<task-notification>` misses its prompts (`escapedNote`).
- Else the shell's output file: Claude ends it with `[exited with code N]` as the last line when the shell exits. Each read of the conversation reads the end of each running shell's file (`settle`), so it shows within one poll (a few seconds) even when no transcript line comes. The time is the file's.

A notification, when one comes, has the last word (a shell the file said ended can still read Stopped). A monitor is never read from a file.

## Sub-features

- `chip-counts-running`: the chip's count is of running jobs only; with none, "N finished" for five minutes.
- `exit-badge`: `Done · exit 0`, `Failed · exit N`, `Stopped`; plain `Done`/`Failed` from a box too old to send `exit`.
- `frozen-duration`: an ended job's duration stays put while the panel's clock ticks (every 15 s).
- `structured-end`: a chat agent's shells end (they never did before: the stream's `task_notification` only reached the crew).
- `output-file-end`: a shell ends from its output file's last line, before or without a notification.

## How to get to it (user POV)

- Open a worktree's agent in **Conversation** and ask it to run something in the background.
- On the mock: `gpu/judge-v2` has the dev server running, the payment tests done (exit 0) and a lint that failed (exit 3).

## Driving it with drive.mjs

- On the mock: `scenarios/chat-background-shells.mjs` opens `gpu/judge-v2`, asserts the chip says "1 shell running", the three badges and durations, then waits past a clock tick and asserts the ended ones' durations didn't move.
- On a real box: `scenarios/chat-background-shells-live.mjs` (`export const live = true`) on a dev box whose agent runs structured. Claude starts `sleep 20; echo hi` and `sleep 6; exit 3` in the background. It asserts Running, then `Failed · exit 3`, then `Done · exit 0` within ~45 s of the chip first showing both, the output `hi`, durations that stay put for 20 s, and "N finished" on the chip. Second view: the box's `transcript` signals (`state`, `exit`, `until`) through the agent (`call`). About 1.5 minutes.

```sh
VERIFY_BOX_DIR=/tmp/vb-$$ VERIFY_DRIVER=claude .claude/skills/verify-berthd/scripts/dev-box.sh up
eval "$(VERIFY_BOX_DIR=/tmp/vb-$$ .claude/skills/verify-berthd/scripts/dev-box.sh env)"
node .claude/skills/verify-berthd/scripts/drive.mjs chat-background-shells-live --port $PORT --agent http://127.0.0.1:9378
VERIFY_BOX_DIR=/tmp/vb-$$ .claude/skills/verify-berthd/scripts/dev-box.sh down
```

For a before, `dev-box.sh restart <a main checkout>/bin/berthd` on a fresh dev box, then the same run: it fails at `Failed · exit 3` with both rows still Running.

## Gotchas

- Run each live pass on a fresh dev box (`down`, then `up`): the scenario finds rows by label, and a second pass in the same session has two of each.
- A new structured agent opens on its first-task box ("What should Claude Code do?"), not the chat; the scenario types there.
- From inside an agent session, unset every `BERTH_*` before `dev-box.sh`, or the session's own driver leaks into the dev box's agents.
