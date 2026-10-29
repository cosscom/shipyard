# Questions in chat

When an agent asks with a form of its own (Claude Code's AskUserQuestion: up to four questions, each with options, some taking several picks, each with room for the person's own words), the chat draws it as a card: a step per question, then a review with **Submit answers**. The box fills in the agent's own form with keys, checking its screen after every key (`internal/box/answer.go`, POST `/v1/sessions/{name}/answer`). The card is `app/src/components/conversation/question-form.tsx`.

## Sub-features

- `questions-card`: the card's steps, the person's own words, the review, Submit; once answered it folds to what was answered (`app/e2e/chat.spec.ts`, mock).
- `questions-links`: a web address in a question, an option's label or description, the review, the card for an agent that can't be answered from the chat, or the screen-read "Needs your answer" card wraps inside the card. Every http(s) address in that text is a link to the whole address (`linked-text.tsx`, `lib/link-text.ts`), opened with `openUrl` (the system browser in the Mac app, `window.open` in a browser). A link in an option opens without picking the option, by click or Enter. An address that runs into the box's cut (the trailing "…" at 1,000 bytes, `internal/transcript` `clip`) is shown but not linked. The review's rows are buttons, so their text wraps but isn't linked (`scenarios/chat-question-links.mjs`, `app/e2e/question-links.spec.ts`, and `app/e2e/ask-card.spec.ts` for the screen-read card).
- `questions-deliver`: on a real box, long own words (wrapped by Claude Code), questions with lists in them, on an agent nobody has open (its pane at tmux's 80x24): every answer arrives word for word and the agent goes on. The box makes the pane tall enough while it answers and puts it back.
- `questions-kept`: when the box can't fill the form in, the card keeps every answer and says why, with **Retry** and **Copy answers** (each answer on a line under its question's name), and the agent's own screen opens under it to finish there. A retry that goes closes both.
- `questions-log`: every answer that doesn't go is in the box's log with why, and the screen it stopped at.

## How to get to it (user POV)

- Open an agent in chat and have it ask (or ask it to call AskUserQuestion). The card is in the conversation, and the reply box points at it.

## Driving it with drive.mjs

- Mock: `app/e2e/chat.spec.ts` covers the card and, with `?scene=answer-stuck`, a first submit that fails then a Retry.
- Mock, long addresses (`?scene=question-links`, made-up sign-in addresses): `node .claude/skills/verify-berthd/scripts/drive.mjs chat-question-links --port $PORT`. At 1440x900 and 390x844 (the sidebar hidden), in Shipyard Dark and Shipyard Light (picked from the command palette), it checks that the card doesn't run past its edge. It also checks that each link's href is the literal whole address and that clicking a link in an option, or pressing Enter on it, records a `window.open` of that address and leaves the option unpicked. Step 2's cut-short address has no link, and the review shows the question whole.
- Real box: `scenarios/chat-questions-live.mjs`, on a dev box of this checkout (`../scripts/dev-box.sh`):

```sh
.claude/skills/verify-berthd/scripts/dev-box.sh up
eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"   # the token stays in env
# An agent nobody has open sits at 80x24:
tmux -L berth resize-window -t ask -x 80 -y 24 && tmux -L berth set-option -w -u -t ask window-size
node .claude/skills/verify-berthd/scripts/drive.mjs chat-questions-live --port $PORT --agent http://127.0.0.1:9378
# The failure path: Claude's own-words row holds something else when the box gets there.
VERIFY_SURPRISE="tmux -L berth send-keys -t ask Down Down Down && sleep 0.6 && tmux -L berth send-keys -t ask -l 'typed in the terminal' && sleep 0.8" \
VERIFY_UNSURPRISE="tmux -L berth send-keys -t ask -N 21 BSpace && sleep 0.8" \
node .claude/skills/verify-berthd/scripts/drive.mjs chat-questions-live --port $PORT --agent http://127.0.0.1:9378
.claude/skills/verify-berthd/scripts/dev-box.sh down
```

The preview must be opened as `http://localhost:<1420-1439>`: the agent's API only takes those origins. Second view: Claude's own record (`~/.claude/projects/*acme-shop*/*.jsonl`) has the tool result with every answer, and the dev box's log (`/tmp/verify-berthd-box/berthd.log`) has `answer ask: answered 3 questions`, or why not with the screen.

## Gotchas

- At 390px wide the sidebar stays open and leaves the chat ~120px: hide it ("Hide the sidebar") before judging a narrow layout.
- The app's theme is Shipyard Dark unless picked, not the system's, so `emulateMedia({ colorScheme })` changes nothing. Pick a theme from the command palette.

- The scenario sends its prompt from the chat, so the session must be at its prompt: one left at a form from a failed run needs Esc first.
- A box started from the app starts agents structured (Claude through its SDK, which answers through a hook, not keys); `dev-box.sh` sets the box's defaults so they start in their terminals, the path this covers. A structured agent's questions are covered by `chat-structured-ask-live` (`VERIFY_DRIVER=claude .claude/skills/verify-berthd/scripts/dev-box.sh up`, [chat-ask-card.md](chat-ask-card.md)).
- `dev-box.sh up` refuses if the dev box rewrote the agent hooks in your home (it does that only when they are older than its own); put them back from your backup before going on.
