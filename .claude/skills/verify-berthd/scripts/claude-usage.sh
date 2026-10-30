#!/usr/bin/env bash
# claude-usage.sh DIR [WORKDIR]: what Claude Code's own /usage says of the
# account in DIR (a CLAUDE_CONFIG_DIR), the ground truth for the Usage
# screen's Claude limits (features/usage-limits.md). It starts Claude Code
# on its own screen in a tmux server of its own, trusts WORKDIR (default
# /tmp/claude-usage-w, made empty) if asked, types /usage, and prints
#   five_hour=45 seven_day=23
# Nothing else: the panel also lists the account's sessions and MCP
# servers, which stay out of evidence.
set -euo pipefail
dir=${1:?usage: claude-usage.sh CLAUDE_CONFIG_DIR [WORKDIR]}
# The default folder keeps its path, so Claude Code asks to trust it only
# once, and is emptied every run so nothing from another one is in it.
if [[ -n ${2:-} ]]; then work=$2; else work=/tmp/claude-usage-w; rm -rf "$work"; fi
sock=$(mktemp -d /tmp/claude-usage-tmux.XXXXXX)
tm() { env TMUX_TMPDIR="$sock" tmux -L usage "$@"; }
trap 'tm kill-server 2>/dev/null || true; rm -rf "$sock"' EXIT
mkdir -p "$work"
tm new-session -d -s u -x 160 -y 60 -c "$work" -e "CLAUDE_CONFIG_DIR=$dir" claude --model haiku
screen() { tm capture-pane -p -t u -S -80; }
# Until its prompt shows, saying yes to the folder's trust question. Its
# cursor starts on "No, exit" and the screen shows before it reads keys,
# so Enter goes only once the cursor is on yes.
for _ in $(seq 60); do
  s=$(screen)
  if grep -q "❯ Yes, I trust this folder" <<<"$s"; then
    tm send-keys -t u Enter
  elif grep -q "Yes, I trust this folder" <<<"$s"; then
    tm send-keys -t u Down
  elif grep -q "❯" <<<"$s" && ! grep -q "Enter to confirm" <<<"$s"; then
    break
  fi
  sleep 0.5
done
# A notice can take the first keys: type /usage until its panel shows.
for _ in 1 2 3; do
  tm send-keys -t u "/usage" && sleep 1.5 && tm send-keys -t u Enter
  for _ in $(seq 30); do
    s=$(screen)
    grep -q "Current week (all models)" <<<"$s" && break 2
    sleep 0.5
  done
done
pct() { grep -A1 -F "$1" <<<"$s" | grep -o '[0-9]\+% used' | head -1 | tr -dc 0-9; }
five=$(pct "Current session")
week=$(pct "Current week (all models)")
[[ -n $five && -n $week ]] || { echo "no /usage panel on screen" >&2; exit 1; }
echo "five_hour=$five seven_day=$week"
