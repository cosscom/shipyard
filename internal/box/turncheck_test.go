package box

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/transcript"
)

type jevCall struct {
	path, auth string
	body       map[string]any
}

// checkedBox is a box with turn check on (or off) and a Claude Code session
// whose transcript holds prompt and reply. Its Jev is answer, on loopback.
func checkedBox(t *testing.T, enabled bool, prompt, reply string, answer http.HandlerFunc) (*Box, *events.Bus, Session, chan jevCall) {
	t.Helper()
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexec sleep 600\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("BERTH_TEST_JEV_KEY", "jev-test-key")
	calls := make(chan jevCall, 10)
	jev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		calls <- jevCall{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		answer(w, r)
	}))
	t.Cleanup(jev.Close)
	old := jevURL
	jevURL = jev.URL + "/v1/evaluate"
	t.Cleanup(func() { jevURL = old })

	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = &Turns{}
		b.Turns.Attach(b.Events)
		// The test's Jev is on loopback, which the box's owner must allow.
		b.Flows = &Flows{AllowOutbound: []string{"127.0.0.1"}}
		b.TurnCheck = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json"), settle: 10 * time.Millisecond, timeout: 300 * time.Millisecond}
		bx = b
	})
	bx.TurnCheck.save(TurnCheckConfig{Enabled: enabled, Key: "env://BERTH_TEST_JEV_KEY"})
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": gitRepo(t)}, nil)
	call(t, c, "POST", "/v1/locations/shop/worktrees", "", WorktreeRequest{Name: "fix"}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "shop/fix", Command: "claude"}, &sess); status != 200 {
		t.Fatalf("session: %d", status)
	}
	line := func(v map[string]any) string { b, _ := json.Marshal(v); return string(b) + "\n" }
	at := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	proj := transcript.ClaudeDir(sess.Dir)
	os.MkdirAll(proj, 0o755)
	rec := filepath.Join(proj, "conv.jsonl")
	appendTo(t, rec, line(map[string]any{"type": "user", "timestamp": at, "message": map[string]any{"role": "user", "content": prompt}}))
	appendTo(t, rec, line(map[string]any{"type": "assistant", "timestamp": at, "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": reply}}}}))

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go bx.TurnCheck.Run(ctx, bx)
	time.Sleep(50 * time.Millisecond)
	return bx, bus, sess, calls
}

// endTurn is a prompt typed at the terminal and its turn's end.
func endTurn(bus *events.Bus, s Session) {
	hook(bus, adapters.Started, s.Name, s.Dir, "claude", "signal", "prompt")
	hook(bus, adapters.Finished, s.Name, s.Dir, "claude")
}

func jevSays(choice string, p float64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"answers": map[string]any{"status": map[string]any{"choice": choice, "probabilities": map[string]float64{choice: p}}}})
	}
}

func waitCall(t *testing.T, calls chan jevCall) jevCall {
	t.Helper()
	select {
	case c := <-calls:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("Jev was never asked")
	}
	return jevCall{}
}

func stateNow(t *testing.T, b *Box, name string) string {
	t.Helper()
	st, _ := b.Turns.State(name)
	return st.State
}

// A turn that ends on a question shows as waiting, yet still takes prompts.
func TestTurnCheckMakesATurnThatAsksWait(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Both operators are in place. Should the filter default to AND or OR?", jevSays("needs_input", 0.92))
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	waitCall(t, calls)
	deadline := time.After(5 * time.Second)
	for e := (events.Event{}); e.Type != adapters.Waiting; {
		select {
		case e = <-ch:
		case <-deadline:
			t.Fatal("no agent.waiting")
		}
		if e.Type == adapters.Waiting && (e.Data["session"] != sess.Name || e.Data["source"] != "turncheck" || e.Data["choice"] != "needs_input") {
			t.Fatalf("agent.waiting %v", e.Data)
		}
	}
	if got := stateNow(t, b, sess.Name); got != "waiting" {
		t.Fatalf("state %s", got)
	}
	// Not a question: a prompt held for idle goes, and one sent now is
	// typed as a new turn rather than refused.
	ctx := context.Background()
	if res, err := b.sendPrompt(ctx, sess.Name, SendRequest{Text: "Go on", When: "idle"}, "test", "test"); err != nil || !res.Sent {
		t.Fatalf("when idle: %+v %v", res, err)
	}
	end := hook(bus, adapters.Finished, sess.Name, sess.Dir, "claude")
	// The ledger takes a verdict only on the turn end it was about.
	verdict := func(seq int64) {
		bus.Publish(events.Event{Type: adapters.Waiting, Data: map[string]any{"session": sess.Name, "path": sess.Dir, "source": "turncheck", "seq": seq}})
	}
	if verdict(end.Seq - 1); stateNow(t, b, sess.Name) != "finished" {
		t.Fatal("a verdict on an older turn was taken")
	}
	if verdict(end.Seq); stateNow(t, b, sess.Name) != "waiting" {
		t.Fatal("the verdict was not taken")
	}
	if res, err := b.sendPrompt(ctx, sess.Name, SendRequest{Text: "And then", When: "now"}, "test", "test"); err != nil || !res.Sent {
		t.Fatalf("when now: %+v %v", res, err)
	}
}

// The agent stopped with its work unfinished ("the build is still compiling,
// I'll come back"): not done, not a question. It reads as idle, and only on
// the turn end it was about.
func TestTurnCheckReadsUnfinishedWorkAsIdle(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Run the suite", "Backend operators are in place. Checking how enumOptions is used elsewhere…", jevSays("working", 0.92))
	endTurn(bus, sess)
	waitCall(t, calls)
	deadline := time.Now().Add(5 * time.Second)
	for stateNow(t, b, sess.Name) != "idle" {
		if time.Now().After(deadline) {
			t.Fatalf("state %s, want idle", stateNow(t, b, sess.Name))
		}
		time.Sleep(20 * time.Millisecond)
	}
	end := hook(bus, adapters.Finished, sess.Name, sess.Dir, "claude")
	bus.Publish(events.Event{Type: adapters.Ready, Data: map[string]any{"session": sess.Name, "path": sess.Dir, "source": "turncheck", "seq": end.Seq - 1}})
	if got := stateNow(t, b, sess.Name); got != "finished" {
		t.Fatalf("a verdict on an older turn was taken: %s", got)
	}
}

func TestTurnCheckLeavesOtherTurnsFinished(t *testing.T) {
	for name, answer := range map[string]http.HandlerFunc{
		"done":   jevSays("done", 0.99),
		"unsure": jevSays("needs_input", 0.5),
		"error":  func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", 500) },
	} {
		t.Run(name, func(t *testing.T) {
			b, bus, sess, calls := checkedBox(t, true, "Ship it", "Pushed and deployed.", answer)
			endTurn(bus, sess)
			waitCall(t, calls)
			time.Sleep(300 * time.Millisecond)
			if got := stateNow(t, b, sess.Name); got != "finished" || len(calls) != 0 {
				t.Fatalf("state %s, asked %d more times", got, len(calls))
			}
		})
	}
}

func TestTurnCheckOffAsksNothing(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, false, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	endTurn(bus, sess)
	time.Sleep(300 * time.Millisecond)
	if len(calls) != 0 || stateNow(t, b, sess.Name) != "finished" {
		t.Fatalf("asked %d times, state %s", len(calls), stateNow(t, b, sess.Name))
	}
}

// You typed again before Jev answered: its answer is about a turn that is
// no longer the last, and is dropped.
func TestTurnCheckDropsALateAnswer(t *testing.T) {
	release := make(chan struct{})
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", func(w http.ResponseWriter, r *http.Request) {
		<-release
		jevSays("needs_input", 0.9)(w, r)
	})
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	waitCall(t, calls)
	hook(bus, adapters.Started, sess.Name, sess.Dir, "claude", "signal", "prompt")
	close(release)
	time.Sleep(300 * time.Millisecond)
	if got := stateNow(t, b, sess.Name); got != "running" {
		t.Fatalf("state %s, want running", got)
	}
	for len(ch) > 0 {
		if e := <-ch; e.Type == adapters.Waiting {
			t.Fatalf("published %v", e.Data)
		}
	}
}

func TestTurnCheckSendsTheTurnsEndsToJev(t *testing.T) {
	reply := strings.Repeat("r", 13000) + "REPLY-END"
	_, bus, sess, calls := checkedBox(t, true, "Ship it", reply, jevSays("done", 0.9))
	endTurn(bus, sess)
	c := waitCall(t, calls)
	state, _ := c.body["state"].(map[string]any)
	resp, _ := state["agent_response"].(string)
	gateway, _ := c.body["providerOptions"].(map[string]any)["gateway"].(map[string]any)
	if c.auth != "Bearer jev-test-key" || state["user_request"] != "Ship it" || len(resp) > turnCheckReplyLimit+len("…") || !strings.HasSuffix(resp, "REPLY-END") {
		t.Fatalf("asked with %q: %d %v", c.auth, len(resp), state["user_request"])
	}
	if c.body["model"] != "typesafe-ai/jev" || gateway["disallowPromptTraining"] != true {
		t.Fatalf("body %v", c.body)
	}
}

// Another server that speaks Jev's shape, such as a self-hosted laya-serve:
// its own model, no AI Gateway options, and not the key pasted for AI
// Gateway.
func TestTurnCheckAsksTheServerItIsGiven(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	own := strings.TrimSuffix(jevURL, "/v1/evaluate") + "/v1/systemone"
	b.TurnCheck.KeyPath = filepath.Join(t.TempDir(), "turncheck.key")
	os.WriteFile(b.TurnCheck.KeyPath, []byte("vck_pasted_value\n"), 0o600)
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, URL: own, Model: "multilingual"})
	endTurn(bus, sess)
	c := waitCall(t, calls)
	if _, has := c.body["providerOptions"]; has || c.path != "/v1/systemone" || c.body["model"] != "multilingual" || c.auth != "" {
		t.Fatalf("asked %s with %q: %v", c.path, c.auth, c.body)
	}
}

func TestJevVerdictReadsOnlyJevsAnswer(t *testing.T) {
	for in, want := range map[string]string{
		`{"answers":{"status":{"choice":"blocked","probabilities":{"blocked":0.7,"done":0.3}}}}`: "blocked 0.70",
		`{"answers":{"status":{"choice":"maybe","probabilities":{"maybe":0.9}}}}`:                "unusable",
		`{"answers":{"status":{"choice":"done","probabilities":{"working":0.9}}}}`:               "unusable",
		`{"answers":{"status":{"choice":"done","probabilities":{"done":1.5}}}}`:                  "unusable",
		`{"answers":{"status":{"value":"done","probability":0.8}}}`:                              "unusable",
		`<html>not json`: "unusable",
	} {
		choice, p, err := jevVerdict([]byte(in))
		got := "unusable"
		if err == nil {
			got = fmt.Sprintf("%s %.2f", choice, p)
		}
		if got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestTurnCheckSettingsHoldOnlyAReference(t *testing.T) {
	t.Setenv("BERTH_TEST_JEV_KEY", "the-real-key-value")
	var tc *TurnCheck
	c, bus := servedBox(t, func(b *Box) {
		tc = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json")}
		b.TurnCheck = tc
	})
	var bad map[string]string
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true}, &bad); status != 400 {
		t.Fatalf("on without a key: %d", status)
	}
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Key: "vck_live_secret"}, &bad); status != 400 || strings.Contains(bad["error"], "vck_live_secret") {
		t.Fatalf("a key that is not a reference: %d %v", status, bad)
	}
	ch, stop := bus.Subscribe()
	defer stop()
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Key: "env://BERTH_TEST_JEV_KEY"}, nil); status != 200 {
		t.Fatalf("put: %d", status)
	}
	if e := <-ch; e.Type != "turncheck.changed" || e.Data["enabled"] != true {
		t.Fatalf("event %v", e)
	}
	resp, err := c.Do(context.Background(), "GET", "/v1/turncheck", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var got TurnCheckConfig
	json.Unmarshal(raw, &got)
	if !got.Enabled || got.Key != "env://BERTH_TEST_JEV_KEY" || strings.Contains(string(raw), "the-real-key-value") {
		t.Fatalf("get: %s", raw)
	}
	if file, _ := os.ReadFile(tc.Path); strings.Contains(string(file), "the-real-key-value") {
		t.Fatal("the value is on disk")
	}
	// A server of your own may need no key; its URL must be http(s).
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, URL: "http://127.0.0.1:8000/v1/systemone", Model: "multilingual"}, nil); status != 200 {
		t.Fatalf("own server without a key: %d", status)
	}
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, URL: "file:///etc/passwd"}, nil); status != 400 {
		t.Fatalf("a file URL: %d", status)
	}
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Key: "env://BERTH_TEST_JEV_KEY", URL: "http://example.com/v1/evaluate"}, nil); status != 400 {
		t.Fatalf("a key over http: %d", status)
	}
}

// The simple way: a key pasted in Settings, kept on the box (0600) and
// never answered.
// A key never goes over plain http, even to a server you set.
func TestTurnCheckSendsAKeyOnlyOverHTTPS(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Key: "env://BERTH_TEST_JEV_KEY", URL: jevURL})
	endTurn(bus, sess)
	time.Sleep(300 * time.Millisecond)
	if len(calls) != 0 {
		t.Fatal("the key was sent over http")
	}
}

func TestTurnCheckKeepsAPastedKeyOnTheBox(t *testing.T) {
	var tc *TurnCheck
	c, _ := servedBox(t, func(b *Box) {
		tc = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json"), KeyPath: filepath.Join(t.TempDir(), "turncheck.key")}
		b.TurnCheck = tc
	})
	for _, bad := range []string{"env://X", "vck_\u200bpasted"} {
		if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "key_value": bad}, nil); status != 400 {
			t.Fatalf("%q pasted as the key: %d", bad, status)
		}
	}
	var st TurnCheckStatus
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "key_value": "vck_pasted_value"}, &st); status != 200 || !st.KeySet || !st.Enabled {
		t.Fatalf("pasting a key: %d %+v", status, st)
	}
	if fi, err := os.Stat(tc.KeyPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", fi, err)
	}
	resp, _ := c.Do(context.Background(), "GET", "/v1/turncheck", nil)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(string(raw), "vck_pasted_value") || !strings.Contains(string(raw), `"key_set":true`) {
		t.Fatalf("get: %s", raw)
	}
	// The last one set wins: a reference removes the pasted key.
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "key": "env://BERTH_TEST_JEV_KEY"}, &st); status != 200 || st.KeySet {
		t.Fatalf("a reference: %d %+v", status, st)
	}
	call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "key_value": "vck_pasted_value"}, nil)
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": false, "remove_key": true}, &st); status != 200 || st.KeySet {
		t.Fatalf("remove: %d %+v", status, st)
	}
	if _, err := os.Stat(tc.KeyPath); !os.IsNotExist(err) {
		t.Fatal("the key file is still there")
	}
}

func TestTurnCheckSendsThePastedKey(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("done", 0.9))
	b.TurnCheck.KeyPath = filepath.Join(t.TempDir(), "turncheck.key")
	os.WriteFile(b.TurnCheck.KeyPath, []byte("vck_pasted_value\n"), 0o600)
	b.TurnCheck.save(TurnCheckConfig{Enabled: true})
	endTurn(bus, sess)
	if c := waitCall(t, calls); c.auth != "Bearer vck_pasted_value" {
		t.Fatalf("authorization %q", c.auth)
	}
}
