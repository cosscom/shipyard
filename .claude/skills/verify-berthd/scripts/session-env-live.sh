#!/usr/bin/env bash
# session-env-live.sh [OUT]: a session's own variables (`--env KEY=VALUE`,
# features/session-env.md) on a dev box of this checkout (dev-box.sh up),
# read back from inside Claude Code's Bash tool.
#
# It sets ACME_* at three levels: the box's env.json, the project's box-local
# env and the session's own. Then it starts Claude Code four ways, each
# with its own variables:
#   env-task     berthd task new --env, structured (the agent host)
#   env-session  berthd session new --env, structured
#   env-mcp      the berth_task_new MCP tool with env, structured
#   env-term     berthd session new --env -- claude …, in its terminal
# and each one's Bash tool writes `env | grep ^ACME_` to OUT/<name>.txt,
# which must read: ACME_ACCOUNT=box (the box's), ACME_TICKET=repo (the
# project's over the box's), ACME_REGION=<the session's>, ACME_RUN=<the
# session's>. Then the refusals: a name berthd sets and a malformed --env,
# neither of which may start anything.
#
# Run it with VERIFY_BOX_DIR as dev-box.sh had it, and every BERTH_*
# variable unset when you are an agent yourself. Its sessions stay for the
# app scenario (session-env-live.mjs) and go with `dev-box.sh down`.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
dir=${VERIFY_BOX_DIR:-/tmp/verify-berthd-box}
out=${1:-/tmp/verify-berthd/session-env-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$out"
[[ -f $dir/berthd.pid ]] || { echo "no dev box in $dir: dev-box.sh up first" >&2; exit 1; }
box() { env BERTH_HOME="$dir/box-home" BERTH_USER_DIR="$dir/box-user" TMUX_TMPDIR="$dir/tmux" "$root/bin/berthd" "$@"; }
tm() { env TMUX_TMPDIR="$dir/tmux" tmux -L berth "$@"; }
eval "$("$(dirname "$0")/dev-box.sh" env)"
api() { curl -sf -X "$1" -H "Authorization: Bearer $VERIFY_BERTH_TOKEN" -H 'content-type: application/json' "http://127.0.0.1:9378/v1/boxes/devq/api/$2" ${3:+-d "$3"}; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== the box's and the project's variables"
api PUT env '{"env":{"ACME_ACCOUNT":"box","ACME_TICKET":"box","ACME_REGION":"box"}}' >/dev/null
api PUT locations/acme-shop/config '{"local":{"env":{"ACME_TICKET":"repo","ACME_REGION":"repo"}}}' >/dev/null
# The app's default: agents in chat, allowed what they ask.
api PUT agents/defaults '{"structured":true,"mode":"bypassPermissions"}' >/dev/null

prompt() {
  echo "Run exactly this one command with your Bash tool, nothing else: env | grep '^ACME_' | sort > $out/$1.txt && cat $out/$1.txt -- then reply with its output, verbatim."
}

echo "== berthd task new --env (structured)"
box task new acme-shop/env-task --agent claude --no-notify --env ACME_REGION=eu-north --env "ACME_RUN=task run 41" --prompt "$(prompt env-task)" | tee "$out/cli.txt"

echo "== berthd session new --env (structured)"
box session new acme-shop --name env-session --agent claude --env ACME_REGION=us-east --env ACME_RUN=session-42 --prompt "$(prompt env-session)" | tee -a "$out/cli.txt"

echo "== berth_task_new with env (structured)"
args=$(jq -nc --arg p "$(prompt env-mcp)" '{location:"acme-shop",name:"env-mcp",agent:"claude",prompt:$p,notify:false,env:{ACME_REGION:"ap-south",ACME_RUN:"mcp-43"}}')
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"berth_task_new\",\"arguments\":$args}}" |
  box mcp | tail -1 | tee "$out/mcp.json"
jq -e '.result.isError != true' "$out/mcp.json" >/dev/null || fail "berth_task_new: $(cat "$out/mcp.json")"
echo

echo "== berthd session new --env -- claude (its terminal)"
box session new acme-shop/env-task --name env-term --env ACME_REGION=eu-west --env ACME_RUN=term-44 -- claude --dangerously-skip-permissions "$(prompt env-term)" | tee -a "$out/cli.txt"
# Claude Code asks to trust a new folder before it reads the prompt.
for _ in $(seq 90); do
  [[ -s $out/env-term.txt ]] && break
  screen=$(box session screen env-term 2>/dev/null || true)
  if grep -q '❯ .*Yes, I trust\|❯ .*Yes, proceed\|❯ .*Yes, I accept' <<<"$screen"; then
    tm send-keys -t env-term Enter
  elif grep -qi 'trust this folder\|Bypass Permissions mode' <<<"$screen"; then
    tm send-keys -t env-term Down
  fi
  sleep 2
done

echo "== what each agent's Bash tool saw"
want() { printf 'ACME_ACCOUNT=box\nACME_REGION=%s\nACME_RUN=%s\nACME_TICKET=repo\n' "$1" "$2"; }
check() {
  local name=$1 region=$2 run=$3
  for _ in $(seq 150); do [[ -s $out/$name.txt ]] && break; sleep 2; done
  [[ -s $out/$name.txt ]] || fail "$name wrote nothing to $out/$name.txt in 5 minutes"
  diff <(want "$region" "$run") "$out/$name.txt" || fail "$name saw the above"
  echo "ok $name: $(tr '\n' ' ' <"$out/$name.txt")"
}
check env-task eu-north "task run 41"
check env-session us-east session-42
check env-mcp ap-south mcp-43
check env-term eu-west term-44
box session screen env-term --history 60 >"$out/env-term.screen.txt" || true
for s in $(box sessions --json | jq -r '.[] | select(.name | test("env-(task|session|mcp)")) | .name'); do
  api GET "sessions/$s/transcript" >"$out/$s.transcript.json" || true
done
box sessions --json | jq -r '.[] | select(.name | test("env-")) | "\(.name)\t\(.driver // "terminal")\t\(.location)"' | tee "$out/sessions.tsv"

echo "== refusals: nothing starts"
before=$(box sessions --json | jq length)
if box task new acme-shop/env-refused --agent claude --env BERTH_SESSION=someone-else >"$out/refused-reserved.txt" 2>&1; then fail "BERTH_SESSION was accepted"; fi
grep -q "BERTH_SESSION is set by berthd" "$out/refused-reserved.txt" || fail "refusal said: $(cat "$out/refused-reserved.txt")"
if box session new acme-shop --agent claude --env ACME_REGION >"$out/refused-malformed.txt" 2>&1; then fail "--env with no = was accepted"; fi
grep -q -- '--env takes KEY=VALUE, got "ACME_REGION" with no =' "$out/refused-malformed.txt" || fail "refusal said: $(cat "$out/refused-malformed.txt")"
if box locations --json | jq -e '.[] | select(.name == "acme-shop") | .worktrees[]? | select(.name == "env-refused")' >/dev/null; then fail "a refused task made its worktree"; fi
[[ $(box sessions --json | jq length) == "$before" ]] || fail "a refused request started a session"
cat "$out/refused-reserved.txt" "$out/refused-malformed.txt"
echo "ok: refused, nothing started"
echo "evidence: $out"
