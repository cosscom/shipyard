# The board's columns, and the sub-states of Needs you

The Agent Dashboard (`app/src/views/dashboard/dashboard-view.tsx`) has four columns: Needs you, Working, Done and Idle, each with a title, a count and an empty message, oldest in its state first. An optional set of sub-states (`internal/box/substates.go`, `app/src/lib/substates.ts`) replaces Needs you with one amber column each, in the set's order. `agent_state` stays `waiting`: only `agent_sub_state` says which. With no set, nothing changes anywhere.

## Sub-features

- `columns`: the four columns and their counts, with no set. The grid wraps on a narrow window.
- `preset`: Settings → Agents → **Needs you columns** → **Use Needs a decision and Needs you to act**. The board then has both, amber, with their own counts.
- `not-sorted`: a waiting agent with no sub-state, or one the set doesn't have, sits in the first column with a small **Not sorted** tag (`data-testid=not-sorted`). `placeSession` decides, unit tested in `app/src/lib/substates.test.ts`.
- `editor`: add, rename, move up and down, remove, then Save. Nothing half made saves. At most 6. Removing all restores Needs you.
- `warnings`: an older box ("runs an older berthd"), a box with turn check off, and who changed what last.
- `spread`: an edit on one box reaches the others through the app (`lib/substates-sync.ts`), gated on the `substates` capability. A box keeps only a newer stamped set.
- `placing`: end of turn: the verdict's request as ever, then with a waiting verdict a second one for the sub-state, so descriptions never reach the verdict. A form: one request on its words, default until the answer, then `agent.substate`. A permission prompt: the default by rule, no request, no tag.
- `surfaces`: the field reads the same through `GET sessions`, `berthd sessions --json` and MCP's `berth_sessions` (`sub_state`). Edits work over `/v1/substates`, `berthd substates` and MCP's `berth_substates`, including from a box's own agent; `/v1/turncheck` stays closed to it.

## How to get to it (user POV)

- ⌘J opens the Agent Dashboard. Settings (the gear) → Agents, under Turn check, has **Needs you columns**.

## Driving it with drive.mjs

- Mock: `node .claude/skills/verify-berthd/scripts/drive.mjs dashboard-sub-states --port $PORT` checks the four columns, turns on the preset, checks both columns' counts and the tagged card from the older box (`gpu`), removes the set and checks the four come back. `app/e2e/dashboard-sub-states.spec.ts` asserts it and the editor.
- Real boxes, with a real Claude Code and the real provider:

  ```sh
  export VERIFY_BOX_DIR=/tmp/vb-NNNN
  .claude/skills/verify-berthd/scripts/sub-states-box.sh up     # two boxes (devq, devr), turn check on devq, a structured Claude
  eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"
  node .claude/skills/verify-berthd/scripts/drive.mjs dashboard-sub-states-live --port $PORT --agent http://127.0.0.1:9378
  .claude/skills/verify-berthd/scripts/sub-states-box.sh down
  ```

  An agent's edit over MCP shows in Settings with who made it and spreads to `devr`; a real turn that asks for a choice lands in `decision`; a real form reads `decision → act`, with one `agent.waiting` and one `agent.substate`; the field agrees on the API, the CLI and MCP; clearing the set restores four columns on both boxes. The gateway key comes from `VERIFY_TURNCHECK_KEY_FILE` (default the box's own `turncheck.key`) and goes over stdin, never a command line.
- The classifier: `go test ./internal/box -run TestSubStateReplays` replays recorded gateway answers (`testdata/turncheck/substate-*.json`). Re-record with `BERTH_TURNCHECK_RECORD_KEY_FILE=<key file>`, then grep the fixtures for the key.

## Gotchas

- Live runs need `labs=0` in the scenario's params. With Labs on, `nav-home` is New task, and Home's Pull requests widget shows the signed-in person's real repositories, so never put that screen in a public PR.
- Unset every `BERTH_*` before running these from inside an agent session, or the worker's `BERTH_DRIVER=structured` turns the dev box's hooks off.
- Claude Code's terminal reports a form as a `permission` wait with tool `AskUserQuestion`, then again about 6 seconds later as a notification with no tool. It's one wait: `sub.From` keeps the first Seq, and the repeat says where the wait is. The structured driver says `question` once.
- A sync that fails retries on its own every 15 seconds, and a hook's refusal (403) isn't retried until the set or the box's info changes.
- A form's real answer can come back under 0.65 and go to Not sorted: the live scenario's question is worded to be a clear task. That's a model's answer, not a bug.
- The mock's only capable box is `devl`, so its `checkout-fix` card is placed and `gpu`'s waiting card is tagged.
