package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cosscom/shipyard/internal/box"
)

// fakeBox answers the box API calls the tools make.
type fakeBox struct {
	calls []string
}

func (f *fakeBox) Do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	return f.DoWithHeader(ctx, method, path, body, nil)
}

func (f *fakeBox) DoWithHeader(ctx context.Context, method, path string, body io.Reader, h http.Header) (*http.Response, error) {
	f.calls = append(f.calls, method+" "+path)
	w := httptest.NewRecorder()
	switch {
	case path == "/v1/sessions":
		w.WriteString(`[{"name":"shop-a-claude","agent":"claude","agent_state":"running","turn":"shop-a-claude#3","location":"shop/a","dir":"/very/long/path","command":"claude --long flags"}]`)
	case strings.HasPrefix(path, "/v1/turns/"):
		w.WriteString(`{"turn":{"id":"x#1","state":"running"},"state":"running","timed_out":true}`)
	case path == "/v1/runs":
		w.WriteHeader(202)
		w.WriteString(`{"id":"r_1","template":"loop","status":"running","created":"2026-01-01T00:00:00Z","updated":"2026-01-01T00:00:00Z"}`)
	case strings.HasPrefix(path, "/v1/runs/"):
		w.WriteString(`{"id":"r_1","template":"attempts","status":"waiting_gate","cursor":"2.t.0","gate":{"path":"2.t.0","title":"Pick"},"steps":[],"candidates":[{"index":0,"agent":"claude","verify":{"passed":true,"exit_code":0},"diff":{"files":2,"added":10,"removed":1,"commits":1},"judge":{"rank":1}}],"usage":{"input":1000,"output":200,"usd":0.05}}`)
	default:
		w.WriteHeader(404)
		w.WriteString(`{"error":"no"}`)
	}
	return w.Result(), nil
}

func rpc(t *testing.T, s *Server, lines ...string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	var res []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		res = append(res, m)
	}
	return res
}

func TestToolsAreShortAndNonBlocking(t *testing.T) {
	f := &fakeBox{}
	s := &Server{Box: box.NewClient(f)}
	res := rpc(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"berth_sessions","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"berth_wait_turn","arguments":{"turn":"x#1","timeout":600}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"berth_run_get","arguments":{"run":"r_1"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"berth_run_start","arguments":{"template":"loop","params":{"session":"s","check":"make test"}}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"nope"}`,
	)
	if len(res) != 7 {
		t.Fatalf("%d answers (a notification has none): %v", len(res), res)
	}
	if res[0]["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatal(res[0])
	}
	tools := res[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(Tools) {
		t.Fatal(len(tools))
	}
	text := func(r map[string]any) string {
		return r["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	sessions := text(res[2])
	if strings.Contains(sessions, "/very/long/path") || strings.Contains(sessions, "--long") || len(sessions) > 120 {
		t.Fatalf("sessions are not minimal: %s", sessions)
	}
	// A wait asked for 600 s waits at most 90, and says where to go on.
	if !strings.Contains(f.calls[1], "timeout=1m30s") || !strings.Contains(text(res[3]), `"cursor":"x#1"`) {
		t.Fatalf("%v %s", f.calls, text(res[3]))
	}
	got := text(res[4])
	if !strings.Contains(got, `"gate":"Pick"`) || !strings.Contains(got, `"rank":1`) || len(got) > 300 {
		t.Fatalf("run_get: %s", got)
	}
	if !strings.Contains(text(res[5]), `"run":"r_1"`) {
		t.Fatal(text(res[5]))
	}
	if res[6]["error"] == nil {
		t.Fatal("an unknown method answered")
	}
}

// taskBox answers a task and keeps what it was asked for.
type taskBox struct {
	tasks []box.TaskRequest
}

func (f *taskBox) DoWithHeader(ctx context.Context, method, path string, body io.Reader, h http.Header) (*http.Response, error) {
	w := httptest.NewRecorder()
	if path != "/v1/tasks" {
		w.WriteHeader(404)
		w.WriteString(`{"error":"no"}`)
		return w.Result(), nil
	}
	var req box.TaskRequest
	json.NewDecoder(body).Decode(&req)
	f.tasks = append(f.tasks, req)
	w.WriteString(`{"worktree":{"name":"fix","path":"/w/fix","branch":"fix"},"session":{"name":"acme-fix-claude"}}`)
	return w.Result(), nil
}

func TestATasksAgentGetsTheVariablesItWasGiven(t *testing.T) {
	f := &taskBox{}
	res := rpc(t, &Server{Box: box.NewClient(f)},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"acme","name":"fix","agent":"claude","env":{"TICKET":"T-7","CLAUDE_CONFIG_DIR":"/home/acme/.claude-two"}}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"acme","name":"fix","agent":"claude"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"acme","name":"fix","agent":"claude","env":["TICKET=T-7"]}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"acme","name":"fix","agent":"claude","env":{"TICKET":7}}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"acme","name":"fix","agent":"claude","env":{"":"T-7"}}}}`,
	)
	if len(f.tasks) != 2 {
		t.Fatalf("%d tasks reached the box, want 2: %+v", len(f.tasks), f.tasks)
	}
	if env := f.tasks[0].Env; len(env) != 2 || env["TICKET"] != "T-7" || env["CLAUDE_CONFIG_DIR"] != "/home/acme/.claude-two" {
		t.Fatalf("env = %v", env)
	}
	if f.tasks[1].Env != nil {
		t.Fatalf("no env sent %v", f.tasks[1].Env)
	}
	for i, says := range map[int]string{2: "env must be an object", 3: "TICKET's value must be a string", 4: "a variable needs a name"} {
		r := res[i]["result"].(map[string]any)
		text := r["content"].([]any)[0].(map[string]any)["text"].(string)
		if r["isError"] != true || !strings.Contains(text, says) {
			t.Errorf("call %d: %v %q, want an error saying %q", i+1, r["isError"], text, says)
		}
	}
}
