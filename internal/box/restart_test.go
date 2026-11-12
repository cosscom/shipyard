package box

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/wire"
)

// restartBox is a served box running the stand-in Claude (fakeStreamClaude)
// in structured sessions, with its turn ledger and inbox running, and a
// location "acme".
func restartBox(t *testing.T) (*wire.Client, *Turns, *Box) {
	t.Helper()
	fakeClaudeOnPath(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	states := &Turns{InboxPath: filepath.Join(t.TempDir(), "inbox.json")}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		bx = b
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
	})
	states.Attach(bus)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go states.Run(ctx, bx)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": gitRepo(t)}, nil)
	return c, states, bx
}

// post is call without t, for a goroutine: the status, and the error the
// box answered with.
func post(c *wire.Client, path string, in, out any) (int, string, error) {
	b, _ := json.Marshal(in)
	resp, err := c.Do(context.Background(), "POST", path, bytes.NewReader(b))
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return resp.StatusCode, e.Error, nil
	}
	return resp.StatusCode, "", json.NewDecoder(resp.Body).Decode(out)
}

func stateIs(states *Turns, name, want string) func() bool {
	return func() bool { st, _ := states.State(name); return st.State == want }
}

func logOf(t *testing.T, conv string) []agenthost.Entry {
	t.Helper()
	var all []agenthost.Entry
	agenthost.ReadLog(filepath.Join(conv, agenthost.LogName), 0, func(e agenthost.Entry) error {
		all = append(all, e)
		return nil
	})
	return all
}

// hostEntries are a log's host entries, in order.
func hostEntries(log []agenthost.Entry) []agenthost.Entry {
	var out []agenthost.Entry
	for _, e := range log {
		if e.Dir == "host" {
			out = append(out, e)
		}
	}
	return out
}

// argAfter is the word after flag in argv, or "".
func argAfter(argv []string, flag string) string {
	if i := slices.Index(argv, flag); i >= 0 && i+1 < len(argv) {
		return argv[i+1]
	}
	return ""
}

// A restart asked for mid-turn waits for the turn's result, then starts the
// agent again with --resume and what it was started with, on the same log
// (its numbering carries on) and socket. A prompt held for the agent's idle
// meanwhile goes to the new one.
func TestAStructuredSessionRestartsAtItsTurnsEndAndCarriesItsConversationOn(t *testing.T) {
	c, states, bx := restartBox(t)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude",
		"mode": "acceptEdits", "model": "claude-fake-model", "effort": "high", "prompt": "hello"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	name := sess.Name
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+name, "", nil, nil) })
	until(t, "the first reply", saidIn(t, c, name, "echo: hello"))
	until(t, "the first turn's end", stateIs(states, name, "finished"))
	live, err := bx.Sessions.Get(t.Context(), name)
	if err != nil {
		t.Fatal(err)
	}

	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "take your time", "when": "now"}, nil)
	until(t, "the slow turn's start", stateIs(states, name, "running"))
	type answer struct {
		status int
		msg    string
		res    RestartResult
		err    error
	}
	done := make(chan answer, 1)
	go func() {
		var a answer
		a.status, a.msg, a.err = post(c, "/v1/sessions/"+name+"/restart", RestartRequest{Reason: "a newer Claude Code"}, &a.res)
		done <- a
	}()
	// Held until the agent is idle: it is working, then restarting.
	time.Sleep(200 * time.Millisecond)
	var held SendResult
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "after the restart", "when": "idle"}, &held)
	if !held.Queued {
		t.Fatalf("a send for when it is idle went in mid-turn: %+v", held)
	}

	var a answer
	select {
	case a = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the restart never answered")
	}
	if a.err != nil || a.status != 200 {
		t.Fatalf("restart: %d %s %v", a.status, a.msg, a.err)
	}
	if a.res.Name != name || a.res.AgentSessionID != "00000000-0000-4000-8000-0000000000c1" || a.res.Reason != "a newer Claude Code" || a.res.WaitedMS < 500 {
		t.Fatalf("restart answered %+v", a.res)
	}

	// The held prompt went to the agent started again, and was answered.
	until(t, "the held prompt's reply", saidIn(t, c, name, "echo: after the restart"))
	until(t, "its turn's end", stateIs(states, name, "finished"))

	log := logOf(t, live.conv)
	for i, e := range log {
		if e.Seq != int64(i+1) {
			t.Fatalf("the log's numbering broke at entry %d: seq %d", i, e.Seq)
		}
	}
	hosts := hostEntries(log)
	if len(hosts) != 4 || hosts[0].Event != "started" || hosts[1].Event != "exited" || hosts[2].Event != "restart" || hosts[3].Event != "started" {
		t.Fatalf("host entries: %+v", hosts)
	}
	if hosts[2].Text != "a newer Claude Code" {
		t.Fatalf("the restart's reason in the log: %q", hosts[2].Text)
	}
	// It was stopped only once its turn had ended.
	var took, slowEnd, heldIn int64
	for _, e := range log {
		switch {
		case e.Dir == "out" && took == 0 && strings.Contains(string(e.Data), "Took my time."):
			took = e.Seq
		case e.Dir == "out" && took > 0 && slowEnd == 0 && isResult(e.Data):
			slowEnd = e.Seq
		case e.Dir == "in" && strings.Contains(string(e.Data), "after the restart"):
			heldIn = e.Seq
		}
	}
	if slowEnd == 0 || slowEnd > hosts[1].Seq {
		t.Fatalf("the agent was stopped (seq %d) before its turn ended (seq %d)", hosts[1].Seq, slowEnd)
	}
	if heldIn < hosts[3].Seq {
		t.Fatalf("the held prompt (seq %d) went in before the agent started again (seq %d)", heldIn, hosts[3].Seq)
	}
	first, again := hosts[0].Argv, hosts[3].Argv
	for _, argv := range [][]string{first, again} {
		if argAfter(argv, "--model") != "claude-fake-model" || argAfter(argv, "--effort") != "high" || argAfter(argv, "--permission-mode") != "acceptEdits" {
			t.Fatalf("started without its model, effort or mode: %q", argv)
		}
	}
	if argAfter(again, "--resume") != "00000000-0000-4000-8000-0000000000c1" {
		t.Fatalf("started again without --resume: %q", again)
	}
	if after, err := bx.Sessions.Get(t.Context(), name); err != nil || after.conv != live.conv || after.sock != live.sock || after.Exited {
		t.Fatalf("after the restart the session is %+v (%v), was on %s %s", after, err, live.conv, live.sock)
	}
}

// A turn that doesn't end in time leaves the agent alone: 504, and it works
// on, never stopped.
func TestARestartWhoseTurnDoesntEndInTimeLeavesTheAgentRunning(t *testing.T) {
	c, states, bx := restartBox(t)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "prompt": "hello"}, &sess)
	name := sess.Name
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+name, "", nil, nil) })
	until(t, "the first turn's end", stateIs(states, name, "finished"))
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "work", "when": "now"}, nil)
	until(t, "the long turn's start", stateIs(states, name, "running"))

	status, msg, err := post(c, "/v1/sessions/"+name+"/restart?timeout=500ms", nil, nil)
	if err != nil || status != http.StatusGatewayTimeout {
		t.Fatalf("restart: %d %s %v", status, msg, err)
	}
	live, _ := bx.Sessions.Get(t.Context(), name)
	if !conversationRunning(live) {
		t.Fatal("the agent was stopped")
	}
	if st, _ := states.State(name); st.State != "running" {
		t.Fatalf("the agent is %s", st.State)
	}
	for _, e := range hostEntries(logOf(t, live.conv)) {
		if e.Event != "started" {
			t.Fatalf("the log has %+v", e)
		}
	}
	// Still its own: it takes an interrupt, and sends after it.
	var stopped map[string]bool
	call(t, c, "POST", "/v1/sessions/"+name+"/interrupt", "", nil, &stopped)
	if !stopped["stopped"] {
		t.Fatalf("interrupt: %v", stopped)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "still there", "when": "now"}, nil)
	until(t, "a reply after the timeout", saidIn(t, c, name, "echo: still there"))
}

// A session never prompted starts again under the same --session-id (there
// is nothing saved to resume); one that isn't a structured Claude session,
// or isn't there, is refused.
func TestARestartBeforeTheFirstPromptKeepsItsIDAndOnlyChatSessionsRestart(t *testing.T) {
	c, states, bx := restartBox(t)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude"}, &sess)
	name := sess.Name
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+name, "", nil, nil) })
	live, err := bx.Sessions.Get(t.Context(), name)
	if err != nil {
		t.Fatal(err)
	}
	// Its SessionStart hooks name it before any prompt.
	until(t, "its session id", func() bool { return lastSessionID(filepath.Join(live.conv, agenthost.LogName)) != "" })
	var res RestartResult
	if status, msg, err := post(c, "/v1/sessions/"+name+"/restart", nil, &res); err != nil || status != 200 || res.AgentSessionID != "00000000-0000-4000-8000-0000000000c1" || res.Reason != "" {
		t.Fatalf("restart: %d %s %v %+v", status, msg, err, res)
	}
	hosts := hostEntries(logOf(t, live.conv))
	if n := len(hosts); n != 4 || argAfter(hosts[3].Argv, "--session-id") != res.AgentSessionID || slices.Contains(hosts[3].Argv, "--resume") {
		t.Fatalf("host entries: %+v", hosts)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "first words", "when": "idle"}, nil)
	until(t, "the first reply", saidIn(t, c, name, "echo: first words"))
	until(t, "its turn's end", stateIs(states, name, "finished"))

	if status, _, _ := post(c, "/v1/sessions/nope/restart", nil, nil); status != http.StatusNotFound {
		t.Fatalf("an unknown session: %d", status)
	}
	var shell Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme"}, &shell)
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+shell.Name, "", nil, nil) })
	if status, _, _ := post(c, "/v1/sessions/"+shell.Name+"/restart", nil, nil); status != http.StatusConflict {
		t.Fatalf("a terminal session: %d", status)
	}
	if status, _, _ := post(c, "/v1/sessions/"+name+"/restart?timeout=forever", nil, nil); status != http.StatusBadRequest {
		t.Fatalf("a bad timeout: %d", status)
	}
}

// Started again (resumed, restarted, carried on), Claude keeps the model,
// effort and mode its conversation was started with.
func TestAClaudeConversationStartedAgainKeepsItsModelAndEffort(t *testing.T) {
	b := &Box{AgentHost: []string{"berthd", "agent-host"}, Locations: NewLocations(filepath.Join(t.TempDir(), "locations.json"))}
	dir := t.TempDir()
	noteConversation(dir, func(m *Conversation) { m.Agent, m.Model, m.Effort, m.Mode = "claude", "opus", "high", "plan" })
	l, err := b.relaunch(t.Context(), "", dir, "/tmp/s", "sid-1", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"claude --model opus --effort high ", "--permission-mode plan", "--session-id sid-1"} {
		if !strings.Contains(strings.ReplaceAll(l.command, "'", ""), want) {
			t.Fatalf("started again with %q, without %q", l.command, want)
		}
	}
	// A mode asked for wins over the one it was started in.
	if l, _ := b.relaunch(t.Context(), "", dir, "/tmp/s", "sid-1", "acceptEdits"); !strings.Contains(strings.ReplaceAll(l.command, "'", ""), "--permission-mode acceptEdits") {
		t.Fatalf("started again with %q", l.command)
	}
}
