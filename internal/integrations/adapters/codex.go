package adapters

import "strings"

// Codex reports through its hooks (hooks.json, trusted once with /hooks)
// and, on versions without them, only through notify. Notify comes at the
// end of each of its messages, not only the turn's: once a session's hooks
// are heard, the ledger leaves the end to Stop.
var Codex = register(&Adapter{
	Name: "codex",
	Caps: Caps{Ready: true, Started: true, Waiting: true, Finished: true, FinalMessage: true, Via: "hooks"},
	Translate: func(hook string, in Payload) (string, map[string]any, bool) {
		d := map[string]any{"path": in.Str("cwd"), "agent_session_id": in.Str("session_id"), "turn_id": firstOf(in, "turn_id", "turn-id")}
		switch hook {
		case "notify":
			// Codex passes its notification as an argument, not on stdin.
			if in.Str("type") != "agent-turn-complete" {
				return "", nil, false
			}
			d["via"] = "notify"
			return Finished, d, true
		case "SessionStart":
			return Ready, d, true
		case "UserPromptSubmit":
			d["signal"] = "prompt"
			// Only its short title: the box names an untitled session
			// after it, and drops it before the event is published.
			d["title"] = Title(in.Str("prompt"))
			return Started, d, true
		case "PreToolUse":
			// Codex's question box is a tool. Only that it asks is kept,
			// never the questions.
			if strings.HasPrefix(in.Str("tool_name"), "request_user_input") {
				d["reason"] = "question"
				return Waiting, d, true
			}
			d["signal"] = "tool"
			return Started, d, true
		case "PostToolUse":
			// The async question box returns at once, before anyone
			// answers; the wait holds until the turn ends.
			if strings.HasPrefix(in.Str("tool_name"), "request_user_input_async") {
				return "", nil, false
			}
			// Working again: a tool ran, or the question was answered.
			d["signal"] = "tool"
			return Started, d, true
		case "PermissionRequest":
			d["reason"] = "permission"
			return Waiting, d, true
		case "Stop":
			return Finished, d, true
		}
		return "", nil, false
	},
})

func firstOf(in Payload, keys ...string) string {
	for _, k := range keys {
		if s := in.Str(k); s != "" {
			return s
		}
	}
	return ""
}
