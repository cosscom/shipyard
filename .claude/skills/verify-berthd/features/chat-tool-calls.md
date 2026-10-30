# Chat: tool calls, opened

An agent's steps fold into the chat. A turn's steps sit under one line (**Working · read 2 files**, then **Worked …** once it ends); under it, calls of a kind group (**Read 2 files**, **Searched 3 times**, **Ran 2 commands**), and each call is a row: its verb, its target, and a chevron. Opening a row asks the box for that call's detail (GET `…/sessions/{name}/transcript/tool/{id}`; a helper's `…/subagents/{id}/tool/{tool}`) and draws it as the terminal does: a command and its output, a search and its matches, an edit's change, a written file (`app/src/components/conversation/conversation-view.tsx` `Tools`, `ToolRow`, `ToolDetailView`; `internal/transcript/detail.go`).

A call that returned pictures (a Read of a .png or .jpg, a screenshot tool) shows each picture where the terminal says `[image]`, from the conversation's own record, not the file: it shows for files outside the worktree, changed or deleted since. The detail only names them (`images: [{n, line, mediaType}]`, `line` being where each stands in the output: its own `[image]` line, or the `… more lines …` line when the middle of a long output is cut, so a text block that itself reads `[image]` stays text); the app fetches each one's bytes once the row is open (GET `…/tool/{id}/image/{n}`, through the agent with its token, as a blob URL), as a thumbnail up to 320 px tall that opens at full size (`tool-image.tsx`, `lib/tool-images.ts`). Only PNG, JPEG, GIF and WebP are served; anything else, or a picture the box can't read back (the record rotated past the box's 32 MB window), stays the text `[image]`.

## Sub-features

- `tool-groups`: a turn's steps fold under one line; calls group by kind with a count; a group still running opens, and folds to its summary a moment after it finishes in view.
- `tool-detail`: a row opens to its detail, read when opened; a call that is gone from the record says so.
- `tool-images`: a call's pictures in place of its `[image]` lines, fetched only once opened; a click opens one at full size, Escape closes it; the picture is the record's, so it outlives the file.

## How to get to it (user POV)

- Open an agent in chat, open **Worked …** and a group such as **Read 3 files**, then a row.
- On the mock: `gpu/shop`'s chat, **Read 3 files**: `webhook.ts` opens to its lines, `checkout-result.png` to a drawn checkout page.
- On a real box: ask the agent to read a picture, such as a screenshot in `/tmp`.

## Driving it with drive.mjs

- Mock: `app/e2e/chat.spec.ts` asserts it ("a tool call opens to what it did", "a call that returned a picture shows it once opened, …": the picture isn't asked for before the row opens, `window.__berthToolImages`).
- Real box: `scenarios/chat-tool-image-live.mjs` (`live = true`), on a dev box of this checkout, in either driver:

```sh
VERIFY_BOX_DIR=/tmp/vb-$$ .claude/skills/verify-berthd/scripts/dev-box.sh up   # or VERIFY_DRIVER=claude … up
eval "$(VERIFY_BOX_DIR=/tmp/vb-$$ .claude/skills/verify-berthd/scripts/dev-box.sh env)"
VERIFY_WORKTREE=devq/acme-shop node .claude/skills/verify-berthd/scripts/drive.mjs chat-tool-image-live --port $PORT --agent http://127.0.0.1:9378
# The build before: [image] as text. Main's berthd and main's app, same box:
VERIFY_BOX_DIR=/tmp/vb-$$ .claude/skills/verify-berthd/scripts/dev-box.sh restart <main checkout>/bin/berthd
VERIFY_EXPECT=text VERIFY_WORKTREE=devq/acme-shop node .claude/skills/verify-berthd/scripts/drive.mjs chat-tool-image-live --port <main's preview> --agent http://127.0.0.1:9378
```

It draws `/tmp/acme-shot.png` (a synthetic acme checkout page, 480x300), has Claude Code read it from the chat, and waits until that Read's detail names one PNG. Second view: the box's image route, through the agent (`call(…, { raw: true })`), gives back the very bytes of the file. Then it opens the row (the thumbnail's `naturalWidth` is 480, no `[image]` text), opens it full size and closes it, deletes the file, and opens the row again: the picture still shows.

- Go: `TestDetailNamesTheImagesAResultHoldsButNotTheirBytes` and `TestAToolsImagesStandAtTheirOwnLines` (`internal/transcript`), `TestAToolsImagesAreServedFromTheTranscript` (`internal/box`: the session's and a helper's route, a bad index and an unknown call are 404).

## Gotchas

- A terminal agent's folder that Claude Code already trusts gets dev-box.sh's Up+Enter as a prompt, which re-sends the last one: on a second `up` in the same `VERIFY_BOX_DIR` the chat has an extra Read. The scenario waits for a Read after its own prompt, so it still holds; for clean screenshots use a fresh `VERIFY_BOX_DIR`, or the structured driver.
- The pictures are never in the detail itself, so a chat's 2 s polling and the 32 KB output cap never carry image bytes. The box marks them cacheable (`private, immutable`): a row opened again may not ask the box at all.
