#!/usr/bin/env bash
# attention-reads-live.sh [OUT]: post attention items on a real box of this
# checkout's build, then read them back the way a phone and an agent do:
# GET /phone/v1/attention on the box's phone listener, with and without its
# token, and berthd mcp's berth_attention tool. Both must equal the box's
# own open list (GET /v1/attention?open=1) without details or answers.
#
# The box runs in a user and network namespace of its own (unshare -rn),
# with a dummy interface on a tailnet-looking address, so its phone
# listener gets its own port 1379 and never meets the machine's Shipyard or
# another session's dev box. No agent CLI runs: the session is a plain
# shell. Evidence (each answer, as JSON) goes to OUT, by default
# /tmp/verify-berthd/attention-reads-<time>; the phone token never does.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out=${1:-/tmp/verify-berthd/attention-reads-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$out"
dir=$(mktemp -d /tmp/vb-attention-reads.XXXXXX)
trap 'rm -rf "$dir"' EXIT
(cd "$root" && go build -o "$dir/berthd" ./cmd/berthd)

# The part that runs inside the namespace.
cat >"$dir/inside.sh" <<'INSIDE'
set -euo pipefail
dir=$1 out=$2
ip link set lo up
ip link add ts0 type dummy && ip addr add 100.64.7.9/32 dev ts0 && ip link set ts0 up
export HOME=$dir/home BERTH_HOME=$dir/box-home BERTH_USER_DIR=$dir/box-user TMUX_TMPDIR=$dir/tmux
mkdir -p "$HOME" "$BERTH_HOME" "$BERTH_USER_DIR" "$TMUX_TMPDIR" && chmod 700 "$TMUX_TMPDIR"
"$dir/berthd" serve --listen 127.0.0.1:7600 >"$dir/berthd.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; tmux -L berth kill-server 2>/dev/null || true' EXIT
until grep -q "berthd serving" "$dir/berthd.log"; do sleep 0.3; done
sock=$(find "$BERTH_HOME" -name berthd.sock | head -1)
api() { curl -sS --unix-socket "$sock" -H 'Content-Type: application/json' -H 'X-Berth-Origin: app' "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A repository, and a plain shell session in it to be the ask's session.
repo=$dir/acme-shop
git init -q -b main "$repo" && echo "# acme shop" >"$repo/README.md"
git -C "$repo" add . && git -C "$repo" -c user.email=dev@acme.test -c user.name=acme commit -qm init
api -X POST http://box/v1/locations -d "{\"name\":\"acme-shop\",\"path\":\"$repo\"}" >/dev/null
sess=$(api -X POST http://box/v1/sessions -d '{"location":"acme-shop","command":"sh"}' | jq -r .name)
[[ -n $sess && $sess != null ]] || fail "no session"

# Phone access on, as a paired laptop turns it on. Keep the token out of OUT.
token=$(api -X PUT http://box/v1/phone -d '{"enabled":true}' | jq -r .token)
for _ in $(seq 50); do curl -s -o /dev/null http://100.64.7.9:1379/ && break; sleep 0.2; done
phone() { curl -sS -H "Host: 100.64.7.9:1379" "$@"; }

# The items: an agent's ask about the session, a person's snooze on a
# signal, and an ask that was answered (settled, so never listed).
api -X POST http://box/v1/attention -d "{\"kind\":\"decision\",\"title\":\"Ship the acme checkout on Friday?\",\"details\":\"secret plans for the acme sale\",\"session\":\"$sess\",\"options\":[{\"label\":\"Ship\"},{\"label\":\"Wait\",\"description\":\"after the sale\"}],\"recommended\":\"Ship\"}" >"$out/posted.json"
api -X PATCH "http://box/v1/attention/$(jq -rn --arg k "signal:$sess:waiting" '$k|@uri')" -d '{"snoozed_until":"2030-01-01T09:00:00Z"}' >"$out/snoozed.json"
api -X POST http://box/v1/attention -d '{"key":"acme/rotate-key","kind":"action","title":"Rotate the acme API key"}' >/dev/null
api -X PATCH http://box/v1/attention/acme%2Frotate-key -d '{"answer":"rotated, secret-answer-words"}' >/dev/null

api 'http://box/v1/attention?open=1' >"$out/box-open.json"
api 'http://box/v1/attention' >"$out/box-all.json"
phone -H "Authorization: Bearer $token" http://100.64.7.9:1379/phone/v1/info >"$out/phone-info.json"
phone -H "Authorization: Bearer $token" http://100.64.7.9:1379/phone/v1/attention >"$out/phone-attention.json"
phone -H "Authorization: Bearer $token" "http://100.64.7.9:1379/phone/v1/attention?session=$sess" >"$out/phone-attention-session.json"
no_token=$(phone -o "$out/phone-no-token.json" -w '%{http_code}' http://100.64.7.9:1379/phone/v1/attention)
wrong_token=$(phone -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" http://100.64.7.9:1379/phone/v1/attention)
post_status=$(phone -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -d '{"kind":"decision","title":"from a phone"}' http://100.64.7.9:1379/phone/v1/attention)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"berth_attention","arguments":{}}}' |
  "$dir/berthd" mcp >"$out/mcp.ndjson"
jq -c 'select(.id==3) | .result.content[0].text | fromjson' "$out/mcp.ndjson" >"$out/mcp-attention.json"

# The checks.
brief='map({key,revision,kind,title,options,recommended,status,snoozed_until,session,created,updated} | with_entries(select(.value != null)))'
want=$(jq -cS "$brief" "$out/box-open.json")
[[ $(jq length "$out/box-open.json") == 2 && $(jq length "$out/box-all.json") == 3 ]] || fail "the box holds $(jq length "$out/box-all.json") items, $(jq length "$out/box-open.json") open"
[[ $(jq -cS . "$out/phone-attention.json") == "$want" ]] || fail "the phone's list isn't the box's: $(cat "$out/phone-attention.json")"
[[ $(jq -cS . "$out/mcp-attention.json") == "$want" ]] || fail "berth_attention isn't the box's list: $(cat "$out/mcp-attention.json")"
[[ $(jq -r 'map(.key)|join(",")' "$out/phone-attention-session.json") == "session:$sess" ]] || fail "one session's: $(cat "$out/phone-attention-session.json")"
jq -e '.capabilities | index("attention")' "$out/phone-info.json" >/dev/null || fail "info: $(cat "$out/phone-info.json")"
jq -e '.result.tools | map(.name) | index("berth_attention")' <(jq -c 'select(.id==2)' "$out/mcp.ndjson") >/dev/null || fail "tools/list has no berth_attention"
for f in phone-attention.json mcp-attention.json; do
  if grep -q 'secret\|"details"\|"answer"' "$out/$f"; then fail "$f carries an item's words"; fi
done
[[ $no_token == 401 && $wrong_token == 401 ]] || fail "without the token $no_token, wrong token $wrong_token"
[[ $post_status -ge 400 ]] || fail "a phone POST answered $post_status"
[[ $(jq length "$out/box-all.json") == 3 ]] || fail "a phone added an item"
grep -q "phone access on http://100.64.7.9:1379/" "$dir/berthd.log" || fail "no phone listener in the log"
echo "ok: box, phone and berth_attention list the same $(jq length "$out/phone-attention.json") open items, without words; no token 401, wrong token 401, phone POST $post_status"
INSIDE

unshare -rn bash "$dir/inside.sh" "$dir" "$out"
echo "evidence: $out"
