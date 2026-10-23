# The board's cards for agents in chat

An agent that runs in chat (structured: `Session.driver` is `claude`, `codex` or `acp`) has no screen of its own: its pane holds the host that runs it (`berthd agent-host`), which logs one line per frame (`out stream_event`, `out control_request`), and its command line is the host's, ending in `'--permission-prompt-tool' 'stdio'`. So its card on the Agent Dashboard reads the agent instead (`views/dashboard/agent-card.tsx`, `use-chat-tail.ts`, `lib/chat-card.ts`):

- **Waiting on you**: what it asks, from `Session.ask`. A permission shows its reason and the command (`$ pnpm …`) or the tool and file (`Edit src/x.ts`), with the answers it offers (`ask.choices`) as chips. A question (AskUserQuestion, ExitPlanMode) shows the question or its message, with chips only where it offers choices.
- **Otherwise**: the last lines of its newest reply, without Markdown's marks, or the step it took since (`Read search.ts`, `Edit src/x.ts +9 −2`), or a notice (a usage limit). It reads the conversation as a chat does (`GET sessions/{name}/transcript?since=N&gen=…`): the recent window once, then only what was added, which the box reads on from where it was (about 8 ms on a 30 MB record), keeping the newest 12 items. It reads when a terminal card would read its screen (on a state change, an event about it, and every 20s while it works), one read at a time, and not while the card shows an ask.
- **Hidden** when there's nothing yet (no ask, no reply, or a prompt it hasn't answered), and in Ready as before. Never a host frame.
- **The quote** under the title is its conversation's first prompt, or the command typed as one (`/ship ACME-12`), hidden when it repeats the title. Never "stdio". It is read once per session from the page at the record's start (`transcript?before=262144&limit=50`, paging back to the start when that holds more): the first prompt comes after the agent's opening frame, tens of KB in. A session's conversation list entry (`GET conversations`) has no title when its prompt was sent after it started, which is how orchestrators start agents, so it isn't used.

A terminal agent's card is unchanged: the last 3 meaningful lines of its screen, its menu's options as chips (see [chat-ask-card.md](chat-ask-card.md) `board-answers`).

## How to get to it (user POV)

- ⌘J (or Home with Labs off) opens the Agent Dashboard. Cards sit in Needs you, Working, Idle and Done.

## Driving it with drive.mjs

- On the mock: `scenarios/chat-board-cards.mjs` opens `?mock=1&structured=1`. There, devl's search-perf Claude (Done) and gpu's judge-v2 (Working), shop (Needs you: AskUserQuestion) and ci-flake (Needs you: a Bash permission with Yes / Yes, and don't ask again / No) run in chat, with the host's command line and pane log as a real box has them. checkout-fix's Claude stays in its terminal.
- It asserts each chat card's box and quote, the chips on the permission and none on the question, the terminal card's screen and chips, and that nowhere on the board shows `out stream_event`, `out control_request`, `out system`, `in user` or `stdio`. Screenshots: `1-waiting-permission` … `5-terminal`, `6-board`.
- `app/e2e/dashboard-chat-cards.spec.ts` asserts the same on the mock.

## Gotchas

- The mock's Review fixtures (`lib/mock-review.ts`) answer `screen` for search-perf and checkout-fix before the mock's own screens do, so search-perf's pane reads as a Claude screen there, not a host log. Its card doesn't read the screen, so this doesn't show on the board.
- Review's summary (`views/review/summary.ts`) still reads the pane for agents in chat.
