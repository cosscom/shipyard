# What a phone and an agent read

A box serves phones a narrow API on its tailnet address, port 1379 (`internal/box/phone.go`, `phonev2.go`, `docs/reference/phone-api.mdx`), and agents get typed tools from `berthd mcp` over the box's own socket (`internal/mcpserver`). Neither has a screen in the desktop app to look at, so this is proved on a real box, with the box's own API as the second view.

## Sub-features

- `attention-reads`: `GET /phone/v1/attention[?session=S]` and the `berth_attention` tool list the box's open [attention items](plugins.md) (`plugin-attention`), the most recently changed first, as `AttentionBrief`: key, revision, kind, title, options, recommended, status, snoozed_until, session, created and updated. They never carry an item's `details`, `answer` or `by`. Settled items aren't listed. The phone route needs the phone token (401 without it or with a wrong one) and is only read: `POST`, `PATCH` and `DELETE` are refused. `info` lists `attention` in `capabilities` on a box that keeps items.

## How to get to it (user POV)

- A paired phone, with phone access on in Settings → Phone: `curl -H "Authorization: Bearer <token>" http://<tailnet ip>:1379/phone/v1/attention`.
- An agent on the box: the `berth_attention` tool, once `berthd integrations install` has added `berthd mcp`.

## Driving it

`../scripts/attention-reads-live.sh [OUT]` builds berthd from this checkout and runs a box in a user and network namespace of its own (`unshare -rn`), with a dummy interface on 100.64.7.9. The box's phone listener then gets its own port 1379 and never meets the machine's Shipyard or another session's dev box, so it can run while `dev-box.sh` or `attention-live.sh` are up. It starts a plain `sh` session, turns phone access on over the socket, posts an ask about the session (with details), puts a snooze mark on a signal key, and posts and answers a third item. Then it reads the list through the phone listener (with the token, without it, with a wrong one, and a `POST`) and through `berthd mcp` (`initialize`, `tools/list`, `tools/call`). It checks both against `GET /v1/attention?open=1` with the words taken out, and greps both answers for the item's words. It prints `ok: …` and leaves each answer as JSON in OUT (default `/tmp/verify-berthd/attention-reads-<time>`), never the token. It runs in about 30 seconds, mostly the build.

The unit tests are `go test ./internal/box -run TestThePhone.*Attention` and `go test ./internal/mcpserver -run Attention`.

## Gotchas

- `unshare -rn` needs unprivileged user namespaces (on by default on the devbox's Ubuntu). Inside, the box runs as a mapped root with `HOME` in its own temp folder, so it can't rewrite the machine's agent hooks.
- The phone's `Host` must be the listener's own address and port (`100.64.7.9:1379`), or it answers 403 before it checks the token.
