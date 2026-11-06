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
	case strings.HasPrefix(path, "/v1/attention?"):
		w.WriteString(`[{"key":"session:shop-a-claude","revision":2,"kind":"decision","title":"Ship on Friday?","details":"secret plans","options":[{"label":"Ship"},{"label":"Wait"}],"recommended":"Ship","status":"open","session":"shop-a-claude","by":"mcp","created":"2026-11-06T09:00:00Z","updated":"2026-11-06T09:05:00Z"},` +
			`{"key":"signal:shop-b-claude","revision":1,"kind":"mark","status":"open","snoozed_until":"2026-11-07T09:00:00Z","by":"app","created":"2026-11-06T09:01:00Z","updated":"2026-11-06T09:01:00Z"}]`)
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

func TestTheAttentionToolReadsTheBoxsOpenItemsWithoutTheirWords(t *testing.T) {
	f := &fakeBox{}
	s := &Server{Box: box.NewClient(f)}
	res := rpc(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"berth_attention","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"berth_attention","arguments":{"session":"shop-a-claude"}}}`,
	)
	if len(f.calls) != 2 || f.calls[0] != "GET /v1/attention?open=1" || f.calls[1] != "GET /v1/attention?open=1&session=shop-a-claude" {
		t.Fatalf("calls: %v", f.calls)
	}
	text := res[0]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	var got []box.AttentionBrief
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatal(err)
	}
	// The same list the box holds, as the phone reads it.
	var items []box.AttentionItem
	resp, _ := f.Do(context.Background(), "GET", "/v1/attention?open=1", nil)
	json.NewDecoder(resp.Body).Decode(&items)
	want, _ := json.Marshal(box.AttentionBriefs(items))
	if text != string(want) {
		t.Fatalf("attention: %s, want %s", text, want)
	}
	if len(got) != 2 || got[0].Title != "Ship on Friday?" || got[0].Recommended != "Ship" || got[1].Kind != "mark" || got[1].SnoozedUntil.IsZero() {
		t.Fatalf("attention: %s", text)
	}
	for _, secret := range []string{"secret plans", `"details"`, `"by"`} {
		if strings.Contains(text, secret) {
			t.Fatalf("the tool read %q: %s", secret, text)
		}
	}
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
