package box

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/transcript"
)

// fakeCodexAppServer stands in for `codex app-server` with the messages the
// spike recorded (design/structured-agents): it opens a thread, echoes a
// prompt, asks to approve "run the tests" (unless its turn's policy is
// never), asks a question to "ask me", works until interrupted on "work",
// and resumes a thread by its id.
const fakeCodexAppServer = `#!/usr/bin/env python3
import json, os, sys
T = "00000000-0000-7000-8000-0000000000d1"
n = [0]
srv = [0]
state = {"turn": None, "thread": None}
def out(d):
    print(json.dumps(d), flush=True)
def note(m, p):
    p.setdefault("threadId", state["thread"])
    out({"method": m, "params": p, "emittedAtMs": 0})
def uid():
    n[0] += 1
    return "item-%d" % n[0]
def say(text):
    i = uid()
    note("item/started", {"item": {"type": "agentMessage", "id": i, "text": ""}})
    note("item/agentMessage/delta", {"itemId": i, "delta": text})
    note("item/completed", {"item": {"type": "agentMessage", "id": i, "text": text}})
def finish(status="completed"):
    note("thread/status/changed", {"status": {"type": "idle"}})
    note("turn/completed", {"turn": {"id": state["turn"], "status": status, "items": []}})
    state["turn"] = None
def ask(method, params):
    rid = srv[0]
    srv[0] += 1
    out({"id": rid, "method": method, "params": params})
    for line in sys.stdin:
        m = json.loads(line)
        if m.get("id") == rid and "method" not in m:
            note("serverRequest/resolved", {"requestId": rid})
            return m.get("result") or {}
        if handle(m) == "interrupted":
            return None
def handle(m):
    method, rid, p = m.get("method"), m.get("id"), m.get("params") or {}
    if method == "initialize":
        out({"id": rid, "result": {"userAgent": "fake", "platformFamily": "unix"}})
    elif method == "thread/start":
        state["thread"] = T
        out({"id": rid, "result": {"thread": {"id": T}}})
        note("thread/started", {"thread": {"id": T}})
    elif method == "thread/resume":
        state["thread"] = p["threadId"]
        out({"id": rid, "result": {"thread": {"id": p["threadId"]}}})
    elif method == "turn/interrupt":
        out({"id": rid, "result": {}})
        if state["turn"]:
            finish("interrupted")
        return "interrupted"
    elif method == "turn/start":
        state["turn"] = "turn-" + uid()
        out({"id": rid, "result": {"turn": {"id": state["turn"], "status": "inProgress", "items": []}}})
        note("turn/started", {"turn": {"id": state["turn"], "status": "inProgress"}})
        text = p["input"][0]["text"]
        note("item/started", {"item": {"type": "userMessage", "id": uid(), "content": [{"type": "text", "text": text}]}})
        if text == "run the tests":
            i = uid()
            note("item/started", {"item": {"type": "commandExecution", "id": i, "command": "/bin/zsh -lc 'pnpm test'", "commandActions": [{"type": "unknown", "command": "pnpm test"}], "status": "inProgress"}})
            ok = True
            if p.get("approvalPolicy") != "never":
                r = ask("item/commandExecution/requestApproval", {"turnId": state["turn"], "itemId": i, "command": "/bin/zsh -lc 'pnpm test'", "reason": "Run the tests"})
                ok = bool(r) and r.get("decision") in ("accept", "acceptForSession")
            note("item/completed", {"item": {"type": "commandExecution", "id": i, "command": "/bin/zsh -lc 'pnpm test'", "status": "completed" if ok else "declined", "exitCode": 0 if ok else None, "aggregatedOutput": "12 passed" if ok else None}})
            say("The tests pass." if ok else "I didn't run them.")
            finish()
        elif text == "edit the notes":
            i = uid()
            change = {"type": "fileChange", "id": i, "changes": [{"path": os.getcwd() + "/notes.txt", "kind": {"type": "update"}, "diff": "@@ -1 +1 @@\n-old\n+new\n"}]}
            note("item/started", {"item": dict(change, status="inProgress")})
            note("item/completed", {"item": dict(change, status="completed")})
            say("Edited the notes.")
            finish()
        elif text == "ask me":
            r = ask("item/tool/requestUserInput", {"turnId": state["turn"], "itemId": "ask-item", "questions": [{"id": "drink", "header": "Drink", "question": "Tea or coffee?", "isOther": False, "isSecret": False, "options": [{"label": "Tea", "description": ""}, {"label": "Coffee", "description": ""}]}]})
            say("You chose " + r["answers"]["drink"]["answers"][0] + ".")
            finish()
        elif text == "work":
            i = uid()
            note("item/started", {"item": {"type": "agentMessage", "id": i, "text": ""}})
            note("item/agentMessage/delta", {"itemId": i, "delta": "Working through it"})
            for line in sys.stdin:
                if handle(json.loads(line)) == "interrupted":
                    break
        else:
            say("echo: " + text)
            finish()
for line in sys.stdin:
    handle(json.loads(line))
`

func TestAStructuredCodexSessionIsDrivenThroughItsAppServer(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Codex needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "codex"), []byte(fakeCodexAppServer), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
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
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "codex", "driver": "codex", "prompt": "hello there"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })
	if sess.Driver != DriverCodex || sess.Switch != "" {
		t.Fatalf("session = %+v", sess)
	}
	name := sess.Name
	until := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				var res transcript.Result
				call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
				st, _ := states.State(name)
				t.Fatalf("%s never happened: %+v / %+v", what, res.Items, st)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	said := func(text string) func() bool {
		return func() bool {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
			n := 0
			for _, it := range res.Items {
				if strings.Contains(it.Text, text) {
					n++
				}
			}
			return n > 0
		}
	}
	state := func(want string) func() bool {
		return func() bool { st, _ := states.State(name); return st.State == want }
	}

	until("the first reply", said("echo: hello there"))
	until("the first turn's end", state("finished"))
	if st, _ := states.State(name); st.AgentSessionID != "00000000-0000-7000-8000-0000000000d1" {
		t.Fatalf("the thread = %q", st.AgentSessionID)
	}

	// A command waits for approval, with choices.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "run the tests", "when": "now"}, nil)
	until("the approval", state("waiting"))
	if st, _ := states.State(name); st.Ask == nil || st.Ask.Tool != "Bash" || st.Ask.Input != "pnpm test" {
		t.Fatalf("ask = %+v", st.Ask)
	}
	var list []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &list)
	if len(list) != 1 || list[0].Ask == nil || len(list[0].Ask.Choices) != 3 {
		t.Fatalf("no choices: %+v", list)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "1", "enter": false, "when": "now", "force": true}, nil)
	until("the approved command's reply", said("The tests pass."))
	until("its turn's end", state("finished"))

	// An edit, then each step opened up as the chat's cards do: from
	// berthd's own log of the app server, where the ids are the items'.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "edit the notes", "when": "now"}, nil)
	until("the edit's reply", said("Edited the notes."))
	until("its turn's end", state("finished"))
	var res transcript.Result
	call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
	edit, run := "", ""
	for _, it := range res.Items {
		if it.Kind == "edit" && it.File == "notes.txt" {
			edit = it.Tool
		}
		for _, tc := range it.Items {
			if strings.Contains(tc.Target, "pnpm test") {
				run = tc.ID
			}
		}
	}
	if edit == "" || run == "" {
		t.Fatalf("no edit or command to open: %+v", res.Items)
	}
	var change transcript.ToolDetail
	if status := call(t, c, "GET", "/v1/sessions/"+name+"/transcript/tool/"+edit, "", nil, &change); status != 200 || change.File != "notes.txt" || !strings.Contains(change.New, "+new") {
		t.Fatalf("the edit's change: %d %+v", status, change)
	}
	var cmd transcript.ToolDetail
	if status := call(t, c, "GET", "/v1/sessions/"+name+"/transcript/tool/"+run, "", nil, &cmd); status != 200 || cmd.Command != "pnpm test" || cmd.Output != "12 passed" {
		t.Fatalf("the command's output: %d %+v", status, cmd)
	}

	// Bypass: the turn says so, and Codex asks nothing.
	var mode map[string]string
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/mode", "", map[string]string{"mode": "bypassPermissions"}, &mode); status != 200 || mode["mode"] != "bypassPermissions" {
		t.Fatalf("mode: %d %v", status, mode)
	}
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "run the tests", "when": "now"}, nil)
	until("a second run with no approval", func() bool {
		var res transcript.Result
		call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
		n := 0
		for _, it := range res.Items {
			if it.Text == "The tests pass." {
				n++
			}
		}
		return n == 2
	})
	until("its turn's end", state("finished"))

	// Its question, answered from the chat.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "ask me", "when": "now"}, nil)
	until("the question", state("waiting"))
	var ans AnswerResult
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/answer", "", map[string]any{"tool": "ask-item", "answers": []any{map[string]any{"picks": []string{"Coffee"}}}}, &ans); status != 200 {
		t.Fatalf("answer: %d", status)
	}
	until("the answer's reply", said("You chose Coffee."))
	until("its turn's end", state("finished"))

	// The reply being written, then an interrupt.
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "work", "when": "now"}, nil)
	until("the draft", func() bool {
		var d Draft
		call(t, c, "GET", "/v1/sessions/"+name+"/draft", "", nil, &d)
		return d.Text == "Working through it"
	})
	var stopped map[string]bool
	call(t, c, "POST", "/v1/sessions/"+name+"/interrupt", "", nil, &stopped)
	if !stopped["stopped"] {
		t.Fatalf("interrupt: %v", stopped)
	}
	until("the interrupted turn's end", state("finished"))

	// Its app server ends; resumed, it opens the same thread again.
	live, err := bx.Sessions.Get(t.Context(), name)
	if err != nil {
		t.Fatal(err)
	}
	if err := agenthost.Stop(t.Context(), live.sock); err != nil {
		t.Fatal(err)
	}
	until("the session's end", func() bool {
		s, err := bx.Sessions.Get(t.Context(), name)
		return err == nil && s.Exited
	})
	if status := call(t, c, "POST", "/v1/sessions/"+name+"/resume", "", nil, nil); status != 200 {
		t.Fatalf("resume: %d", status)
	}
	// At its prompt, as the app lists it: not working.
	until("idle once resumed", func() bool {
		var list []Session
		call(t, c, "GET", "/v1/sessions", "", nil, &list)
		return len(list) == 1 && !list[0].Exited && list[0].AgentState == "idle"
	})
	call(t, c, "POST", "/v1/sessions/"+name+"/send", "", map[string]any{"text": "again", "when": "now"}, nil)
	until("a reply once resumed", said("echo: again"))
	var controls Controls
	call(t, c, "GET", "/v1/sessions/"+name+"/controls", "", nil, &controls)
	if controls.Agent != "codex" || controls.Mode != "bypassPermissions" {
		t.Fatalf("controls = %+v", controls)
	}
}

// TestALiveCodexSessionWorks drives the real Codex: run it with
// BERTH_LIVE_CODEX=1 on a machine logged in to Codex (BERTH_LIVE_CODEX_MODEL
// picks the model).
func TestALiveCodexSessionWorks(t *testing.T) {
	if os.Getenv("BERTH_LIVE_CODEX") != "1" {
		t.Skip("set BERTH_LIVE_CODEX=1 to drive the real Codex")
	}
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex on PATH")
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
	req := map[string]any{"location": "acme", "agent": "codex", "driver": "codex", "mode": "bypassPermissions", "effort": "low", "prompt": "Reply with just the word: harbour"}
	if m := os.Getenv("BERTH_LIVE_CODEX_MODEL"); m != "" {
		req["model"] = m
	}
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", req, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil) })
	wait := func(what, word string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Minute)
		for {
			var res transcript.Result
			call(t, c, "GET", "/v1/sessions/"+sess.Name+"/transcript?since=0", "", nil, &res)
			st, _ := states.State(sess.Name)
			for _, it := range res.Items {
				if it.Kind == "text" && strings.Contains(strings.ToLower(it.Text), word) && st.State == "finished" {
					return
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never happened: %+v / %+v", what, res.Items, st)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	wait("the first reply", "harbour")
	call(t, c, "POST", "/v1/sessions/"+sess.Name+"/send", "", map[string]any{"text": "Run `echo shipyard-live` in the shell, then reply with just its output.", "when": "now"}, nil)
	wait("the command's output", "shipyard-live")
}
