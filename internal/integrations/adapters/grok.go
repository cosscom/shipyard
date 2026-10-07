package adapters

// Grok is Grok CLI (xAI Grok Build), through hooks in ~/.grok/hooks/.
// Its event names match Claude Code's; the JSON on stdin uses camelCase
// (sessionId, notificationType) rather than Claude's snake_case.
var Grok = register(&Adapter{
	Name: "grok",
	Caps: Caps{Ready: true, Started: true, Waiting: true, Finished: true, Via: "hooks"},
	Translate: func(hook string, in Payload) (string, map[string]any, bool) {
		sid := firstOf(in, "sessionId", "session_id")
		d := map[string]any{"path": in.Str("cwd"), "agent_session_id": sid, "session_id": sid}
		switch hook {
		case "SessionStart":
			return Ready, d, true
		case "UserPromptSubmit":
			d["signal"] = "prompt"
			// Only its short title: the box names an untitled session
			// after it, and drops it before the event is published.
			d["title"] = Title(firstOf(in, "prompt"))
			return Started, d, true
		case "PostToolUse":
			// No hook fires when a permission is granted, but the tool it
			// allowed then runs: the agent is working again.
			d["signal"] = "tool"
			return Started, d, true
		case "Notification":
			reason, typ, ok := grokNotification(in)
			if !ok {
				return "", nil, false
			}
			if typ == Finished {
				return Finished, d, true
			}
			d["reason"] = reason
			// The message goes with the ask, never into the event.
			if msg := clip(in.Str("message")); msg != "" {
				d[AskKey] = map[string]any{"message": msg}
			}
			return Waiting, d, true
		case "Stop":
			return Finished, d, true
		case "StopFailure":
			d["status"] = "error"
			return Finished, d, true
		case "StopCancelled":
			// A turn that was interrupted or refused, instead of Stop.
			d["status"] = "cancelled"
			return Finished, d, true
		case "SessionEnd":
			return Exited, d, true
		}
		return "", nil, false
	},
})

// grokNotification says whether a Notification is a question, a finished
// turn, or noise. permission_prompt (and Claude-compatible names) need
// someone; idle_prompt and task_complete settle a turn that never reported
// Stop, so they are finished, not waiting. auth_success is a login.
func grokNotification(in Payload) (reason, typ string, ok bool) {
	switch firstOf(in, "notificationType", "notification_type") {
	case "permission_prompt":
		return "permission", Waiting, true
	case "elicitation_dialog", "agent_needs_input":
		return "question", Waiting, true
	case "idle_prompt", "task_complete":
		return "", Finished, true
	case "auth_success":
		return "", "", false
	}
	return "", "", false
}
