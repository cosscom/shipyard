# Inbox (listed plugin)

`plugins/inbox` is a plugin in the listing (`"marketplace": true`), not built in: one list of what every agent needs from the person, grouped by what it needs (decision, action, ready to review or merge, blocked or crashed), with each item's card answering back to the session that asked. It reads what the app already has (sessions, their asks, transcripts, runs) through `@berth/plugin`. `src/model.ts` is the rules, `src/store.ts` talks to the boxes, the rest draws. Stable hooks are its `inbox-*` and `peek-*` test ids.

## Sub-features

| Feature | What a person does | Proof |
|---|---|---|
| The list | Opens Inbox, sees the groups, oldest first, with a count equal to the list | `inbox-mock` |
| Moving around | `j`/`k`, click a row. A new item never replaces the card you're on | `inbox-mock`; rule in `plugins/inbox/src/model.test.ts` |
| Walk-through | `w`: one card at a time, "N left", "1 of N" | `inbox-mock` |
| Answering a form | Number keys pick, recommended is marked, Enter sends. Reaches the agent | `inbox-mock` (payload), `inbox-live` (both drivers) |
| A pick with a note | The note goes with the pick as one line, double quotes survive | `inbox-live` (both drivers) |
| Permission prompts | Allow, Always allow, Deny, by key or click. The command runs | `inbox-live` (both drivers) |
| Close session | A few seconds to undo. Nothing unsaved: it stops at once, with no agent turn. Unsaved work: the agent saves it and closes itself | `inbox-mock` (undo, stop), `inbox-live` (clean and form on both drivers; permission on the chat driver, and on the terminal only the deny: see Gotchas) |
| Snooze | `h` then 1/2/3. Leaves the count, shows "N snoozed", returns when due | `inbox-mock`; return in `model.test.ts` |
| Peek | `p`: the session beside the card, following along, work folded into one line that opens on a click. The draft stays | `inbox-mock`, `inbox-live` |
| How a turn ended | An interrupted or failed agent says so on the card and in the peek, whatever its title still claims | `inbox-mock`; rule in `model.test.ts` |
| Drafts | Walking away and back keeps what you wrote | `inbox-mock` |
| Typing is safe | No shortcut fires in the note, so a dictation tool can type there | `inbox-mock` |
| Dismiss | A secret request or a session already gone leaves the list | Not driven yet |
| Agents on their own screen | Trust prompt and similar: shows the screen, offers Open session, no reply box | By hand on a fresh dev box. No scenario yet |
| Run gates | Approve or Reject on the card | Shown in `inbox-mock`. Deciding isn't driven yet |
| Secret requests | Listed as an action, filled in the session | `model.test.ts`. Not driven yet |
| Crashed or exited sessions | Blocked group, Resume | `model.test.ts`. Resume isn't driven yet |
| In the listing | Settings → Plugins → Browse lists Inbox; Install puts it in `~/.berth/plugins/inbox`, off | `pnpm -C app check:marketplace`; `TestTheCommittedListingInstalls` installs every listed plugin |

## How to get to it (user POV)

- Settings → Plugins → Browse → Install beside Inbox, then turn it on under Installed. It shows under More, or pinned from More → Customize sidebar.
- The scenarios skip the install: `drive.mjs` loads `plugins/inbox/dist/index.js` as an extra built-in, so build it first.

## Driving it with drive.mjs

```sh
(cd plugins/inbox && pnpm install && pnpm test && pnpm build)
node .claude/skills/verify-berthd/scripts/drive.mjs inbox-mock --port $PORT
```

`inbox-mock` runs on the mock with `?structured=1`. The mock has no transcripts for a plugin's own requests, so the scenario wraps the plugin's `berth.api.request` with synthetic ones ("acme"), adds one interrupted session whose title still asks, and keeps what the plugin sends on `window.__inboxSent`. It checks the exact answer payload, and that Close stops a clean session with a `DELETE`.

Real Claude Code, once per driver. It costs a few real turns on the signed-in account:

```sh
d=/tmp/vb-inbox-$$; export VERIFY_BOX_DIR=$d
for p in 7544 9377 9378; do ss -ltn | grep -q ":$p " && echo "port $p is taken: another dev box is up"; done
env -u BERTH_DRIVER -u BERTH_SESSION .claude/skills/verify-berthd/scripts/dev-box.sh up
eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"   # the token stays in env
# Claude can stop at its trust prompt on a fresh folder: if the "ask" session shows it, accept it once. Then remove "ask".
tm() { tmux -L berth "$@"; }
for _ in $(seq 20); do tm capture-pane -p -t ask | grep -qE 'trust this folder|^❯ *$' && break; sleep 1; done
if tm capture-pane -p -t ask | grep -q 'trust this folder'; then
  for _ in 1 2 3; do tm capture-pane -p -t ask | grep -q '❯ .*Yes, I trust' && break; tm send-keys -t ask Down; sleep 0.5; done
  tm send-keys -t ask Enter
fi
curl -s -X DELETE -H "Authorization: Bearer $VERIFY_BERTH_TOKEN" http://127.0.0.1:9378/v1/boxes/devq/api/sessions/ask
VERIFY_INBOX_DRIVER=terminal node .claude/skills/verify-berthd/scripts/drive.mjs inbox-live --port $PORT --agent http://127.0.0.1:9378
VERIFY_INBOX_DRIVER=claude   node .claude/skills/verify-berthd/scripts/drive.mjs inbox-live --port $PORT --agent http://127.0.0.1:9378
.claude/skills/verify-berthd/scripts/dev-box.sh down; sleep 3; rm -rf "$d"
```

`inbox-live` names the driver (and bypass mode) on every session it starts and checks they have it: the app puts its own agent defaults on the box when it connects, so a scenario that set the box's defaults would race it. On the terminal driver the box ignores `mode` and runs `claude '<prompt>'`, which takes its permission mode from the machine's Claude settings (often bypass), so the two sessions that must ask, and the one that must not, start from a command naming `--permission-mode default` or `--dangerously-skip-permissions`. Second views: each agent's own transcript (`GET …/sessions/<name>/transcript`) says the answer back word for word; an allowed command's file is in the dev box's `acme-shop` and a denied one's isn't; before Close over unsaved work `git status` lists that file, and the agent's transcript gets the Inbox's "commit and push, then close" before the session is gone from `GET …/sessions`. It starts from nothing unsaved: it gives `acme-shop` a local remote (`acme-shop.git` beside it) and commits and pushes whatever an earlier run left, because the Inbox counts commits on no remote as unsaved too. Its files are named per run, so a second driver's run makes fresh unsaved work. It removes its sessions at the end. It doesn't check what the agent chose to commit: that's the agent's call.

## Gotchas

- Answers run through the plugin's `answerFor`. A change there needs `inbox-live` on both drivers: a box refuses a single choice with both a pick and words, so a pick with a note goes as one line, and a straight `"` in an answer is cut short on the chat driver unless it's turned into a curly one (the scenario checks `”calm”`).
- The app's floating card for a running loop (devl's "Agent working · Round 2" on the mock) covers the right end of the Inbox's bottom bar, where Close session's **Undo** is. `inbox-mock` presses Undo with Enter on the button, as `dashboard-stop-archive` does for the Worktrees bulk bar. A person with a loop running has to fold the card first: a known gap in the plugin, not in the scenario.
- **Close on a terminal agent's permission prompt doesn't finish.** The Inbox presses Deny, Claude stops at "What should Claude do instead?", and the Inbox's "commit and push, then close" goes with `when: "idle"`. On the terminal driver the box still has the session `waiting` after that interrupt (no hook fires), so the message stays queued (`queued: 1`) and the agent never closes. `inbox-live` checks the deny there (the interrupt in the transcript, no file written) and not the close; on the chat driver it checks both.
- Without sub-states of Needs you on the box, every waiting session sorts as a decision; the scenarios don't depend on the split.
- Live screenshots show only the dev box's synthetic sessions. Never drive it against a real fleet for a PR.
- Run `dev-box.sh` with `BERTH_DRIVER` unset when you are an agent yourself, or its agents inherit your driver.
