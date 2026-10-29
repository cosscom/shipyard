#!/usr/bin/env bash
# dev-box.sh up|env|down: a box and a laptop agent of this checkout's
# build, on this machine, apart from the Shipyard already running here:
# their own state, tmux server and ports. `up` builds bin/, starts berthd
# on 127.0.0.1:7544 and the agent on 9377/9378 (never 1377-1379), pairs
# them as box "devq", adds a synthetic repo "acme-shop" and starts Claude
# Code in its terminal there, session "ask" (VERIFY_DRIVER=claude: Claude
# structured instead, as the app starts agents). `env` prints what
# drive.mjs and tmux need; `restart [berthd]` starts the box again, every
# conversation then read afresh, with another build if given (a main
# checkout's bin/berthd, for a before); `down` stops it all and deletes
# the state.
# VERIFY_BOX_ADDR=<ip>:7544 (say, `tailscale ip -4`) has the box listen and
# pair there instead: a box not on 127.0.0.1 is one the app treats as on
# another computer, so a laptop path goes up through the agent.
#
# HOME stays real: Claude Code needs its sign-in. The box refreshes
# Claude's hooks in ~ only when they are out of date; `up` stops if it
# did, so a dev box never changes the real one's hooks unnoticed.
set -euo pipefail
# Run from an agent's own terminal, the caller's BERTH_* (its session, and
# BERTH_DRIVER=structured, which turns `berthd hook` off) would reach the
# dev box's agents: none of them go in.
for v in $(compgen -e | grep '^BERTH_' || true); do unset "$v"; done
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# Short: a unix socket's path can't be longer than 108 bytes.
dir=${VERIFY_BOX_DIR:-/tmp/verify-berthd-box}
addr=${VERIFY_BOX_ADDR:-127.0.0.1:7544}
box_env=(BERTH_HOME="$dir/box-home" BERTH_USER_DIR="$dir/box-user" TMUX_TMPDIR="$dir/tmux")
lap_env=(BERTH_HOME="$dir/lap-home" BERTH_USER_DIR="$dir/lap-user" BERTH_UI_ADDR=127.0.0.1:9378 BERTH_PROXY_ADDR=127.0.0.1:9377)
box() { env "${box_env[@]}" "$root/bin/berthd" "$@"; }
lap() { env "${lap_env[@]}" "$root/bin/berth" "$@"; }
tm() { env TMUX_TMPDIR="$dir/tmux" tmux -L berth "$@"; }
serve() {
  env "${box_env[@]}" nohup "$1" serve --listen "$addr" >"$dir/berthd.log" 2>&1 &
  local pid=$!
  echo $pid >"$dir/berthd.pid"
  for _ in $(seq 120); do
    grep -q "berthd serving" "$dir/berthd.log" && return
    kill -0 $pid 2>/dev/null || { echo "berthd exited before it served: $dir/berthd.log" >&2; exit 1; }
    sleep 0.5
  done
  echo "berthd isn't serving after a minute: $dir/berthd.log" >&2
  exit 1
}

case ${1:-} in
up)
  for p in 7544 9377 9378; do
    if ss -ltn | grep -q ":$p "; then echo "port $p is taken: is a dev box up already? ($0 down)" >&2; exit 1; fi
  done
  mkdir -p "$dir"/{box-home,box-user,lap-home,lap-user,tmux} && chmod 700 "$dir/tmux"
  make -C "$root" build >/dev/null
  serve "$root/bin/berthd"
  if grep -q "updated berth's hooks" "$dir/berthd.log"; then
    echo "the dev box rewrote agent hooks in $HOME (berthd.log): put them back before going on" >&2
    exit 1
  fi
  lap pair "$(box pair --address "$addr" --json | jq -r .link)" --name devq >/dev/null
  token=$(lap ui-token | jq -r .token)
  # Agents in their terminals, as the bug reports' sessions run.
  curl -sf -X PUT -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    http://127.0.0.1:9378/v1/boxes/devq/api/agents/defaults -d '{"structured":false,"mode":"bypassPermissions"}' >/dev/null
  repo=$dir/acme-shop
  if [[ ! -d $repo/.git ]]; then
    git init -q -b main "$repo" && echo "# acme shop" >"$repo/README.md"
    git -C "$repo" add . && git -C "$repo" -c user.email=dev@acme.test -c user.name=acme commit -qm init
  fi
  box location add acme-shop "$repo" >/dev/null
  if [[ ${VERIFY_DRIVER:-} == claude ]]; then
    # Its chat is its stream: no screen of its own, no folder to trust.
    curl -sf -X POST -H "Authorization: Bearer $token" -H 'content-type: application/json' \
      http://127.0.0.1:9378/v1/boxes/devq/api/sessions -d '{"name":"ask","location":"acme-shop","agent":"claude","driver":"claude","mode":"bypassPermissions"}' >/dev/null
  else
    box session new acme-shop --name ask -- claude --dangerously-skip-permissions >/dev/null
    # A new folder asks to be trusted first. One trusted already (Claude keeps
    # that in ~, past `down`) goes straight to its prompt, and there Up and
    # Enter would send the last prompt again from its history. So wait for
    # one or the other, answer the question once, and stop if neither shows.
    trusted=
    for ((i = 0; ; i++)); do
      pane=$(tm capture-pane -p -t ask)
      if [[ -z $trusted ]] && grep -qi 'trust' <<<"$pane"; then
        tm send-keys -t ask Up && sleep 0.5 && tm send-keys -t ask Enter
        trusted=1
      elif grep -qiE 'bypass permissions on|\? for shortcuts' <<<"$pane"; then
        break
      fi
      if ((i == 90)); then
        printf 'up: Claude in session ask showed neither the trust question nor its prompt in 90 s; its screen:\n%s\n' "$pane" >&2
        exit 1
      fi
      sleep 1
    done
  fi
  echo "up: box devq ($addr), agent http://127.0.0.1:9378, worktree devq/acme-shop, session ask"
  ;;
restart)
  # berthd only: tmux, and the agents in it, keep running.
  bin=${2:-$root/bin/berthd}
  [[ -x $bin ]] || { echo "no berthd at $bin" >&2; exit 1; }
  # Until it has exited, not just let go of the port: its cleanup on the
  # way out would take the new one's socket.
  pid=$(cat "$dir/berthd.pid")
  kill "$pid"
  for _ in $(seq 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then echo "berthd ($pid) is still running after 30 s" >&2; exit 1; fi
  serve "$bin"
  echo "restarted: $bin"
  ;;
env)
  # VERIFY_BERTH_TOKEN is a secret: export it, don't print it anywhere else.
  echo "export VERIFY_BERTH_TOKEN=$(lap ui-token | jq -r .token) VERIFY_WORKTREE=devq/acme-shop TMUX_TMPDIR=$(printf %q "$dir/tmux")"
  ;;
down)
  [[ -f $dir/berthd.pid ]] && kill "$(cat "$dir/berthd.pid")" 2>/dev/null || true
  tm kill-server 2>/dev/null || true
  # The agent the CLI started: the one on 9378 with this state, no other.
  for pid in $(ss -ltnpH "sport = :9378" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    tr '\0' '\n' <"/proc/$pid/environ" | grep -qx "BERTH_HOME=$dir/lap-home" && kill "$pid"
  done
  rm -rf "$dir"
  echo "down: $dir removed"
  ;;
*)
  echo "usage: dev-box.sh up|env|restart [berthd]|down" >&2
  exit 2
  ;;
esac
