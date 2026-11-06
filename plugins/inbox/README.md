# Inbox

One inbox across all your agents. It shows what needs you, grouped by what it needs, and your answer goes straight back to the session that asked.

- **Four groups:** needs my decision, needs an action from me, ready to review or merge, blocked or crashed.
- **Question cards:** options with the recommended one marked, a note, Snooze, and Close session. A session with nothing unsaved stops at once; one with unsaved work saves it and closes itself.
- **Walk-through:** press `w` to go through items one at a time.
- **Peek:** press `p` to read the session beside the card, without losing your answer.
- **Keyboard first:** `1`–`9` pick, `↵` sends, `j`/`k` move, `h` snoozes, `x` closes, `n` writes a note, `o` opens the session. No shortcut fires while you're typing, so dictation tools work in the note.

It needs nothing from your agents. It reads the signals Shipyard already has: question forms, permission prompts, run gates and exits. Nothing is sent anywhere but your own boxes.

## Install

**Settings → Plugins → Browse**, then **Install** beside Inbox and turn it on under Installed. To keep it at hand, pin it from **More → Customize sidebar**.

## Limits for now

- Snooze and Dismiss marks stay on the computer you made them on.
- "Ready to review or merge" fills once agents can post to the Inbox, which needs a change in Shipyard.
- Resume works for a box's chat sessions, which keep a conversation record.
- Sessions sort into decision and action on a Shipyard with sub-states of Needs you. Without them, every waiting session is a decision.

## Develop

`src/model.ts` holds the rules and is pure, `src/store.ts` talks to the boxes, the rest draws. It uses only `@berth/plugin`.

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm build
mkdir -p ~/.berth/plugins && ln -s "$PWD" ~/.berth/plugins/inbox   # to try it in the app
```

- Use classes the app already has, or inline styles: a plugin's own Tailwind classes aren't generated.
- A key shortcut must never fire while a text field has focus.
- Raise `version` in `berth-plugin.json` and `package.json` when the code changes, then run `pnpm -C app build:marketplace`.
- To prove a change in the real app, run `inbox-mock` and `inbox-live` from [verify-berthd](../../.claude/skills/verify-berthd/features/inbox.md). Anything that changes what's sent to an agent needs `inbox-live` on both drivers.
