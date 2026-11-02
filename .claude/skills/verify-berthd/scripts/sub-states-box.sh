#!/usr/bin/env bash
# sub-states-box.sh up|down: what dashboard-sub-states-live drives: a dev box
# with a structured Claude and turn check on (devq, from dev-box.sh), and a
# second box of this build paired to the same agent (devr), so an edit can be
# seen to spread. Unsets every BERTH_* first: a worker's turn hooks off in its
# agents otherwise. The turn check key goes over stdin, never a command line.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
for v in $(env | grep -oE '^BERTH_[A-Z_]+'); do unset "$v"; done
export VERIFY_BOX_DIR=${VERIFY_BOX_DIR:-/tmp/verify-berthd-box}
d=$VERIFY_BOX_DIR
second=${VERIFY_SECOND_BOX_ADDR:-127.0.0.1:7546}
second_env=(BERTH_HOME="$d/b2-home" BERTH_USER_DIR="$d/b2-user" TMUX_TMPDIR="$d/b2-tmux")

case ${1:-} in
up)
  key=${VERIFY_TURNCHECK_KEY_FILE:-$HOME/.config/berth/box/turncheck.key}
  [[ -r $key ]] || { echo "no turn check key at $key (VERIFY_TURNCHECK_KEY_FILE)" >&2; exit 1; }
  VERIFY_DRIVER=claude "$here/dev-box.sh" up
  eval "$("$here/dev-box.sh" env)"
  mkdir -p "$d/b2-home" "$d/b2-user" "$d/b2-tmux" && chmod 700 "$d/b2-tmux"
  env "${second_env[@]}" nohup "$root/bin/berthd" serve --listen "$second" >"$d/b2.log" 2>&1 &
  echo $! >"$d/b2.pid"
  for _ in $(seq 60); do grep -q "berthd serving" "$d/b2.log" && break; sleep 0.5; done
  link=$(env "${second_env[@]}" "$root/bin/berthd" pair --address "$second" --json | jq -r .link)
  env BERTH_HOME="$d/lap-home" BERTH_USER_DIR="$d/lap-user" BERTH_UI_ADDR=127.0.0.1:9378 BERTH_PROXY_ADDR=127.0.0.1:9377 "$root/bin/berth" pair "$link" --name devr >/dev/null
  jq -n --rawfile k "$key" '{enabled:true,provider:"gateway",model:"typesafe-ai/jev",key_value:($k|gsub("\\s";""))}' |
    curl -sf -X PUT -H "Authorization: Bearer $VERIFY_BERTH_TOKEN" -H 'content-type: application/json' http://127.0.0.1:9378/v1/boxes/devq/api/turncheck -d @- >/dev/null
  echo "up: boxes devq (turn check on) and devr ($second)"
  ;;
down)
  [[ -f $d/b2.pid ]] && kill "$(cat "$d/b2.pid")" 2>/dev/null || true
  env TMUX_TMPDIR="$d/b2-tmux" tmux -L berth kill-server 2>/dev/null || true
  "$here/dev-box.sh" down
  ;;
*)
  echo "usage: sub-states-box.sh up|down" >&2
  exit 2
  ;;
esac
