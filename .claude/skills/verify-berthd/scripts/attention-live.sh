#!/usr/bin/env bash
# attention-live.sh up|env|down: one box and two laptop agents of this
# checkout's build, as two computers paired with the same box, for the
# attention scenario (scenarios/attention-two-laptops-live.mjs). No agent
# CLI runs: the scenario starts a plain shell session itself.
#
# Its own ports, so it never meets dev-box.sh (7544/9377/9378) or the
# machine's Shipyard (1377-1379): the box on 127.0.0.1:7547, laptop A on
# 9471/9472 and laptop B on 9473/9474 (proxy/UI). `env` prints what
# drive.mjs needs; `down` stops it all and deletes the state.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
dir=${VERIFY_BOX_DIR:-/tmp/vb-attention}
addr=127.0.0.1:7547
box_env=(BERTH_HOME="$dir/box-home" BERTH_USER_DIR="$dir/box-user" TMUX_TMPDIR="$dir/tmux")
box() { env "${box_env[@]}" "$root/bin/berthd" "$@"; }
# lap a|b …: laptop A (proxy 9471, UI 9472) or B (9473, 9474).
lap() {
  local who=$1 p=9471
  shift
  [[ $who == b ]] && p=9473
  env BERTH_HOME="$dir/lap-$who-home" BERTH_USER_DIR="$dir/lap-$who-user" BERTH_PROXY_ADDR="127.0.0.1:$p" BERTH_UI_ADDR="127.0.0.1:$((p + 1))" "$root/bin/berth" "$@"
}

case ${1:-} in
up)
  for p in 7547 9471 9472 9473 9474; do
    if ss -ltn | grep -q ":$p "; then echo "port $p is taken: is it up already? ($0 down)" >&2; exit 1; fi
  done
  mkdir -p "$dir"/{box-home,box-user,lap-a-home,lap-a-user,lap-b-home,lap-b-user,tmux} && chmod 700 "$dir/tmux"
  make -C "$root" build >/dev/null
  env "${box_env[@]}" nohup "$root/bin/berthd" serve --listen "$addr" >"$dir/berthd.log" 2>&1 &
  echo $! >"$dir/berthd.pid"
  until grep -q "berthd serving" "$dir/berthd.log"; do sleep 0.5; done
  if grep -q "updated berth's hooks" "$dir/berthd.log"; then
    echo "the box rewrote agent hooks in $HOME (berthd.log): put them back before going on" >&2
    exit 1
  fi
  # Each laptop pairs with a code of its own, as two computers do.
  lap a pair "$(box pair --address "$addr" --json | jq -r .link)" --name devq >/dev/null
  lap b pair "$(box pair --address "$addr" --json | jq -r .link)" --name devq >/dev/null
  repo=$dir/acme-shop
  if [[ ! -d $repo/.git ]]; then
    git init -q -b main "$repo" && echo "# acme shop" >"$repo/README.md"
    git -C "$repo" add . && git -C "$repo" -c user.email=dev@acme.test -c user.name=acme commit -qm init
  fi
  box location add acme-shop "$repo" >/dev/null
  # The CLI starts each agent; wait until both answer.
  lap a ui-token >/dev/null && lap b ui-token >/dev/null
  for u in 9472 9474; do
    until ss -ltn | grep -q "127.0.0.1:$u "; do sleep 0.5; done
  done
  echo "up: box devq ($addr), laptop A http://127.0.0.1:9472, laptop B http://127.0.0.1:9474"
  ;;
env)
  # The tokens are secrets: export them, don't print them anywhere else.
  echo "export VERIFY_BERTH_TOKEN=$(lap a ui-token | jq -r .token) VERIFY_BERTH_TOKEN_B=$(lap b ui-token | jq -r .token) VERIFY_AGENT_B=http://127.0.0.1:9474"
  ;;
down)
  [[ -f $dir/berthd.pid ]] && kill "$(cat "$dir/berthd.pid")" 2>/dev/null || true
  env TMUX_TMPDIR="$dir/tmux" tmux -L berth kill-server 2>/dev/null || true
  # The agents the CLI started: the ones on 9472/9474 with this state, no other.
  for port in 9472 9474; do
    for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      tr '\0' '\n' <"/proc/$pid/environ" | grep -q "^BERTH_HOME=$dir/lap-" && kill "$pid"
    done
  done
  rm -rf "$dir"
  echo "down: $dir removed"
  ;;
*)
  echo "usage: attention-live.sh up|env|down" >&2
  exit 2
  ;;
esac
