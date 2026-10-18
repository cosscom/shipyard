package box

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/transcript"
)

// conversationsDir is a test box's folder of structured conversations. A
// host writes its exit into its conversation's folder after the session it
// ran in is stopped, so the folder goes only once no host listens for a
// conversation in it: removed sooner, it races that last write.
func conversationsDir(t *testing.T) string {
	dir := t.TempDir()
	t.Cleanup(func() {
		entries, _ := os.ReadDir(dir)
		deadline := time.Now().Add(15 * time.Second)
		for _, e := range entries {
			sock, err := hostSocket(e.Name())
			if err != nil {
				continue
			}
			for {
				conn, err := net.DialTimeout("unix", sock, time.Second)
				if err != nil {
					break
				}
				conn.Close()
				if time.Now().After(deadline) {
					t.Errorf("the host for %s never went", e.Name())
					return
				}
				time.Sleep(50 * time.Millisecond)
			}
		}
		// A host closes its socket before its log, so its last write can land
		// as the folder is being removed ("directory not empty"). Remove it
		// until it stays removed; t.TempDir's own cleanup then finds nothing.
		for {
			err := os.RemoveAll(dir)
			if err == nil {
				return
			}
			if time.Now().After(deadline) {
				t.Errorf("removing %s: %v", dir, err)
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return dir
}

// fakeStreamClaude stands in for `claude -p` speaking stream-json, with the
// lines the spike recorded (design/structured-agents): it echoes each
// prompt, streams and writes a reply, asks for a permission to "run the
// tests", asks a question to "ask me", works until interrupted on "work",
// and answers control requests.
const fakeStreamClaude = `#!/usr/bin/env python3
import json, os, re, sys
S = "00000000-0000-4000-8000-0000000000c1"
def transcript(sid):
    d = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects", re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()))
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, sid + ".jsonl")
if "-p" not in sys.argv:
    # Claude Code's own screen, resumed: a turn typed there, then /exit.
    sid = sys.argv[sys.argv.index("--resume") + 1]
    with open(transcript(sid), "a") as f:
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "typed in the terminal"}, "uuid": "00000000-0000-4000-8000-0000000000f1", "sessionId": sid, "timestamp": "2026-10-13T12:00:00Z"}) + "\n")
        f.write(json.dumps({"type": "assistant", "message": {"id": "msg_t", "role": "assistant", "content": [{"type": "text", "text": "answered in the terminal"}]}, "uuid": "00000000-0000-4000-8000-0000000000f2", "sessionId": sid, "timestamp": "2026-10-13T12:00:01Z"}) + "\n")
    print("Claude Code, resumed " + sid, flush=True)
    for line in sys.stdin:
        if "/exit" in line:
            sys.exit(0)
    sys.exit(0)
open(transcript(S), "a").close()
mode = sys.argv[sys.argv.index("--permission-mode") + 1]
n = [0]
def out(d):
    d.setdefault("session_id", S)
    print(json.dumps(d), flush=True)
def uid():
    n[0] += 1
    return "00000000-0000-4000-8000-%012d" % n[0]
def say(text):
    out({"type": "stream_event", "event": {"type": "message_start"}, "parent_tool_use_id": None})
    out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}, "parent_tool_use_id": None})
    out({"type": "assistant", "message": {"id": "msg_" + uid(), "role": "assistant", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": None, "uuid": uid()})
def tool(name, inp):
    t = "toolu_" + uid()[-8:]
    out({"type": "assistant", "message": {"id": "msg_" + uid(), "role": "assistant", "content": [{"type": "tool_use", "id": t, "name": name, "input": inp}]}, "parent_tool_use_id": None, "uuid": uid()})
    return t
def result(sub="success"):
    out({"type": "result", "subtype": sub, "is_error": sub != "success", "result": "", "session_id": S})
def control_reply(req):
    r = req["request"]
    if r["subtype"] == "set_permission_mode":
        global mode
        mode = r["mode"]
        out({"type": "control_response", "response": {"subtype": "success", "request_id": req["request_id"], "response": {"mode": mode}}})
        out({"type": "system", "subtype": "status", "status": None, "permissionMode": mode})
    else:
        out({"type": "control_response", "response": {"subtype": "success", "request_id": req["request_id"], "response": {}}})
def wait_for(rid):
    for line in sys.stdin:
        m = json.loads(line)
        if m["type"] == "control_response" and m["response"]["request_id"] == rid:
            return m["response"]["response"]
        if m["type"] == "control_request":
            control_reply(m)
            if m["request"]["subtype"] == "interrupt":
                return None
first = True
for line in sys.stdin:
    m = json.loads(line)
    if m["type"] == "control_request":
        control_reply(m)
        continue
    text = m["message"]["content"]
    out({"type": "user", "message": m["message"], "isReplay": True, "parent_tool_use_id": None, "uuid": uid()})
    if first:
        out({"type": "system", "subtype": "init", "cwd": "/w", "model": "claude-fake", "permissionMode": mode, "uuid": uid()})
        first = False
    if text == "run the tests":
        t = tool("Bash", {"command": "pnpm test", "description": "Run the tests"})
        rid = "req_" + uid()[-6:]
        out({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": t, "input": {"command": "pnpm test", "description": "Run the tests"}, "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "pnpm test"}], "behavior": "allow", "destination": "localSettings"}]}})
        r = wait_for(rid)
        ok = r and r.get("behavior") == "allow"
        out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": t, "content": "12 passed" if ok else "denied", "is_error": not ok}]}, "parent_tool_use_id": None, "uuid": uid()})
        say("The tests pass." if ok else "I didn't run them.")
        result()
    elif text == "ask me":
        q = {"question": "Tea or coffee?", "header": "Drink", "options": [{"label": "Tea", "description": ""}, {"label": "Coffee", "description": ""}], "multiSelect": False}
        t = tool("AskUserQuestion", {"questions": [q]})
        rid = "req_" + uid()[-6:]
        out({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": t, "requires_user_interaction": True, "input": {"questions": [q]}}})
        r = wait_for(rid)
        a = r["updatedInput"]["answers"]["Tea or coffee?"]
        out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": t, "content": "Your questions have been answered: \"Tea or coffee?\"=\"%s\"." % a}]}, "parent_tool_use_id": None, "uuid": uid()})
        say("You chose " + a + ".")
        result()
    elif text == "work":
        out({"type": "stream_event", "event": {"type": "message_start"}, "parent_tool_use_id": None})
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Working through it"}}, "parent_tool_use_id": None})
        wait_for("never")
        result("error_during_execution")
    else:
        say("echo: " + text)
        result()
`

func TestAStructuredClaudeSessionIsDrivenThroughItsStream(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Claude needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeStreamClaude), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	states := &Turns{}
	var box *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
		box = b
	})
	states.Attach(bus)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)

	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "prompt": "hello there"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })
	if sess.Driver != DriverClaude {
		t.Fatalf("driver = %q", sess.Driver)
	}
	name := sess.Name

	// read waits for the conversation to hold what ok looks for.
	read := func(ok func([]transcript.Item) bool) []transcript.Item {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
			if ok(res.Items) {
				return res.Items
			}
			if time.Now().After(deadline) {
				t.Fatalf("the conversation never showed it: %+v (%s)", res.Items, res.Reason)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	has := func(kind, text string) func([]transcript.Item) bool {
		return func(items []transcript.Item) bool {
			for _, it := range items {
				if it.Kind == kind && strings.Contains(it.Text, text) {
					return true
				}
			}
			return false
		}
	}
	state := func(want string) SessionState {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			st, _ := states.State(name)
			if st.State == want {
				return st
			}
			if time.Now().After(deadline) {
				t.Fatalf("the agent never became %s: %+v", want, st)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}

	// The first prompt goes in once the host listens, and the turn it
	// starts ends, all from the stream: no hook ran.
	read(has("text", "echo: hello there"))
	read(has("user", "hello there"))
	if st := state("finished"); st.AgentSessionID != "00000000-0000-4000-8000-0000000000c1" {
		t.Fatalf("the agent's own session id = %q", st.AgentSessionID)
	}

	// A permission waits for the person, with choices to answer it by.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "run the tests", "when": "now"}, nil)
	if st := state("waiting"); st.Ask == nil || st.Ask.Tool != "Bash" || st.Ask.Input != "pnpm test" {
		t.Fatalf("ask = %+v", st.Ask)
	}
	var list []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &list)
	if len(list) != 1 || list[0].Ask == nil || len(list[0].Ask.Choices) != 3 || list[0].Ask.Choices[0].Label != "Yes" {
		t.Fatalf("the session list doesn't offer the choices: %+v", list)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "1", "enter": false, "when": "now", "force": true}, nil)
	read(has("text", "The tests pass."))
	state("finished")

	// Bypass: berthd says yes for the person.
	var mode map[string]string
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/mode", "", map[string]string{"mode": "bypassPermissions"}, &mode); status != 200 || mode["mode"] != "bypassPermissions" {
		t.Fatalf("mode: %d %v", status, mode)
	}
	var controls Controls
	call(t, c, "GET", "/v1/sessions/"+name+"/controls", "", nil, &controls)
	if controls.Mode != "bypassPermissions" {
		t.Fatalf("controls = %+v", controls)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "run the tests", "when": "now"}, nil)
	items := read(func(items []transcript.Item) bool {
		n := 0
		for _, it := range items {
			if it.Kind == "text" && it.Text == "The tests pass." {
				n++
			}
		}
		return n == 2
	})
	if len(items) == 0 {
		t.Fatal("no items")
	}

	// A question waits even in bypass, and is answered from the chat.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "ask me", "when": "now"}, nil)
	state("waiting")
	q := read(func(items []transcript.Item) bool {
		for _, it := range items {
			if it.Kind == "question" {
				return true
			}
		}
		return false
	})
	var tool string
	for _, it := range q {
		if it.Kind == "question" {
			tool = it.Tool
		}
	}
	var ans AnswerResult
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/answer", "", map[string]any{"tool": tool, "answers": []any{map[string]any{"picks": []string{"Coffee"}}}}, &ans); status != 200 || len(ans.Answered) != 1 || ans.Answered[0] != "Coffee" {
		t.Fatalf("answer: %d %+v", status, ans)
	}
	read(has("text", "You chose Coffee."))
	state("finished")

	// The reply being written shows as a draft, and an interrupt stops it.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "work", "when": "now"}, nil)
	deadline := time.Now().Add(10 * time.Second)
	for {
		var d Draft
		call(t, c, "GET", "/v1/sessions/"+name+"/draft", "", nil, &d)
		if d.Text == "Working through it" && d.Status != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("draft = %+v", d)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var stopped map[string]bool
	call(t, c, "POST", "/v1/sessions/"+name+"/interrupt", "", nil, &stopped)
	if !stopped["stopped"] {
		t.Fatalf("interrupt: %v", stopped)
	}
	state("finished")

	// berthd starting again reads the log back, and goes on driving it.
	live, err := box.Sessions.Get(t.Context(), name)
	if err != nil || live.conv == "" || live.sock == "" {
		t.Fatalf("the session lost its labels: %+v, %v", live, err)
	}
	again := &claudeDriver{b: box, convs: map[string]*claudeConv{}}
	if err := again.Send(t.Context(), live, "still there?", true); err != nil {
		t.Fatal(err)
	}
	read(has("text", "echo: still there?"))
	conv, _ := again.conv(live)
	conv.mu.Lock()
	sid := conv.sessionID
	conv.mu.Unlock()
	if sid != "00000000-0000-4000-8000-0000000000c1" {
		t.Fatalf("read back, the session id is %q", sid)
	}

	// Its log is berthd's own record of all of it, the streamed words too.
	raw, _ := os.ReadFile(filepath.Join(live.conv, "events.jsonl"))
	if !json.Valid([]byte(strings.Split(string(raw), "\n")[0])) || !strings.Contains(string(raw), `"Working through it"`) {
		t.Fatalf("the log doesn't hold the stream")
	}
}

// A structured session's first prompt is sent before its stream has said
// anything, so its turn starts as one only the screen could end. The
// screen of a structured session is its host's, which never shows the
// question: read, it ended the wait for a permission and then the turn, and
// the chat lost the person's Allow / Deny.
func TestAPermissionInAStructuredSessionsFirstTurnWaitsForThePerson(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Claude needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeStreamClaude), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	states := &Turns{}
	var box *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
		box = b
	})
	states.Attach(bus)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "prompt": "run the tests"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })

	deadline := time.Now().Add(10 * time.Second)
	for st, _ := states.State(sess.Name); st.State != "waiting"; st, _ = states.State(sess.Name) {
		if time.Now().After(deadline) {
			t.Fatalf("the permission never waited: %+v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// More polls than it takes the screen to call a turn finished.
	for range screenQuiet + 2 {
		box.pollScreens(t.Context())
	}
	if st, _ := states.State(sess.Name); st.State != "waiting" || st.Ask == nil || st.Ask.Input != "pnpm test" {
		t.Fatalf("the screen settled a structured session's permission: %+v", st)
	}
}

// TestALiveClaudeSessionWorks drives the real Claude Code (haiku): run it
// with BERTH_LIVE_CLAUDE=1 on a machine logged in to Claude.
func TestALiveClaudeSessionWorks(t *testing.T) {
	if os.Getenv("BERTH_LIVE_CLAUDE") != "1" {
		t.Skip("set BERTH_LIVE_CLAUDE=1 to drive the real Claude Code")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("no claude on PATH")
	}
	exe, _ := os.Executable()
	states := &Turns{}
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
	})
	states.Attach(bus)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "model": "haiku", "mode": "bypassPermissions", "prompt": "Reply with just the word: harbour"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })
	wait := func(what string, ok func([]transcript.Item, SessionState) bool) {
		t.Helper()
		deadline := time.Now().Add(90 * time.Second)
		for {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+sess.Name+"/transcript?since=0", "", nil, &res)
			st, _ := states.State(sess.Name)
			if ok(res.Items, st) {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never happened: %+v / %+v", what, res.Items, st)
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	said := func(word string) func([]transcript.Item, SessionState) bool {
		return func(items []transcript.Item, st SessionState) bool {
			for _, it := range items {
				if it.Kind == "text" && strings.Contains(strings.ToLower(it.Text), word) {
					return st.State == "finished"
				}
			}
			return false
		}
	}
	wait("the first reply", said("harbour"))
	// Bypass: the box allows the command it runs.
	call(t, c, "POST", "/v1/sessions/"+sess.Name+"/send", "", map[string]any{"text": "Run `echo shipyard-live` with the Bash tool, then reply with just its output.", "when": "now"}, nil)
	wait("the command's output", said("shipyard-live"))

	// To Claude Code's own terminal and back, the same conversation.
	if status := call(t, c, "POST", "/v1/sessions/"+sess.Name+"/switch", "", map[string]string{"to": "terminal"}, nil); status != 200 {
		t.Fatalf("to terminal: %d", status)
	}
	var screen struct{ Screen string }
	deadline := time.Now().Add(60 * time.Second)
	for !strings.Contains(screen.Screen, "shipyard-live") {
		if time.Now().After(deadline) {
			t.Fatalf("Claude Code's screen never showed the conversation:\n%s", screen.Screen)
		}
		time.Sleep(500 * time.Millisecond)
		call(t, c, "GET", "/v1/sessions/"+sess.Name+"/screen", "", nil, &screen)
		if strings.Contains(screen.Screen, "Yes, I trust this folder") {
			// A folder it hasn't seen: answered as a person would.
			call(t, c, "POST", "/v1/sessions/"+sess.Name+"/keys", "", map[string]any{"keys": []string{"down", "enter"}}, nil)
			time.Sleep(time.Second)
		}
	}
	if status := call(t, c, "POST", "/v1/sessions/"+sess.Name+"/switch", "", map[string]string{"to": "chat"}, nil); status != 200 {
		t.Fatalf("to chat: %d", status)
	}
	call(t, c, "POST", "/v1/sessions/"+sess.Name+"/send", "", map[string]any{"text": "What word did you reply with first? Reply with just that word.", "when": "now"}, nil)
	wait("a reply that remembers", func(items []transcript.Item, st SessionState) bool {
		n := 0
		for _, it := range items {
			if it.Kind == "text" && strings.Contains(strings.ToLower(it.Text), "harbour") {
				n++
			}
		}
		return n >= 2 && st.State == "finished"
	})
}

func TestAStructuredSessionGoesToItsTerminalAndBack(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Claude needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeStreamClaude), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	exe, _ := os.Executable()
	states := &Turns{}
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
	})
	states.Attach(bus)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "prompt": "hello"}, &sess)
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })
	name := sess.Name
	until := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("%s never happened", what)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	said := func(text string) func() bool {
		return func() bool {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
			for _, it := range res.Items {
				if strings.Contains(it.Text, text) {
					return true
				}
			}
			return false
		}
	}
	finished := func() bool { st, _ := states.State(name); return st.State == "finished" }
	until("the first reply", said("echo: hello"))
	until("the first turn's end", finished)
	if sess.Switch != "terminal" {
		t.Fatalf("a structured session can't go to its terminal: %+v", sess)
	}

	var moved Session
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/switch", "", map[string]string{"to": "terminal"}, &moved); status != 200 {
		t.Fatalf("to terminal: %d", status)
	}
	if moved.Driver != DriverTerminal || moved.Switch != "chat" || moved.Exited {
		t.Fatalf("in its terminal it reads %+v", moved)
	}
	until("Claude Code's own screen", func() bool {
		var screen struct{ Screen string }
		call(t, c, "GET", "/v1/sessions/"+name+"/screen", "", nil, &screen)
		return strings.Contains(screen.Screen, "resumed 00000000-0000-4000-8000-0000000000c1")
	})
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/switch", "", map[string]string{"to": "terminal"}, nil); status != http.StatusConflict {
		t.Fatalf("switching to the terminal twice: %d", status)
	}

	if status := call(t, c, "POST", "/v1/sessions/"+name+"/switch", "", map[string]string{"to": "chat"}, &moved); status != 200 {
		t.Fatalf("to chat: %d", status)
	}
	if moved.Driver != DriverClaude || moved.Switch != "terminal" {
		t.Fatalf("back in its chat it reads %+v", moved)
	}
	// What was said in the terminal reads in the chat, in its place.
	until("the terminal's turn in the chat", said("answered in the terminal"))
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "back again", "when": "now"}, nil); status != 200 {
		st, _ := states.State(name)
		t.Fatalf("send after coming back: %d (%+v)", status, st)
	}
	until("a reply after coming back", said("echo: back again"))
	var res transcript.Result
	call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
	var order []string
	for _, it := range res.Items {
		if it.Kind == "text" {
			order = append(order, it.Text)
		}
	}
	if strings.Join(order, " | ") != "echo: hello | answered in the terminal | echo: back again" {
		t.Fatalf("the conversation reads %q", order)
	}
}

func TestAStructuredConversationIsResumedWhenItsAgentEndsAndWhenItsSessionIsGone(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Claude needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeStreamClaude), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	exe, _ := os.Executable()
	states := &Turns{}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		bx = b
		b.Turns = states
		b.ConversationsDir = conversationsDir(t)
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
	})
	states.Attach(bus)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "mode": "bypassPermissions", "prompt": "hello"}, &sess)
	names := []string{sess.Name}
	t.Cleanup(func() {
		for _, n := range names {
			call(t, c, "DELETE", "/v1/sessions/"+n, "", nil, nil)
		}
	})
	until := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("%s never happened", what)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	said := func(name, text string) func() bool {
		return func() bool {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
			for _, it := range res.Items {
				if strings.Contains(it.Text, text) {
					return true
				}
			}
			return false
		}
	}
	finished := func(name string) func() bool {
		return func() bool { st, _ := states.State(name); return st.State == "finished" }
	}
	until("the first reply", said(sess.Name, "echo: hello"))
	until("the first turn's end", finished(sess.Name))

	var convs []Conversation
	call(t, c, "GET", "/v1/conversations?path="+repo, "", nil, &convs)
	if len(convs) != 1 || !convs[0].Live || convs[0].Session != sess.Name || convs[0].Title != "hello" ||
		convs[0].AgentSessionID != "00000000-0000-4000-8000-0000000000c1" || convs[0].Mode != "bypassPermissions" {
		t.Fatalf("conversations = %+v", convs)
	}
	id := convs[0].ID

	// Its agent ends (stopped here; a crash or a /exit alike): the session
	// starts it again on its own log.
	live, err := bx.Sessions.Get(t.Context(), sess.Name)
	if err != nil {
		t.Fatal(err)
	}
	if err := agenthost.Stop(t.Context(), live.sock); err != nil {
		t.Fatal(err)
	}
	until("the session's end", func() bool {
		var list []Session
		call(t, c, "GET", "/v1/sessions", "", nil, &list)
		return len(list) == 1 && list[0].Exited
	})
	var resumed Session
	if status := call(t, c, "POST", "/v1/sessions/"+sess.Name+"/resume", "", nil, &resumed); status != 200 || resumed.Exited || resumed.Driver != DriverClaude {
		t.Fatalf("resume: %d %+v", status, resumed)
	}
	call(t, c, "POST", "/v1/sessions/"+sess.Name+"/send", "", map[string]any{"text": "again", "when": "now"}, nil)
	until("a reply once resumed", said(sess.Name, "echo: again"))
	until("its turn's end", finished(sess.Name))

	// Its session closed altogether: the conversation is found and carried
	// on in a new one, its earlier turns with it.
	if status := call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil); status != 200 {
		t.Fatalf("delete: %d", status)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		convs = nil
		call(t, c, "GET", "/v1/conversations", "", nil, &convs)
		if len(convs) == 1 && !convs[0].Live {
			break
		}
		if time.Now().After(deadline) {
			var list []Session
			call(t, c, "GET", "/v1/sessions", "", nil, &list)
			t.Fatalf("the conversation is still %+v; sessions %+v", convs, list)
		}
		time.Sleep(100 * time.Millisecond)
	}
	var again Session
	if status := call(t, c, "POST", "/v1/conversations/"+id+"/resume", "", nil, &again); status != 200 || again.Driver != DriverClaude || again.Title != "hello" {
		t.Fatalf("resume the conversation: %d %+v", status, again)
	}
	names = append(names, again.Name)
	call(t, c, "POST", "/v1/sessions/"+again.Name+"/send", "", map[string]any{"text": "third", "when": "now"}, nil)
	until("a reply in the new session", said(again.Name, "echo: third"))
	until("the earlier turns in it", said(again.Name, "echo: again"))
	var controls Controls
	call(t, c, "GET", "/v1/sessions/"+again.Name+"/controls", "", nil, &controls)
	if controls.Mode != "bypassPermissions" {
		t.Fatalf("it came back in %q", controls.Mode)
	}
	if status := call(t, c, "POST", "/v1/conversations/nope/resume", "", nil, nil); status != http.StatusNotFound {
		t.Fatalf("an unknown conversation: %d", status)
	}
}
