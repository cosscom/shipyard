# Attachments

Files pasted or dropped for an agent: a screenshot, a PDF, a log. They go up to the box first, into the worktree's `.berth/attachments` (git ignores it, `internal/box/attachments.go`), and the agent gets their paths, which Claude Code reads as it reads an image in a prompt. The hook is `useAttachments` and the chips are `AttachmentChips` (`app/src/components/conversation/attachments.tsx`); the rules for what goes and how a pasted screenshot shrinks are in `app/src/lib/attachments.ts`.

## Sub-features

- `attach-composer`: the chat's reply box, Home's composer and the prompt dialog take a pasted image (shrunk first when it's big), dropped files, and a pasted path to a file on this computer (uploaded by the laptop agent). Each shows as a chip with its upload's progress, a way to take it out, and Retry when it fails; Send waits until every upload is done, and the paths go after the prompt, one to a line (`app/e2e/composer.spec.ts`, `app/e2e/drop.spec.ts`).
- `attach-question`: a form of questions (Claude Code's AskUserQuestion, see [chat-questions.md](chat-questions.md)) takes images too. Pasted into a question's "Something else…" or dropped on the card, they show as chips under the question and turn its answer into the person's own words; images alone are an answer. While the form waits, the reply box hands it its files: ones dropped or pasted there, and ones already there, show on the card instead. Submit waits for every upload. The answer goes as one line, the paths after the words, parted by ", " so a path with a space stays one: `this one is off [attached: /…/My Projects/shop/.berth/attachments/…-checkout-step-2.png, /…/pasted-153012.png]`, which Claude opens with Read through either driver. Once it goes, the files leave the reply box; a submit that fails keeps them on the card. A pick made after an image leaves that image out of the answer, and in the reply box.
- `attach-question-wrap`: on the terminal driver the box types that line into Claude's form and reads it back from the screen. In a narrow pane (80x24, an agent nobody has open) Claude Code breaks a path longer than a line in the middle; the box reads the words back whatever the wraps (`internal/box/answer.go`, `TestDriveAttachedPathsOnAShortPane`, `internal/box/testdata/answer/own-words-paths-80.txt`).

## How to get to it (user POV)

- Paste (⌘V) a screenshot into the reply box, or drag files onto it.
- With a question card waiting: paste into its "Something else…", drag onto the card, or onto the reply box below it.

## Driving it with drive.mjs

- Mock: `app/e2e/chat.spec.ts` ("files in the reply box and dropped on the form go with its answer", "a screenshot pasted into the form's own words…") drives the card: chips, the reply box handing over, Submit held while a 2.5 MB file uploads, the failed submit keeping them, and the answer with the paths.
- Real box, both drivers: `../scripts/scenarios/chat-question-images-live.mjs` draws two images with words on them, drops one on the reply box (`checkout step 2.png`: the box makes that `checkout-step-2.png`) and pastes one into the card, submits, and waits for Claude to say what both show.

```sh
# A path with a space in it, as a worktree in ~/My Projects has: VERIFY_BOX_DIR='/tmp/verify berthd' (then use it for /tmp/verify-berthd-box below).
.claude/skills/verify-berthd/scripts/dev-box.sh up
eval "$(.claude/skills/verify-berthd/scripts/dev-box.sh env)"   # the token stays in env
# Terminal driver, the pane at 80x24 as for an agent nobody has open:
tmux -L berth resize-window -t ask -x 80 -y 24 && tmux -L berth set-option -w -u -t ask window-size
node .claude/skills/verify-berthd/scripts/drive.mjs chat-question-images-live --port $PORT --agent http://127.0.0.1:9378
# Structured (Claude's SDK): a second repo whose agent the box starts structured.
api() { curl -sf -X "$1" -H "Authorization: Bearer $VERIFY_BERTH_TOKEN" -H 'content-type: application/json' "http://127.0.0.1:9378/v1/boxes/devq/api/$2" ${3:+-d "$3"}; }
git init -q -b main /tmp/verify-berthd-box/acme-web && git -C /tmp/verify-berthd-box/acme-web -c user.email=dev@acme.test -c user.name=acme commit -q --allow-empty -m init
api PUT agents/defaults '{"structured":true,"mode":"bypassPermissions"}'
box() { env -u BERTH_DRIVER BERTH_HOME=/tmp/verify-berthd-box/box-home BERTH_USER_DIR=/tmp/verify-berthd-box/box-user TMUX_TMPDIR=/tmp/verify-berthd-box/tmux bin/berthd "$@"; }
box location add acme-web /tmp/verify-berthd-box/acme-web
box session new acme-web --name sdk --agent claude
VERIFY_WORKTREE=devq/acme-web node .claude/skills/verify-berthd/scripts/drive.mjs chat-question-images-live --port $PORT --agent http://127.0.0.1:9378
.claude/skills/verify-berthd/scripts/dev-box.sh down
```

Second view: the box's transcript (`GET /v1/boxes/devq/api/sessions/<name>/transcript` through the agent) has the question's answer with both paths and, after it, a `tools` item with two `Read`s of those files; Claude's own record (`~/.claude/projects/*acme*/*.jsonl`) has the tool result with the answer.

## Gotchas

- Run from an agent's own terminal, the caller's `BERTH_DRIVER=structured` used to reach the dev box's agents and turn their hooks off ("Claude isn't waiting for an answer"); `dev-box.sh` now starts the box without the caller's `BERTH_*`.
- The prompt must not mention images, or it proves nothing about the answer's wording.
- On Claude's SDK the box reads the answer back from Claude's result text, `"question"="answer"`, which doesn't escape quotes inside the answer: an encoding with `"` in it shows cut short once that record comes (`internal/transcript/questions.go`, `answerPair`). The scenario checks the answer again after Claude replies for that reason.
