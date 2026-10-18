#!/usr/bin/env bash
# doctor.sh PORT: is the preview on PORT ours, the app, and built from the
# current source? Read only.
set -uo pipefail
port=${1:?usage: doctor.sh PORT}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
pidfile=/tmp/verify-berthd-preview.pid
ok=1
say() { printf '%-8s %s\n' "$1" "$2"; }

if curl -sf "http://localhost:$port/" | grep -q '<div id="root"'; then say ok "the app answers on $port"; else say FAIL "nothing serving the app on $port"; ok=0; fi

if [[ -f $pidfile ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  pid=$(cat "$pidfile")
  # vite preview runs as a child of pnpm exec: the listener is the PID or one of its children.
  listeners=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
  mine=0
  for l in $listeners; do
    [[ $l == "$pid" ]] && mine=1
    [[ $(ps -o ppid= -p "$l" | tr -d ' ') == "$pid" ]] && mine=1
  done
  if [[ $mine == 1 ]]; then say ok "preview PID $pid (from $pidfile) owns $port"; else say FAIL "$port isn't served by PID $pid: not ours, don't drive it"; ok=0; fi
else
  say FAIL "no live PID in $pidfile: start the preview as the skill's Launch says"; ok=0
fi

dist=$root/app/dist/index.html
if [[ -f $dist ]]; then
  newer=$(find "$root/app/src" "$root/packages/plugin-sdk/src" -type f -newer "$dist" | head -3)
  if [[ -z $newer ]]; then say ok "dist/ is newer than the source"; else say FAIL "dist/ is older than: $(echo "$newer" | tr '\n' ' ')- run pnpm build"; ok=0; fi
else
  say FAIL "no app/dist: run pnpm build"; ok=0
fi

say rev "$(git -C "$root" rev-parse --short HEAD) $(git -C "$root" status --porcelain | grep -q . && echo '(uncommitted changes)')"
[[ $ok == 1 ]]
