#!/usr/bin/env bash
# sidebar-layout-restart.sh PORT: does the sidebar's saved layout survive
# the laptop agent restarting while the app starts?
#
# Seeds a layout (Kits pinned, Automations hidden) in a throwaway agent's
# state, starts a real agent of this checkout (agent-box.sh), drives the
# app served on PORT through scenarios/sidebar-layout-restart-live.mjs
# (which restarts the agent as the app asks for the layout), then checks
# sidebar.json is byte for byte what was seeded. Prints the evidence folder
# and one JSON line; exit 1 if the scenario or the comparison failed.
#
#   VERIFY_AGENT_DIR (default /tmp/vb-sidebar-layout) is deleted at the end.
#   OUT=<dir> for the evidence (drive.mjs --out).
set -euo pipefail
port=${1:?usage: sidebar-layout-restart.sh PORT}
here=$(cd "$(dirname "$0")" && pwd)
export VERIFY_AGENT_DIR=${VERIFY_AGENT_DIR:-/tmp/vb-sidebar-layout}
file=$VERIFY_AGENT_DIR/user/app/sidebar.json
trap '"$here/agent-box.sh" down >/dev/null' EXIT

rm -rf "$VERIFY_AGENT_DIR" && mkdir -p "$(dirname "$file")"
printf '%s' '{"version":2,"pinned":["home","kits","review","worktrees"],"more":[],"hidden":["automations"]}' >"$file"
before=$(sha256sum "$file" | cut -d' ' -f1)
"$here/agent-box.sh" up
eval "$("$here/agent-box.sh" env)"
ok=true
node "$here/drive.mjs" sidebar-layout-restart-live --port "$port" --agent http://127.0.0.1:9468 ${OUT:+--out "$OUT"} || ok=false
after=$(sha256sum "$file" | cut -d' ' -f1)
[[ $before == "$after" ]] || ok=false
printf '{"ok":%s,"sidebar_json_before":"%s","sidebar_json_after":"%s"}\n' "$ok" "$before" "$after"
$ok
