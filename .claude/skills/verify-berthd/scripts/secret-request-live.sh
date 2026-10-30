#!/usr/bin/env bash
# secret-request-live.sh: on the box dev-box.sh starts, the real Claude in
# session "ask" asks for a secret with `berthd secret request`, the app (or,
# with VERIFY_SAVE=api, the laptop agent's API the app calls) saves a
# sentinel value, and the agent uses it in one command with
# `berthd secret exec --env` and `--file`, checking its sha256. Then every
# place a value must never be is grepped for the sentinel: the agent's
# transcript, the structured host's log, the box's log and state (events,
# turns, inbox, run records, notify), and the laptop agent's state with its
# offline queue. Each must have 0 hits.
#
#   dev-box.sh up                                    # terminal Claude (or VERIFY_DRIVER=claude: structured)
#   PORT=1433 secret-request-live.sh                 # saves through the app on vite preview :1433
#   VERIFY_SAVE=api secret-request-live.sh           # saves through the agent's API, no browser
#   dev-box.sh down
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
dir=${VERIFY_BOX_DIR:-/tmp/verify-berthd-box}
eval "$("$here/dev-box.sh" env 2>/dev/null)"
api=http://127.0.0.1:9378/v1/boxes/devq/api
out=${VERIFY_OUT:-/tmp/verify-berthd/secret-request-live-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$out"
call() { curl -sS -H "Authorization: Bearer $VERIFY_BERTH_TOKEN" -H "Content-Type: application/json" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# A fresh sentinel each run, and the hash the agent compares with: the
# agent is only ever given the hash.
sentinel="acme-sentinel-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
hash=$(printf %s "$sentinel" | sha256sum | cut -d' ' -f1)
name=ACME_TOKEN
berthd=$root/bin/berthd
marks=$(mktemp -d /tmp/secret-live-XXXX)

send() { call -X POST "$api/sessions/ask/send" -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "when": "idle"}))' "$1")" >/dev/null; }

echo "1. the agent asks for $name"
# An earlier run's secret would come back at once, with no card.
call "$api/secrets" | python3 -c "
import json,sys
for s in json.load(sys.stdin).get('secrets', []):
    if s['name'] == '$name': print(s['ref'])" | while read -r ref; do
  call -X POST "$api/secrets/delete" -d "{\"ref\":\"$ref\",\"confirm\":\"$name\"}" >/dev/null
done
send "Run exactly this shell command, then end your turn without running anything else: $berthd secret request $name --reason 'verify: deploy the acme app to staging' --ttl 24h"
id=""
for _ in $(seq 120); do
  id=$(call "$api/secrets/requests" | python3 -c "
import json,sys
for r in json.load(sys.stdin):
    if r['session'] == 'ask' and r['name'] == '$name': print(r['id'])" | head -1)
  [[ -n $id ]] && break
  sleep 1
done
[[ -n $id ]] || fail "no request from the agent after 2 minutes"
echo "   request $id"
state=$(call "$api/sessions" | python3 -c "
import json,sys
s=[x for x in json.load(sys.stdin) if x['name']=='ask'][0]
print(s.get('agent_state'), (s.get('secret_request') or {}).get('id'))")
[[ $state == "waiting $id" ]] || fail "the session doesn't read as waiting on the request: $state"

echo "2. the person saves it"
if [[ ${VERIFY_SAVE:-app} == api ]]; then
  res=$(call -X POST "$api/secrets/requests/$id/save" -d "{\"value\":\"$sentinel\",\"expires\":\"\"}")
  [[ $(json 'd["ref"]' <<<"$res") == "box://$name" ]] || fail "save: $res"
else
  [[ -n ${PORT:-} ]] || fail "PORT (the app's vite preview) is needed to save through the app; or VERIFY_SAVE=api"
  VERIFY_SECRET_SENTINEL=$sentinel node "$here/drive.mjs" secret-request-live --port "$PORT" --agent http://127.0.0.1:9378 --out "$out/app"
fi
[[ $(call "$api/secrets/requests/$id" | json 'd["status"]') == saved ]] || fail "the request isn't saved"

echo "3. the agent hears back, and uses it in one command"
# The notification is a turn of its own; the next prompt waits behind it.
send "Run exactly these two shell commands, then end your turn. Do not print the secret.
$berthd secret exec --env T=box://$name -- sh -c '[ \"\$(printf %s \"\$T\" | sha256sum | cut -d\" \" -f1)\" = $hash ] && echo ok > $marks/env'
$berthd secret exec --file F=box://$name -- sh -c '[ \"\$(sha256sum < \"\$F\" | cut -d\" \" -f1)\" = $hash ] && echo \"\$F\" > $marks/file'"
for _ in $(seq 240); do
  [[ -s $marks/env && -s $marks/file ]] && break
  sleep 1
done
[[ -s $marks/env ]] || fail "secret exec --env: the hash didn't match, or it never ran"
[[ -s $marks/file ]] || fail "secret exec --file: the hash didn't match, or it never ran"
tmpfile=$(cat "$marks/file")
[[ ! -e $tmpfile ]] || fail "--file left $tmpfile behind"
echo "   --env and --file both matched; $tmpfile is gone"
sleep 5

echo "4. the sentinel is nowhere it must not be"
# The agent's own transcript: Claude keeps it under ~/.claude/projects by
# folder; the structured host's log and every state file of the box and
# the laptop agent are under $dir, the encrypted store too (sealed, so it
# holds no plaintext either).
proj=$HOME/.claude/projects/$(sed 's#[/.]#-#g' <<<"$dir/acme-shop")
hits=0
for where in "$dir" "$proj"; do
  [[ -e $where ]] || continue
  if found=$(grep -rlF "$sentinel" "$where" 2>/dev/null); then
    echo "   HIT in: $found" >&2
    hits=$((hits + $(wc -l <<<"$found")))
  fi
done
screen=$(env TMUX_TMPDIR="$dir/tmux" tmux -L berth capture-pane -p -S - -t ask 2>/dev/null || true)
if grep -qF "$sentinel" <<<"$screen"; then echo "   HIT on the agent's screen" >&2; hits=$((hits + 1)); fi
echo "   grepped: $dir (box log, box and laptop state: events, turns.json, inbox.json, runs, notify.json, queue.json), $proj, the agent's screen"
[[ $hits == 0 ]] || fail "$hits places hold the sentinel"
call "$api/secrets" >"$out/secrets.json"
grep -qF "$sentinel" "$out/secrets.json" && fail "GET secrets holds the value"
rm -rf "$marks"
echo "OK: requested, saved, used by --env and --file, 0 hits for the sentinel. Evidence: $out"
