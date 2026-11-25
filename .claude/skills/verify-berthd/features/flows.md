# Flows (Automations)

**Automations** in the sidebar (`nav-automations`, `app/src/views/automations/`) has three tabs: **Flows**, **Runs** and **Advanced: shell hooks**. Flows are the box's automations (`internal/box/flows.go`): a trigger (an event, a schedule, GitHub or a webhook), then steps. The app lists and edits them through `GET`/`PUT /v1/flows` and shows their runs from `GET /v1/flows/runs` and the box's runs. On the mock the fixtures are in `app/src/lib/mock-flows.ts`.

## Sub-features

- `flows-list`: the flow list, grouped by where each flow lives (the box's own, then each project's), each row with its steps' kinds, a summary of its trigger, its last run and an on/off switch; templates above it.
- `flows-editor`: a row opens the editor: name, on/off, **Runs for**, **Starts**, the steps, **At most N runs an hour**, **Test run** and **Save**. A committed or kit flow opens read-only with **Override on <box>**.
- `flows-runs`: the **Runs** tab lists recent runs with their status, what started them and each step's output.
- `flows-limit`: a flow whose runs-per-hour limit refused starts shows **Limit reached · N refused in the last hour** on its row and in its editor's header, with the latest refusal in the badge's tip, while the box's count for the last hour is above 0. The box keeps that count in memory: a restart of berthd clears it.
- `flows-rate-warning`: a scheduled flow that fires more often in an hour than its limit (the box's `fires_per_hour`, times its worktrees for `each_worktree`) shows, by **At most N runs an hour**, "This schedule fires up to F times an hour; the limit is L, so about F−L starts an hour will be refused." The warning follows the limit as it is typed; a changed schedule is counted once saved. It never stops the flow from saving or running.
- `flows-limit-log`: on the box, berthd.log says once when a flow reaches its limit (`flows: <scope>/<id> reached its limit of L runs an hour; refusing its starts (first from <cron|event|github|webhook|api>) …`), once when a start is allowed again (`N starts refused HH:MM–HH:MM`), and once when it loads a schedule over its limit. `POST /v1/runs` with a limited `flow_id` and a webhook answer 429.

## How to get to it (user POV)

- Sidebar → **Automations** → **Flows**: the list. Click a row: the editor. **Runs**: the runs.
- A flow held back by its limit: let a schedule like `* * * * *` with **At most 2 runs an hour** run for a few minutes, or start it from the API more often than its limit.

## Driving it with drive.mjs

- Mock: `scenarios/flows-limit.mjs` (`flows-limit`, `flows-rate-warning`, and `flows-list`/`flows-editor` along the way): the mock's box flow "Sweep stale previews every minute" on devl has 7 refusals and an every-minute schedule under the default limit of 20.

```sh
node .claude/skills/verify-berthd/scripts/drive.mjs flows-limit --port $PORT
```

- Real box: `scenarios/flows-limit-live.mjs` (`flows-limit`, `flows-rate-warning`, `flows-limit-log`), on a dev box of this checkout. It saves a box flow `every-minute` (off, `* * * * *`, limit 2), starts it three times through `POST /v1/runs` (202, 202, 429), reads berthd.log and `GET /v1/flows`, shoots the badge and the warning, raises the limit to see the summary line, and puts the box's flows back.

```sh
.claude/skills/verify-berthd/scripts/dev-box.sh up
eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"   # the token stays in env
node .claude/skills/verify-berthd/scripts/drive.mjs flows-limit-live --port $PORT --agent http://127.0.0.1:9378
.claude/skills/verify-berthd/scripts/dev-box.sh down
```

With another `VERIFY_BOX_DIR`, pass the same to the scenario: it reads `$VERIFY_BOX_DIR/berthd.log`.

- Asserted too: `app/e2e/project-flows.spec.ts` (badge and warning on the mock); `go test ./internal/box -run 'Limit|Refus|429|BusiestHour'` (the count, the log lines, the cron and each-worktree counts, 429 and the full queue's slot).

## Not covered here

- `flows-runs` has no scenario yet: the Runs tab is shown by hand, or on a real box after any run.
- A refusal from a GitHub poll or a schedule on a real box takes minutes of real time; the scenario starts the flow through the API, which goes through the same count and log (`allowRate`), and the Go tests drive the schedule and the event bus.
