#!/usr/bin/env bash
# agent-box.sh up|env|stop|start|restart [SECONDS]|down: a laptop agent of
# this checkout's build with one empty box paired ("devr", so the app is
# past onboarding), on their own state and ports (agent UI 127.0.0.1:9468,
# proxy 9467, box 7546; never 1377-1379), for what the app reads from the
# agent itself, such as its /v1/app documents. No agent runs on the box.
# `up` builds both into the state folder; `stop`, `start` and `restart 2`
# (2 seconds between) take the laptop agent down and up again, the box
# untouched; `env` prints what drive.mjs needs; `down` stops both and
# deletes the state.
#
#   VERIFY_AGENT_DIR=/tmp/va-NNNN  the state (default /tmp/verify-berthd-agent)
#   VERIFY_AGENT_BIN=<berth>       another build of the laptop agent, say main's
#
# The app's documents are in $VERIFY_AGENT_DIR/user/app/<key>.json: seed one
# before `up` (sidebar-layout-restart.sh does). The box's HOME is in the
# state folder too, so it never touches the real one's agent hooks.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
dir=${VERIFY_AGENT_DIR:-/tmp/verify-berthd-agent}
ui=127.0.0.1:9468
addr=127.0.0.1:7546
bin=${VERIFY_AGENT_BIN:-$dir/bin/berth}
lap_env=(BERTH_HOME="$dir/home" BERTH_USER_DIR="$dir/user" BERTH_UI_ADDR="$ui" BERTH_PROXY_ADDR=127.0.0.1:9467)
box_env=(HOME="$dir/box-home" BERTH_HOME="$dir/box-home" BERTH_USER_DIR="$dir/box-user" TMUX_TMPDIR="$dir/tmux")
box() { env "${box_env[@]}" "$dir/bin/berthd" "$@"; }

# ours: the agent listening on the UI port with this state, no other.
ours() {
  for pid in $(ss -ltnpH "sport = :${ui##*:}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx "BERTH_HOME=$dir/home" && echo "$pid"
  done
  return 0
}
start() {
  mkdir -p "$dir"/{home,user}
  env "${lap_env[@]}" setsid nohup "$bin" agent >>"$dir/agent.log" 2>&1 </dev/null &
  for _ in $(seq 120); do
    curl -s -o /dev/null "http://$ui/" && return
    sleep 0.25
  done
  echo "the agent isn't answering on $ui after 30 s: $dir/agent.log" >&2
  exit 1
}
stop() {
  local pids
  pids=$(ours)
  [[ -z $pids ]] && return
  kill $pids
  for _ in $(seq 100); do
    [[ -z $(ours) ]] && ! ss -ltnH "sport = :${ui##*:}" | grep -q . && return
    sleep 0.1
  done
  echo "the agent ($pids) is still running after 10 s" >&2
  exit 1
}

case ${1:-} in
up)
  for p in 7546 9467 9468; do
    if ss -ltn | grep -q ":$p "; then echo "port $p is taken: is an agent up already? ($0 down)" >&2; exit 1; fi
  done
  mkdir -p "$dir"/{home,user,box-home,box-user,tmux,bin} && chmod 700 "$dir/tmux"
  (cd "$root" && go build -o "$dir/bin/" ./cmd/berth ./cmd/berthd)
  env "${box_env[@]}" setsid nohup "$dir/bin/berthd" serve --listen "$addr" >"$dir/berthd.log" 2>&1 </dev/null &
  box_pid=$!
  echo $box_pid >"$dir/berthd.pid"
  for _ in $(seq 120); do
    grep -q "berthd serving" "$dir/berthd.log" && break
    kill -0 $box_pid 2>/dev/null || { echo "berthd exited before it served: $dir/berthd.log" >&2; exit 1; }
    sleep 0.5
  done
  grep -q "berthd serving" "$dir/berthd.log" || { echo "the box isn't serving: $dir/berthd.log" >&2; exit 1; }
  start
  env "${lap_env[@]}" "$bin" pair "$(box pair --address "$addr" --json | jq -r .link)" --name devr >/dev/null
  echo "up: agent http://$ui with box devr ($addr), state $dir"
  ;;
start) start ;;
stop) stop ;;
restart)
  stop
  sleep "${2:-0}"
  start
  ;;
env)
  # VERIFY_BERTH_TOKEN is a secret: export it, don't print it anywhere else.
  echo "export VERIFY_BERTH_TOKEN=$(env "${lap_env[@]}" "$bin" ui-token | jq -r .token) VERIFY_AGENT_DIR=$dir"
  ;;
down)
  stop
  [[ -f $dir/berthd.pid ]] && kill "$(cat "$dir/berthd.pid")" 2>/dev/null || true
  env TMUX_TMPDIR="$dir/tmux" tmux -L berth kill-server 2>/dev/null || true
  rm -rf "$dir"
  echo "down: $dir removed"
  ;;
*)
  echo "usage: agent-box.sh up|env|stop|start|restart [SECONDS]|down" >&2
  exit 2
  ;;
esac
