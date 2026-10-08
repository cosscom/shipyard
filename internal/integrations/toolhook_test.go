package integrations

import (
	"strings"
	"testing"

	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

func TestTranslate(t *testing.T) {
	for _, tc := range []struct {
		tool, hook, payload string
		typ                 string
		data                map[string]any
	}{
		{"claude", "Stop", `{"session_id":"s1","cwd":"/w/cal-billing","hook_event_name":"Stop","transcript_path":"/secret/transcript.jsonl"}`,
			"agent.finished", map[string]any{"path": "/w/cal-billing", "session_id": "s1", "agent_session_id": "s1", "agent": "claude"}},
		{"claude", "Notification", `{"session_id":"s1","cwd":"/w","message":"Claude needs permission to run rm -rf"}`,
			"agent.waiting", map[string]any{"path": "/w", "session_id": "s1", "agent_session_id": "s1", "reason": "permission", "agent": "claude"}},
		{"cursor", "stop", `{"conversation_id":"c1","status":"completed","workspace_roots":["/w/cal"]}`,
			"agent.finished", map[string]any{"path": "/w/cal", "conversation_id": "c1", "agent_session_id": "c1", "status": "completed", "agent": "cursor"}},
		{"codex", "notify", `{"type":"agent-turn-complete","turn-id":"t1","cwd":"/w","last-assistant-message":"secret plan"}`,
			"agent.finished", map[string]any{"path": "/w", "turn_id": "t1", "via": "notify", "agent": "codex"}},
		{"orca", "worktree.archived", `{"cwd":"/w/x"}`,
			"worktree.archived", map[string]any{"path": "/w/x", "agent": "orca"}},
	} {
		e, ok := Translate(tc.tool, tc.hook, []byte(tc.payload))
		if !ok || e.Type != tc.typ || e.Origin != tc.tool {
			t.Errorf("%s %s: %+v ok=%v", tc.tool, tc.hook, e, ok)
			continue
		}
		// The ask is not part of the event: the box takes it out (TestPermissionRequestAsk).
		delete(e.Data, adapters.AskKey)
		if len(e.Data) != len(tc.data) {
			t.Errorf("%s %s: data %v, want %v", tc.tool, tc.hook, e.Data, tc.data)
		}
		for k, v := range tc.data {
			if e.Data[k] != v {
				t.Errorf("%s %s: data[%s] = %v, want %v", tc.tool, tc.hook, k, e.Data[k], v)
			}
		}
	}
}

// Prompts, messages, and transcripts can hold anything a user typed; they
// must never become part of an event. A prompt's short title is the one
// exception, and only on its way to the box, which names the session with
// it and drops it before publishing (box.TestSessionsAreNamedAfterTheirTask).
func TestTranslateNeverCopiesContent(t *testing.T) {
	e, _ := Translate("claude", "UserPromptSubmit", []byte(`{"prompt":"Fix the cart\nSECRET-TEXT","cwd":"/w","session_id":"s"}`))
	if e.Data["title"] != "Fix the cart" {
		t.Errorf("a prompt's title = %v", e.Data["title"])
	}
	for _, tc := range [][3]string{
		{"claude", "Notification", `{"message":"SECRET-TEXT","transcript_path":"/SECRET-TEXT","cwd":"/w"}`},
		{"claude", "UserPromptSubmit", `{"prompt":"\nfirst line\nSECRET-TEXT","cwd":"/w","session_id":"s"}`},
		{"codex", "UserPromptSubmit", `{"prompt":"first line\n\nSECRET-TEXT","cwd":"/w"}`},
		{"codex", "notify", `{"type":"agent-turn-complete","input-messages":["SECRET-TEXT"],"last-assistant-message":"SECRET-TEXT"}`},
		{"cursor", "stop", `{"prompt":"SECRET-TEXT","workspace_roots":["/w"]}`},
		{"grok", "UserPromptSubmit", `{"prompt":"first line\nSECRET-TEXT","cwd":"/w","sessionId":"g"}`},
		{"grok", "Notification", `{"message":"SECRET-TEXT","cwd":"/w","notificationType":"permission_prompt"}`},
	} {
		e, _ := Translate(tc[0], tc[1], []byte(tc[2]))
		delete(e.Data, adapters.AskKey) // never published: see TestPermissionRequestAsk
		for k, v := range e.Data {
			if s, _ := v.(string); strings.Contains(s, "SECRET-TEXT") {
				t.Errorf("%s: content leaked into data[%s]", tc[0], k)
			}
		}
	}
}

func TestUninterestingHooksAreIgnored(t *testing.T) {
	for _, tc := range [][3]string{
		{"claude", "PreToolUse", `{}`},
		{"grok", "PreToolUse", `{}`},
		{"cursor", "beforeShellExecution", `{}`},
		{"codex", "notify", `{"type":"something-else"}`},
		{"orca", "not-an-event-type", `{}`},
		{"claude", "Stop", `not json`},
	} {
		if e, ok := Translate(tc[0], tc[1], []byte(tc[2])); ok && tc[2] != "not json" {
			t.Errorf("%s %s produced %+v", tc[0], tc[1], e)
		}
	}
	if Reply("cursor") != "{}" || Reply("claude") != "" {
		t.Error("wrong hook replies")
	}
}

// E5/F9: only a permission or a question is "needs you". idle_prompt comes
// a minute after every finished turn, and auth_success after a login.
func TestClaudeNotificationsThatAreNotQuestionsAreIgnored(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    string // "" = ignored
	}{
		{`{"cwd":"/w","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}`, "permission"},
		{`{"cwd":"/w","notification_type":"elicitation_dialog"}`, "question"},
		{`{"cwd":"/w","notification_type":"agent_needs_input"}`, "question"},
		{`{"cwd":"/w","notification_type":"idle_prompt","message":"Claude is waiting for your input"}`, ""},
		{`{"cwd":"/w","notification_type":"auth_success"}`, ""},
		{`{"cwd":"/w","notification_type":"something_new"}`, ""},
		{`{"cwd":"/w","message":"Claude is waiting for your input"}`, ""},
	} {
		e, ok := Translate("claude", "Notification", []byte(tc.payload))
		switch {
		case tc.want == "" && ok:
			t.Errorf("%s became %+v", tc.payload, e)
		case tc.want != "" && (!ok || e.Type != "agent.waiting" || e.Data["reason"] != tc.want):
			t.Errorf("%s: %+v ok=%v, want waiting (%s)", tc.payload, e, ok, tc.want)
		}
	}
}

// E4: after an approval, the tool runs, and PostToolUse says the agent is
// working again; PermissionRequest says it waits.
func TestClaudeToolUseAndPermissionHooks(t *testing.T) {
	e, ok := Translate("claude", "PostToolUse", []byte(`{"cwd":"/w","session_id":"s","tool_input":{"command":"SECRET"}}`))
	if !ok || e.Type != "agent.started" || e.Data["signal"] != "tool" || e.Data["tool_input"] != nil {
		t.Fatalf("PostToolUse = %+v %v", e, ok)
	}
	if e, ok := Translate("claude", "UserPromptSubmit", []byte(`{"cwd":"/w"}`)); !ok || e.Data["signal"] != "prompt" {
		t.Fatalf("UserPromptSubmit = %+v", e)
	}
	if e, ok := Translate("claude", "PermissionRequest", []byte(`{"cwd":"/w"}`)); !ok || e.Type != "agent.waiting" {
		t.Fatalf("PermissionRequest = %+v", e)
	}
	if e, ok := Translate("claude", "StopFailure", []byte(`{"cwd":"/w"}`)); !ok || e.Type != "agent.finished" || e.Data["status"] != "error" {
		t.Fatalf("StopFailure = %+v", e)
	}
	if e, ok := Translate("claude", "SessionEnd", []byte(`{"cwd":"/w"}`)); !ok || e.Type != "agent.exited" {
		t.Fatalf("SessionEnd = %+v", e)
	}
}

func TestEveryAgentAdapterMapsItsTurn(t *testing.T) {
	for _, tc := range [][4]string{
		{"codex", "UserPromptSubmit", `{"cwd":"/w","session_id":"x"}`, "agent.started"},
		{"codex", "PermissionRequest", `{"cwd":"/w"}`, "agent.waiting"},
		{"codex", "Stop", `{"cwd":"/w"}`, "agent.finished"},
		{"cursor", "beforeSubmitPrompt", `{"workspace_roots":["/w"]}`, "agent.started"},
		{"cursor", "sessionStart", `{"workspace_roots":["/w"]}`, "agent.ready"},
		{"gemini", "BeforeAgent", `{"cwd":"/w"}`, "agent.started"},
		{"gemini", "Notification", `{"cwd":"/w","notification_type":"ToolPermission"}`, "agent.waiting"},
		{"gemini", "AfterAgent", `{"cwd":"/w"}`, "agent.finished"},
		{"opencode", "session.busy", `{"cwd":"/w","session_id":"o"}`, "agent.started"},
		{"opencode", "permission.updated", `{"cwd":"/w"}`, "agent.waiting"},
		{"opencode", "session.idle", `{"cwd":"/w"}`, "agent.finished"},
		{"grok", "SessionStart", `{"cwd":"/w","sessionId":"g"}`, "agent.ready"},
		{"grok", "UserPromptSubmit", `{"cwd":"/w","sessionId":"g","prompt":"Fix it"}`, "agent.started"},
		{"grok", "PostToolUse", `{"cwd":"/w","sessionId":"g"}`, "agent.started"},
		{"grok", "Notification", `{"cwd":"/w","sessionId":"g","notificationType":"permission_prompt"}`, "agent.waiting"},
		{"grok", "Stop", `{"cwd":"/w","sessionId":"g"}`, "agent.finished"},
		{"grok", "StopFailure", `{"cwd":"/w","sessionId":"g"}`, "agent.finished"},
		{"grok", "StopCancelled", `{"cwd":"/w","sessionId":"g"}`, "agent.finished"},
		{"grok", "SessionEnd", `{"cwd":"/w","sessionId":"g"}`, "agent.exited"},
	} {
		e, ok := Translate(tc[0], tc[1], []byte(tc[2]))
		if !ok || e.Type != tc[3] || e.Data["path"] != "/w" {
			t.Errorf("%s %s = %+v %v, want %s", tc[0], tc[1], e, ok, tc[3])
		}
	}
}

func TestGrokNotificationsAndCamelCaseFields(t *testing.T) {
	e, ok := Translate("grok", "Stop", []byte(`{"sessionId":"g1","cwd":"/w/fix"}`))
	if !ok || e.Type != "agent.finished" || e.Data["session_id"] != "g1" || e.Data["agent_session_id"] != "g1" {
		t.Fatalf("grok Stop camelCase = %+v %v", e, ok)
	}
	e, ok = Translate("grok", "UserPromptSubmit", []byte(`{"session_id":"g2","cwd":"/w","prompt":"Fix the cart\nSECRET"}`))
	if !ok || e.Type != "agent.started" || e.Data["title"] != "Fix the cart" || e.Data["session_id"] != "g2" {
		t.Fatalf("grok UserPromptSubmit snake_case = %+v %v", e, ok)
	}
	for _, tc := range []struct {
		payload, typ, reason string
		ok                   bool
	}{
		{`{"cwd":"/w","notificationType":"permission_prompt","message":"Allow bash?"}`, "agent.waiting", "permission", true},
		{`{"cwd":"/w","notification_type":"elicitation_dialog"}`, "agent.waiting", "question", true},
		{`{"cwd":"/w","notificationType":"idle_prompt"}`, "agent.finished", "", true},
		{`{"cwd":"/w","notificationType":"task_complete"}`, "agent.finished", "", true},
		{`{"cwd":"/w","notificationType":"auth_success"}`, "", "", false},
		{`{"cwd":"/w","notificationType":"something_new"}`, "", "", false},
	} {
		e, ok := Translate("grok", "Notification", []byte(tc.payload))
		delete(e.Data, adapters.AskKey)
		switch {
		case !tc.ok && ok:
			t.Errorf("%s became %+v", tc.payload, e)
		case tc.ok && (!ok || e.Type != tc.typ || e.Data["reason"] != tc.reason && tc.reason != ""):
			t.Errorf("%s: %+v ok=%v, want %s (%s)", tc.payload, e, ok, tc.typ, tc.reason)
		}
	}
}
