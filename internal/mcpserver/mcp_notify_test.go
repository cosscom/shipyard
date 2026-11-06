package mcpserver

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// callerBox answers the calls that start work and keeps who each named as
// its caller.
type callerBox struct {
	calls   []string
	callers []string
	bodies  []string
	ended   bool
}

func (f *callerBox) DoWithHeader(ctx context.Context, method, path string, body io.Reader, h http.Header) (*http.Response, error) {
	f.calls = append(f.calls, method+" "+path)
	f.callers = append(f.callers, h.Get(box.CallerHeader))
	var in []byte
	if body != nil {
		in, _ = io.ReadAll(body)
	}
	f.bodies = append(f.bodies, string(in))
	w := httptest.NewRecorder()
	switch {
	case path == "/v1/tasks":
		w.WriteString(`{"worktree":{"name":"fix","path":"/w/fix","branch":"fix"},"session":{"name":"shop-fix-claude"}}`)
	case strings.HasSuffix(path, "/send"):
		w.WriteString(`{"sent":true,"turn":"shop-fix-claude#2"}`)
	case strings.HasSuffix(path, "/attention"):
		w.WriteString(`{"key":"session:lead-claude","revision":1,"kind":"decision","title":"Ship acme on Friday?","status":"open","session":"lead-claude"}`)
	case path == "/v1/exec":
		w.WriteHeader(202)
		w.WriteString(`{"run":"r_x","status":"running","detached":true}`)
	case path == "/v1/runs":
		w.WriteHeader(202)
		w.WriteString(`{"id":"r_1","template":"loop","status":"running","created":"2026-01-01T00:00:00Z","updated":"2026-01-01T00:00:00Z"}`)
	case strings.HasPrefix(path, "/v1/turns/"):
		if f.ended {
			w.WriteString(`{"turn":{"id":"shop-fix-claude#2","state":"finished"},"state":"finished","timed_out":false}`)
		} else {
			w.WriteString(`{"turn":{"id":"shop-fix-claude#2","state":"running"},"state":"running","timed_out":true}`)
		}
	case strings.HasPrefix(path, "/v1/notify/caller?pid=4242"):
		w.WriteString(`{"session":"lead-codex"}`)
	case strings.HasPrefix(path, "/v1/notify/caller"):
		w.WriteString(`{"session":""}`)
	case strings.HasPrefix(path, "/v1/notify/"):
		w.WriteString(`{"forgot":1}`)
	case strings.HasPrefix(path, "/v1/runs/"):
		w.WriteString(`{"id":"r_x","template":"exec","status":"running","steps":[]}`)
	default:
		w.WriteHeader(404)
		w.WriteString(`{"error":"no"}`)
	}
	return w.Result(), nil
}

// callerOf is who the first call to path named.
func (f *callerBox) callerOf(prefix string) (string, bool) {
	for i, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return f.callers[i], true
		}
	}
	return "", false
}

func TestWorkAnAgentStartsNamesItSoItHearsBack(t *testing.T) {
	f := &callerBox{}
	s := &Server{Box: box.NewClient(f), Caller: "lead-claude"}
	res := rpc(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"shop","name":"fix","agent":"claude","prompt":"fix it"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"berth_send","arguments":{"session":"shop-fix-claude","text":"and the tests"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"berth_run_start","arguments":{"template":"loop","params":{"session":"s"}}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"berth_attempts","arguments":{"location":"shop","name":"try","prompt":"p","agents":["claude","codex"]}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"berth_exec","arguments":{"location":"shop/fix","command":"make test"}}}`,
	)
	for _, p := range []string{"POST /v1/tasks", "POST /v1/sessions/shop-fix-claude/send", "POST /v1/runs", "POST /v1/exec"} {
		if who, ok := f.callerOf(p); !ok || who != "lead-claude" {
			t.Fatalf("%s named %q as its caller (calls %v)", p, who, f.calls)
		}
	}
	text := func(r map[string]any) string {
		return r["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	for i, r := range res {
		if !strings.Contains(text(r), `"notify":true`) {
			t.Fatalf("answer %d does not say it reports back: %s", i+1, text(r))
		}
	}
	// A task says which session handed it the work.
	if !strings.Contains(text(res[0]), `"session":"shop-fix-claude"`) {
		t.Fatal(text(res[0]))
	}

	// notify false opts out: no caller, and the answer says so.
	f = &callerBox{}
	s.Box = box.NewClient(f)
	res = rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_send","arguments":{"session":"shop-fix-claude","text":"t","notify":false}}}`)
	if who, _ := f.callerOf("POST /v1/sessions/"); who != "" {
		t.Fatalf("notify false still named %q", who)
	}
	if !strings.Contains(text(res[0]), `"notify":false`) {
		t.Fatal(text(res[0]))
	}

	// Outside a berth session there is no one to report to.
	f = &callerBox{}
	res = rpc(t, &Server{Box: box.NewClient(f)}, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_task_new","arguments":{"location":"shop","name":"fix","agent":"claude"}}}`)
	if who, _ := f.callerOf("POST /v1/tasks"); who != "" || !strings.Contains(text(res[0]), `"notify":false`) {
		t.Fatalf("no caller, yet %q / %s", who, text(res[0]))
	}
}

func TestAWaitThatSeesTheEndDropsTheReport(t *testing.T) {
	f := &callerBox{}
	s := &Server{Box: box.NewClient(f), Caller: "lead-claude"}
	// Still running: nothing is dropped.
	rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_wait_turn","arguments":{"turn":"shop-fix-claude#2","timeout":1}}}`)
	if _, ok := f.callerOf("DELETE"); ok {
		t.Fatalf("a wait that timed out dropped the watch: %v", f.calls)
	}
	f.ended = true
	rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_wait_turn","arguments":{"turn":"shop-fix-claude#2","timeout":1}}}`)
	who, ok := f.callerOf("DELETE /v1/notify/shop-fix-claude%232")
	if !ok || who != "lead-claude" {
		t.Fatalf("the ended turn's watch was not dropped for its caller: %v %v", f.calls, f.callers)
	}
}

func TestToolsThatStartWorkSayTheyReportBack(t *testing.T) {
	for _, tool := range Tools {
		props := tool.InputSchema["properties"].(map[string]any)
		_, hasNotify := props["notify"]
		starts := map[string]bool{"berth_task_new": true, "berth_send": true, "berth_exec": true, "berth_run_start": true, "berth_attempts": true}[tool.Name]
		if starts != hasNotify {
			t.Errorf("%s: notify option %v, starts work %v", tool.Name, hasNotify, starts)
		}
		if starts && !strings.Contains(tool.Description, "<berth-notification>") {
			t.Errorf("%s does not say it reports back: %s", tool.Name, tool.Description)
		}
	}
	var wait Tool
	for _, tool := range Tools {
		if tool.Name == "berth_wait_turn" {
			wait = tool
		}
	}
	if !strings.Contains(wait.Description, "end your turn") {
		t.Errorf("wait_turn should steer agents away from polling: %s", wait.Description)
	}
}

// Codex starts its MCP servers with a bare environment: the server finds its
// session from the agent that started it.
func TestAnAgentWithoutItsEnvironmentIsFoundByItsProcess(t *testing.T) {
	f := &callerBox{}
	s := &Server{Box: box.NewClient(f), AgentPid: 4242}
	rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_send","arguments":{"session":"shop-fix-claude","text":"go"}}}`)
	if who, _ := f.callerOf("POST /v1/sessions/"); who != "lead-codex" {
		t.Fatalf("named %q, want lead-codex (calls %v)", who, f.calls)
	}
	// Outside any session there is no one to tell.
	f = &callerBox{}
	s = &Server{Box: box.NewClient(f), AgentPid: 7}
	rpc(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_send","arguments":{"session":"shop-fix-claude","text":"go"}}}`)
	if who, _ := f.callerOf("POST /v1/sessions/"); who != "" {
		t.Fatalf("named %q outside a session", who)
	}
}

// An ask is posted for the agent's own session and returns at once;
// anything the tool doesn't name is refused before it reaches the box (the
// box checks the rest).
func TestAnAskReturnsAtOnceAndRefusesWhatItDoesntName(t *testing.T) {
	f := &callerBox{}
	s := &Server{Box: box.NewClient(f), Caller: "lead-claude"}
	start := time.Now()
	res := rpc(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_ask","arguments":{"kind":"decision","title":"Ship acme on Friday?","options":[{"label":"Friday"},{"label":"Monday","description":"after the freeze"}],"recommended":"Friday"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"berth_ask","arguments":{"kind":"ready","title":"t","url":"https://acme.test/merge"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"berth_ask","arguments":{"kind":"decision","title":"t","options":[{"label":"Merge","command":"gh pr merge 12"}]}}}`,
	)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("it waited %s", time.Since(start))
	}
	text := func(r map[string]any) string {
		return r["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	if got := text(res[0]); res[0]["result"].(map[string]any)["isError"] == true || !strings.Contains(got, `"key":"session:lead-claude"`) || !strings.Contains(got, `"status":"open"`) {
		t.Fatalf("ask = %s", got)
	}
	if len(f.calls) != 1 || f.calls[0] != "POST /v1/sessions/lead-claude/attention" {
		t.Fatalf("calls = %v", f.calls)
	}
	if !strings.Contains(f.bodies[0], `"recommended":"Friday"`) || !strings.Contains(f.bodies[0], `"description":"after the freeze"`) {
		t.Fatalf("body = %s", f.bodies[0])
	}
	for i, why := range map[int]string{1: `unknown field "url"`, 2: `unknown field "command"`} {
		if res[i]["result"].(map[string]any)["isError"] != true || !strings.Contains(text(res[i]), why) {
			t.Errorf("call %d: %s", i+1, text(res[i]))
		}
	}
	// Without a session there is no one to ask for.
	res = rpc(t, &Server{Box: box.NewClient(&callerBox{})}, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"berth_ask","arguments":{"kind":"blocked","title":"t"}}}`)
	if res[0]["result"].(map[string]any)["isError"] != true {
		t.Fatalf("an ask with no session: %v", res[0])
	}
}
