# Shipyard app verification map

The maintained list of what a person can do in the app, and how to prove each one with this skill. Read it before driving; use the matching file as the recipe. A change to a feature updates its file, and a scenario that proved it moves into `../scripts/scenarios/`, in the same PR.

## Baseline

- The production build served by `vite preview` on a free port in 1421-1439, opened at `/?mock=1` (see `../SKILL.md` Launch).
- `../scripts/doctor.sh $PORT` passes.
- The mock's fixtures as they ship: boxes `devl` and others, projects `shop` and `evals`, agents waiting and working. Nothing is seeded by hand.

## Features

| Feature | File | Scenario |
| --- | --- | --- |
| Sidebar places: Pinned, More, Hidden, counts on rows (Home's waiting, Review's, a plugin's) | [sidebar-nav.md](sidebar-nav.md) | `plugin-nav-badges` |
| Back and forward: the window strip's arrows, ⌘[ and ⌘], the mouse's buttons; archiving or removing the worktree in front goes back, not Home; the dashboard keeps its scroll | [navigation-history.md](navigation-history.md) | `navigation-history`; `app/e2e/back-forward.spec.ts` asserts it |
| Stopping agents from the Agent Dashboard: one, the picked ones, a column, Clean up; archiving their worktrees where it's safe | [dashboard-stop.md](dashboard-stop.md) | `dashboard-stop-archive`; `app/e2e/dashboard-stop-archive.spec.ts` asserts it |
| Plugins: built-in and your own, what they add (screens, sidebar items, widgets, panels) | [plugins.md](plugins.md) | `plugin-nav-badges` (sidebar items) |
| Home's widget grid | [home-widgets.md](home-widgets.md) | none yet; `app/e2e/home-widgets.spec.ts` asserts it |
| Questions in chat: an agent's form of questions as a card, answered on a real box; kept with Retry and Copy when it can't be | [chat-questions.md](chat-questions.md) | `chat-questions-live` (a real box, `--agent`); `app/e2e/chat.spec.ts` on the mock |
| Chat and board: no question card or answers but the options the agent's screen shows; the mode menu while turn check waits; a structured agent's form while its helpers report back, and a reply box that answers a card with nothing to pick | [chat-ask-card.md](chat-ask-card.md) | `chat-ask-card`, `chat-structured-ask-live` (a real box, `--agent`); `app/e2e/ask-card.spec.ts` on a stand-in box |
| Turn check's "working": an hourglass with why in the sidebar, the tab and the rail's card, not a live turn's spinner; a handoff reads as done | [turn-check-indicator.md](turn-check-indicator.md) | `turn-check-indicator`; `app/e2e/sidebar-turn-check.spec.ts` asserts it, `TestTurnCheckLive` asks the real provider |

## Proof and skip reporting

- Every proof names the feature file and the scenario it ran, and attaches the screenshots from the evidence folder.
- Something the mock can't show (the Mac app's window and updater, a plugin's helper on a box) is reported as not verified here, with what would verify it. A real box and agent of this checkout run on the same machine with `../scripts/dev-box.sh` (see [chat-questions.md](chat-questions.md)).
